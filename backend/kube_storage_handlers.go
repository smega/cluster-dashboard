// kube_storage_handlers.go
package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Uses global:
//   - kubeClient (typed clientset)
//   - kubeDynamic (dynamic.Interface)  // already used by VPA
//
// Also uses existing helpers in your repo:
//   - ageString(time.Time) string
//   - metaLiteFromObject(...)
//   - metaLiteFromUnstructured(*unstructured.Unstructured)

type PVItem struct {
	Kind         string   `json:"kind"` // "PV"
	Name         string   `json:"name"`
	Phase        string   `json:"phase"`
	Capacity     string   `json:"capacity,omitempty"`
	StorageClass string   `json:"storageClass,omitempty"`
	Claim        string   `json:"claim,omitempty"` // ns/name
	Reclaim      string   `json:"reclaim,omitempty"`
	AccessModes  []string `json:"accessModes,omitempty"`
	VolumeMode   string   `json:"volumeMode,omitempty"`
	Driver       string   `json:"driver,omitempty"`
	Age          string   `json:"age"`
}

type StorageClassItem struct {
	Kind              string `json:"kind"` // "StorageClass"
	Name              string `json:"name"`
	Provisioner       string `json:"provisioner,omitempty"`
	ReclaimPolicy     string `json:"reclaimPolicy,omitempty"`
	VolumeBindingMode string `json:"volumeBindingMode,omitempty"`
	AllowExpansion    bool   `json:"allowExpansion"`
	Parameters        int    `json:"parameters,omitempty"`
	Age               string `json:"age"`
}

type CSIDriverItem struct {
	Kind              string `json:"kind"` // "CSIDriver"
	Name              string `json:"name"`
	AttachRequired    string `json:"attachRequired,omitempty"`    // true/false/-
	PodInfoOnMount    string `json:"podInfoOnMount,omitempty"`    // true/false/-
	StorageCapacity   string `json:"storageCapacity,omitempty"`   // true/false/-
	FSGroupPolicy     string `json:"fsGroupPolicy,omitempty"`     // ReadWriteOnceWithFSType / File / None / -
	RequiresRepublish string `json:"requiresRepublish,omitempty"` // true/false/-
	Age               string `json:"age"`
}

type VolumeSnapshotItem struct {
	Kind        string `json:"kind"` // "VolumeSnapshot"
	Name        string `json:"name"`
	Namespace   string `json:"namespace"`
	ClassName   string `json:"className,omitempty"`
	Ready       string `json:"ready,omitempty"`  // true/false/-
	Source      string `json:"source,omitempty"` // pvc=... or content=...
	RestoreSize string `json:"restoreSize,omitempty"`
	Error       string `json:"error,omitempty"`
	APIVersion  string `json:"apiVersion,omitempty"`
	Age         string `json:"age"`
}

type VolumeSnapshotClassItem struct {
	Kind           string `json:"kind"` // "VolumeSnapshotClass"
	Name           string `json:"name"`
	Driver         string `json:"driver,omitempty"`
	DeletionPolicy string `json:"deletionPolicy,omitempty"`
	IsDefault      bool   `json:"isDefault"`
	Parameters     int    `json:"parameters,omitempty"`
	APIVersion     string `json:"apiVersion,omitempty"`
	Age            string `json:"age"`
}

// -----------------------------
// PVs
// -----------------------------
// GET /api/kube/storage/pvs
func kubePVsListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	lst, err := kubeClient.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list pvs: %v", err)})
		return
	}

	items := make([]PVItem, 0, len(lst.Items))
	for i := range lst.Items {
		pv := &lst.Items[i]

		capacity := ""
		if q, ok := pv.Spec.Capacity[corev1.ResourceStorage]; ok {
			capacity = q.String()
		}

		claim := ""
		if pv.Spec.ClaimRef != nil && pv.Spec.ClaimRef.Namespace != "" && pv.Spec.ClaimRef.Name != "" {
			claim = fmt.Sprintf("%s/%s", pv.Spec.ClaimRef.Namespace, pv.Spec.ClaimRef.Name)
		}

		reclaim := ""
		if pv.Spec.PersistentVolumeReclaimPolicy != "" {
			reclaim = string(pv.Spec.PersistentVolumeReclaimPolicy)
		}

		am := make([]string, 0, len(pv.Spec.AccessModes))
		for _, m := range pv.Spec.AccessModes {
			am = append(am, string(m))
		}

		vm := ""
		if pv.Spec.VolumeMode != nil {
			vm = string(*pv.Spec.VolumeMode)
		}

		driver := ""
		if pv.Spec.CSI != nil && pv.Spec.CSI.Driver != "" {
			driver = pv.Spec.CSI.Driver
		}

		items = append(items, PVItem{
			Kind:         "PV",
			Name:         pv.Name,
			Phase:        string(pv.Status.Phase),
			Capacity:     capacity,
			StorageClass: pv.Spec.StorageClassName,
			Claim:        claim,
			Reclaim:      reclaim,
			AccessModes:  am,
			VolumeMode:   vm,
			Driver:       driver,
			Age:          ageString(pv.CreationTimestamp.Time),
		})
	}

	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })

	c.JSON(http.StatusOK, gin.H{"items": items})
}

// GET /api/kube/storage/pvs/:name
func kubePVDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	pv, err := kubeClient.CoreV1().PersistentVolumes().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "pv not found"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get pv %s: %v", name, err)})
		return
	}

	meta := metaLiteFromObject(pv.GetName(), pv.GetNamespace(), string(pv.UID), pv.ResourceVersion, pv.CreationTimestamp.Time, pv.Labels, pv.Annotations)

	c.JSON(http.StatusOK, gin.H{
		"kind":      "PV",
		"name":      pv.Name,
		"namespace": "",
		"age":       ageString(pv.CreationTimestamp.Time),
		"meta":      meta,
		"spec":      pv.Spec,
		"status":    pv.Status,
	})
}

// -----------------------------
// StorageClasses
// -----------------------------
// GET /api/kube/storage/storageclasses
func kubeStorageClassesListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	lst, err := kubeClient.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list storageclasses: %v", err)})
		return
	}

	items := make([]StorageClassItem, 0, len(lst.Items))
	for i := range lst.Items {
		sc := &lst.Items[i]

		reclaim := ""
		if sc.ReclaimPolicy != nil {
			reclaim = string(*sc.ReclaimPolicy)
		}

		bm := ""
		if sc.VolumeBindingMode != nil {
			bm = string(*sc.VolumeBindingMode)
		}

		allowExp := false
		if sc.AllowVolumeExpansion != nil {
			allowExp = *sc.AllowVolumeExpansion
		}

		params := 0
		if sc.Parameters != nil {
			params = len(sc.Parameters)
		}

		items = append(items, StorageClassItem{
			Kind:              "StorageClass",
			Name:              sc.Name,
			Provisioner:       sc.Provisioner,
			ReclaimPolicy:     reclaim,
			VolumeBindingMode: bm,
			AllowExpansion:    allowExp,
			Parameters:        params,
			Age:               ageString(sc.CreationTimestamp.Time),
		})
	}

	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// GET /api/kube/storage/storageclasses/:name
func kubeStorageClassDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	sc, err := kubeClient.StorageV1().StorageClasses().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "storageclass not found"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get storageclass %s: %v", name, err)})
		return
	}

	meta := metaLiteFromObject(sc.GetName(), sc.GetNamespace(), string(sc.UID), sc.ResourceVersion, sc.CreationTimestamp.Time, sc.Labels, sc.Annotations)

	c.JSON(http.StatusOK, gin.H{
		"kind":      "StorageClass",
		"name":      sc.Name,
		"namespace": "",
		"age":       ageString(sc.CreationTimestamp.Time),
		"meta":      meta,
		"object":    sc, // full object is handy
	})
}

// -----------------------------
// CSIDrivers
// -----------------------------
// GET /api/kube/storage/csidrivers
func kubeCSIDriversListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	lst, err := kubeClient.StorageV1().CSIDrivers().List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list csidrivers: %v", err)})
		return
	}

	items := make([]CSIDriverItem, 0, len(lst.Items))
	for i := range lst.Items {
		d := &lst.Items[i]

		items = append(items, CSIDriverItem{
			Kind:              "CSIDriver",
			Name:              d.Name,
			AttachRequired:    ptrBoolToTri(d.Spec.AttachRequired),
			PodInfoOnMount:    ptrBoolToTri(d.Spec.PodInfoOnMount),
			StorageCapacity:   ptrBoolToTri(d.Spec.StorageCapacity),
			RequiresRepublish: ptrBoolToTri(d.Spec.RequiresRepublish),
			FSGroupPolicy: func() string {
				if d.Spec.FSGroupPolicy == nil {
					return "-"
				}
				return string(*d.Spec.FSGroupPolicy)
			}(),
			Age: ageString(d.CreationTimestamp.Time),
		})
	}

	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// GET /api/kube/storage/csidrivers/:name
func kubeCSIDriverDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	d, err := kubeClient.StorageV1().CSIDrivers().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "csidriver not found"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get csidriver %s: %v", name, err)})
		return
	}

	meta := metaLiteFromObject(d.GetName(), d.GetNamespace(), string(d.UID), d.ResourceVersion, d.CreationTimestamp.Time, d.Labels, d.Annotations)

	c.JSON(http.StatusOK, gin.H{
		"kind":      "CSIDriver",
		"name":      d.Name,
		"namespace": "",
		"age":       ageString(d.CreationTimestamp.Time),
		"meta":      meta,
		"object":    d,
	})
}

func ptrBoolToTri(p *bool) string {
	if p == nil {
		return "-"
	}
	if *p {
		return "true"
	}
	return "false"
}

// -----------------------------
// VolumeSnapshots (dynamic, CRD)
// -----------------------------
// GET /api/kube/storage/snapshots?namespace=<ns|all>
func kubeVolumeSnapshotsListHandler(c *gin.Context) {
	if kubeDynamic == nil {
		// Keep it consistent with your VPA behavior
		c.JSON(http.StatusBadGateway, gin.H{"error": "kube dynamic client not initialized (snapshots require dynamic client)"})
		return
	}

	nsQuery := strings.TrimSpace(c.Query("namespace"))
	ns := metav1.NamespaceAll
	if nsQuery != "" && !strings.EqualFold(nsQuery, "all") {
		ns = nsQuery
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	items, apiVer, err := listVolumeSnapshots(ctx, ns)
	if err != nil {
		// If CRD isn't installed, return empty list + warning instead of failing the page
		if apierrors.IsNotFound(err) || isNoMatchCRDError(err) {
			c.JSON(http.StatusOK, gin.H{
				"items":   []VolumeSnapshotItem{},
				"warning": "VolumeSnapshot CRD not installed (snapshot.storage.k8s.io)",
			})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list snapshots: %v", err)})
		return
	}

	for i := range items {
		items[i].APIVersion = apiVer
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// GET /api/kube/storage/snapshots/:namespace/:name
func kubeVolumeSnapshotDetailHandler(c *gin.Context) {
	if kubeDynamic == nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "kube dynamic client not initialized (snapshots require dynamic client)"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	obj, apiVer, err := getVolumeSnapshot(ctx, ns, name)
	if err != nil {
		if apierrors.IsNotFound(err) || isNoMatchCRDError(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "snapshot not found (or CRD missing)"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get snapshot %s/%s: %v", ns, name, err)})
		return
	}

	meta := metaLiteFromUnstructured(obj)

	ready := "-"
	if b, found, _ := unstructured.NestedBool(obj.Object, "status", "readyToUse"); found {
		if b {
			ready = "true"
		} else {
			ready = "false"
		}
	}

	src := snapshotSourceString(obj)
	className, _, _ := unstructured.NestedString(obj.Object, "spec", "volumeSnapshotClassName")
	restoreSize, _, _ := unstructured.NestedString(obj.Object, "status", "restoreSize")
	errMsg := snapshotErrorString(obj)

	c.JSON(http.StatusOK, gin.H{
		"kind":       "VolumeSnapshot",
		"apiVersion": apiVer,
		"namespace":  ns,
		"name":       name,
		"age":        ageString(obj.GetCreationTimestamp().Time),
		"meta":       meta,
		"summary": gin.H{
			"readyToUse":  ready,
			"className":   className,
			"source":      src,
			"restoreSize": restoreSize,
			"error":       errMsg,
		},
		"object": obj.Object,
	})
}

func listVolumeSnapshots(ctx context.Context, ns string) ([]VolumeSnapshotItem, string, error) {
	gvrs := []schema.GroupVersionResource{
		{Group: "snapshot.storage.k8s.io", Version: "v1", Resource: "volumesnapshots"},
		{Group: "snapshot.storage.k8s.io", Version: "v1beta1", Resource: "volumesnapshots"},
	}

	var lastErr error
	for _, gvr := range gvrs {
		lst, err := kubeDynamic.Resource(gvr).Namespace(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			lastErr = err
			continue
		}

		items := make([]VolumeSnapshotItem, 0, len(lst.Items))
		for i := range lst.Items {
			u := &lst.Items[i]

			ready := "-"
			if b, found, _ := unstructured.NestedBool(u.Object, "status", "readyToUse"); found {
				if b {
					ready = "true"
				} else {
					ready = "false"
				}
			}

			className, _, _ := unstructured.NestedString(u.Object, "spec", "volumeSnapshotClassName")
			restoreSize, _, _ := unstructured.NestedString(u.Object, "status", "restoreSize")

			items = append(items, VolumeSnapshotItem{
				Kind:        "VolumeSnapshot",
				Name:        u.GetName(),
				Namespace:   u.GetNamespace(),
				ClassName:   className,
				Ready:       ready,
				Source:      snapshotSourceString(u),
				RestoreSize: restoreSize,
				Error:       snapshotErrorString(u),
				APIVersion:  fmt.Sprintf("%s/%s", gvr.Group, gvr.Version),
				Age:         ageString(u.GetCreationTimestamp().Time),
			})
		}

		sort.Slice(items, func(i, j int) bool {
			if items[i].Namespace == items[j].Namespace {
				return items[i].Name < items[j].Name
			}
			return items[i].Namespace < items[j].Namespace
		})

		return items, fmt.Sprintf("%s/%s", gvr.Group, gvr.Version), nil
	}

	return nil, "", lastErr
}

func getVolumeSnapshot(ctx context.Context, ns, name string) (*unstructured.Unstructured, string, error) {
	gvrs := []schema.GroupVersionResource{
		{Group: "snapshot.storage.k8s.io", Version: "v1", Resource: "volumesnapshots"},
		{Group: "snapshot.storage.k8s.io", Version: "v1beta1", Resource: "volumesnapshots"},
	}

	var lastErr error
	for _, gvr := range gvrs {
		u, err := kubeDynamic.Resource(gvr).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			lastErr = err
			continue
		}
		return u, fmt.Sprintf("%s/%s", gvr.Group, gvr.Version), nil
	}
	return nil, "", lastErr
}

func snapshotSourceString(u *unstructured.Unstructured) string {
	pvc, _, _ := unstructured.NestedString(u.Object, "spec", "source", "persistentVolumeClaimName")
	if pvc != "" {
		return "pvc=" + pvc
	}
	content, _, _ := unstructured.NestedString(u.Object, "spec", "source", "volumeSnapshotContentName")
	if content != "" {
		return "content=" + content
	}
	return ""
}

func snapshotErrorString(u *unstructured.Unstructured) string {
	// v1: status.error.message
	msg, _, _ := unstructured.NestedString(u.Object, "status", "error", "message")
	if msg != "" {
		return msg
	}
	// sometimes it can be at status.error or status.error.message differs by impl
	msg2, _, _ := unstructured.NestedString(u.Object, "status", "error")
	return msg2
}

// -----------------------------
// VolumeSnapshotClasses (dynamic, CRD)
// -----------------------------
// GET /api/kube/storage/snapshotclasses
func kubeVolumeSnapshotClassesListHandler(c *gin.Context) {
	if kubeDynamic == nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "kube dynamic client not initialized (snapshotclasses require dynamic client)"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	items, apiVer, err := listVolumeSnapshotClasses(ctx)
	if err != nil {
		if apierrors.IsNotFound(err) || isNoMatchCRDError(err) {
			c.JSON(http.StatusOK, gin.H{
				"items":   []VolumeSnapshotClassItem{},
				"warning": "VolumeSnapshotClass CRD not installed (snapshot.storage.k8s.io)",
			})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list snapshotclasses: %v", err)})
		return
	}

	for i := range items {
		items[i].APIVersion = apiVer
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// GET /api/kube/storage/snapshotclasses/:name
func kubeVolumeSnapshotClassDetailHandler(c *gin.Context) {
	if kubeDynamic == nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "kube dynamic client not initialized (snapshotclasses require dynamic client)"})
		return
	}

	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	obj, apiVer, err := getVolumeSnapshotClass(ctx, name)
	if err != nil {
		if apierrors.IsNotFound(err) || isNoMatchCRDError(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "snapshotclass not found (or CRD missing)"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get snapshotclass %s: %v", name, err)})
		return
	}

	meta := metaLiteFromUnstructured(obj)

	driver, _, _ := unstructured.NestedString(obj.Object, "driver")
	dp, _, _ := unstructured.NestedString(obj.Object, "deletionPolicy")
	paramsMap, _, _ := unstructured.NestedMap(obj.Object, "parameters")

	isDefault := false
	if v := obj.GetAnnotations()["snapshot.storage.kubernetes.io/is-default-class"]; strings.EqualFold(v, "true") {
		isDefault = true
	}

	c.JSON(http.StatusOK, gin.H{
		"kind":       "VolumeSnapshotClass",
		"apiVersion": apiVer,
		"name":       name,
		"age":        ageString(obj.GetCreationTimestamp().Time),
		"meta":       meta,
		"summary": gin.H{
			"driver":         driver,
			"deletionPolicy": dp,
			"isDefault":      isDefault,
			"parameters":     len(paramsMap),
		},
		"object": obj.Object,
	})
}

func listVolumeSnapshotClasses(ctx context.Context) ([]VolumeSnapshotClassItem, string, error) {
	gvrs := []schema.GroupVersionResource{
		{Group: "snapshot.storage.k8s.io", Version: "v1", Resource: "volumesnapshotclasses"},
		{Group: "snapshot.storage.k8s.io", Version: "v1beta1", Resource: "volumesnapshotclasses"},
	}

	var lastErr error
	for _, gvr := range gvrs {
		lst, err := kubeDynamic.Resource(gvr).List(ctx, metav1.ListOptions{})
		if err != nil {
			lastErr = err
			continue
		}

		items := make([]VolumeSnapshotClassItem, 0, len(lst.Items))
		for i := range lst.Items {
			u := &lst.Items[i]

			driver, _, _ := unstructured.NestedString(u.Object, "driver")
			dp, _, _ := unstructured.NestedString(u.Object, "deletionPolicy")
			paramsMap, _, _ := unstructured.NestedMap(u.Object, "parameters")

			isDefault := false
			if v := u.GetAnnotations()["snapshot.storage.kubernetes.io/is-default-class"]; strings.EqualFold(v, "true") {
				isDefault = true
			}

			items = append(items, VolumeSnapshotClassItem{
				Kind:           "VolumeSnapshotClass",
				Name:           u.GetName(),
				Driver:         driver,
				DeletionPolicy: dp,
				IsDefault:      isDefault,
				Parameters:     len(paramsMap),
				APIVersion:     fmt.Sprintf("%s/%s", gvr.Group, gvr.Version),
				Age:            ageString(u.GetCreationTimestamp().Time),
			})
		}

		sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
		return items, fmt.Sprintf("%s/%s", gvr.Group, gvr.Version), nil
	}

	return nil, "", lastErr
}

func getVolumeSnapshotClass(ctx context.Context, name string) (*unstructured.Unstructured, string, error) {
	gvrs := []schema.GroupVersionResource{
		{Group: "snapshot.storage.k8s.io", Version: "v1", Resource: "volumesnapshotclasses"},
		{Group: "snapshot.storage.k8s.io", Version: "v1beta1", Resource: "volumesnapshotclasses"},
	}

	var lastErr error
	for _, gvr := range gvrs {
		u, err := kubeDynamic.Resource(gvr).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			lastErr = err
			continue
		}
		return u, fmt.Sprintf("%s/%s", gvr.Group, gvr.Version), nil
	}
	return nil, "", lastErr
}

// Some apiservers return slightly different errors when CRDs are missing.
// We keep this conservative and only treat obvious cases as "CRD missing".
func isNoMatchCRDError(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "the server could not find the requested resource") ||
		strings.Contains(s, "could not find the requested resource") ||
		strings.Contains(s, "no matches for kind") ||
		strings.Contains(s, "not found")
}

// Make sure we reference storagev1 somewhere so goimports doesn't drop it in some setups
var _ = storagev1.StorageClass{}

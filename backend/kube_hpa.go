// kube_autoscaling_handlers.go
package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	autoscalingv1 "k8s.io/api/autoscaling/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	policyv1 "k8s.io/api/policy/v1"
	policyv1beta1 "k8s.io/api/policy/v1beta1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/dynamic"
)

// IMPORTANT:
// You must initialize this in your kube init code (see snippet below).
var kubeDynamic dynamic.Interface

type MetaLite struct {
	Name              string            `json:"name"`
	Namespace         string            `json:"namespace"`
	UID               string            `json:"uid,omitempty"`
	ResourceVersion   string            `json:"resourceVersion,omitempty"`
	CreationTimestamp string            `json:"creationTimestamp,omitempty"`
	Labels            map[string]string `json:"labels,omitempty"`
	Annotations       map[string]string `json:"annotations,omitempty"`
}

type HPAItem struct {
	Kind            string   `json:"kind"` // "HPA"
	Name            string   `json:"name"`
	Namespace       string   `json:"namespace"`
	TargetKind      string   `json:"targetKind,omitempty"`
	TargetName      string   `json:"targetName,omitempty"`
	MinReplicas     *int32   `json:"minReplicas,omitempty"`
	MaxReplicas     int32    `json:"maxReplicas"`
	CurrentReplicas int32    `json:"currentReplicas"`
	DesiredReplicas int32    `json:"desiredReplicas"`
	Metrics         []string `json:"metrics,omitempty"`
	Age             string   `json:"age"`
}

type PDBItem struct {
	Kind               string `json:"kind"` // "PDB"
	Name               string `json:"name"`
	Namespace          string `json:"namespace"`
	MinAvailable       string `json:"minAvailable,omitempty"`
	MaxUnavailable     string `json:"maxUnavailable,omitempty"`
	DisruptionsAllowed int32  `json:"disruptionsAllowed"`
	CurrentHealthy     int32  `json:"currentHealthy"`
	DesiredHealthy     int32  `json:"desiredHealthy"`
	ExpectedPods       int32  `json:"expectedPods"`
	Age                string `json:"age"`
}

type VPAItem struct {
	Kind       string `json:"kind"` // "VPA"
	Name       string `json:"name"`
	Namespace  string `json:"namespace"`
	TargetKind string `json:"targetKind,omitempty"`
	TargetName string `json:"targetName,omitempty"`
	UpdateMode string `json:"updateMode,omitempty"`
	Recs       int    `json:"recommendations,omitempty"`
	Age        string `json:"age"`
	APIVersion string `json:"apiVersion,omitempty"`
}

// -----------------------------
// GET /api/kube/hpas
// Optional: ?namespace=<ns> (if empty or "all", returns all namespaces)
// -----------------------------
func kubeHPAsListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}
	nsQuery := c.Query("namespace")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	// Prefer autoscaling/v2; fallback to v1 if v2 not available on the apiserver.
	if items, ok := listHPAsV2(ctx, nsQuery); ok {
		c.JSON(http.StatusOK, gin.H{"items": items})
		return
	}

	items, err := listHPAsV1(ctx, nsQuery)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list hpas: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{"items": items})
}

func listHPAsV2(ctx context.Context, nsQuery string) ([]HPAItem, bool) {
	var (
		list *autoscalingv2.HorizontalPodAutoscalerList
		err  error
	)

	if nsQuery != "" && nsQuery != "all" {
		list, err = kubeClient.AutoscalingV2().HorizontalPodAutoscalers(nsQuery).List(ctx, metav1.ListOptions{})
	} else {
		list, err = kubeClient.AutoscalingV2().HorizontalPodAutoscalers(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		return nil, false
	}

	items := make([]HPAItem, 0, len(list.Items))
	for i := range list.Items {
		h := &list.Items[i]
		m := make([]string, 0, len(h.Spec.Metrics))
		for _, ms := range h.Spec.Metrics {
			m = append(m, hpaMetricToString(ms))
		}
		items = append(items, HPAItem{
			Kind:            "HPA",
			Name:            h.Name,
			Namespace:       h.Namespace,
			TargetKind:      h.Spec.ScaleTargetRef.Kind,
			TargetName:      h.Spec.ScaleTargetRef.Name,
			MinReplicas:     h.Spec.MinReplicas,
			MaxReplicas:     h.Spec.MaxReplicas,
			CurrentReplicas: h.Status.CurrentReplicas,
			DesiredReplicas: h.Status.DesiredReplicas,
			Metrics:         compactStrings(m),
			Age:             ageString(h.CreationTimestamp.Time),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].Namespace == items[j].Namespace {
			return items[i].Name < items[j].Name
		}
		return items[i].Namespace < items[j].Namespace
	})
	return items, true
}

func listHPAsV1(ctx context.Context, nsQuery string) ([]HPAItem, error) {
	var (
		list *autoscalingv1.HorizontalPodAutoscalerList
		err  error
	)

	if nsQuery != "" && nsQuery != "all" {
		list, err = kubeClient.AutoscalingV1().HorizontalPodAutoscalers(nsQuery).List(ctx, metav1.ListOptions{})
	} else {
		list, err = kubeClient.AutoscalingV1().HorizontalPodAutoscalers(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		return nil, err
	}

	items := make([]HPAItem, 0, len(list.Items))
	for i := range list.Items {
		h := &list.Items[i]
		var metrics []string
		if h.Spec.TargetCPUUtilizationPercentage != nil {
			metrics = []string{fmt.Sprintf("cpu=%d%%", *h.Spec.TargetCPUUtilizationPercentage)}
		}
		items = append(items, HPAItem{
			Kind:            "HPA",
			Name:            h.Name,
			Namespace:       h.Namespace,
			TargetKind:      h.Spec.ScaleTargetRef.Kind,
			TargetName:      h.Spec.ScaleTargetRef.Name,
			MinReplicas:     h.Spec.MinReplicas,
			MaxReplicas:     h.Spec.MaxReplicas,
			CurrentReplicas: h.Status.CurrentReplicas,
			DesiredReplicas: h.Status.DesiredReplicas,
			Metrics:         metrics,
			Age:             ageString(h.CreationTimestamp.Time),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].Namespace == items[j].Namespace {
			return items[i].Name < items[j].Name
		}
		return items[i].Namespace < items[j].Namespace
	})
	return items, nil
}

// GET /api/kube/hpas/:namespace/:name
func kubeHPADetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	// Try v2, fallback to v1
	h2, err2 := kubeClient.AutoscalingV2().HorizontalPodAutoscalers(ns).Get(ctx, name, metav1.GetOptions{})
	if err2 == nil && h2 != nil {
		meta := metaLiteFromObject(h2.GetName(), h2.GetNamespace(), string(h2.UID), h2.ResourceVersion, h2.CreationTimestamp.Time, h2.Labels, h2.Annotations)
		c.JSON(http.StatusOK, gin.H{
			"kind":       "HPA",
			"apiVersion": "autoscaling/v2",
			"namespace":  ns,
			"name":       name,
			"age":        ageString(h2.CreationTimestamp.Time),
			"meta":       meta,
			"spec":       h2.Spec,
			"status":     h2.Status,
		})
		return
	}

	h1, err := kubeClient.AutoscalingV1().HorizontalPodAutoscalers(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get hpa %s/%s: %v", ns, name, err)})
		return
	}
	meta := metaLiteFromObject(h1.GetName(), h1.GetNamespace(), string(h1.UID), h1.ResourceVersion, h1.CreationTimestamp.Time, h1.Labels, h1.Annotations)
	c.JSON(http.StatusOK, gin.H{
		"kind":       "HPA",
		"apiVersion": "autoscaling/v1",
		"namespace":  ns,
		"name":       name,
		"age":        ageString(h1.CreationTimestamp.Time),
		"meta":       meta,
		"spec":       h1.Spec,
		"status":     h1.Status,
	})
}

// -----------------------------
// GET /api/kube/pdbs
// Optional: ?namespace=<ns> (if empty or "all", returns all namespaces)
// -----------------------------
func kubePDBsListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}
	nsQuery := c.Query("namespace")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	// Prefer policy/v1, fallback to v1beta1
	items, ok := listPDBsV1(ctx, nsQuery)
	if ok {
		c.JSON(http.StatusOK, gin.H{"items": items})
		return
	}

	items2, err := listPDBsV1beta1(ctx, nsQuery)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list pdbs: %v", err)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items2})
}

func listPDBsV1(ctx context.Context, nsQuery string) ([]PDBItem, bool) {
	var (
		list *policyv1.PodDisruptionBudgetList
		err  error
	)
	if nsQuery != "" && nsQuery != "all" {
		list, err = kubeClient.PolicyV1().PodDisruptionBudgets(nsQuery).List(ctx, metav1.ListOptions{})
	} else {
		list, err = kubeClient.PolicyV1().PodDisruptionBudgets(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		return nil, false
	}

	items := make([]PDBItem, 0, len(list.Items))
	for i := range list.Items {
		p := &list.Items[i]
		items = append(items, PDBItem{
			Kind:               "PDB",
			Name:               p.Name,
			Namespace:          p.Namespace,
			MinAvailable:       intOrStringPtrToString(p.Spec.MinAvailable),
			MaxUnavailable:     intOrStringPtrToString(p.Spec.MaxUnavailable),
			DisruptionsAllowed: p.Status.DisruptionsAllowed,
			CurrentHealthy:     p.Status.CurrentHealthy,
			DesiredHealthy:     p.Status.DesiredHealthy,
			ExpectedPods:       p.Status.ExpectedPods,
			Age:                ageString(p.CreationTimestamp.Time),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].Namespace == items[j].Namespace {
			return items[i].Name < items[j].Name
		}
		return items[i].Namespace < items[j].Namespace
	})
	return items, true
}

func listPDBsV1beta1(ctx context.Context, nsQuery string) ([]PDBItem, error) {
	var (
		list *policyv1beta1.PodDisruptionBudgetList
		err  error
	)
	if nsQuery != "" && nsQuery != "all" {
		list, err = kubeClient.PolicyV1beta1().PodDisruptionBudgets(nsQuery).List(ctx, metav1.ListOptions{})
	} else {
		list, err = kubeClient.PolicyV1beta1().PodDisruptionBudgets(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		return nil, err
	}

	items := make([]PDBItem, 0, len(list.Items))
	for i := range list.Items {
		p := &list.Items[i]
		items = append(items, PDBItem{
			Kind:               "PDB",
			Name:               p.Name,
			Namespace:          p.Namespace,
			MinAvailable:       intOrStringPtrToString(p.Spec.MinAvailable),
			MaxUnavailable:     intOrStringPtrToString(p.Spec.MaxUnavailable),
			DisruptionsAllowed: p.Status.DisruptionsAllowed,
			CurrentHealthy:     p.Status.CurrentHealthy,
			DesiredHealthy:     p.Status.DesiredHealthy,
			ExpectedPods:       p.Status.ExpectedPods,
			Age:                ageString(p.CreationTimestamp.Time),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].Namespace == items[j].Namespace {
			return items[i].Name < items[j].Name
		}
		return items[i].Namespace < items[j].Namespace
	})
	return items, nil
}

// GET /api/kube/pdbs/:namespace/:name
func kubePDBDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	// Prefer v1
	p1, err1 := kubeClient.PolicyV1().PodDisruptionBudgets(ns).Get(ctx, name, metav1.GetOptions{})
	if err1 == nil && p1 != nil {
		meta := metaLiteFromObject(p1.GetName(), p1.GetNamespace(), string(p1.UID), p1.ResourceVersion, p1.CreationTimestamp.Time, p1.Labels, p1.Annotations)
		c.JSON(http.StatusOK, gin.H{
			"kind":       "PDB",
			"apiVersion": "policy/v1",
			"namespace":  ns,
			"name":       name,
			"age":        ageString(p1.CreationTimestamp.Time),
			"meta":       meta,
			"spec":       p1.Spec,
			"status":     p1.Status,
		})
		return
	}

	// fallback v1beta1
	p2, err := kubeClient.PolicyV1beta1().PodDisruptionBudgets(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get pdb %s/%s: %v", ns, name, err)})
		return
	}
	meta := metaLiteFromObject(p2.GetName(), p2.GetNamespace(), string(p2.UID), p2.ResourceVersion, p2.CreationTimestamp.Time, p2.Labels, p2.Annotations)
	c.JSON(http.StatusOK, gin.H{
		"kind":       "PDB",
		"apiVersion": "policy/v1beta1",
		"namespace":  ns,
		"name":       name,
		"age":        ageString(p2.CreationTimestamp.Time),
		"meta":       meta,
		"spec":       p2.Spec,
		"status":     p2.Status,
	})
}

// -----------------------------
// GET /api/kube/vpas
// Optional: ?namespace=<ns> (if empty or "all", returns all namespaces)
// (VPA is a CRD; if not installed you’ll get an error.)
// -----------------------------
func kubeVPAsListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}
	if kubeDynamic == nil {
		vpaUnavailableOK(c, "VPA unavailable: kube dynamic client not initialized (dynamic.NewForConfig missing)")
		return
	}

	nsQuery := c.Query("namespace")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	items, apiVer, err := listVPAs(ctx, nsQuery)
	if err != nil {
		// Treat VPA as optional: no toasts / no 502 for expected cases
		switch {
		case apierrors.IsNotFound(err):
			vpaUnavailableOK(c, "VPA not installed: verticalpodautoscalers.autoscaling.k8s.io CRD missing")
			return
		case apierrors.IsForbidden(err):
			vpaUnavailableOK(c, "VPA forbidden: dashboard ServiceAccount lacks RBAC for autoscaling.k8s.io/verticalpodautoscalers")
			return
		case apierrors.IsUnauthorized(err):
			vpaUnavailableOK(c, "VPA unauthorized: dashboard ServiceAccount cannot access VPA resources")
			return
		default:
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list vpas: %v", err)})
			return
		}
	}

	for i := range items {
		items[i].APIVersion = apiVer
	}

	c.JSON(http.StatusOK, gin.H{"items": items})
}

func vpaUnavailableOK(c *gin.Context, warning string) {
	c.JSON(http.StatusOK, gin.H{
		"items":   []VPAItem{},
		"warning": warning,
	})
}

func kubeVPADetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}
	if kubeDynamic == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "VPA unavailable: kube dynamic client not initialized"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	obj, apiVer, err := getVPA(ctx, ns, name)
	if err != nil {
		// make this readable
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("vpa %s/%s not found (or CRD missing): %v", ns, name, err)})
			return
		}
		if apierrors.IsForbidden(err) {
			c.JSON(http.StatusForbidden, gin.H{"error": fmt.Sprintf("vpa %s/%s forbidden: %v", ns, name, err)})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get vpa %s/%s: %v", ns, name, err)})
		return
	}

	meta := metaLiteFromUnstructured(obj)
	tk, tn := vpaTarget(obj)
	mode := vpaUpdateMode(obj)
	recs := vpaRecCount(obj)

	c.JSON(http.StatusOK, gin.H{
		"kind":       "VPA",
		"apiVersion": apiVer,
		"namespace":  ns,
		"name":       name,
		"age":        ageString(obj.GetCreationTimestamp().Time),
		"meta":       meta,
		"summary": gin.H{
			"targetKind":      tk,
			"targetName":      tn,
			"updateMode":      mode,
			"recommendations": recs,
		},
		"object": obj.Object,
	})
}

// -----------------------------
// Helpers
// -----------------------------
// func ageString(t time.Time) string {
// 	if t.IsZero() {
// 		return "-"
// 	}
// 	d := time.Since(t)
// 	if d < time.Minute {
// 		return "just now"
// 	}
// 	if d < time.Hour {
// 		return fmt.Sprintf("%dm", int(d.Minutes()))
// 	}
// 	if d < 24*time.Hour {
// 		return fmt.Sprintf("%dh", int(d.Hours()))
// 	}
// 	if d < 7*24*time.Hour {
// 		return fmt.Sprintf("%dd", int(d.Hours()/24))
// 	}
// 	return t.Format("2006-01-02")
// }

func metaLiteFromObject(name, ns, uid, rv string, created time.Time, labels, ann map[string]string) MetaLite {
	ts := ""
	if !created.IsZero() {
		ts = created.Format(time.RFC3339)
	}
	return MetaLite{
		Name:              name,
		Namespace:         ns,
		UID:               uid,
		ResourceVersion:   rv,
		CreationTimestamp: ts,
		Labels:            labels,
		Annotations:       ann,
	}
}

func metaLiteFromUnstructured(u *unstructured.Unstructured) MetaLite {
	created := u.GetCreationTimestamp().Time
	ts := ""
	if !created.IsZero() {
		ts = created.Format(time.RFC3339)
	}
	return MetaLite{
		Name:              u.GetName(),
		Namespace:         u.GetNamespace(),
		UID:               string(u.GetUID()),
		ResourceVersion:   u.GetResourceVersion(),
		CreationTimestamp: ts,
		Labels:            u.GetLabels(),
		Annotations:       u.GetAnnotations(),
	}
}

func intOrStringPtrToString(p *intstr.IntOrString) string {
	if p == nil {
		return ""
	}
	if p.Type == intstr.Int {
		return fmt.Sprintf("%d", p.IntVal)
	}
	return p.StrVal
}

func compactStrings(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func qtyToString(q resource.Quantity) string {
	if q.IsZero() {
		return ""
	}
	return q.String()
}

func hpaMetricToString(m autoscalingv2.MetricSpec) string {
	switch m.Type {
	case autoscalingv2.ResourceMetricSourceType:
		if m.Resource == nil {
			return "resource"
		}
		t := m.Resource.Target
		if t.AverageUtilization != nil {
			return fmt.Sprintf("res:%s=%d%%", m.Resource.Name, *t.AverageUtilization)
		}
		if t.AverageValue != nil {
			return fmt.Sprintf("res:%s~%s", m.Resource.Name, qtyToString(*t.AverageValue))
		}
		if t.Value != nil {
			return fmt.Sprintf("res:%s=%s", m.Resource.Name, qtyToString(*t.Value))
		}
		return fmt.Sprintf("res:%s", m.Resource.Name)

	case autoscalingv2.PodsMetricSourceType:
		if m.Pods == nil {
			return "pods"
		}
		t := m.Pods.Target
		if t.AverageValue != nil {
			return fmt.Sprintf("pods:%s~%s", m.Pods.Metric.Name, qtyToString(*t.AverageValue))
		}
		if t.Value != nil {
			return fmt.Sprintf("pods:%s=%s", m.Pods.Metric.Name, qtyToString(*t.Value))
		}
		return fmt.Sprintf("pods:%s", m.Pods.Metric.Name)

	case autoscalingv2.ObjectMetricSourceType:
		if m.Object == nil {
			return "object"
		}
		t := m.Object.Target
		ref := fmt.Sprintf("%s/%s", m.Object.DescribedObject.Kind, m.Object.DescribedObject.Name)
		if t.Value != nil {
			return fmt.Sprintf("obj:%s:%s=%s", m.Object.Metric.Name, ref, qtyToString(*t.Value))
		}
		if t.AverageValue != nil {
			return fmt.Sprintf("obj:%s:%s~%s", m.Object.Metric.Name, ref, qtyToString(*t.AverageValue))
		}
		return fmt.Sprintf("obj:%s:%s", m.Object.Metric.Name, ref)

	case autoscalingv2.ExternalMetricSourceType:
		if m.External == nil {
			return "external"
		}
		t := m.External.Target
		if t.Value != nil {
			return fmt.Sprintf("ext:%s=%s", m.External.Metric.Name, qtyToString(*t.Value))
		}
		if t.AverageValue != nil {
			return fmt.Sprintf("ext:%s~%s", m.External.Metric.Name, qtyToString(*t.AverageValue))
		}
		return fmt.Sprintf("ext:%s", m.External.Metric.Name)

	case autoscalingv2.ContainerResourceMetricSourceType:
		if m.ContainerResource == nil {
			return "containerResource"
		}
		t := m.ContainerResource.Target
		if t.AverageUtilization != nil {
			return fmt.Sprintf("ctr:%s:%s=%d%%", m.ContainerResource.Container, m.ContainerResource.Name, *t.AverageUtilization)
		}
		if t.AverageValue != nil {
			return fmt.Sprintf("ctr:%s:%s~%s", m.ContainerResource.Container, m.ContainerResource.Name, qtyToString(*t.AverageValue))
		}
		if t.Value != nil {
			return fmt.Sprintf("ctr:%s:%s=%s", m.ContainerResource.Container, m.ContainerResource.Name, qtyToString(*t.Value))
		}
		return fmt.Sprintf("ctr:%s:%s", m.ContainerResource.Container, m.ContainerResource.Name)
	}
	return string(m.Type)
}

// VPA dynamic access helpers.
// Try autoscaling.k8s.io/v1 first, then v1beta2.
func listVPAs(ctx context.Context, nsQuery string) ([]VPAItem, string, error) {
	gvrs := []schema.GroupVersionResource{
		{Group: "autoscaling.k8s.io", Version: "v1", Resource: "verticalpodautoscalers"},
		{Group: "autoscaling.k8s.io", Version: "v1beta2", Resource: "verticalpodautoscalers"},
		{Group: "autoscaling.k8s.io", Version: "v1beta1", Resource: "verticalpodautoscalers"},
	}

	ns := metav1.NamespaceAll
	if nsQuery != "" && nsQuery != "all" {
		ns = nsQuery
	}

	var lastErr error
	for _, gvr := range gvrs {
		lst, err := kubeDynamic.Resource(gvr).Namespace(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			// If it’s a permission/auth problem, stop immediately (don’t try other versions)
			if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {
				return nil, "", err
			}
			lastErr = err
			continue
		}

		items := make([]VPAItem, 0, len(lst.Items))
		for i := range lst.Items {
			u := &lst.Items[i]
			tk, tn := vpaTarget(u)
			mode := vpaUpdateMode(u)
			recs := vpaRecCount(u)

			items = append(items, VPAItem{
				Kind:       "VPA",
				Name:       u.GetName(),
				Namespace:  u.GetNamespace(),
				TargetKind: tk,
				TargetName: tn,
				UpdateMode: mode,
				Recs:       recs,
				Age:        ageString(u.GetCreationTimestamp().Time),
				APIVersion: fmt.Sprintf("%s/%s", gvr.Group, gvr.Version),
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

func getVPA(ctx context.Context, ns, name string) (*unstructured.Unstructured, string, error) {
	gvrs := []schema.GroupVersionResource{
		{Group: "autoscaling.k8s.io", Version: "v1", Resource: "verticalpodautoscalers"},
		{Group: "autoscaling.k8s.io", Version: "v1beta2", Resource: "verticalpodautoscalers"},
		{Group: "autoscaling.k8s.io", Version: "v1beta1", Resource: "verticalpodautoscalers"},
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

func vpaTarget(u *unstructured.Unstructured) (string, string) {
	m, found, _ := unstructured.NestedMap(u.Object, "spec", "targetRef")
	if !found {
		return "", ""
	}
	tk, _ := m["kind"].(string)
	tn, _ := m["name"].(string)
	return tk, tn
}

func vpaUpdateMode(u *unstructured.Unstructured) string {
	s, _, _ := unstructured.NestedString(u.Object, "spec", "updatePolicy", "updateMode")
	return s
}

func vpaRecCount(u *unstructured.Unstructured) int {
	sl, found, _ := unstructured.NestedSlice(u.Object, "status", "recommendation", "containerRecommendations")
	if !found {
		return 0
	}
	return len(sl)
}

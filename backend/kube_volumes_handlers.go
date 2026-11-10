// kube_volumes_handlers.go
package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// VolumeItem represents a PVC + some PV/pod info for the frontend.
type VolumeItem struct {
	Name         string   `json:"name"`
	Namespace    string   `json:"namespace"`
	Status       string   `json:"status"`
	StorageClass string   `json:"storageClass,omitempty"`
	Capacity     string   `json:"capacity,omitempty"`
	AccessModes  []string `json:"accessModes,omitempty"`
	VolumeName   string   `json:"volumeName,omitempty"`
	VolumeMode   string   `json:"volumeMode,omitempty"`
	Age          string   `json:"age"`

	Bound  bool `json:"bound"`
	Orphan bool `json:"orphan"` // Bound but currently used by 0 pods

	PodNames  []string `json:"podNames,omitempty"`
	NodeNames []string `json:"nodeNames,omitempty"`

	PVPhase         string `json:"pvPhase,omitempty"`
	PVReclaimPolicy string `json:"pvReclaimPolicy,omitempty"`

	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

// GET /api/volumes
// Optional: ?namespace=<ns> (if empty or "all", returns all namespaces)
func volumesListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	nsQuery := c.Query("namespace") // "", "all", or specific ns

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	// List PVCs
	var (
		pvcList *corev1.PersistentVolumeClaimList
		err     error
	)

	if nsQuery != "" && nsQuery != "all" {
		pvcList, err = kubeClient.CoreV1().
			PersistentVolumeClaims(nsQuery).
			List(ctx, metav1.ListOptions{})
	} else {
		pvcList, err = kubeClient.CoreV1().
			PersistentVolumeClaims("").
			List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list pvc: %v", err)})
		return
	}

	// Group PVCs by namespace
	pvcsByNS := map[string][]*corev1.PersistentVolumeClaim{}
	for i := range pvcList.Items {
		pvc := &pvcList.Items[i]
		ns := pvc.Namespace
		pvcsByNS[ns] = append(pvcsByNS[ns], pvc)
	}

	// For each namespace that has PVCs, list Pods once (to see who uses which PVC)
	podsByNS := map[string]*corev1.PodList{}
	for ns := range pvcsByNS {
		pods, err := kubeClient.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			fmt.Printf("warn: list pods for volumes in ns=%s: %v\n", ns, err)
			continue
		}
		podsByNS[ns] = pods
	}

	// List PVs once, cluster-wide
	pvList, err := kubeClient.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
	if err != nil {
		fmt.Printf("warn: list persistentvolumes: %v\n", err)
	}
	pvByName := map[string]*corev1.PersistentVolume{}
	if pvList != nil {
		for i := range pvList.Items {
			pv := &pvList.Items[i]
			pvByName[pv.Name] = pv
		}
	}

	// Build VolumeItem list
	items := make([]VolumeItem, 0, len(pvcList.Items))
	for i := range pvcList.Items {
		pvc := &pvcList.Items[i]
		ns := pvc.Namespace
		var pods *corev1.PodList
		if p, ok := podsByNS[ns]; ok {
			pods = p
		}
		var pv *corev1.PersistentVolume
		if pvc.Spec.VolumeName != "" {
			pv = pvByName[pvc.Spec.VolumeName]
		}
		items = append(items, makeVolumeItem(pvc, pods, pv))
	}

	// Sort: namespace, then name
	sort.Slice(items, func(i, j int) bool {
		if items[i].Namespace == items[j].Namespace {
			return items[i].Name < items[j].Name
		}
		return items[i].Namespace < items[j].Namespace
	})

	c.JSON(http.StatusOK, gin.H{
		"items": items,
	})
}

func makeVolumeItem(
	pvc *corev1.PersistentVolumeClaim,
	pods *corev1.PodList,
	pv *corev1.PersistentVolume,
) VolumeItem {
	ns := pvc.Namespace

	status := string(pvc.Status.Phase)
	bound := pvc.Status.Phase == corev1.ClaimBound

	// Capacity
	capacity := ""
	if qty, ok := pvc.Status.Capacity[corev1.ResourceStorage]; ok {
		capacity = qty.String()
	}

	// StorageClass
	storageClass := ""
	if pvc.Spec.StorageClassName != nil {
		storageClass = *pvc.Spec.StorageClassName
	}

	// Access modes
	accessModes := make([]string, 0, len(pvc.Spec.AccessModes))
	for _, am := range pvc.Spec.AccessModes {
		accessModes = append(accessModes, string(am))
	}

	// VolumeMode
	volumeMode := ""
	if pvc.Spec.VolumeMode != nil {
		volumeMode = string(*pvc.Spec.VolumeMode)
	}

	// Pods using this PVC
	podNames, nodeNames := podsUsingPVC(pods, pvc.Name)

	// Orphan: bound but no pods currently referencing it
	orphan := bound && len(podNames) == 0

	// PV details
	pvPhase := ""
	pvReclaim := ""
	if pv != nil {
		pvPhase = string(pv.Status.Phase)
		pvReclaim = string(pv.Spec.PersistentVolumeReclaimPolicy)
	}

	return VolumeItem{
		Name:         pvc.Name,
		Namespace:    ns,
		Status:       status,
		StorageClass: storageClass,
		Capacity:     capacity,
		AccessModes:  accessModes,
		VolumeName:   pvc.Spec.VolumeName,
		VolumeMode:   volumeMode,
		Age:          volumeAgeString(pvc.CreationTimestamp.Time),

		Bound:  bound,
		Orphan: orphan,

		PodNames:  podNames,
		NodeNames: nodeNames,

		PVPhase:         pvPhase,
		PVReclaimPolicy: pvReclaim,

		Labels:      pvc.Labels,
		Annotations: pvc.Annotations,
	}
}

func podsUsingPVC(pods *corev1.PodList, claimName string) ([]string, []string) {
	if pods == nil || claimName == "" {
		return nil, nil
	}
	var podNames []string
	nodeSet := make(map[string]bool)

	for i := range pods.Items {
		p := &pods.Items[i]
		uses := false
		for _, v := range p.Spec.Volumes {
			if v.PersistentVolumeClaim != nil && v.PersistentVolumeClaim.ClaimName == claimName {
				uses = true
				break
			}
		}
		if uses {
			podNames = append(podNames, p.Name)
			if p.Spec.NodeName != "" {
				nodeSet[p.Spec.NodeName] = true
			}
		}
	}

	nodeNames := make([]string, 0, len(nodeSet))
	for n := range nodeSet {
		nodeNames = append(nodeNames, n)
	}
	sort.Strings(nodeNames)

	return podNames, nodeNames
}

func volumeAgeString(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	d := time.Since(t)
	if d < time.Minute {
		return "just now"
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	if d < 7*24*time.Hour {
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
	return t.Format("2006-01-02")
}

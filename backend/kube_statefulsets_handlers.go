// kube_statefulsets_handlers.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	appsv1 "k8s.io/api/apps/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
)

type StatefulSetSummary struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Status    string `json:"status"`
	Notice    string `json:"notice,omitempty"` // short extra info (e.g. updating)
	Desired   int32  `json:"desired"`
	Current   int32  `json:"current"`
	Ready     int32  `json:"ready"`
	Updated   int32  `json:"updated"`
	Service   string `json:"service,omitempty"`
	Age       string `json:"age"`
}

type StatefulSetContainerDetail struct {
	Name  string `json:"name"`
	Image string `json:"image"`
}

type StatefulSetDetail struct {
	Name         string                       `json:"name"`
	Namespace    string                       `json:"namespace"`
	Status       string                       `json:"status"`
	Notice       string                       `json:"notice,omitempty"`
	Desired      int32                        `json:"desired"`
	Current      int32                        `json:"current"`
	Ready        int32                        `json:"ready"`
	Updated      int32                        `json:"updated"`
	Service      string                       `json:"service,omitempty"`
	Selector     map[string]string            `json:"selector,omitempty"`
	Labels       map[string]string            `json:"labels,omitempty"`
	Annotations  map[string]string            `json:"annotations,omitempty"`
	Age          string                       `json:"age"`
	Strategy     string                       `json:"strategy,omitempty"`
	Policy       string                       `json:"podManagementPolicy,omitempty"`
	Containers   []StatefulSetContainerDetail `json:"containers,omitempty"`
	VolumeClaims []string                     `json:"volumeClaims,omitempty"`
	Spec         appsv1.StatefulSetSpec       `json:"spec"`
	StatusObj    appsv1.StatefulSetStatus     `json:"statusObj"`
}

func stsDesired(s *appsv1.StatefulSet) int32 {
	if s == nil || s.Spec.Replicas == nil {
		return 1
	}
	return *s.Spec.Replicas
}

func stsStatus(s *appsv1.StatefulSet) (status string, notice string) {
	if s == nil {
		return "Unknown", ""
	}

	desired := stsDesired(s)
	ready := s.Status.ReadyReplicas
	updated := s.Status.UpdatedReplicas
	current := s.Status.CurrentReplicas

	// Simple readable status
	if desired == 0 && current == 0 {
		return "ScaledDown", ""
	}
	if ready == desired && updated == desired {
		return "Ready", ""
	}
	if s.Status.UpdateRevision != "" && s.Status.CurrentRevision != "" && s.Status.UpdateRevision != s.Status.CurrentRevision {
		return "Updating", fmt.Sprintf("rev %s → %s", s.Status.CurrentRevision, s.Status.UpdateRevision)
	}
	if ready < desired {
		return "NotReady", fmt.Sprintf("ready %d/%d", ready, desired)
	}
	return "Progressing", fmt.Sprintf("updated %d/%d", updated, desired)
}

func buildStatefulSetSummary(s *appsv1.StatefulSet, now time.Time) StatefulSetSummary {
	st, note := stsStatus(s)
	desired := stsDesired(s)

	return StatefulSetSummary{
		Name:      s.Name,
		Namespace: s.Namespace,
		Status:    st,
		Notice:    note,
		Desired:   desired,
		Current:   s.Status.CurrentReplicas,
		Ready:     s.Status.ReadyReplicas,
		Updated:   s.Status.UpdatedReplicas,
		Service:   s.Spec.ServiceName,
		Age:       humanAge(s.CreationTimestamp.Time, now),
	}
}

// GET /api/statefulsets
// Optional: ?namespace=<ns>&search=<q>
func statefulSetsHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	rawNamespace := strings.TrimSpace(c.Query("namespace"))
	nsFilter := rawNamespace
	if nsFilter == "" || strings.EqualFold(nsFilter, "all") {
		nsFilter = ""
	}
	search := strings.ToLower(strings.TrimSpace(c.Query("search")))

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	list, err := kubeClient.AppsV1().StatefulSets(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("list statefulsets: %v", err)})
		return
	}

	now := time.Now()
	nsSet := make(map[string]struct{})
	out := make([]StatefulSetSummary, 0, len(list.Items))

	for i := range list.Items {
		s := &list.Items[i]
		nsSet[s.Namespace] = struct{}{}

		if nsFilter != "" && s.Namespace != nsFilter {
			continue
		}

		if search != "" {
			text := strings.ToLower(s.Namespace + "/" + s.Name + " " + s.Spec.ServiceName)
			if !strings.Contains(text, search) {
				continue
			}
		}

		out = append(out, buildStatefulSetSummary(s, now))
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Namespace == out[j].Namespace {
			return out[i].Name < out[j].Name
		}
		return out[i].Namespace < out[j].Namespace
	})

	namespaces := make([]string, 0, len(nsSet))
	for ns := range nsSet {
		namespaces = append(namespaces, ns)
	}
	sort.Strings(namespaces)

	c.JSON(http.StatusOK, gin.H{
		"items":      out,
		"count":      len(out),
		"namespaces": namespaces,
	})
}

// GET /api/statefulsets/:namespace/:name
func statefulSetDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	s, err := kubeClient.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "statefulset not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("get statefulset: %v", err)})
		return
	}

	now := time.Now()
	st, note := stsStatus(s)
	desired := stsDesired(s)

	selector := map[string]string{}
	if s.Spec.Selector != nil && len(s.Spec.Selector.MatchLabels) > 0 {
		for k, v := range s.Spec.Selector.MatchLabels {
			selector[k] = v
		}
	}

	containers := make([]StatefulSetContainerDetail, 0, len(s.Spec.Template.Spec.Containers))
	for _, ct := range s.Spec.Template.Spec.Containers {
		containers = append(containers, StatefulSetContainerDetail{
			Name:  ct.Name,
			Image: ct.Image,
		})
	}

	claims := make([]string, 0, len(s.Spec.VolumeClaimTemplates))
	for _, pvc := range s.Spec.VolumeClaimTemplates {
		if pvc.Name != "" {
			claims = append(claims, pvc.Name)
		}
	}
	sort.Strings(claims)

	strategy := ""
	if s.Spec.UpdateStrategy.Type != "" {
		strategy = string(s.Spec.UpdateStrategy.Type)
	}

	c.JSON(http.StatusOK, StatefulSetDetail{
		Name:         s.Name,
		Namespace:    s.Namespace,
		Status:       st,
		Notice:       note,
		Desired:      desired,
		Current:      s.Status.CurrentReplicas,
		Ready:        s.Status.ReadyReplicas,
		Updated:      s.Status.UpdatedReplicas,
		Service:      s.Spec.ServiceName,
		Selector:     selector,
		Labels:       s.Labels,
		Annotations:  s.Annotations,
		Age:          humanAge(s.CreationTimestamp.Time, now),
		Strategy:     strategy,
		Policy:       string(s.Spec.PodManagementPolicy),
		Containers:   containers,
		VolumeClaims: claims,
		Spec:         s.Spec,
		StatusObj:    s.Status,
	})
}


// SSE: GET /api/statefulsets/stream
// Optional: ?namespace=<ns> (or all)
// Emits:
//
//	event: upsert   data: StatefulSetSummary JSON
//	event: delete   data: {"namespace":"...", "name":"..."}
func statefulSetsStreamHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	ctx := c.Request.Context()

	w := c.Writer
	flusher, ok := w.(http.Flusher)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "streaming not supported"})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ns := strings.TrimSpace(c.Query("namespace"))
	if ns == "" || strings.EqualFold(ns, "all") {
		ns = ""
	}

	watcher, err := kubeClient.AppsV1().StatefulSets(ns).Watch(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("watch statefulsets: %v", err)})
		return
	}
	defer watcher.Stop()

	flusher.Flush()

	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-watcher.ResultChan():
			if !ok {
				return
			}
			obj, ok := ev.Object.(*appsv1.StatefulSet)
			if !ok || obj == nil {
				continue
			}

			switch ev.Type {
			case watch.Added, watch.Modified:
				now := time.Now()
				info := buildStatefulSetSummary(obj, now)
				payload, err := json.Marshal(info)
				if err != nil {
					continue
				}
				fmt.Fprintf(w, "event: upsert\n")
				fmt.Fprintf(w, "data: %s\n\n", payload)
				flusher.Flush()

			case watch.Deleted:
				payload, err := json.Marshal(map[string]string{
					"namespace": obj.Namespace,
					"name":      obj.Name,
				})
				if err != nil {
					continue
				}
				fmt.Fprintf(w, "event: delete\n")
				fmt.Fprintf(w, "data: %s\n\n", payload)
				flusher.Flush()
			}
		}
	}
}

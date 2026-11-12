package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
)

type PodSummary struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Phase     string `json:"phase"`
	Status    string `json:"status"`
	Ready     string `json:"ready"`
	Restarts  int32  `json:"restarts"`
	NodeName  string `json:"nodeName"`
	Age       string `json:"age"`
}

type PodContainerDetail struct {
	Name         string `json:"name"`
	Image        string `json:"image"`
	Ready        bool   `json:"ready"`
	RestartCount int32  `json:"restartCount"`
	State        string `json:"state"`
}

type PodDetail struct {
	Name        string               `json:"name"`
	Namespace   string               `json:"namespace"`
	Phase       string               `json:"phase"`
	Status      string               `json:"status"`
	NodeName    string               `json:"nodeName"`
	PodIP       string               `json:"podIP"`
	HostIP      string               `json:"hostIP"`
	Age         string               `json:"age"`
	Restarts    int32                `json:"restarts"`
	Labels      map[string]string    `json:"labels,omitempty"`
	Annotations map[string]string    `json:"annotations,omitempty"`
	Containers  []PodContainerDetail `json:"containers"`

	// New: why-not-ready diagnostics (includes events/conditions/container states)
	Diagnostics PodWhyNotReady `json:"diagnostics,omitempty"`
}

func podStatus(p *corev1.Pod) string {
	if p == nil {
		return "Unknown"
	}
	// Prefer container-level reasons (e.g. CrashLoopBackOff, ImagePullBackOff)
	for _, cs := range p.Status.ContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			return cs.State.Waiting.Reason
		}
		if cs.State.Terminated != nil && cs.State.Terminated.Reason != "" {
			return cs.State.Terminated.Reason
		}
	}
	phase := string(p.Status.Phase)
	if phase == "" {
		return "Unknown"
	}
	return phase
}

func podReadyString(p *corev1.Pod) string {
	if p == nil {
		return "0/0"
	}
	total := len(p.Status.ContainerStatuses)
	if total == 0 {
		return "0/0"
	}
	ready := 0
	for _, cs := range p.Status.ContainerStatuses {
		if cs.Ready {
			ready++
		}
	}
	return fmt.Sprintf("%d/%d", ready, total)
}

func podRestartCount(p *corev1.Pod) int32 {
	var total int32
	for _, cs := range p.Status.ContainerStatuses {
		total += cs.RestartCount
	}
	return total
}

func buildPodSummary(p *corev1.Pod, now time.Time) PodSummary {
	return PodSummary{
		Name:      p.Name,
		Namespace: p.Namespace,
		Phase:     string(p.Status.Phase),
		Status:    podStatus(p),
		Ready:     podReadyString(p),
		Restarts:  podRestartCount(p),
		NodeName:  p.Spec.NodeName,
		Age:       humanAge(p.CreationTimestamp.Time, now),
	}
}

// GET /api/pods
func podsHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	rawNamespace := c.Query("namespace")
	nsFilter := strings.TrimSpace(rawNamespace)
	if nsFilter == "" || strings.EqualFold(nsFilter, "all") {
		nsFilter = ""
	}
	search := strings.ToLower(strings.TrimSpace(c.Query("search")))

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	pods, err := kubeClient.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("list pods: %v", err)})
		return
	}

	now := time.Now()
	nsSet := make(map[string]struct{})
	out := make([]PodSummary, 0, len(pods.Items))

	for _, p := range pods.Items {
		nsSet[p.Namespace] = struct{}{}

		if nsFilter != "" && p.Namespace != nsFilter {
			continue
		}

		if search != "" {
			text := strings.ToLower(p.Namespace + "/" + p.Name)
			if !strings.Contains(text, search) {
				continue
			}
		}

		out = append(out, buildPodSummary(&p, now))
	}

	namespaces := make([]string, 0, len(nsSet))
	for ns := range nsSet {
		namespaces = append(namespaces, ns)
	}

	c.JSON(http.StatusOK, gin.H{
		"items":      out,
		"count":      len(out),
		"namespaces": namespaces,
	})
}

// GET /api/pods/:namespace/:name
func podDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	p, err := kubeClient.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "pod not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("get pod: %v", err)})
		return
	}

	now := time.Now()

	// Build container image map from spec
	imageByName := map[string]string{}
	for _, ctn := range p.Spec.Containers {
		imageByName[ctn.Name] = ctn.Image
	}

	detail := PodDetail{
		Name:        p.Name,
		Namespace:   p.Namespace,
		Phase:       string(p.Status.Phase),
		Status:      podStatus(p),
		NodeName:    p.Spec.NodeName,
		PodIP:       p.Status.PodIP,
		HostIP:      p.Status.HostIP,
		Age:         humanAge(p.CreationTimestamp.Time, now),
		Restarts:    podRestartCount(p),
		Labels:      p.Labels,
		Annotations: p.Annotations,
		Containers:  make([]PodContainerDetail, 0, len(p.Status.ContainerStatuses)),
	}

	for _, cs := range p.Status.ContainerStatuses {
		state := "unknown"
		if cs.State.Running != nil {
			state = "Running"
		} else if cs.State.Waiting != nil {
			if cs.State.Waiting.Reason != "" {
				state = cs.State.Waiting.Reason
			} else {
				state = "Waiting"
			}
		} else if cs.State.Terminated != nil {
			if cs.State.Terminated.Reason != "" {
				state = cs.State.Terminated.Reason
			} else {
				state = "Terminated"
			}
		}

		detail.Containers = append(detail.Containers, PodContainerDetail{
			Name:         cs.Name,
			Image:        imageByName[cs.Name],
			Ready:        cs.Ready,
			RestartCount: cs.RestartCount,
			State:        state,
		})
	}

	// New: add diagnostics (events/conditions/container reasons)
	detail.Diagnostics = buildPodWhyNotReady(ctx, ns, p)

	c.JSON(http.StatusOK, detail)
}

// SSE: GET /api/pods/stream
// Emits:
//
//	event: upsert   data: PodSummary JSON
//	event: delete   data: {"namespace": "...", "name": "..." }
func podsStreamHandler(c *gin.Context) {
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
	if strings.EqualFold(ns, "all") {
		ns = ""
	}

	watcher, err := kubeClient.CoreV1().Pods(ns).Watch(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("watch pods: %v", err)})
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
			p, ok := ev.Object.(*corev1.Pod)
			if !ok || p == nil {
				continue
			}

			switch ev.Type {
			case watch.Added, watch.Modified:
				now := time.Now()
				info := buildPodSummary(p, now)
				payload, err := json.Marshal(info)
				if err != nil {
					continue
				}
				fmt.Fprintf(w, "event: upsert\n")
				fmt.Fprintf(w, "data: %s\n\n", payload)
				flusher.Flush()
			case watch.Deleted:
				payload, err := json.Marshal(map[string]string{
					"namespace": p.Namespace,
					"name":      p.Name,
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

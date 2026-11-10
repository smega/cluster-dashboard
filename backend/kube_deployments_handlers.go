package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	appsv1 "k8s.io/api/apps/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
)

type DeploymentInfo struct {
	Name              string `json:"name"`
	Namespace         string `json:"namespace"`
	Status            string `json:"status"`
	Replicas          int32  `json:"replicas"`
	ReadyReplicas     int32  `json:"readyReplicas"`
	AvailableReplicas int32  `json:"availableReplicas"`
	UpdatedReplicas   int32  `json:"updatedReplicas"`
	Age               string `json:"age"`
}

type DeploymentContainer struct {
	Name  string `json:"name"`
	Image string `json:"image"`
}

type DeploymentDetail struct {
	Name              string                `json:"name"`
	Namespace         string                `json:"namespace"`
	Status            string                `json:"status"`
	Replicas          int32                 `json:"replicas"`
	ReadyReplicas     int32                 `json:"readyReplicas"`
	AvailableReplicas int32                 `json:"availableReplicas"`
	UpdatedReplicas   int32                 `json:"updatedReplicas"`
	Age               string                `json:"age"`
	Labels            map[string]string     `json:"labels,omitempty"`
	Annotations       map[string]string     `json:"annotations,omitempty"`
	Containers        []DeploymentContainer `json:"containers"`
}

// convert a k8s Deployment into the JSON we send to the frontend
func buildDeploymentInfo(d *appsv1.Deployment, now time.Time) DeploymentInfo {
	replicas := int32(1)
	if d.Spec.Replicas != nil {
		replicas = *d.Spec.Replicas
	}
	return DeploymentInfo{
		Name:              d.Name,
		Namespace:         d.Namespace,
		Status:            deploymentStatus(d),
		Replicas:          replicas,
		ReadyReplicas:     d.Status.ReadyReplicas,
		AvailableReplicas: d.Status.AvailableReplicas,
		UpdatedReplicas:   d.Status.UpdatedReplicas,
		Age:               humanAge(d.CreationTimestamp.Time, now),
	}
}

// GET /api/deployments
// (optionally can still use ?namespace & ?search, but frontend will now normally call without params)
func deploymentsHandler(c *gin.Context) {
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

	// Always list all namespaces; filter in code so we can still compute full namespace list.
	deps, err := kubeClient.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("list deployments: %v", err)})
		return
	}

	now := time.Now()
	nsSet := make(map[string]struct{})
	out := make([]DeploymentInfo, 0, len(deps.Items))

	for _, d := range deps.Items {
		nsSet[d.Namespace] = struct{}{}

		if nsFilter != "" && d.Namespace != nsFilter {
			continue
		}

		if search != "" {
			text := strings.ToLower(d.Namespace + "/" + d.Name)
			if !strings.Contains(text, search) {
				continue
			}
		}

		out = append(out, buildDeploymentInfo(&d, now))
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

// GET /api/deployments/:namespace/:name
func deploymentDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	d, err := kubeClient.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		statusCode := http.StatusInternalServerError
		if apierrors.IsNotFound(err) {
			statusCode = http.StatusNotFound
		}
		c.JSON(statusCode, gin.H{"error": fmt.Sprintf("get deployment: %v", err)})
		return
	}

	now := time.Now()
	replicas := int32(1)
	if d.Spec.Replicas != nil {
		replicas = *d.Spec.Replicas
	}

	detail := DeploymentDetail{
		Name:              d.Name,
		Namespace:         d.Namespace,
		Status:            deploymentStatus(d),
		Replicas:          replicas,
		ReadyReplicas:     d.Status.ReadyReplicas,
		AvailableReplicas: d.Status.AvailableReplicas,
		UpdatedReplicas:   d.Status.UpdatedReplicas,
		Age:               humanAge(d.CreationTimestamp.Time, now),
		Labels:            d.Labels,
		Annotations:       d.Annotations,
		Containers:        make([]DeploymentContainer, 0, len(d.Spec.Template.Spec.Containers)),
	}

	for _, ctn := range d.Spec.Template.Spec.Containers {
		detail.Containers = append(detail.Containers, DeploymentContainer{
			Name:  ctn.Name,
			Image: ctn.Image,
		})
	}

	c.JSON(http.StatusOK, detail)
}

// POST /api/deployments/:namespace/:name/scale  (admin only)
// body: { "replicas": 3 }  or legacy { "direction": "up"|"down" }
func scaleDeploymentHandler(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	var body struct {
		Direction string `json:"direction"`
		Replicas  *int32 `json:"replicas,omitempty"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON body"})
		return
	}

	dir := strings.ToLower(strings.TrimSpace(body.Direction))
	if body.Replicas == nil && dir != "up" && dir != "down" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "replicas must be set, or direction must be 'up' or 'down'"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	d, err := kubeClient.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "deployment not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("get deployment: %v", err)})
		return
	}

	current := int32(1)
	if d.Spec.Replicas != nil {
		current = *d.Spec.Replicas
	}

	var newReplicas int32
	if body.Replicas != nil {
		newReplicas = *body.Replicas
	} else {
		if dir == "up" {
			newReplicas = current + 1
		} else {
			if current > 0 {
				newReplicas = current - 1
			} else {
				newReplicas = 0
			}
		}
	}
	if newReplicas < 0 {
		newReplicas = 0
	}
	d.Spec.Replicas = &newReplicas

	if _, err := kubeClient.AppsV1().Deployments(ns).Update(ctx, d, metav1.UpdateOptions{}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("update deployment: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status":      "ok",
		"message":     fmt.Sprintf("scaled %s/%s from %d to %d", ns, name, current, newReplicas),
		"oldReplicas": current,
		"newReplicas": newReplicas,
	})
}

// POST /api/deployments/namespace/:namespace/scale-bulk  (admin only)
// body: { "replicas": 2 }  or legacy { "direction": "up"|"down" }
func bulkScaleDeploymentsHandler(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	ns := strings.TrimSpace(c.Param("namespace"))
	if ns == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace is required"})
		return
	}

	var body struct {
		Direction string `json:"direction"`
		Replicas  *int32 `json:"replicas,omitempty"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON body"})
		return
	}

	dir := strings.ToLower(strings.TrimSpace(body.Direction))
	if body.Replicas == nil && dir != "up" && dir != "down" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "replicas must be set, or direction must be 'up' or 'down'"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()

	deps, err := kubeClient.AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("list deployments: %v", err)})
		return
	}

	var changed, failed int
	var targetReplicas int32
	if body.Replicas != nil {
		targetReplicas = *body.Replicas
		if targetReplicas < 0 {
			targetReplicas = 0
		}
	}

	for _, d := range deps.Items {
		current := int32(1)
		if d.Spec.Replicas != nil {
			current = *d.Spec.Replicas
		}

		var newReplicas int32
		if body.Replicas != nil {
			newReplicas = targetReplicas
		} else {
			if dir == "up" {
				newReplicas = current + 1
			} else {
				if current > 0 {
					newReplicas = current - 1
				} else {
					newReplicas = 0
				}
			}
		}

		if newReplicas < 0 {
			newReplicas = 0
		}
		d.Spec.Replicas = &newReplicas

		if _, err := kubeClient.AppsV1().Deployments(ns).Update(ctx, &d, metav1.UpdateOptions{}); err != nil {
			failed++
			continue
		}
		changed++
	}

	c.JSON(http.StatusOK, gin.H{
		"status":        "ok",
		"namespace":     ns,
		"direction":     dir,
		"replicas":      body.Replicas,
		"changedCount":  changed,
		"failedCount":   failed,
		"totalSelected": len(deps.Items),
	})
}

// SSE: GET /api/deployments/stream
// Emits:
//
//	event: upsert   data: DeploymentInfo JSON
//	event: delete   data: {"namespace": "...", "name": "..." }
func deploymentsStreamHandler(c *gin.Context) {
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

	watcher, err := kubeClient.AppsV1().Deployments(ns).Watch(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("watch deployments: %v", err)})
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
			d, ok := ev.Object.(*appsv1.Deployment)
			if !ok || d == nil {
				continue
			}

			switch ev.Type {
			case watch.Added, watch.Modified:
				now := time.Now()
				info := buildDeploymentInfo(d, now)
				payload, err := json.Marshal(info)
				if err != nil {
					continue
				}
				fmt.Fprintf(w, "event: upsert\n")
				fmt.Fprintf(w, "data: %s\n\n", payload)
				flusher.Flush()
			case watch.Deleted:
				payload, err := json.Marshal(map[string]string{
					"namespace": d.Namespace,
					"name":      d.Name,
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

// status helper (unchanged)
func deploymentStatus(d *appsv1.Deployment) string {
	if d == nil {
		return ""
	}
	desired := int32(1)
	if d.Spec.Replicas != nil {
		desired = *d.Spec.Replicas
	}
	if d.Status.AvailableReplicas >= desired && desired > 0 {
		return "Ready"
	}
	if desired == 0 {
		return "ScaledDown"
	}
	return "NotReady"
}

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type LogsResponse struct {
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	Container string `json:"container"`
	Logs      string `json:"logs"`
	Truncated bool   `json:"truncated"`
}

type logLineEvent struct {
	Line string `json:"line"`
	Ts   int64  `json:"ts"`
}

// resolveContainerName chooses which container to use:
// - if containerParam is non-empty, use that
// - otherwise, use the first regular container (ignores init containers).
func resolveContainerName(ctx context.Context, ns, podName, containerParam string) (string, error) {
	if containerParam != "" {
		return containerParam, nil
	}
	if kubeClient == nil {
		return "", fmt.Errorf("kubernetes client not initialized")
	}

	pod, err := kubeClient.CoreV1().Pods(ns).Get(ctx, podName, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	if len(pod.Spec.Containers) == 0 {
		return "", fmt.Errorf("pod has no regular containers")
	}
	// This mimics kubectl logs default: first regular container (init containers are separate).
	return pod.Spec.Containers[0].Name, nil
}

// GET /api/logs?namespace=...&pod=...&container=...&tailLines=...
func logsHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	ns := c.Query("namespace")
	podName := c.Query("pod")
	containerParam := c.Query("container")

	if ns == "" || podName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace and pod are required"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	containerName, err := resolveContainerName(ctx, ns, podName, containerParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("resolve container: %v", err)})
		return
	}

	var tailLines int64 = 300
	if tlStr := c.Query("tailLines"); tlStr != "" {
		if v, err := strconv.ParseInt(tlStr, 10, 64); err == nil && v > 0 {
			tailLines = v
		}
	}

	opts := &corev1.PodLogOptions{
		Container: containerName,
		TailLines: &tailLines,
		Follow:    false,
	}

	req := kubeClient.CoreV1().Pods(ns).GetLogs(podName, opts)
	data, err := req.Do(ctx).Raw()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("get logs: %v", err)})
		return
	}

	c.JSON(http.StatusOK, LogsResponse{
		Namespace: ns,
		Pod:       podName,
		Container: containerName,
		Logs:      string(data),
		Truncated: false, // we only tail last N lines so it's bounded
	})
}

// SSE: GET /api/logs/stream?namespace=...&pod=...&container=...&tailLines=...
// Sends:
//
//	event: log
//	data: {"line":"...","ts":123456789}
func logsStreamHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	ns := c.Query("namespace")
	podName := c.Query("pod")
	containerParam := c.Query("container")

	if ns == "" || podName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace and pod are required"})
		return
	}

	ctx := c.Request.Context()

	containerName, err := resolveContainerName(ctx, ns, podName, containerParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("resolve container: %v", err)})
		return
	}

	var tailLinesPtr *int64
	if tlStr := c.Query("tailLines"); tlStr != "" {
		if v, err := strconv.ParseInt(tlStr, 10, 64); err == nil && v > 0 {
			tailLinesPtr = &v
		}
	}

	opts := &corev1.PodLogOptions{
		Container: containerName,
		Follow:    true,
		TailLines: tailLinesPtr,
	}

	req := kubeClient.CoreV1().Pods(ns).GetLogs(podName, opts)
	stream, err := req.Stream(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("open log stream: %v", err)})
		return
	}
	defer stream.Close()

	w := c.Writer
	flusher, ok := w.(http.Flusher)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "streaming not supported"})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher.Flush()

	scanner := bufio.NewScanner(stream)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)

	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}
		line := scanner.Text()
		payload, err := json.Marshal(logLineEvent{
			Line: line,
			Ts:   time.Now().UnixNano(),
		})
		if err != nil {
			continue
		}
		fmt.Fprintf(w, "event: log\n")
		fmt.Fprintf(w, "data: %s\n\n", payload)
		flusher.Flush()
	}

	// Normal EOF or client disconnect is fine; only log unexpected errors if needed
}

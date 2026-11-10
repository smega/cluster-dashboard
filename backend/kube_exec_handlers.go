// kube_exec_handlers.go
package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	kubescheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// ExecRunRequest is used for both "command" and "script" endpoints.
type ExecRunRequest struct {
	Namespace      string `json:"namespace"`
	Pod            string `json:"pod"`
	Container      string `json:"container,omitempty"`
	Command        string `json:"command,omitempty"` // used by /api/exec/command
	Script         string `json:"script,omitempty"`  // used by /api/exec/script
	TimeoutSeconds int    `json:"timeoutSeconds,omitempty"`
}

type ExecRunResponse struct {
	Namespace   string `json:"namespace"`
	Pod         string `json:"pod"`
	Container   string `json:"container"`
	CommandType string `json:"commandType"` // "command" or "script"`

	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`

	Success        bool      `json:"success"`
	Error          string    `json:"error,omitempty"`
	StartedAt      time.Time `json:"startedAt"`
	FinishedAt     time.Time `json:"finishedAt"`
	DurationMillis int64     `json:"durationMillis"`
}

// POST /api/exec/command
// Body: { namespace, pod, container?, command, timeoutSeconds? }
func execCommandHandler(c *gin.Context) {
	handleExecRun(c, "command")
}

// POST /api/exec/script
// Body: { namespace, pod, container?, script, timeoutSeconds? }
func execScriptHandler(c *gin.Context) {
	handleExecRun(c, "script")
}

func handleExecRun(c *gin.Context, mode string) {
	// We only need kubeClient here; config will be loaded per-call via InClusterConfig.
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	var req ExecRunRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid json: %v", err)})
		return
	}

	ns := strings.TrimSpace(req.Namespace)
	podName := strings.TrimSpace(req.Pod)
	containerName := strings.TrimSpace(req.Container)

	var text string
	if mode == "command" {
		text = strings.TrimSpace(req.Command)
	} else {
		text = strings.TrimSpace(req.Script)
	}

	if ns == "" || podName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace and pod are required"})
		return
	}
	if text == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "command/script text is empty"})
		return
	}

	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
	defer cancel()

	// If container not provided, auto-pick a sensible default (non-init, non-sidecar if possible)
	if containerName == "" {
		pod, err := kubeClient.CoreV1().Pods(ns).Get(ctx, podName, metav1.GetOptions{})
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get pod for container selection: %v", err)})
			return
		}
		containerName = pickDefaultContainerForExec(pod)
		if containerName == "" {
			c.JSON(http.StatusBadGateway, gin.H{"error": "could not determine default container for pod"})
			return
		}
	}

	// Use /bin/sh -c "<text>" so users can type normal shell commands
	cmd := []string{"/bin/sh", "-c", text}

	started := time.Now()
	stdout, stderr, err := execInPod(ctx, ns, podName, containerName, cmd)
	finished := time.Now()

	resp := ExecRunResponse{
		Namespace:      ns,
		Pod:            podName,
		Container:      containerName,
		CommandType:    mode,
		Stdout:         stdout,
		Stderr:         stderr,
		StartedAt:      started,
		FinishedAt:     finished,
		DurationMillis: finished.Sub(started).Milliseconds(),
		Success:        err == nil,
	}

	if err != nil {
		// Keep logs but surface error message as well
		msg := fmt.Sprintf("exec error: %v", err)
		if strings.TrimSpace(resp.Stderr) == "" {
			resp.Stderr = msg
		} else {
			resp.Stderr = resp.Stderr + "\n" + msg
		}
		resp.Error = msg
	}

	// Always 200: we return stdout/stderr even on failures.
	c.JSON(http.StatusOK, resp)
}

func execInPod(
	ctx context.Context,
	namespace, podName, containerName string,
	command []string,
) (string, string, error) {
	// Load in-cluster config here – no global kubeConfig required.
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return "", "", fmt.Errorf("load in-cluster config: %w", err)
	}

	req := kubeClient.CoreV1().RESTClient().
		Post().
		Resource("pods").
		Name(podName).
		Namespace(namespace).
		SubResource("exec")

	req.VersionedParams(&corev1.PodExecOptions{
		Container: containerName,
		Command:   command,
		Stdin:     false,
		Stdout:    true,
		Stderr:    true,
		TTY:       false,
	}, kubescheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(cfg, http.MethodPost, req.URL())
	if err != nil {
		return "", "", fmt.Errorf("create executor: %w", err)
	}

	var stdoutBuf, stderrBuf bytes.Buffer
	streamErr := executor.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdout: &stdoutBuf,
		Stderr: &stderrBuf,
	})

	if streamErr != nil {
		return stdoutBuf.String(), stderrBuf.String(), fmt.Errorf("stream exec: %w", streamErr)
	}

	return stdoutBuf.String(), stderrBuf.String(), nil
}

// pickDefaultContainerForExec picks a reasonable default container for exec/logs.
func pickDefaultContainerForExec(pod *corev1.Pod) string {
	if pod == nil {
		return ""
	}
	// Prefer regular containers over init containers
	if len(pod.Spec.Containers) == 1 {
		return pod.Spec.Containers[0].Name
	}

	// Try to skip obvious sidecars
	for _, c := range pod.Spec.Containers {
		name := strings.ToLower(c.Name)
		if strings.Contains(name, "sidecar") || strings.Contains(name, "istio") {
			continue
		}
		if c.Name != "" {
			return c.Name
		}
	}

	// Fallback: first container with a name
	for _, c := range pod.Spec.Containers {
		if c.Name != "" {
			return c.Name
		}
	}
	return ""
}

// kube_image_provenance_handlers.go
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
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ProvenanceContainer struct {
	Container string `json:"container"`
	Image     string `json:"image,omitempty"`    // from workload template
	Registry  string `json:"registry,omitempty"` // parsed from Image
	Tag       string `json:"tag,omitempty"`      // parsed from Image
	Digest    string `json:"digest,omitempty"`   // resolved from pod ImageID or from image@sha256
	ImageID   string `json:"imageID,omitempty"`  // raw from pod status
	Pod       string `json:"pod,omitempty"`      // where it was resolved from
	Ready     bool   `json:"ready"`
}

type ProvenanceWorkload struct {
	Kind       string                `json:"kind"`
	Namespace  string                `json:"namespace"`
	Name       string                `json:"name"`
	Age        string                `json:"age"`
	Selector   string                `json:"selector,omitempty"`
	Containers []ProvenanceContainer `json:"containers"`
	Warning    string                `json:"warning,omitempty"`
}

func parseImageRef(img string) (registry, tag, digest string) {
	// Examples:
	//  - gcr.io/proj/app:tag
	//  - europe-west2-docker.pkg.dev/proj/repo/app:tag
	//  - .../app@sha256:abcd
	//  - nginx:1.27 (implicit docker hub)
	img = strings.TrimSpace(img)
	if img == "" {
		return "", "", ""
	}
	if at := strings.LastIndex(img, "@"); at >= 0 && at+1 < len(img) {
		digest = img[at+1:]
		img = img[:at]
	}
	// detect tag (last ':' after last '/')
	slash := strings.LastIndex(img, "/")
	colon := strings.LastIndex(img, ":")
	if colon > slash && colon+1 < len(img) {
		tag = img[colon+1:]
		img = img[:colon]
	}
	// registry: if first segment looks like a registry host
	parts := strings.Split(img, "/")
	if len(parts) >= 2 {
		first := parts[0]
		if strings.Contains(first, ".") || strings.Contains(first, ":") || first == "localhost" {
			registry = first
		} else {
			registry = "docker.io"
		}
	} else {
		registry = "docker.io"
	}
	return registry, tag, digest
}

func extractDigestFromImageID(imageID string) string {
	// common formats:
	// docker-pullable://...@sha256:...
	// containerd://sha256:...
	s := strings.TrimSpace(imageID)
	if s == "" {
		return ""
	}
	if i := strings.LastIndex(s, "@"); i >= 0 && i+1 < len(s) {
		return s[i+1:]
	}
	if i := strings.LastIndex(s, "sha256:"); i >= 0 {
		return s[i:]
	}
	return ""
}

func selectorStringFromLabelSelector(ls *metav1.LabelSelector) string {
	if ls == nil {
		return ""
	}
	return metav1.FormatLabelSelector(ls)
}

func resolveContainersFromPods(ctx context.Context, ns string, selector string, template []corev1.Container) ([]ProvenanceContainer, string) {
	out := make([]ProvenanceContainer, 0, len(template))

	// Start with template info
	for _, c := range template {
		reg, tag, dig := parseImageRef(c.Image)
		out = append(out, ProvenanceContainer{
			Container: c.Name,
			Image:     c.Image,
			Registry:  reg,
			Tag:       tag,
			Digest:    dig, // if image@sha256, we already have it
			Ready:     false,
		})
	}

	if selector == "" {
		return out, "missing selector; cannot resolve digest from pods"
	}

	pods, err := kubeClient.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{
		LabelSelector: selector,
		Limit:         50,
	})
	if err != nil {
		return out, fmt.Sprintf("list pods for selector: %v", err)
	}
	if len(pods.Items) == 0 {
		return out, "no pods found for selector; workload may be scaled to zero"
	}

	// pick a “best” pod (running + newest startTime)
	bestIdx := 0
	bestScore := -1
	bestStart := time.Time{}
	for i := range pods.Items {
		p := &pods.Items[i]
		score := 0
		if p.Status.Phase == corev1.PodRunning {
			score += 10
		}
		if p.DeletionTimestamp != nil {
			score -= 5
		}
		if p.Status.StartTime != nil {
			st := p.Status.StartTime.Time
			if score > bestScore || (score == bestScore && st.After(bestStart)) {
				bestIdx = i
				bestScore = score
				bestStart = st
			}
		} else if score > bestScore {
			bestIdx = i
			bestScore = score
		}
	}
	best := &pods.Items[bestIdx]

	// map container status by name
	statusByName := map[string]corev1.ContainerStatus{}
	for _, cs := range best.Status.ContainerStatuses {
		statusByName[cs.Name] = cs
	}

	for i := range out {
		cs, ok := statusByName[out[i].Container]
		if !ok {
			continue
		}
		out[i].Ready = cs.Ready
		out[i].ImageID = cs.ImageID
		out[i].Pod = best.Name

		if out[i].Digest == "" {
			out[i].Digest = extractDigestFromImageID(cs.ImageID)
		}
	}

	return out, ""
}

// GET /api/kube/provenance?namespace=all
// Lists Deployments + StatefulSets with resolved image digests (best-effort).
func kubeImageProvenanceListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	ns := strings.TrimSpace(c.Query("namespace"))
	if ns == "" || strings.EqualFold(ns, "all") {
		ns = ""
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()

	now := time.Now()
	out := make([]ProvenanceWorkload, 0, 200)

	// Deployments
	deps, err := kubeClient.AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list deployments: %v", err)})
		return
	}
	for i := range deps.Items {
		d := &deps.Items[i]
		sel := selectorStringFromLabelSelector(d.Spec.Selector)
		containers, warn := resolveContainersFromPods(ctx, d.Namespace, sel, d.Spec.Template.Spec.Containers)
		out = append(out, ProvenanceWorkload{
			Kind:       "Deployment",
			Namespace:  d.Namespace,
			Name:       d.Name,
			Age:        humanAge(d.CreationTimestamp.Time, now),
			Selector:   sel,
			Containers: containers,
			Warning:    warn,
		})
	}

	// StatefulSets
	sts, err := kubeClient.AppsV1().StatefulSets(ns).List(ctx, metav1.ListOptions{})
	if err == nil {
		for i := range sts.Items {
			s := &sts.Items[i]
			sel := selectorStringFromLabelSelector(s.Spec.Selector)
			containers, warn := resolveContainersFromPods(ctx, s.Namespace, sel, s.Spec.Template.Spec.Containers)
			out = append(out, ProvenanceWorkload{
				Kind:       "StatefulSet",
				Namespace:  s.Namespace,
				Name:       s.Name,
				Age:        humanAge(s.CreationTimestamp.Time, now),
				Selector:   sel,
				Containers: containers,
				Warning:    warn,
			})
		}
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Namespace == out[j].Namespace {
			if out[i].Kind == out[j].Kind {
				return out[i].Name < out[j].Name
			}
			return out[i].Kind < out[j].Kind
		}
		return out[i].Namespace < out[j].Namespace
	})

	c.JSON(http.StatusOK, gin.H{"items": out, "count": len(out)})
}

// GET /api/kube/provenance/:kind/:namespace/:name
func kubeImageProvenanceDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	kind := strings.ToLower(strings.TrimSpace(c.Param("kind")))
	ns := strings.TrimSpace(c.Param("namespace"))
	name := strings.TrimSpace(c.Param("name"))
	if ns == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace and name are required"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	now := time.Now()

	switch kind {
	case "deployment", "deployments":
		d, err := kubeClient.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			if apierrors.IsNotFound(err) {
				c.JSON(http.StatusNotFound, gin.H{"error": "deployment not found"})
				return
			}
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get deployment: %v", err)})
			return
		}
		sel := selectorStringFromLabelSelector(d.Spec.Selector)
		containers, warn := resolveContainersFromPods(ctx, d.Namespace, sel, d.Spec.Template.Spec.Containers)
		c.JSON(http.StatusOK, ProvenanceWorkload{
			Kind:       "Deployment",
			Namespace:  d.Namespace,
			Name:       d.Name,
			Age:        humanAge(d.CreationTimestamp.Time, now),
			Selector:   sel,
			Containers: containers,
			Warning:    warn,
		})
		return

	case "statefulset", "statefulsets":
		s, err := kubeClient.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			if apierrors.IsNotFound(err) {
				c.JSON(http.StatusNotFound, gin.H{"error": "statefulset not found"})
				return
			}
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get statefulset: %v", err)})
			return
		}
		sel := selectorStringFromLabelSelector(s.Spec.Selector)
		containers, warn := resolveContainersFromPods(ctx, s.Namespace, sel, s.Spec.Template.Spec.Containers)
		c.JSON(http.StatusOK, ProvenanceWorkload{
			Kind:       "StatefulSet",
			Namespace:  s.Namespace,
			Name:       s.Name,
			Age:        humanAge(s.CreationTimestamp.Time, now),
			Selector:   sel,
			Containers: containers,
			Warning:    warn,
		})
		return

	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported kind (use deployment or statefulset)"})
		return
	}
}

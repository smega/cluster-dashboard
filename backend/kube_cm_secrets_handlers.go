// kube_config_handlers.go
package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ConfigMapItem struct {
	Kind        string            `json:"kind"` // "ConfigMap"
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace"`
	Keys        int               `json:"keys"`
	Immutable   *bool             `json:"immutable,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
	Age         string            `json:"age"`
}

type SecretItem struct {
	Kind        string            `json:"kind"` // "Secret"
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace"`
	Type        string            `json:"type,omitempty"`
	Keys        int               `json:"keys"`
	Immutable   *bool             `json:"immutable,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
	Age         string            `json:"age"`
}

type KeyInfo struct {
	Key  string `json:"key"`
	Size int    `json:"size"` // bytes (we never return decoded plaintext in list)
	From string `json:"from,omitempty"`
}

type SafeMeta struct {
	Name              string            `json:"name"`
	Namespace         string            `json:"namespace"`
	UID               string            `json:"uid,omitempty"`
	ResourceVersion   string            `json:"resourceVersion,omitempty"`
	CreationTimestamp string            `json:"creationTimestamp,omitempty"`
	Labels            map[string]string `json:"labels,omitempty"`
	Annotations       map[string]string `json:"annotations,omitempty"`
}

// GET /api/kube/configmaps
// Optional: ?namespace=<ns> (if empty or "all", returns all namespaces)
func kubeConfigMapsListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	nsQuery := c.Query("namespace")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	var (
		list *corev1.ConfigMapList
		err  error
	)

	if nsQuery != "" && nsQuery != "all" {
		list, err = kubeClient.CoreV1().ConfigMaps(nsQuery).List(ctx, metav1.ListOptions{})
	} else {
		list, err = kubeClient.CoreV1().ConfigMaps("").List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list configmaps: %v", err)})
		return
	}

	items := make([]ConfigMapItem, 0, len(list.Items))
	for i := range list.Items {
		cm := &list.Items[i]
		keys := len(cm.Data) + len(cm.BinaryData)

		items = append(items, ConfigMapItem{
			Kind:        "ConfigMap",
			Name:        cm.Name,
			Namespace:   cm.Namespace,
			Keys:        keys,
			Immutable:   cm.Immutable,
			Labels:      cm.Labels,
			Annotations: cm.Annotations,
			Age:         configAgeString(cm.CreationTimestamp.Time),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].Namespace == items[j].Namespace {
			return items[i].Name < items[j].Name
		}
		return items[i].Namespace < items[j].Namespace
	})

	c.JSON(http.StatusOK, gin.H{"items": items})
}

// GET /api/kube/secrets
// Optional: ?namespace=<ns> (if empty or "all", returns all namespaces)
func kubeSecretsListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	nsQuery := c.Query("namespace")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	var (
		list *corev1.SecretList
		err  error
	)

	if nsQuery != "" && nsQuery != "all" {
		list, err = kubeClient.CoreV1().Secrets(nsQuery).List(ctx, metav1.ListOptions{})
	} else {
		list, err = kubeClient.CoreV1().Secrets("").List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list secrets: %v", err)})
		return
	}

	items := make([]SecretItem, 0, len(list.Items))
	for i := range list.Items {
		s := &list.Items[i]
		keys := len(s.Data) // stringData is write-only and not returned by API

		items = append(items, SecretItem{
			Kind:        "Secret",
			Name:        s.Name,
			Namespace:   s.Namespace,
			Type:        string(s.Type),
			Keys:        keys,
			Immutable:   s.Immutable,
			Labels:      s.Labels,
			Annotations: s.Annotations,
			Age:         configAgeString(s.CreationTimestamp.Time),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].Namespace == items[j].Namespace {
			return items[i].Name < items[j].Name
		}
		return items[i].Namespace < items[j].Namespace
	})

	c.JSON(http.StatusOK, gin.H{"items": items})
}

// GET /api/kube/configmaps/:namespace/:name
// Optional: ?includeData=1 (returns data + binaryDataB64)
func kubeConfigMapDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	cm, err := kubeClient.CoreV1().ConfigMaps(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get configmap %s/%s: %v", ns, name, err)})
		return
	}

	keys := make([]KeyInfo, 0, len(cm.Data)+len(cm.BinaryData))
	for k, v := range cm.Data {
		keys = append(keys, KeyInfo{Key: k, Size: len(v), From: "data"})
	}
	for k, v := range cm.BinaryData {
		keys = append(keys, KeyInfo{Key: k, Size: len(v), From: "binaryData"})
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].Key < keys[j].Key })

	meta := SafeMeta{
		Name:              cm.Name,
		Namespace:         cm.Namespace,
		UID:               string(cm.UID),
		ResourceVersion:   cm.ResourceVersion,
		CreationTimestamp: cm.CreationTimestamp.Time.Format(time.RFC3339),
		Labels:            cm.Labels,
		Annotations:       cm.Annotations,
	}

	// Include values only when explicitly requested
	includeData := c.Query("includeData")
	wantData := includeData == "1" || strings.ToLower(includeData) == "true"

	var data map[string]string
	var binaryDataB64 map[string]string
	if wantData {
		data = cm.Data
		if len(cm.BinaryData) > 0 {
			binaryDataB64 = make(map[string]string, len(cm.BinaryData))
			for k, v := range cm.BinaryData {
				binaryDataB64[k] = base64.StdEncoding.EncodeToString(v)
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"kind":          "ConfigMap",
		"namespace":     ns,
		"name":          name,
		"age":           configAgeString(cm.CreationTimestamp.Time),
		"immutable":     cm.Immutable,
		"keys":          keys,
		"meta":          meta,
		"data":          data,          // only if includeData=1
		"binaryDataB64": binaryDataB64, // only if includeData=1
	})
}

// GET /api/kube/secrets/:namespace/:name
// Optional: ?includeData=1 (returns dataB64)
func kubeSecretDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	s, err := kubeClient.CoreV1().Secrets(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get secret %s/%s: %v", ns, name, err)})
		return
	}

	keys := make([]KeyInfo, 0, len(s.Data))
	for k, v := range s.Data {
		keys = append(keys, KeyInfo{Key: k, Size: len(v), From: "data"})
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].Key < keys[j].Key })

	meta := SafeMeta{
		Name:              s.Name,
		Namespace:         s.Namespace,
		UID:               string(s.UID),
		ResourceVersion:   s.ResourceVersion,
		CreationTimestamp: s.CreationTimestamp.Time.Format(time.RFC3339),
		Labels:            s.Labels,
		Annotations:       s.Annotations,
	}

	includeData := c.Query("includeData")
	wantData := includeData == "1" || strings.ToLower(includeData) == "true"

	var dataB64 map[string]string
	if wantData {
		dataB64 = make(map[string]string, len(s.Data))
		for k, v := range s.Data {
			dataB64[k] = base64.StdEncoding.EncodeToString(v)
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"kind":      "Secret",
		"namespace": ns,
		"name":      name,
		"age":       configAgeString(s.CreationTimestamp.Time),
		"type":      string(s.Type),
		"immutable": s.Immutable,
		"keys":      keys,
		"meta":      meta,
		"dataB64":   dataB64, // only if includeData=1
	})
}

func configAgeString(t time.Time) string {
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

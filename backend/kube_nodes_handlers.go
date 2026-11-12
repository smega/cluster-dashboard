// kube_nodes_handlers.go
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
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const gkeNodepoolLabel = "cloud.google.com/gke-nodepool"

type NodeItem struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Ready       bool   `json:"ready"`
	ReadyReason string `json:"readyReason,omitempty"`

	Schedulable bool   `json:"schedulable"`
	Pool        string `json:"pool,omitempty"`
	Zone        string `json:"zone,omitempty"`
	Instance    string `json:"instanceType,omitempty"`

	KubeletVersion string `json:"kubeletVersion,omitempty"`
	OSImage        string `json:"osImage,omitempty"`

	TaintsCount int    `json:"taintsCount"`
	Age         string `json:"age"`

	CPUPct float64 `json:"cpuPct,omitempty"`
	MemPct float64 `json:"memPct,omitempty"`

	CPUUsageMilli int64 `json:"cpuUsageMilli,omitempty"`
	CPUAllocMilli int64 `json:"cpuAllocMilli,omitempty"`
	MemUsageBytes int64 `json:"memUsageBytes,omitempty"`
	MemAllocBytes int64 `json:"memAllocBytes,omitempty"`
}

type NodePoolSummary struct {
	Pool       string `json:"pool"`
	NodeCount  int    `json:"nodeCount"`
	ReadyCount int    `json:"readyCount"`

	CPUAllocMilli int64 `json:"cpuAllocMilli,omitempty"`
	MemAllocBytes int64 `json:"memAllocBytes,omitempty"`

	AvgCPUPct float64 `json:"avgCpuPct,omitempty"`
	AvgMemPct float64 `json:"avgMemPct,omitempty"`
}

type NodeConditionItem struct {
	Type               string `json:"type"`
	Status             string `json:"status"`
	Reason             string `json:"reason,omitempty"`
	Message            string `json:"message,omitempty"`
	LastTransitionTime string `json:"lastTransitionTime,omitempty"`
}

type NodeDetail struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`

	Ready       bool   `json:"ready"`
	ReadyReason string `json:"readyReason,omitempty"`
	Schedulable bool   `json:"schedulable"`

	Pool         string `json:"pool,omitempty"`
	Zone         string `json:"zone,omitempty"`
	Region       string `json:"region,omitempty"`
	InstanceType string `json:"instanceType,omitempty"`

	Age string `json:"age"`

	// NodeInfo
	KubeletVersion   string `json:"kubeletVersion,omitempty"`
	KernelVersion    string `json:"kernelVersion,omitempty"`
	OSImage          string `json:"osImage,omitempty"`
	ContainerRuntime string `json:"containerRuntime,omitempty"`
	Architecture     string `json:"architecture,omitempty"`
	OperatingSystem  string `json:"operatingSystem,omitempty"`

	Addresses []string `json:"addresses,omitempty"`

	Taints []string          `json:"taints,omitempty"`
	Labels map[string]string `json:"labels,omitempty"`

	Conditions []NodeConditionItem `json:"conditions,omitempty"`

	// Capacity/allocatable
	CPUCapacityMilli int64 `json:"cpuCapacityMilli,omitempty"`
	CPUAllocMilli    int64 `json:"cpuAllocMilli,omitempty"`
	MemCapacityBytes int64 `json:"memCapacityBytes,omitempty"`
	MemAllocBytes    int64 `json:"memAllocBytes,omitempty"`

	// Optional metrics
	MetricsAvailable bool    `json:"metricsAvailable"`
	MetricsWarning   string  `json:"metricsWarning,omitempty"`
	CPUPct           float64 `json:"cpuPct,omitempty"`
	MemPct           float64 `json:"memPct,omitempty"`
	CPUUsageMilli    int64   `json:"cpuUsageMilli,omitempty"`
	MemUsageBytes    int64   `json:"memUsageBytes,omitempty"`
}

// GET /api/nodes
func nodesListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	nl, err := kubeClient.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list nodes: %v", err)})
		return
	}

	friendlyNames := buildFriendlyNodeNames(nl.Items)
	metricsByNode, metricsOK, metricsWarn := loadNodeMetrics(ctx)

	now := time.Now()

	items := make([]NodeItem, 0, len(nl.Items))
	pools := map[string]*NodePoolSummary{}

	for i := range nl.Items {
		n := &nl.Items[i]

		ready, readyReason := nodeReady(n)
		sched := !n.Spec.Unschedulable

		pool := nodePoolName(n)
		zone := firstLabel(n, "topology.kubernetes.io/zone", "failure-domain.beta.kubernetes.io/zone")
		instance := firstLabel(n, "node.kubernetes.io/instance-type", "beta.kubernetes.io/instance-type")

		cpuAllocMilli := n.Status.Allocatable.Cpu().MilliValue()
		memAllocBytes := n.Status.Allocatable.Memory().Value()

		mi := metricsByNode[n.Name]
		var cpuPct, memPct float64
		var cpuUsageMilli, memUsageBytes int64

		if metricsOK && mi != nil && cpuAllocMilli > 0 && memAllocBytes > 0 {
			cpuUsageMilli = mi.cpuMilli
			memUsageBytes = mi.memBytes
			cpuPct = clampPct(float64(cpuUsageMilli) / float64(cpuAllocMilli) * 100)
			memPct = clampPct(float64(memUsageBytes) / float64(memAllocBytes) * 100)
		}

		items = append(items, NodeItem{
			Name:           n.Name,
			DisplayName:    friendlyNames[n.Name],
			Ready:          ready,
			ReadyReason:    readyReason,
			Schedulable:    sched,
			Pool:           pool,
			Zone:           zone,
			Instance:       instance,
			KubeletVersion: n.Status.NodeInfo.KubeletVersion,
			OSImage:        n.Status.NodeInfo.OSImage,
			TaintsCount:    len(n.Spec.Taints),
			Age:            humanAge(n.CreationTimestamp.Time, now),

			CPUPct: cpuPct,
			MemPct: memPct,

			CPUUsageMilli: cpuUsageMilli,
			CPUAllocMilli: cpuAllocMilli,
			MemUsageBytes: memUsageBytes,
			MemAllocBytes: memAllocBytes,
		})

		ps, ok := pools[pool]
		if !ok {
			ps = &NodePoolSummary{Pool: pool}
			pools[pool] = ps
		}
		ps.NodeCount++
		if ready {
			ps.ReadyCount++
		}
		ps.CPUAllocMilli += cpuAllocMilli
		ps.MemAllocBytes += memAllocBytes
		if metricsOK && cpuPct > 0 {
			ps.AvgCPUPct += cpuPct
		}
		if metricsOK && memPct > 0 {
			ps.AvgMemPct += memPct
		}
	}

	// pool averages
	poolList := make([]NodePoolSummary, 0, len(pools))
	for _, ps := range pools {
		if metricsOK && ps.NodeCount > 0 {
			ps.AvgCPUPct = ps.AvgCPUPct / float64(ps.NodeCount)
			ps.AvgMemPct = ps.AvgMemPct / float64(ps.NodeCount)
		}
		poolList = append(poolList, *ps)
	}
	sort.Slice(poolList, func(i, j int) bool {
		return poolList[i].Pool < poolList[j].Pool
	})

	// sort nodes by name
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })

	// Top nodes (by CPU / Mem)
	topCPU := make([]NodeItem, 0)
	topMem := make([]NodeItem, 0)
	if metricsOK {
		tmp := append([]NodeItem(nil), items...)
		sort.Slice(tmp, func(i, j int) bool { return tmp[i].CPUPct > tmp[j].CPUPct })
		for i := 0; i < len(tmp) && i < 5; i++ {
			if tmp[i].CPUPct > 0 {
				topCPU = append(topCPU, tmp[i])
			}
		}
		tmp2 := append([]NodeItem(nil), items...)
		sort.Slice(tmp2, func(i, j int) bool { return tmp2[i].MemPct > tmp2[j].MemPct })
		for i := 0; i < len(tmp2) && i < 5; i++ {
			if tmp2[i].MemPct > 0 {
				topMem = append(topMem, tmp2[i])
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"items":            items,
		"pools":            poolList,
		"metricsAvailable": metricsOK,
		"metricsWarning":   metricsWarn,
		"topCPU":           topCPU,
		"topMem":           topMem,
	})
}

// GET /api/nodes/:name
func nodeDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	n, err := kubeClient.CoreV1().Nodes().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get node: %v", err)})
		return
	}

	displayName := name
	if nl, err := kubeClient.CoreV1().Nodes().List(ctx, metav1.ListOptions{}); err == nil {
		displayName = buildFriendlyNodeNames(nl.Items)[name]
	}

	ready, readyReason := nodeReady(n)
	sched := !n.Spec.Unschedulable

	pool := nodePoolName(n)
	zone := firstLabel(n, "topology.kubernetes.io/zone", "failure-domain.beta.kubernetes.io/zone")
	region := firstLabel(n, "topology.kubernetes.io/region", "failure-domain.beta.kubernetes.io/region")
	instance := firstLabel(n, "node.kubernetes.io/instance-type", "beta.kubernetes.io/instance-type")

	cpuCapMilli := n.Status.Capacity.Cpu().MilliValue()
	cpuAllocMilli := n.Status.Allocatable.Cpu().MilliValue()
	memCapBytes := n.Status.Capacity.Memory().Value()
	memAllocBytes := n.Status.Allocatable.Memory().Value()

	addrs := make([]string, 0, len(n.Status.Addresses))
	for _, a := range n.Status.Addresses {
		addrs = append(addrs, fmt.Sprintf("%s=%s", a.Type, a.Address))
	}
	sort.Strings(addrs)

	taints := taintsToStrings(n.Spec.Taints)
	conds := nodeConditionsToItems(n.Status.Conditions)

	metricsByNode, metricsOK, metricsWarn := loadNodeMetrics(ctx)
	mi := metricsByNode[n.Name]

	var cpuUsageMilli, memUsageBytes int64
	var cpuPct, memPct float64
	if metricsOK && mi != nil && cpuAllocMilli > 0 && memAllocBytes > 0 {
		cpuUsageMilli = mi.cpuMilli
		memUsageBytes = mi.memBytes
		cpuPct = clampPct(float64(cpuUsageMilli) / float64(cpuAllocMilli) * 100)
		memPct = clampPct(float64(memUsageBytes) / float64(memAllocBytes) * 100)
	}

	out := NodeDetail{
		Name:         n.Name,
		DisplayName:  displayName,
		Ready:        ready,
		ReadyReason:  readyReason,
		Schedulable:  sched,
		Pool:         pool,
		Zone:         zone,
		Region:       region,
		InstanceType: instance,
		Age:          humanAge(n.CreationTimestamp.Time, time.Now()),

		KubeletVersion:   n.Status.NodeInfo.KubeletVersion,
		KernelVersion:    n.Status.NodeInfo.KernelVersion,
		OSImage:          n.Status.NodeInfo.OSImage,
		ContainerRuntime: n.Status.NodeInfo.ContainerRuntimeVersion,
		Architecture:     n.Status.NodeInfo.Architecture,
		OperatingSystem:  n.Status.NodeInfo.OperatingSystem,

		Addresses: addrs,
		Taints:    taints,
		Labels:    n.Labels,

		Conditions: conds,

		CPUCapacityMilli: cpuCapMilli,
		CPUAllocMilli:    cpuAllocMilli,
		MemCapacityBytes: memCapBytes,
		MemAllocBytes:    memAllocBytes,

		MetricsAvailable: metricsOK,
		MetricsWarning:   metricsWarn,
		CPUPct:           cpuPct,
		MemPct:           memPct,
		CPUUsageMilli:    cpuUsageMilli,
		MemUsageBytes:    memUsageBytes,
	}

	c.JSON(http.StatusOK, out)
}

// ---- metrics (optional via dynamic client)

type nodeMetric struct {
	cpuMilli int64
	memBytes int64
}

func loadNodeMetrics(ctx context.Context) (map[string]*nodeMetric, bool, string) {
	// kubeDynamic is already used elsewhere (VPA/snapshots). If it's nil, metrics are simply unavailable.
	if kubeDynamic == nil {
		return map[string]*nodeMetric{}, false, "metrics not available (dynamic client not initialized)"
	}

	gvr := schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "nodes"}
	lst, err := kubeDynamic.Resource(gvr).List(ctx, metav1.ListOptions{})
	if err != nil {
		if isAPIUnavailable(err) {
			return map[string]*nodeMetric{}, false, "metrics-server API not available (metrics.k8s.io/v1beta1)"
		}
		if apierrors.IsForbidden(err) {
			return map[string]*nodeMetric{}, false, "metrics forbidden (RBAC missing: apiGroups=metrics.k8s.io resources=nodes verbs=list/get)"
		}
		return map[string]*nodeMetric{}, false, fmt.Sprintf("metrics error: %v", err)
	}

	out := make(map[string]*nodeMetric, len(lst.Items))
	for i := range lst.Items {
		u := &lst.Items[i]
		name := u.GetName()

		cpuStr, _, _ := unstructured.NestedString(u.Object, "usage", "cpu")
		memStr, _, _ := unstructured.NestedString(u.Object, "usage", "memory")

		var cpuMilli int64
		var memBytes int64

		if cpuStr != "" {
			if q, err := resource.ParseQuantity(cpuStr); err == nil {
				cpuMilli = q.MilliValue()
			}
		}
		if memStr != "" {
			if q, err := resource.ParseQuantity(memStr); err == nil {
				memBytes = q.Value()
			}
		}

		out[name] = &nodeMetric{cpuMilli: cpuMilli, memBytes: memBytes}
	}

	return out, true, ""
}

func isAPIUnavailable(err error) bool {
	if err == nil {
		return false
	}
	if apierrors.IsNotFound(err) {
		return true
	}
	if apimeta.IsNoMatchError(err) {
		return true
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "the server could not find the requested resource") {
		return true
	}
	if strings.Contains(msg, "no matches for kind") {
		return true
	}
	return false
}

// ---- helpers

func nodeReady(n *corev1.Node) (bool, string) {
	for _, c := range n.Status.Conditions {
		if c.Type == corev1.NodeReady {
			if c.Status == corev1.ConditionTrue {
				return true, ""
			}
			rr := c.Reason
			if rr == "" {
				rr = string(c.Status)
			}
			return false, rr
		}
	}
	return false, "Unknown"
}

// buildFriendlyNodeNames assigns a stable, non-identifying display label to
// each node (e.g. "Pi #1 - control plane") instead of the real hostname, so
// the public dashboard doesn't advertise raw node identity. Numbering is
// derived from sorted node name, so it stays stable across requests as long
// as the node set doesn't change.
func buildFriendlyNodeNames(nodes []corev1.Node) map[string]string {
	sorted := append([]corev1.Node(nil), nodes...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })

	out := make(map[string]string, len(sorted))
	for i := range sorted {
		role := "worker"
		if isControlPlaneNode(&sorted[i]) {
			role = "control plane"
		}
		out[sorted[i].Name] = fmt.Sprintf("Pi #%d - %s", i+1, role)
	}
	return out
}

func isControlPlaneNode(n *corev1.Node) bool {
	if _, ok := n.Labels["node-role.kubernetes.io/control-plane"]; ok {
		return true
	}
	if _, ok := n.Labels["node-role.kubernetes.io/master"]; ok {
		return true
	}
	return false
}

func nodePoolName(n *corev1.Node) string {
	if n == nil {
		return "unknown"
	}
	if v := n.Labels[gkeNodepoolLabel]; v != "" {
		return v
	}
	return "unknown"
}

func firstLabel(n *corev1.Node, keys ...string) string {
	for _, k := range keys {
		if v := n.Labels[k]; v != "" {
			return v
		}
	}
	return ""
}

func taintsToStrings(ts []corev1.Taint) []string {
	if len(ts) == 0 {
		return nil
	}
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		// key=value:effect (value may be empty)
		if t.Value != "" {
			out = append(out, fmt.Sprintf("%s=%s:%s", t.Key, t.Value, t.Effect))
		} else {
			out = append(out, fmt.Sprintf("%s:%s", t.Key, t.Effect))
		}
	}
	sort.Strings(out)
	return out
}

func nodeConditionsToItems(cs []corev1.NodeCondition) []NodeConditionItem {
	out := make([]NodeConditionItem, 0, len(cs))
	for _, c := range cs {
		ts := ""
		if !c.LastTransitionTime.IsZero() {
			ts = c.LastTransitionTime.Time.Format(time.RFC3339)
		}
		out = append(out, NodeConditionItem{
			Type:               string(c.Type),
			Status:             string(c.Status),
			Reason:             c.Reason,
			Message:            c.Message,
			LastTransitionTime: ts,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Type < out[j].Type })
	return out
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 999 {
		return 999
	}
	return v
}

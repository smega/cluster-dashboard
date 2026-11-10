// kube_overview_handlers.go
package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// assumes global kubeClient exists

type OverviewStats struct {
	Namespaces    int `json:"namespaces"`
	Nodes         int `json:"nodes"`
	Pods          int `json:"pods"`
	Deployments   int `json:"deployments"`
	CrashLoopPods int `json:"crashLoopPods"`
	ErrorPods     int `json:"errorPods"`
	FailingHPAs   int `json:"failingHPAs"`
}

type UnhealthyPodSummary struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Reason    string `json:"reason"`
	Restarts  int32  `json:"restarts"`
}

type ProblemServiceSummary struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	ClusterIP string `json:"clusterIP"`
	Ports     string `json:"ports"`
	Reason    string `json:"reason"` // "no_endpoints"
}

type ProblemIngressSummary struct {
	Namespace   string `json:"namespace"`
	Name        string `json:"name"`
	Host        string `json:"host"`
	Path        string `json:"path"`
	ServiceName string `json:"serviceName"`
	ServicePort string `json:"servicePort"`
	Reason      string `json:"reason"` // "service_not_found"
}

type OverviewResponse struct {
	Stats            OverviewStats           `json:"stats"`
	UnhealthyPods    []UnhealthyPodSummary   `json:"unhealthyPods"`
	ProblemServices  []ProblemServiceSummary `json:"problemServices"`
	ProblemIngresses []ProblemIngressSummary `json:"problemIngresses"`
}

type workloadInfo struct {
	Name      string
	Replicas  int32
	Labels    map[string]string
	Kind      string // "Deployment" / "StatefulSet"
	Namespace string
}

func labelsContainAll(labels map[string]string, sel map[string]string) bool {
	if len(sel) == 0 {
		return false
	}
	for k, v := range sel {
		if labels == nil {
			return false
		}
		if labels[k] != v {
			return false
		}
	}
	return true
}

func totalRestarts(p *corev1.Pod) int32 {
	var r int32
	for _, cs := range p.Status.InitContainerStatuses {
		r += cs.RestartCount
	}
	for _, cs := range p.Status.ContainerStatuses {
		r += cs.RestartCount
	}
	return r
}

// podProblemReason returns (isProblem, reasonString)
//
// IMPORTANT FIX:
// - ignore Succeeded/Completed pods (Jobs/CronJobs)
func podProblemReason(p *corev1.Pod) (bool, string) {
	// Completed job pods should NOT be considered unhealthy
	if p.Status.Phase == corev1.PodSucceeded {
		return false, ""
	}

	// 1) Container states (ignore "Completed")
	allCS := append(append([]corev1.ContainerStatus{}, p.Status.InitContainerStatuses...), p.Status.ContainerStatuses...)
	for _, cs := range allCS {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			return true, cs.State.Waiting.Reason
		}
		if cs.State.Terminated != nil {
			// Ignore normal completion signals
			if strings.EqualFold(cs.State.Terminated.Reason, "Completed") && cs.State.Terminated.ExitCode == 0 {
				continue
			}
			if cs.State.Terminated.Reason != "" {
				return true, cs.State.Terminated.Reason
			}
			if cs.State.Terminated.ExitCode != 0 {
				return true, "ExitCode_" + strconv.Itoa(int(cs.State.Terminated.ExitCode))
			}
		}
	}

	// 2) Pod conditions (not Ready / ContainersReady)
	for _, cond := range p.Status.Conditions {
		if (cond.Type == corev1.PodReady || cond.Type == corev1.ContainersReady) &&
			cond.Status != corev1.ConditionTrue &&
			cond.Reason != "" {
			return true, cond.Reason
		}
	}

	// 3) Fallback on phase (ignore Running)
	switch p.Status.Phase {
	case corev1.PodRunning:
		return false, ""
	case corev1.PodPending:
		return true, "Pending"
	case corev1.PodFailed:
		// This is usually meaningful (Evicted, etc.)
		return true, "Failed"
	default:
		if p.Status.Phase == "" {
			return false, ""
		}
		return true, string(p.Status.Phase)
	}
}

func summarizeServicePorts(ports []corev1.ServicePort) string {
	if len(ports) == 0 {
		return ""
	}
	out := make([]string, 0, len(ports))
	for _, p := range ports {
		proto := string(p.Protocol)
		if proto == "" {
			proto = "TCP"
		}
		target := p.TargetPort.String()
		if target != "" && target != "0" {
			out = append(out, fmt.Sprintf("%d/%s→%s", p.Port, proto, target))
		} else {
			out = append(out, fmt.Sprintf("%d/%s", p.Port, proto))
		}
	}
	return strings.Join(out, ", ")
}

// EndpointSlice map: ns/service -> has endpoints
func endpointSliceHasEndpoints(es *discoveryv1.EndpointSlice) bool {
	for _, ep := range es.Endpoints {
		if len(ep.Addresses) > 0 {
			return true
		}
	}
	return false
}

func clusterOverviewHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 25*time.Second)
	defer cancel()

	// Core lists
	nsList, err := kubeClient.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list namespaces: %v", err)})
		return
	}
	nodesList, err := kubeClient.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list nodes: %v", err)})
		return
	}
	podList, err := kubeClient.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list pods: %v", err)})
		return
	}
	deployList, err := kubeClient.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list deployments: %v", err)})
		return
	}
	stsList, err := kubeClient.AppsV1().StatefulSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list statefulsets: %v", err)})
		return
	}

	// Services + EndpointSlices
	svcList, err := kubeClient.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list services: %v", err)})
		return
	}
	esList, err := kubeClient.DiscoveryV1().EndpointSlices("").List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list endpointslices: %v", err)})
		return
	}

	// Ingresses
	ingList, err := kubeClient.NetworkingV1().Ingresses("").List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list ingresses: %v", err)})
		return
	}

	// ---- Build workload index for "scaled down => don't flag service" ----
	workloadsByNS := map[string][]workloadInfo{}

	for _, d := range deployList.Items {
		var r int32 = 1
		if d.Spec.Replicas != nil {
			r = *d.Spec.Replicas
		}
		workloadsByNS[d.Namespace] = append(workloadsByNS[d.Namespace], workloadInfo{
			Name:      d.Name,
			Replicas:  r,
			Labels:    d.Spec.Template.Labels,
			Kind:      "Deployment",
			Namespace: d.Namespace,
		})
	}
	for _, s := range stsList.Items {
		var r int32 = 1
		if s.Spec.Replicas != nil {
			r = *s.Spec.Replicas
		}
		workloadsByNS[s.Namespace] = append(workloadsByNS[s.Namespace], workloadInfo{
			Name:      s.Name,
			Replicas:  r,
			Labels:    s.Spec.Template.Labels,
			Kind:      "StatefulSet",
			Namespace: s.Namespace,
		})
	}

	// ---- EndpointSlice map: serviceKey => hasEndpoints ----
	// EndpointSlices identify service name via label: kubernetes.io/service-name
	svcHasEndpoints := map[string]bool{}
	for _, es := range esList.Items {
		svcName := es.Labels["kubernetes.io/service-name"]
		if svcName == "" {
			continue
		}
		key := es.Namespace + "/" + svcName
		if endpointSliceHasEndpoints(&es) {
			svcHasEndpoints[key] = true
		}
	}

	// ---- Stats and unhealthy pods ----
	stats := OverviewStats{
		Namespaces:  len(nsList.Items),
		Nodes:       len(nodesList.Items),
		Pods:        len(podList.Items),
		Deployments: len(deployList.Items),
		FailingHPAs: 0,
	}

	var unhealthyPods []UnhealthyPodSummary
	for _, p := range podList.Items {
		problem, reason := podProblemReason(&p)
		if !problem {
			continue
		}

		restarts := totalRestarts(&p)
		lower := strings.ToLower(reason)
		if strings.Contains(lower, "crashloop") {
			stats.CrashLoopPods++
		} else if strings.Contains(lower, "error") ||
			strings.Contains(lower, "backoff") ||
			strings.Contains(lower, "failed") ||
			strings.Contains(lower, "imagepull") ||
			strings.Contains(lower, "err") {
			stats.ErrorPods++
		}

		unhealthyPods = append(unhealthyPods, UnhealthyPodSummary{
			Namespace: p.Namespace,
			Name:      p.Name,
			Reason:    reason,
			Restarts:  restarts,
		})
	}

	sort.Slice(unhealthyPods, func(i, j int) bool {
		if unhealthyPods[i].Restarts == unhealthyPods[j].Restarts {
			if unhealthyPods[i].Namespace == unhealthyPods[j].Namespace {
				return unhealthyPods[i].Name < unhealthyPods[j].Name
			}
			return unhealthyPods[i].Namespace < unhealthyPods[j].Namespace
		}
		return unhealthyPods[i].Restarts > unhealthyPods[j].Restarts
	})
	if len(unhealthyPods) > 30 {
		unhealthyPods = unhealthyPods[:30]
	}

	// ---- Problem services (no endpoints) ----
	serviceKeys := make(map[string]bool, len(svcList.Items))
	for _, s := range svcList.Items {
		serviceKeys[s.Namespace+"/"+s.Name] = true
	}

	var problemServices []ProblemServiceSummary
	for _, s := range svcList.Items {
		key := s.Namespace + "/" + s.Name

		// Only consider selector-based services (not ExternalName, etc.)
		hasSelector := len(s.Spec.Selector) > 0
		if !hasSelector {
			continue
		}

		// If it HAS endpoints -> not a problem
		if svcHasEndpoints[key] {
			continue
		}

		// IMPORTANT FIX:
		// If the service selector matches workloads and ALL of them are replicas=0, treat as "expected empty"
		matches := 0
		anyNonZero := false
		for _, w := range workloadsByNS[s.Namespace] {
			if labelsContainAll(w.Labels, s.Spec.Selector) {
				matches++
				if w.Replicas > 0 {
					anyNonZero = true
					break
				}
			}
		}
		// matched at least one workload but none running => ignore
		if matches > 0 && !anyNonZero {
			continue
		}

		// Otherwise: flag as real problem
		problemServices = append(problemServices, ProblemServiceSummary{
			Namespace: s.Namespace,
			Name:      s.Name,
			Type:      string(s.Spec.Type),
			ClusterIP: s.Spec.ClusterIP,
			Ports:     summarizeServicePorts(s.Spec.Ports),
			Reason:    "no_endpoints",
		})
	}

	sort.Slice(problemServices, func(i, j int) bool {
		if problemServices[i].Namespace == problemServices[j].Namespace {
			return problemServices[i].Name < problemServices[j].Name
		}
		return problemServices[i].Namespace < problemServices[j].Namespace
	})

	// ---- Problem ingresses (missing services) ----
	var problemIngresses []ProblemIngressSummary
	for _, ing := range ingList.Items {
		ns := ing.Namespace
		for _, rule := range ing.Spec.Rules {
			host := rule.Host
			if rule.HTTP == nil {
				continue
			}
			for _, p := range rule.HTTP.Paths {
				if p.Backend.Service == nil {
					continue
				}
				svcName := p.Backend.Service.Name
				key := ns + "/" + svcName
				if !serviceKeys[key] {
					svcPort := ""
					if p.Backend.Service.Port.Number != 0 {
						svcPort = strconv.Itoa(int(p.Backend.Service.Port.Number))
					} else if p.Backend.Service.Port.Name != "" {
						svcPort = p.Backend.Service.Port.Name
					}
					pathVal := p.Path
					if pathVal == "" {
						pathVal = "/"
					}
					problemIngresses = append(problemIngresses, ProblemIngressSummary{
						Namespace:   ns,
						Name:        ing.Name,
						Host:        host,
						Path:        pathVal,
						ServiceName: svcName,
						ServicePort: svcPort,
						Reason:      "service_not_found",
					})
				}
			}
		}
	}

	sort.Slice(problemIngresses, func(i, j int) bool {
		if problemIngresses[i].Namespace == problemIngresses[j].Namespace {
			if problemIngresses[i].Host == problemIngresses[j].Host {
				return problemIngresses[i].Name < problemIngresses[j].Name
			}
			return problemIngresses[i].Host < problemIngresses[j].Host
		}
		return problemIngresses[i].Namespace < problemIngresses[j].Namespace
	})

	resp := OverviewResponse{
		Stats:            stats,
		UnhealthyPods:    unhealthyPods,
		ProblemServices:  problemServices,
		ProblemIngresses: problemIngresses,
	}

	c.JSON(http.StatusOK, resp)
}

// (optional) you already import networkingv1 somewhere; keep linter happy if needed
var _ networkingv1.Ingress

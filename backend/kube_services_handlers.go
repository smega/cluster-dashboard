package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ServicePortLite struct {
	Name       string `json:"name,omitempty"`
	Protocol   string `json:"protocol,omitempty"`
	Port       int32  `json:"port,omitempty"`
	TargetPort string `json:"targetPort,omitempty"`
	NodePort   int32  `json:"nodePort,omitempty"`
}

type ServiceItem struct {
	Name         string            `json:"name"`
	Namespace    string            `json:"namespace"`
	Type         string            `json:"type"`
	ClusterIP    string            `json:"clusterIP,omitempty"`
	ExternalName string            `json:"externalName,omitempty"`
	Ports        []ServicePortLite `json:"ports,omitempty"`
	Selector     map[string]string `json:"selector,omitempty"`

	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
	Age         string            `json:"age"`

	// Selector ↔ Pod validation
	HasSelector     bool     `json:"hasSelector"`
	SelectorOK      bool     `json:"selectorOK"`
	SelectorChecked bool     `json:"selectorChecked"`
	SelectorError   string   `json:"selectorError,omitempty"`
	MatchingPods    int      `json:"matchingPods"`
	ReadyPods       int      `json:"readyPods"`
	PodNames        []string `json:"podNames,omitempty"` // small sample of matching pods
}

// GET /api/services
// Optional: ?namespace=<ns> (if empty or "all", returns all namespaces)
func servicesListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	nsQuery := c.Query("namespace")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 25*time.Second)
	defer cancel()

	var (
		svcList *corev1.ServiceList
		err     error
	)

	if nsQuery != "" && nsQuery != "all" {
		svcList, err = kubeClient.CoreV1().Services(nsQuery).List(ctx, metav1.ListOptions{})
	} else {
		svcList, err = kubeClient.CoreV1().Services(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list services: %v", err)})
		return
	}

	// Group services by namespace (so we list pods ONCE per namespace)
	svcsByNS := map[string][]*corev1.Service{}
	for i := range svcList.Items {
		svc := &svcList.Items[i]
		svcsByNS[svc.Namespace] = append(svcsByNS[svc.Namespace], svc)
	}

	// List pods once per namespace
	podsByNS := map[string][]corev1.Pod{}
	podsErrByNS := map[string]string{}
	for ns := range svcsByNS {
		pods, err := kubeClient.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			// we don’t fail the whole page — we mark selector checks as not checked
			podsErrByNS[ns] = err.Error()
			continue
		}
		podsByNS[ns] = pods.Items
	}

	items := make([]ServiceItem, 0, len(svcList.Items))
	for ns, svcs := range svcsByNS {
		pods := podsByNS[ns]
		podErr := podsErrByNS[ns]
		for _, svc := range svcs {
			items = append(items, makeServiceItem(svc, pods, podErr))
		}
	}

	// Sort: namespace then name
	sort.Slice(items, func(i, j int) bool {
		if items[i].Namespace == items[j].Namespace {
			return items[i].Name < items[j].Name
		}
		return items[i].Namespace < items[j].Namespace
	})

	c.JSON(http.StatusOK, gin.H{"items": items})
}

func makeServiceItem(svc *corev1.Service, pods []corev1.Pod, podErr string) ServiceItem {
	ports := make([]ServicePortLite, 0, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		tp := ""
		if p.TargetPort.Type == 0 {
			// intstr.Int is 0 in older k8s; String() is safe anyway
			tp = p.TargetPort.String()
		} else {
			tp = p.TargetPort.String()
		}
		ports = append(ports, ServicePortLite{
			Name:       p.Name,
			Protocol:   string(p.Protocol),
			Port:       p.Port,
			TargetPort: tp,
			NodePort:   p.NodePort,
		})
	}

	selector := svc.Spec.Selector
	hasSelector := len(selector) > 0
	selectorChecked := false
	selectorOK := true
	matching := 0
	ready := 0
	podNames := []string{}

	// Services that normally do NOT have selectors
	// - ExternalName
	// - some headless / manually managed services
	// For those, HasSelector=false and we treat validation as OK.
	if svc.Spec.Type == corev1.ServiceTypeExternalName {
		hasSelector = false
	}

	if hasSelector {
		if podErr != "" {
			selectorChecked = false
			selectorOK = false
		} else {
			selectorChecked = true
			for i := range pods {
				p := &pods[i]
				if labelsMatch(selector, p.Labels) {
					matching++
					if podIsReady(p) {
						ready++
					}
					if len(podNames) < 25 {
						podNames = append(podNames, p.Name)
					}
				}
			}
			selectorOK = matching > 0
		}
	}

	return ServiceItem{
		Name:         svc.Name,
		Namespace:    svc.Namespace,
		Type:         string(svc.Spec.Type),
		ClusterIP:    svc.Spec.ClusterIP,
		ExternalName: svc.Spec.ExternalName,
		Ports:        ports,
		Selector:     selector,
		Labels:       svc.Labels,
		Annotations:  svc.Annotations,
		Age:          ageString(svc.CreationTimestamp.Time),

		HasSelector:     hasSelector,
		SelectorOK:      selectorOK,
		SelectorChecked: selectorChecked,
		SelectorError:   podErr,
		MatchingPods:    matching,
		ReadyPods:       ready,
		PodNames:        podNames,
	}
}

func labelsMatch(sel, labels map[string]string) bool {
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

func podIsReady(p *corev1.Pod) bool {
	if p == nil {
		return false
	}
	if p.Status.Phase != corev1.PodRunning {
		return false
	}
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
			return true
		}
	}
	return false
}

// If you get compilation issues due to unused imports:
// - remove apierrors import above.
// Kept here because some clusters throw NotFound for Pods list with RBAC misconfig;
// you can use it if you want richer handling later.
var _ = apierrors.IsNotFound

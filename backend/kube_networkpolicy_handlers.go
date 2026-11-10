// kube_networkpolicy_handlers.go
package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type NetpolItem struct {
	Kind      string `json:"kind"` // "NetworkPolicy"
	Name      string `json:"name"`
	Namespace string `json:"namespace"`

	PodSelector string   `json:"podSelector,omitempty"`
	Types       []string `json:"types,omitempty"`

	IngressRules int `json:"ingressRules"`
	EgressRules  int `json:"egressRules"`

	DefaultDenyIngress bool `json:"defaultDenyIngress"`
	DefaultDenyEgress  bool `json:"defaultDenyEgress"`

	Age string `json:"age"`
}

type NetpolDetail struct {
	Kind      string `json:"kind"`
	APIVer    string `json:"apiVersion"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Age       string `json:"age"`

	PodSelector string   `json:"podSelector,omitempty"`
	Types       []string `json:"types,omitempty"`

	IngressRules int `json:"ingressRules"`
	EgressRules  int `json:"egressRules"`

	DefaultDenyIngress bool `json:"defaultDenyIngress"`
	DefaultDenyEgress  bool `json:"defaultDenyEgress"`

	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`

	// return spec raw as well (useful)
	Spec networkingv1.NetworkPolicySpec `json:"spec"`
}

// GET /api/kube/networkpolicies?namespace=all|<ns>
func kubeNetworkPoliciesListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	nsQuery := strings.TrimSpace(c.Query("namespace"))
	if nsQuery == "" || strings.EqualFold(nsQuery, "all") {
		nsQuery = ""
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	// Namespaces (for dropdown + "zero netpol" warning)
	allNamespaces := []string{}
	nsList, nsErr := kubeClient.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if nsErr == nil {
		for i := range nsList.Items {
			allNamespaces = append(allNamespaces, nsList.Items[i].Name)
		}
		sort.Strings(allNamespaces)
	}

	// NetworkPolicies
	var npl *networkingv1.NetworkPolicyList
	var err error
	if nsQuery != "" {
		npl, err = kubeClient.NetworkingV1().NetworkPolicies(nsQuery).List(ctx, metav1.ListOptions{})
	} else {
		npl, err = kubeClient.NetworkingV1().NetworkPolicies(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list networkpolicies: %v", err)})
		return
	}

	now := time.Now()

	items := make([]NetpolItem, 0, len(npl.Items))
	nsCount := map[string]int{}

	for i := range npl.Items {
		np := &npl.Items[i]
		nsCount[np.Namespace]++

		types := netpolTypes(np)
		sel := netpolSelectorString(np.Spec.PodSelector)

		ddI := contains(types, "Ingress") && len(np.Spec.Ingress) == 0
		ddE := contains(types, "Egress") && len(np.Spec.Egress) == 0

		items = append(items, NetpolItem{
			Kind:      "NetworkPolicy",
			Name:      np.Name,
			Namespace: np.Namespace,

			PodSelector: sel,
			Types:       types,

			IngressRules: len(np.Spec.Ingress),
			EgressRules:  len(np.Spec.Egress),

			DefaultDenyIngress: ddI,
			DefaultDenyEgress:  ddE,

			Age: humanAge(np.CreationTimestamp.Time, now),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].Namespace == items[j].Namespace {
			return items[i].Name < items[j].Name
		}
		return items[i].Namespace < items[j].Namespace
	})

	// namespaces list (prefer real namespace list; fallback derived from items)
	namespaces := allNamespaces
	if len(namespaces) == 0 {
		set := map[string]struct{}{}
		for _, it := range items {
			set[it.Namespace] = struct{}{}
		}
		for ns := range set {
			namespaces = append(namespaces, ns)
		}
		sort.Strings(namespaces)
	}

	// namespaces with zero netpols (if we could list namespaces)
	zero := []string{}
	if len(allNamespaces) > 0 {
		if nsQuery != "" {
			if nsCount[nsQuery] == 0 {
				zero = append(zero, nsQuery)
			}
		} else {
			for _, ns := range allNamespaces {
				if nsCount[ns] == 0 {
					zero = append(zero, ns)
				}
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"items":          items,
		"namespaces":     namespaces,
		"zeroNamespaces": zero,
	})
}

// GET /api/kube/networkpolicies/:namespace/:name
func kubeNetworkPolicyDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kubernetes client not initialized"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	np, err := kubeClient.NetworkingV1().NetworkPolicies(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "networkpolicy not found"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get networkpolicy %s/%s: %v", ns, name, err)})
		return
	}

	types := netpolTypes(np)
	sel := netpolSelectorString(np.Spec.PodSelector)

	ddI := contains(types, "Ingress") && len(np.Spec.Ingress) == 0
	ddE := contains(types, "Egress") && len(np.Spec.Egress) == 0

	c.JSON(http.StatusOK, NetpolDetail{
		Kind:      "NetworkPolicy",
		APIVer:    "networking.k8s.io/v1",
		Name:      np.Name,
		Namespace: np.Namespace,
		Age:       humanAge(np.CreationTimestamp.Time, time.Now()),

		PodSelector: sel,
		Types:       types,

		IngressRules: len(np.Spec.Ingress),
		EgressRules:  len(np.Spec.Egress),

		DefaultDenyIngress: ddI,
		DefaultDenyEgress:  ddE,

		Labels:      np.Labels,
		Annotations: np.Annotations,
		Spec:        np.Spec,
	})
}

// ---- helpers

func netpolTypes(np *networkingv1.NetworkPolicy) []string {
	out := []string{}
	if np == nil {
		return out
	}

	if len(np.Spec.PolicyTypes) > 0 {
		for _, t := range np.Spec.PolicyTypes {
			out = append(out, string(t))
		}
	} else {
		// K8s default: Ingress; add Egress if egress rules exist
		out = append(out, "Ingress")
		if len(np.Spec.Egress) > 0 {
			out = append(out, "Egress")
		}
	}

	// stable
	m := map[string]struct{}{}
	uniq := []string{}
	for _, s := range out {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, ok := m[s]; ok {
			continue
		}
		m[s] = struct{}{}
		uniq = append(uniq, s)
	}
	sort.Strings(uniq)
	return uniq
}

func netpolSelectorString(ls metav1.LabelSelector) string {
	// LabelSelectorAsSelector returns empty selector string for "match everything".
	sel, err := metav1.LabelSelectorAsSelector(&ls)
	if err != nil {
		return "invalid-selector"
	}
	s := strings.TrimSpace(sel.String())
	if s == "" {
		return "<all pods>"
	}
	return s
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

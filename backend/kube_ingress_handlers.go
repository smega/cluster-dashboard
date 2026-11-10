// kube_ingresses_handlers.go
package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type IngressBackendRef struct {
	ServiceName string `json:"serviceName,omitempty"`
	ServicePort string `json:"servicePort,omitempty"`
}

type IngressPath struct {
	Path      string            `json:"path"`
	PathType  string            `json:"pathType,omitempty"`
	Backend   IngressBackendRef `json:"backend"`
	BackendOK bool              `json:"backendOK"`
}

type IngressRuleItem struct {
	Host  string        `json:"host"`
	Paths []IngressPath `json:"paths"`
}

type IngressItem struct {
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace"`
	ClassName   string            `json:"className,omitempty"`
	Rules       []IngressRuleItem `json:"rules"`
	TLSHosts    []string          `json:"tlsHosts,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
	Age         string            `json:"age"`

	DefaultBackend  *IngressBackendRef `json:"defaultBackend,omitempty"`
	BackendsOK      bool               `json:"backendsOK"`
	MissingBackends []string           `json:"missingBackends,omitempty"`
}

// GET /api/ingresses
// Optional: ?namespace=<ns> (if empty or "all", returns all namespaces)
func ingressesListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	nsQuery := c.Query("namespace") // may be "", "all" or specific ns

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	var (
		ingList *networkingv1.IngressList
		err     error
	)

	if nsQuery != "" && nsQuery != "all" {
		ingList, err = kubeClient.NetworkingV1().Ingresses(nsQuery).List(ctx, metav1.ListOptions{})
	} else {
		ingList, err = kubeClient.NetworkingV1().Ingresses("").List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list ingresses: %v", err)})
		return
	}

	// Group ingresses by namespace
	ingByNS := map[string][]*networkingv1.Ingress{}
	for i := range ingList.Items {
		ing := &ingList.Items[i]
		ns := ing.Namespace
		ingByNS[ns] = append(ingByNS[ns], ing)
	}

	// For each namespace that has ingresses, list Services ONCE
	servicesByNS := map[string]map[string]bool{}
	for ns := range ingByNS {
		svcs, err := kubeClient.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			fmt.Printf("warn: list services for ingresses in ns=%s: %v\n", ns, err)
			continue
		}
		sset := make(map[string]bool, len(svcs.Items))
		for i := range svcs.Items {
			sset[svcs.Items[i].Name] = true
		}
		servicesByNS[ns] = sset
	}

	items := make([]IngressItem, 0, len(ingList.Items))
	for i := range ingList.Items {
		ing := &ingList.Items[i]
		svcSet := servicesByNS[ing.Namespace]
		items = append(items, makeIngressItem(ing, svcSet))
	}

	// Sort: namespace, then name
	sort.Slice(items, func(i, j int) bool {
		if items[i].Namespace == items[j].Namespace {
			return items[i].Name < items[j].Name
		}
		return items[i].Namespace < items[j].Namespace
	})

	c.JSON(http.StatusOK, gin.H{
		"items": items,
	})
}

func makeIngressItem(ing *networkingv1.Ingress, svcSet map[string]bool) IngressItem {
	ns := ing.Namespace

	// TLS hosts (de-duplicated)
	tlsHostsSet := map[string]bool{}
	for _, t := range ing.Spec.TLS {
		for _, h := range t.Hosts {
			if h != "" {
				tlsHostsSet[h] = true
			}
		}
	}
	tlsHosts := make([]string, 0, len(tlsHostsSet))
	for h := range tlsHostsSet {
		tlsHosts = append(tlsHosts, h)
	}
	sort.Strings(tlsHosts)

	// Default backend
	var defaultBackend *IngressBackendRef
	backendsOK := true
	missingSet := map[string]bool{}

	if db := ing.Spec.DefaultBackend; db != nil && db.Service != nil {
		ref, ok := ingressBackendFromServiceBackend(db.Service, svcSet)
		defaultBackend = &ref
		if !ok && ref.ServiceName != "" {
			backendsOK = false
			missingSet[fmt.Sprintf("%s/%s", ns, ref.ServiceName)] = true
		}
	}

	// Rules & paths
	rules := make([]IngressRuleItem, 0, len(ing.Spec.Rules))
	for _, r := range ing.Spec.Rules {
		ri := IngressRuleItem{Host: r.Host}
		if r.HTTP != nil {
			for _, p := range r.HTTP.Paths {
				ref, ok := ingressBackendFromServiceBackend(p.Backend.Service, svcSet)
				ip := IngressPath{
					Path:      p.Path,
					PathType:  pathTypeToString(p.PathType),
					Backend:   ref,
					BackendOK: ok,
				}
				if !ok && ref.ServiceName != "" {
					backendsOK = false
					missingSet[fmt.Sprintf("%s/%s", ns, ref.ServiceName)] = true
				}
				ri.Paths = append(ri.Paths, ip)
			}
		}
		rules = append(rules, ri)
	}

	missing := make([]string, 0, len(missingSet))
	for k := range missingSet {
		missing = append(missing, k)
	}
	sort.Strings(missing)

	return IngressItem{
		Name:        ing.Name,
		Namespace:   ns,
		ClassName:   ingressClassName(ing),
		Rules:       rules,
		TLSHosts:    tlsHosts,
		Labels:      ing.Labels,
		Annotations: ing.Annotations,
		Age:         ingressAgeString(ing.CreationTimestamp.Time),

		DefaultBackend:  defaultBackend,
		BackendsOK:      backendsOK,
		MissingBackends: missing,
	}
}

func ingressBackendFromServiceBackend(sb *networkingv1.IngressServiceBackend, svcSet map[string]bool) (IngressBackendRef, bool) {
	if sb == nil {
		// Not a Service backend (e.g. custom resource) – we don't try to validate it.
		return IngressBackendRef{}, true
	}

	ref := IngressBackendRef{
		ServiceName: sb.Name,
	}
	if sb.Port.Name != "" {
		ref.ServicePort = sb.Port.Name
	} else if sb.Port.Number != 0 {
		ref.ServicePort = fmt.Sprintf("%d", sb.Port.Number)
	}

	ok := true
	if svcSet != nil && sb.Name != "" {
		ok = svcSet[sb.Name]
	}
	return ref, ok
}

func pathTypeToString(pt *networkingv1.PathType) string {
	if pt == nil {
		return ""
	}
	return string(*pt)
}

func ingressClassName(ing *networkingv1.Ingress) string {
	if ing.Spec.IngressClassName != nil && *ing.Spec.IngressClassName != "" {
		return *ing.Spec.IngressClassName
	}
	// fallback legacy annotation
	if v, ok := ing.Annotations["kubernetes.io/ingress.class"]; ok && v != "" {
		return v
	}
	return ""
}

func ingressAgeString(t time.Time) string {
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

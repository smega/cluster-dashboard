package main

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	appslisters "k8s.io/client-go/listers/apps/v1"
	corelisters "k8s.io/client-go/listers/core/v1"
	discoverylisters "k8s.io/client-go/listers/discovery/v1"
	networklisters "k8s.io/client-go/listers/networking/v1"
	"k8s.io/client-go/tools/cache"
)

type TopologyManager struct {
	inf informers.SharedInformerFactory

	podsL corelisters.PodLister
	svcL  corelisters.ServiceLister
	esL   discoverylisters.EndpointSliceLister
	ingL  networklisters.IngressLister

	deployL appslisters.DeploymentLister
	rsL     appslisters.ReplicaSetLister
	stsL    appslisters.StatefulSetLister
	dsL     appslisters.DaemonSetLister

	synced uint32

	mu   sync.Mutex
	subs map[string]map[chan struct{}]struct{} // ns -> subscribers
}

func NewTopologyManager(kube kubernetes.Interface) *TopologyManager {
	inf := informers.NewSharedInformerFactory(kube, 0)

	tm := &TopologyManager{
		inf:  inf,
		subs: map[string]map[chan struct{}]struct{}{},
	}

	tm.podsL = inf.Core().V1().Pods().Lister()
	tm.svcL = inf.Core().V1().Services().Lister()
	tm.esL = inf.Discovery().V1().EndpointSlices().Lister()
	tm.ingL = inf.Networking().V1().Ingresses().Lister()

	tm.deployL = inf.Apps().V1().Deployments().Lister()
	tm.rsL = inf.Apps().V1().ReplicaSets().Lister()
	tm.stsL = inf.Apps().V1().StatefulSets().Lister()
	tm.dsL = inf.Apps().V1().DaemonSets().Lister()

	handlers := cache.ResourceEventHandlerFuncs{
		AddFunc:    tm.onObj,
		UpdateFunc: func(_, newObj any) { tm.onObj(newObj) },
		DeleteFunc: tm.onObj,
	}

	inf.Core().V1().Pods().Informer().AddEventHandler(handlers)
	inf.Core().V1().Services().Informer().AddEventHandler(handlers)
	inf.Discovery().V1().EndpointSlices().Informer().AddEventHandler(handlers)
	inf.Networking().V1().Ingresses().Informer().AddEventHandler(handlers)

	inf.Apps().V1().Deployments().Informer().AddEventHandler(handlers)
	inf.Apps().V1().ReplicaSets().Informer().AddEventHandler(handlers)
	inf.Apps().V1().StatefulSets().Informer().AddEventHandler(handlers)
	inf.Apps().V1().DaemonSets().Informer().AddEventHandler(handlers)

	return tm
}

func (tm *TopologyManager) Start(ctx context.Context) {
	log.Printf("[topology] starting informers...")
	tm.inf.Start(ctx.Done())

	syncMap := tm.inf.WaitForCacheSync(ctx.Done())
	okAll := true
	for typ, ok := range syncMap {
		if !ok {
			okAll = false
			log.Printf("[topology] cache NOT synced: %v", typ)
		}
	}
	if okAll {
		atomic.StoreUint32(&tm.synced, 1)
		log.Printf("[topology] caches synced: ready")
	} else {
		log.Printf("[topology] caches not fully synced (RBAC/watch or context issue)")
	}
}

func (tm *TopologyManager) IsReady() bool {
	return atomic.LoadUint32(&tm.synced) == 1
}

func (tm *TopologyManager) Subscribe(namespace string) (ch <-chan struct{}, cancel func()) {
	c := make(chan struct{}, 1)

	tm.mu.Lock()
	if tm.subs[namespace] == nil {
		tm.subs[namespace] = map[chan struct{}]struct{}{}
	}
	tm.subs[namespace][c] = struct{}{}
	tm.mu.Unlock()

	cancel = func() {
		tm.mu.Lock()
		if tm.subs[namespace] != nil {
			delete(tm.subs[namespace], c)
			if len(tm.subs[namespace]) == 0 {
				delete(tm.subs, namespace)
			}
		}
		tm.mu.Unlock()
		close(c)
	}
	return c, cancel
}

func (tm *TopologyManager) notify(namespace string) {
	tm.mu.Lock()
	subs := tm.subs[namespace]
	tm.mu.Unlock()

	for ch := range subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (tm *TopologyManager) onObj(obj any) {
	ns := tm.extractNamespace(obj)
	if ns != "" {
		tm.notify(ns)
	}
}

func (tm *TopologyManager) extractNamespace(obj any) string {
	switch o := obj.(type) {
	case *corev1.Pod:
		return o.Namespace
	case *corev1.Service:
		return o.Namespace
	case *discoveryv1.EndpointSlice:
		return o.Namespace
	case *networkingv1.Ingress:
		return o.Namespace
	case *appsv1.Deployment:
		return o.Namespace
	case *appsv1.ReplicaSet:
		return o.Namespace
	case *appsv1.StatefulSet:
		return o.Namespace
	case *appsv1.DaemonSet:
		return o.Namespace
	default:
		if tomb, ok := obj.(cache.DeletedFinalStateUnknown); ok {
			return tm.extractNamespace(tomb.Obj)
		}
	}
	return ""
}

func (tm *TopologyManager) nodeID(kind, ns, name string) string { return kind + "/" + ns + "/" + name }

// --------------------
// Status + readiness helpers (methods => avoid package collisions)
// --------------------

func (tm *TopologyManager) desiredReplicas(ptr *int32, def int32) int32 {
	if ptr == nil {
		return def
	}
	return *ptr
}

func (tm *TopologyManager) workloadStatus(ready, desired int32) (status string, detail map[string]any) {
	if desired <= 0 {
		return "Idle", map[string]any{"ready": ready, "desired": desired}
	}
	if ready >= desired {
		return fmt.Sprintf("Ready %d/%d", ready, desired), map[string]any{"ready": ready, "desired": desired}
	}
	return fmt.Sprintf("Progressing %d/%d", ready, desired), map[string]any{"ready": ready, "desired": desired}
}

func (tm *TopologyManager) isPodReady(p *corev1.Pod) bool {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
			return true
		}
	}
	return false
}

func (tm *TopologyManager) podStatus(p *corev1.Pod) (status string, reason string) {
	if p.DeletionTimestamp != nil {
		return "Terminating", "deletionTimestamp set"
	}

	// Prefer explicit waiting reasons (init containers first)
	if p.Status.Phase == corev1.PodPending {
		for _, cs := range p.Status.InitContainerStatuses {
			if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
				return cs.State.Waiting.Reason, cs.State.Waiting.Message
			}
		}
		for _, cs := range p.Status.ContainerStatuses {
			if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
				return cs.State.Waiting.Reason, cs.State.Waiting.Message
			}
		}
		return "Pending", ""
	}

	// Running: surface CrashLoopBackOff / ImagePullBackOff etc if present
	if p.Status.Phase == corev1.PodRunning {
		for _, cs := range p.Status.ContainerStatuses {
			if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
				return cs.State.Waiting.Reason, cs.State.Waiting.Message
			}
		}
		if tm.isPodReady(p) {
			return "Ready", ""
		}
		return "Running", "pod not ready"
	}

	switch p.Status.Phase {
	case corev1.PodSucceeded:
		return "Succeeded", ""
	case corev1.PodFailed:
		// try to surface reason/message
		if p.Status.Reason != "" {
			return "Failed", p.Status.Reason
		}
		return "Failed", ""
	default:
		return string(p.Status.Phase), ""
	}
}

func (tm *TopologyManager) containerStatus(containerName string, statuses []corev1.ContainerStatus) (status string, reason string) {
	for _, cs := range statuses {
		if cs.Name != containerName {
			continue
		}
		if cs.State.Waiting != nil {
			if cs.State.Waiting.Reason != "" {
				return cs.State.Waiting.Reason, cs.State.Waiting.Message
			}
			return "Waiting", cs.State.Waiting.Message
		}
		if cs.State.Terminated != nil {
			if cs.State.Terminated.Reason != "" {
				return "Terminated:" + cs.State.Terminated.Reason, cs.State.Terminated.Message
			}
			return "Terminated", cs.State.Terminated.Message
		}
		if cs.State.Running != nil {
			if cs.Ready {
				return "Ready", ""
			}
			return "Running", "container not ready"
		}
		return "Unknown", ""
	}
	return "Unknown", ""
}

func (tm *TopologyManager) endpointCondReady(ep discoveryv1.Endpoint) (ready bool, known bool) {
	if ep.Conditions.Ready == nil {
		return false, false
	}
	return *ep.Conditions.Ready, true
}

func (tm *TopologyManager) lbAddrsCore(ings []corev1.LoadBalancerIngress) []string {
	out := []string{}
	for _, x := range ings {
		if x.IP != "" {
			out = append(out, x.IP)
		} else if x.Hostname != "" {
			out = append(out, x.Hostname)
		}
	}
	return out
}

func (tm *TopologyManager) lbAddrsIngress(ings []networkingv1.IngressLoadBalancerIngress) []string {
	out := []string{}
	for _, x := range ings {
		if x.IP != "" {
			out = append(out, x.IP)
		} else if x.Hostname != "" {
			out = append(out, x.Hostname)
		}
	}
	return out
}

func (tm *TopologyManager) ingressHosts(ing *networkingv1.Ingress) []string {
	set := map[string]struct{}{}

	for _, r := range ing.Spec.Rules {
		h := strings.TrimSpace(r.Host)
		if h == "" {
			set["(all hosts)"] = struct{}{}
			continue
		}
		set[h] = struct{}{}
	}

	for _, t := range ing.Spec.TLS {
		for _, h := range t.Hosts {
			h = strings.TrimSpace(h)
			if h == "" {
				continue
			}
			set[h] = struct{}{}
		}
	}

	out := make([]string, 0, len(set))
	for h := range set {
		out = append(out, h)
	}
	sort.Strings(out)
	return out
}

func (tm *TopologyManager) ingressHostLabel(hosts []string, fallback string) string {
	if len(hosts) == 0 {
		return fallback
	}
	if len(hosts) == 1 {
		return hosts[0]
	}
	if len(hosts) == 2 {
		return hosts[0] + "\n" + hosts[1]
	}
	return hosts[0] + "\n" + hosts[1] + fmt.Sprintf("\n+%d", len(hosts)-2)
}

// Note: json tags must stay stable for your frontend.
type topoIngressPathInfo struct {
	Host         string `json:"host"`
	Path         string `json:"path"`
	PathType     string `json:"pathType,omitempty"`
	Service      string `json:"service"`
	Port         any    `json:"port,omitempty"`
	Default      bool   `json:"default,omitempty"`
	BackendState string `json:"backendState,omitempty"`   // ready|down|unknown
	ReadyPods    int    `json:"readyPods,omitempty"`      // service-side
	ReadyEPs     int    `json:"readyEndpoints,omitempty"` // service-side
	BackendWhy   string `json:"backendReason,omitempty"`
}

func (tm *TopologyManager) backendPortToAny(p networkingv1.ServiceBackendPort) any {
	if p.Number != 0 {
		return p.Number
	}
	if p.Name != "" {
		return p.Name
	}
	return nil
}

type topoSvcInfo struct {
	Name string

	// selector match info (fallback)
	MatchingPods int
	ReadyPods    int

	// endpoint slice info (preferred)
	TotalEPs   int
	ReadyEPs   int
	UnknownEPs int

	BackendState  string // ready|down|unknown
	BackendReason string
}

// --------------------
// BuildSnapshot
// --------------------

func (tm *TopologyManager) BuildSnapshot(ctx context.Context, ns string) (TopologyGraph, error) {
	if tm == nil {
		return TopologyGraph{}, fmt.Errorf("topology manager not configured")
	}
	if !tm.IsReady() {
		return TopologyGraph{}, fmt.Errorf("topology informers not ready (cache not synced yet)")
	}

	g := TopologyGraph{
		Namespace:   ns,
		GeneratedAt: time.Now().UTC(),
		Nodes:       []TopologyNode{},
		Edges:       []TopologyEdge{},
	}

	addNode := func(n TopologyNode) { g.Nodes = append(g.Nodes, n) }
	addEdge := func(from, to, kind string, meta map[string]any) {
		id := fmt.Sprintf("%s->%s:%s", from, to, kind)
		g.Edges = append(g.Edges, TopologyEdge{ID: id, From: from, To: to, Kind: kind, Meta: meta})
	}

	selAll := labels.Everything()

	pods, err := tm.podsL.Pods(ns).List(selAll)
	if err != nil {
		return g, err
	}
	svcs, err := tm.svcL.Services(ns).List(selAll)
	if err != nil {
		return g, err
	}
	ings, err := tm.ingL.Ingresses(ns).List(selAll)
	if err != nil {
		return g, err
	}
	slices, err := tm.esL.EndpointSlices(ns).List(selAll)
	if err != nil {
		return g, err
	}

	deploys, _ := tm.deployL.Deployments(ns).List(selAll)
	stss, _ := tm.stsL.StatefulSets(ns).List(selAll)
	dss, _ := tm.dsL.DaemonSets(ns).List(selAll)

	// --------------------
	// Precompute pod readiness + label selectors
	// --------------------
	podReady := map[string]bool{} // podName -> ready
	for _, p := range pods {
		podReady[p.Name] = tm.isPodReady(p)
	}

	// --------------------
	// Build svc readiness map (EndpointSlice preferred, selector fallback)
	// --------------------
	svcInfo := map[string]*topoSvcInfo{}
	getSvcInfo := func(name string) *topoSvcInfo {
		if svcInfo[name] == nil {
			svcInfo[name] = &topoSvcInfo{Name: name, BackendState: "unknown", BackendReason: "no data"}
		}
		return svcInfo[name]
	}

	// EndpointSlice counts
	for _, sl := range slices {
		svcName := sl.Labels["kubernetes.io/service-name"]
		if svcName == "" {
			continue
		}
		info := getSvcInfo(svcName)

		for _, ep := range sl.Endpoints {
			info.TotalEPs++

			ready, known := tm.endpointCondReady(ep)
			if !known {
				info.UnknownEPs++
				continue
			}
			if ready {
				info.ReadyEPs++
			}
		}
	}

	// Selector fallback counts
	for _, s := range svcs {
		if len(s.Spec.Selector) == 0 {
			continue
		}
		info := getSvcInfo(s.Name)

		sel := labels.SelectorFromSet(s.Spec.Selector)
		for _, p := range pods {
			if sel.Matches(labels.Set(p.Labels)) {
				info.MatchingPods++
				if podReady[p.Name] {
					info.ReadyPods++
				}
			}
		}
	}

	// Decide per-service backendState
	for _, s := range svcs {
		info := getSvcInfo(s.Name)

		// prefer EndpointSlice signal if present
		if info.TotalEPs > 0 || info.UnknownEPs > 0 {
			if info.ReadyEPs > 0 {
				info.BackendState = "ready"
				info.BackendReason = ""
			} else if info.UnknownEPs > 0 {
				info.BackendState = "unknown"
				info.BackendReason = "endpoints readiness unknown"
			} else {
				info.BackendState = "down"
				info.BackendReason = "no ready endpoints"
			}
			continue
		}

		// fallback: selector match
		if len(s.Spec.Selector) > 0 {
			if info.MatchingPods == 0 {
				info.BackendState = "down"
				info.BackendReason = "no matching pods (scaled down / selector mismatch)"
			} else if info.ReadyPods == 0 {
				info.BackendState = "down"
				info.BackendReason = "matching pods exist but none Ready"
			} else {
				info.BackendState = "ready"
				info.BackendReason = ""
			}
			continue
		}

		info.BackendState = "unknown"
		info.BackendReason = "no selector and no endpoints"
	}

	// --------------------
	// Workloads
	// --------------------
	for _, d := range deploys {
		desired := tm.desiredReplicas(d.Spec.Replicas, 1)
		st, det := tm.workloadStatus(d.Status.ReadyReplicas, desired)

		addNode(TopologyNode{
			ID:        tm.nodeID("Deployment", ns, d.Name),
			Kind:      "Deployment",
			Namespace: ns,
			Name:      d.Name,
			Status:    st,
			Detail: map[string]any{
				"desired": desired,
				"ready":   d.Status.ReadyReplicas,
				"updated": d.Status.UpdatedReplicas,
				"detail":  det,
			},
		})
	}

	for _, s := range stss {
		desired := tm.desiredReplicas(s.Spec.Replicas, 1)
		st, det := tm.workloadStatus(s.Status.ReadyReplicas, desired)
		addNode(TopologyNode{
			ID:        tm.nodeID("StatefulSet", ns, s.Name),
			Kind:      "StatefulSet",
			Namespace: ns,
			Name:      s.Name,
			Status:    st,
			Detail:    det,
		})
	}

	for _, d := range dss {
		desired := d.Status.DesiredNumberScheduled
		ready := d.Status.NumberReady
		st, det := tm.workloadStatus(ready, desired)
		addNode(TopologyNode{
			ID:        tm.nodeID("DaemonSet", ns, d.Name),
			Kind:      "DaemonSet",
			Namespace: ns,
			Name:      d.Name,
			Status:    st,
			Detail:    det,
		})
	}

	// --------------------
	// Services (+ optional public endpoint) with richer status
	// --------------------
	for _, s := range svcs {
		info := svcInfo[s.Name]
		sid := tm.nodeID("Service", ns, s.Name)

		// Service status to display
		status := "Ready"
		reason := ""

		// backend state signal
		if info != nil {
			if info.BackendState == "down" {
				// differentiate a bit
				if info.TotalEPs == 0 && info.MatchingPods == 0 {
					status = "NoEndpoints"
				} else {
					status = "NotReady"
				}
				reason = info.BackendReason
			} else if info.BackendState == "unknown" {
				status = "Unknown"
				reason = info.BackendReason
			}
		}

		// LB provisioning signal (only if backend not already "down")
		if s.Spec.Type == corev1.ServiceTypeLoadBalancer && len(s.Status.LoadBalancer.Ingress) == 0 {
			if status == "Ready" || status == "Unknown" {
				status = "Provisioning"
				if reason == "" {
					reason = "waiting for load balancer address"
				}
			}
		}

		addNode(TopologyNode{
			ID:        sid,
			Kind:      "Service",
			Namespace: ns,
			Name:      s.Name,
			Status:    status,
			Detail: map[string]any{
				"type":           string(s.Spec.Type),
				"clusterIP":      s.Spec.ClusterIP,
				"backendState":   info.BackendState,
				"backendReason":  reason,
				"matchingPods":   info.MatchingPods,
				"readyPods":      info.ReadyPods,
				"totalEndpoints": info.TotalEPs,
				"readyEndpoints": info.ReadyEPs,
				"unknownEPs":     info.UnknownEPs,
			},
		})

		if s.Spec.Type == corev1.ServiceTypeLoadBalancer && len(s.Status.LoadBalancer.Ingress) > 0 {
			pubID := "PublicEndpoint/" + ns + "/svc-" + s.Name
			addNode(TopologyNode{
				ID:        pubID,
				Kind:      "PublicEndpoint",
				Namespace: ns,
				Name:      s.Name,
				Status:    "Ready",
				Detail: map[string]any{
					"addresses": tm.lbAddrsCore(s.Status.LoadBalancer.Ingress),
				},
			})
			addEdge(pubID, sid, "public_to_service", nil)
		}
	}

	// --------------------
	// Ingresses (+ optional public endpoint) and edges to service backends
	// --------------------
	for _, ing := range ings {
		iid := tm.nodeID("Ingress", ns, ing.Name)

		hosts := tm.ingressHosts(ing)
		label := tm.ingressHostLabel(hosts, ing.Name)

		className := ""
		if ing.Spec.IngressClassName != nil {
			className = *ing.Spec.IngressClassName
		}

		// Build ingress paths + attach backend readiness from svcInfo
		paths := tm.ingressPathsWithBackend(ing, svcInfo)

		// Ingress status
		status := "Ready"
		reason := ""

		// address provisioning
		if len(ing.Status.LoadBalancer.Ingress) == 0 {
			status = "Provisioning"
			reason = "waiting for ingress address"
		}

		// backend summary: if all backends are down => NoBackends (dominant)
		backendSvcs := tm.ingressBackendServices(ing)
		if len(backendSvcs) > 0 {
			anyReady := false
			anyUnknown := false
			for s := range backendSvcs {
				info := svcInfo[s]
				if info == nil {
					anyUnknown = true
					continue
				}
				switch info.BackendState {
				case "ready":
					anyReady = true
				case "unknown":
					anyUnknown = true
				case "down":
					// keep scanning
				default:
					anyUnknown = true
				}
			}

			if !anyReady && !anyUnknown {
				status = "NoBackends"
				reason = "all backend services have 0 ready endpoints"
			} else if !anyReady && anyUnknown {
				// keep Provisioning/Ready but annotate
				if reason == "" {
					reason = "backend readiness unknown"
				}
				if status == "Ready" {
					status = "Unknown"
				}
			}
		}

		addNode(TopologyNode{
			ID:        iid,
			Kind:      "Ingress",
			Namespace: ns,

			// show hosts on node label
			Name:   label,
			Status: status,

			Detail: map[string]any{
				"ingressName": ing.Name,
				"hosts":       hosts,
				"paths":       paths,
				"className":   className,
				"reason":      reason,
			},
		})

		if len(ing.Status.LoadBalancer.Ingress) > 0 {
			pubID := "PublicEndpoint/" + ns + "/ing-" + ing.Name
			addNode(TopologyNode{
				ID:        pubID,
				Kind:      "PublicEndpoint",
				Namespace: ns,
				Name:      ing.Name,
				Status:    "Ready",
				Detail: map[string]any{
					"addresses": tm.lbAddrsIngress(ing.Status.LoadBalancer.Ingress),
				},
			})
			addEdge(pubID, iid, "public_to_ingress", nil)
		}

		// edges to services
		if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil {
			svcName := ing.Spec.DefaultBackend.Service.Name
			addEdge(iid, tm.nodeID("Service", ns, svcName), "ingress_backend", map[string]any{
				"port": tm.backendPortToAny(ing.Spec.DefaultBackend.Service.Port),
			})
		}

		for _, r := range ing.Spec.Rules {
			if r.HTTP == nil {
				continue
			}
			for _, p := range r.HTTP.Paths {
				if p.Backend.Service == nil {
					continue
				}
				meta := map[string]any{
					"host": r.Host,
					"path": p.Path,
					"port": tm.backendPortToAny(p.Backend.Service.Port),
				}
				addEdge(iid, tm.nodeID("Service", ns, p.Backend.Service.Name), "ingress_backend", meta)
			}
		}
	}

	// --------------------
	// Pods + containers + workload->pod edges
	// --------------------
	for _, p := range pods {
		pid := tm.nodeID("Pod", ns, p.Name)
		pst := ""
		preason := ""
		pst, preason = tm.podStatus(p)

		addNode(TopologyNode{
			ID:        pid,
			Kind:      "Pod",
			Namespace: ns,
			Name:      p.Name,
			Status:    pst,
			Detail: map[string]any{
				"node":   p.Spec.NodeName,
				"ip":     p.Status.PodIP,
				"ready":  podReady[p.Name],
				"reason": preason,
			},
		})

		if ok, k, n := tm.resolveTopOwner(ns, p); ok {
			addEdge(tm.nodeID(k, ns, n), pid, "workload_pod", nil)
		}

		for _, c := range p.Spec.Containers {
			cid := "Container/" + ns + "/" + p.Name + "/" + c.Name
			cst, creason := tm.containerStatus(c.Name, p.Status.ContainerStatuses)

			addNode(TopologyNode{
				ID:        cid,
				Kind:      "Container",
				Namespace: ns,
				Name:      c.Name,
				Status:    cst,
				Detail: map[string]any{
					"reason": creason,
				},
			})
			addEdge(pid, cid, "pod_container", nil)
		}
	}

	// --------------------
	// Service -> Pod edges using EndpointSlices (best) else selector matching
	// --------------------
	if len(slices) > 0 {
		for _, sl := range slices {
			svcName := sl.Labels["kubernetes.io/service-name"]
			if svcName == "" {
				continue
			}
			sid := tm.nodeID("Service", ns, svcName)
			for _, ep := range sl.Endpoints {
				if ep.TargetRef == nil || ep.TargetRef.Kind != "Pod" || ep.TargetRef.Name == "" {
					continue
				}
				ready, known := tm.endpointCondReady(ep)
				meta := map[string]any{
					"ready":  ready,
					"known":  known,
					"node":   "",
					"zone":   "",
					"target": ep.TargetRef.Name,
				}
				addEdge(sid, tm.nodeID("Pod", ns, ep.TargetRef.Name), "service_endpoint", meta)
			}
		}
	} else {
		for _, s := range svcs {
			if len(s.Spec.Selector) == 0 {
				continue
			}
			sel := labels.SelectorFromSet(s.Spec.Selector)
			sid := tm.nodeID("Service", ns, s.Name)
			for _, p := range pods {
				if sel.Matches(labels.Set(p.Labels)) {
					addEdge(sid, tm.nodeID("Pod", ns, p.Name), "service_selector", nil)
				}
			}
		}
	}

	return g, nil
}

func (tm *TopologyManager) resolveTopOwner(ns string, pod *corev1.Pod) (bool, string, string) {
	var owner *metav1.OwnerReference
	for i := range pod.OwnerReferences {
		if pod.OwnerReferences[i].Controller != nil && *pod.OwnerReferences[i].Controller {
			owner = &pod.OwnerReferences[i]
			break
		}
	}
	if owner == nil && len(pod.OwnerReferences) > 0 {
		owner = &pod.OwnerReferences[0]
	}
	if owner == nil {
		return false, "", ""
	}

	// ReplicaSet -> Deployment
	if owner.Kind == "ReplicaSet" {
		rs, err := tm.rsL.ReplicaSets(ns).Get(owner.Name)
		if err == nil {
			for i := range rs.OwnerReferences {
				if rs.OwnerReferences[i].Controller != nil && *rs.OwnerReferences[i].Controller &&
					rs.OwnerReferences[i].Kind == "Deployment" {
					return true, "Deployment", rs.OwnerReferences[i].Name
				}
			}
		}
		return true, "ReplicaSet", owner.Name
	}

	switch owner.Kind {
	case "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob":
		return true, owner.Kind, owner.Name
	default:
		return true, owner.Kind, owner.Name
	}
}

// --------------------
// Ingress helper: backend services + enriched path list
// --------------------

func (tm *TopologyManager) ingressBackendServices(ing *networkingv1.Ingress) map[string]struct{} {
	out := map[string]struct{}{}

	if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil {
		out[ing.Spec.DefaultBackend.Service.Name] = struct{}{}
	}

	for _, r := range ing.Spec.Rules {
		if r.HTTP == nil {
			continue
		}
		for _, p := range r.HTTP.Paths {
			if p.Backend.Service == nil {
				continue
			}
			out[p.Backend.Service.Name] = struct{}{}
		}
	}

	return out
}

func (tm *TopologyManager) ingressPathsWithBackend(ing *networkingv1.Ingress, svcInfo map[string]*topoSvcInfo) []topoIngressPathInfo {
	out := []topoIngressPathInfo{}

	attach := func(pi *topoIngressPathInfo) {
		info := svcInfo[pi.Service]
		if info == nil {
			pi.BackendState = "unknown"
			pi.BackendWhy = "service backend unknown"
			return
		}
		pi.BackendState = info.BackendState
		pi.ReadyPods = info.ReadyPods
		pi.ReadyEPs = info.ReadyEPs
		pi.BackendWhy = info.BackendReason
	}

	// Default backend
	if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil {
		pi := topoIngressPathInfo{
			Host:    "(default)",
			Path:    "(default)",
			Service: ing.Spec.DefaultBackend.Service.Name,
			Port:    tm.backendPortToAny(ing.Spec.DefaultBackend.Service.Port),
			Default: true,
		}
		attach(&pi)
		out = append(out, pi)
	}

	for _, r := range ing.Spec.Rules {
		host := strings.TrimSpace(r.Host)
		if host == "" {
			host = "(all hosts)"
		}
		if r.HTTP == nil {
			continue
		}
		for _, p := range r.HTTP.Paths {
			if p.Backend.Service == nil {
				continue
			}
			pt := ""
			if p.PathType != nil {
				pt = string(*p.PathType)
			}
			pi := topoIngressPathInfo{
				Host:     host,
				Path:     p.Path,
				PathType: pt,
				Service:  p.Backend.Service.Name,
				Port:     tm.backendPortToAny(p.Backend.Service.Port),
			}
			attach(&pi)
			out = append(out, pi)
		}
	}

	return out
}

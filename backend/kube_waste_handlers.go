package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
)

type WasteSignalsResponse struct {
	GeneratedAt string                 `json:"generatedAt"`
	Warnings    []string               `json:"warnings,omitempty"`
	NodePools   []NodePoolWaste        `json:"nodePools"`
	UnusedPVCs  []UnusedPVC            `json:"unusedPVCs"`
	IdleNS      []IdleNamespace        `json:"idleNamespaces"`
	FailingJobs []FailingJob           `json:"failingJobs"`
	CostByLabel map[string][]LabelCost `json:"costByLabel"` // key=labelKey -> items
}

type NodePoolWaste struct {
	Name        string  `json:"name"`
	Nodes       int     `json:"nodes"`
	AllocCPU    float64 `json:"allocCpuCores"`
	AllocMemGi  float64 `json:"allocMemGiB"`
	ReqCPU      float64 `json:"reqCpuCores"`
	ReqMemGi    float64 `json:"reqMemGiB"`
	UseCPU      float64 `json:"useCpuCores,omitempty"` // metrics-server; 0 if unavailable
	UseMemGi    float64 `json:"useMemGiB,omitempty"`
	WasteReqCPU float64 `json:"wasteReqCpuCores"`
	WasteReqMem float64 `json:"wasteReqMemGiB"`
	WasteUseCPU float64 `json:"wasteUseCpuCores"`
	WasteUseMem float64 `json:"wasteUseMemGiB"`
}

type UnusedPVC struct {
	Namespace    string  `json:"namespace"`
	Name         string  `json:"name"`
	StorageClass string  `json:"storageClass,omitempty"`
	Status       string  `json:"status"`
	SizeGiB      float64 `json:"sizeGiB"`
	Age          string  `json:"age"`
}

type IdleNamespace struct {
	Name   string  `json:"name"`
	Pods   int     `json:"activePods"`
	ReqCPU float64 `json:"reqCpuCores"`
	ReqMem float64 `json:"reqMemGiB"`
}

type FailingJob struct {
	Namespace    string `json:"namespace"`
	Name         string `json:"name"`
	Active       int32  `json:"active"`
	Succeeded    int32  `json:"succeeded"`
	Failed       int32  `json:"failed"`
	BackoffLimit *int32 `json:"backoffLimit,omitempty"`
	Reason       string `json:"reason,omitempty"`
	Message      string `json:"message,omitempty"`
	Age          string `json:"age"`
}

type LabelCost struct {
	Value  string  `json:"value"`
	CPU    float64 `json:"reqCpuCores"`
	MemGiB float64 `json:"reqMemGiB"`
	Weight float64 `json:"weight"` // rough “cost weight”
	Pct    float64 `json:"pct"`
}

type wasteCacheEntry struct {
	expires time.Time
	val     WasteSignalsResponse
}

type req struct {
	cpuMilli int64
	memBytes int64
}

var (
	wasteCacheMu sync.RWMutex
	wasteCache   = map[string]wasteCacheEntry{} // key = labelKeys string
)

func handleWasteSignals(c *gin.Context) {
	labelKeys := strings.TrimSpace(c.Query("labelKeys"))
	if labelKeys == "" {
		labelKeys = "team,app,env"
	}
	refresh := strings.ToLower(strings.TrimSpace(c.Query("refresh"))) == "true"

	if !refresh {
		if v, ok := wasteCacheGet(labelKeys); ok {
			c.JSON(http.StatusOK, v)
			return
		}
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 25*time.Second)
	defer cancel()

	kcfg, err := kubeRestConfig()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("kube config: %v", err)})
		return
	}
	cs, err := kubernetes.NewForConfig(kcfg)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("kube client: %v", err)})
		return
	}

	// metrics client is optional (cluster might not have metrics-server / RBAC)
	var mcs *metricsclient.Clientset
	mcs, _ = metricsclient.NewForConfig(kcfg)

	var (
		nodes            *corev1.NodeList
		pods             *corev1.PodList
		pvcs             *corev1.PersistentVolumeClaimList
		nss              *corev1.NamespaceList
		jobs             *batchv1.JobList
		nodeMetricsAvail bool
		nodeMetrics      map[string]struct {
			cpuMilli int64
			memBytes int64
		}
		warnings []string
		wg       sync.WaitGroup
		mu       sync.Mutex
	)

	wg.Add(5)

	go func() {
		defer wg.Done()
		x, e := cs.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
		mu.Lock()
		defer mu.Unlock()
		if e != nil {
			warnings = append(warnings, "nodes: "+e.Error())
			return
		}
		nodes = x
	}()
	go func() {
		defer wg.Done()
		x, e := cs.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
		mu.Lock()
		defer mu.Unlock()
		if e != nil {
			warnings = append(warnings, "pods: "+e.Error())
			return
		}
		pods = x
	}()
	go func() {
		defer wg.Done()
		x, e := cs.CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{})
		mu.Lock()
		defer mu.Unlock()
		if e != nil {
			warnings = append(warnings, "pvcs: "+e.Error())
			return
		}
		pvcs = x
	}()
	go func() {
		defer wg.Done()
		x, e := cs.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
		mu.Lock()
		defer mu.Unlock()
		if e != nil {
			warnings = append(warnings, "namespaces: "+e.Error())
			return
		}
		nss = x
	}()
	go func() {
		defer wg.Done()
		x, e := cs.BatchV1().Jobs("").List(ctx, metav1.ListOptions{})
		mu.Lock()
		defer mu.Unlock()
		if e != nil {
			warnings = append(warnings, "jobs: "+e.Error())
			return
		}
		jobs = x
	}()

	// metrics in parallel, but don’t block the whole response
	wg.Add(1)
	go func() {
		defer wg.Done()
		if mcs == nil {
			return
		}
		m, e := mcs.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{})
		if e != nil {
			mu.Lock()
			warnings = append(warnings, "node metrics: "+e.Error())
			mu.Unlock()
			return
		}
		tmp := make(map[string]struct {
			cpuMilli int64
			memBytes int64
		}, len(m.Items))
		for _, nm := range m.Items {
			cpu := nm.Usage[corev1.ResourceCPU]
			mem := nm.Usage[corev1.ResourceMemory]
			tmp[nm.Name] = struct {
				cpuMilli int64
				memBytes int64
			}{
				cpuMilli: cpu.MilliValue(),
				memBytes: mem.Value(),
			}
		}
		mu.Lock()
		nodeMetrics = tmp
		nodeMetricsAvail = true
		mu.Unlock()
	}()

	wg.Wait()

	if nodes == nil || pods == nil || pvcs == nil || nss == nil || jobs == nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to load cluster data", "warnings": warnings})
		return
	}

	// ---- requested per node (and per namespace / labels) ----
	reqByNode := map[string]req{}
	reqByNS := map[string]req{}
	labelsReq := map[string]map[string]req{} // labelKey -> value -> req

	labelKeyList := splitCSV(labelKeys)
	for _, k := range labelKeyList {
		labelsReq[k] = map[string]req{}
	}

	activePodCountByNS := map[string]int{}

	for _, p := range pods.Items {
		if p.Spec.NodeName == "" {
			continue
		}
		if p.DeletionTimestamp != nil {
			continue
		}
		if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
			continue
		}

		r := podRequested(&p)
		reqByNode[p.Spec.NodeName] = addReq(reqByNode[p.Spec.NodeName], r)

		ns := p.Namespace
		activePodCountByNS[ns]++

		reqByNS[ns] = addReq(reqByNS[ns], r)

		for _, lk := range labelKeyList {
			v := p.Labels[lk]
			if strings.TrimSpace(v) == "" {
				v = "(unlabeled)"
			}
			cur := labelsReq[lk][v]
			labelsReq[lk][v] = addReq(cur, r)
		}
	}

	// ---- node pools aggregations ----
	np := map[string]*NodePoolWaste{}
	for _, n := range nodes.Items {
		pool := n.Labels["cloud.google.com/gke-nodepool"]
		if pool == "" {
			pool = "(unknown)"
		}

		if np[pool] == nil {
			np[pool] = &NodePoolWaste{Name: pool}
		}

		qCPU := n.Status.Allocatable[corev1.ResourceCPU]
		qMem := n.Status.Allocatable[corev1.ResourceMemory]

		allocCPU := qCPU.MilliValue()
		allocMem := qMem.Value()

		np[pool].Nodes++
		np[pool].AllocCPU += float64(allocCPU) / 1000.0
		np[pool].AllocMemGi += float64(allocMem) / (1024.0 * 1024.0 * 1024.0)

		r := reqByNode[n.Name]
		np[pool].ReqCPU += float64(r.cpuMilli) / 1000.0
		np[pool].ReqMemGi += float64(r.memBytes) / (1024.0 * 1024.0 * 1024.0)

		if nodeMetricsAvail {
			if u, ok := nodeMetrics[n.Name]; ok {
				np[pool].UseCPU += float64(u.cpuMilli) / 1000.0
				np[pool].UseMemGi += float64(u.memBytes) / (1024.0 * 1024.0 * 1024.0)
			}
		}
	}

	nodePools := make([]NodePoolWaste, 0, len(np))
	for _, v := range np {
		// “waste” = allocatable - requested / usage (floored at 0)
		v.WasteReqCPU = maxf(0, v.AllocCPU-v.ReqCPU)
		v.WasteReqMem = maxf(0, v.AllocMemGi-v.ReqMemGi)
		v.WasteUseCPU = maxf(0, v.AllocCPU-v.UseCPU)
		v.WasteUseMem = maxf(0, v.AllocMemGi-v.UseMemGi)
		nodePools = append(nodePools, *v)
	}
	sort.Slice(nodePools, func(i, j int) bool {
		// biggest “actual waste” first (CPU+mem weight)
		wi := nodePools[i].WasteUseCPU + nodePools[i].WasteUseMem/4.0
		wj := nodePools[j].WasteUseCPU + nodePools[j].WasteUseMem/4.0
		return wi > wj
	})

	// ---- unused PVCs ----
	usedPVC := map[string]bool{} // "ns/name"
	for _, p := range pods.Items {
		for _, v := range p.Spec.Volumes {
			if v.PersistentVolumeClaim != nil {
				usedPVC[p.Namespace+"/"+v.PersistentVolumeClaim.ClaimName] = true
			}
		}
	}

	unused := make([]UnusedPVC, 0, 200)
	for _, pvc := range pvcs.Items {
		key := pvc.Namespace + "/" + pvc.Name
		if usedPVC[key] {
			continue
		}
		size := pvc.Spec.Resources.Requests[corev1.ResourceStorage]
		sc := ""
		if pvc.Spec.StorageClassName != nil {
			sc = *pvc.Spec.StorageClassName
		}
		unused = append(unused, UnusedPVC{
			Namespace:    pvc.Namespace,
			Name:         pvc.Name,
			StorageClass: sc,
			Status:       string(pvc.Status.Phase),
			SizeGiB:      float64(size.Value()) / (1024.0 * 1024.0 * 1024.0),
			Age:          age(pvc.CreationTimestamp.Time),
		})
	}
	sort.Slice(unused, func(i, j int) bool { return unused[i].SizeGiB > unused[j].SizeGiB })

	// ---- idle namespaces ----
	idle := make([]IdleNamespace, 0)
	for _, ns := range nss.Items {
		name := ns.Name
		if isSystemNamespace(name) { // keep noise low
			continue
		}
		r := reqByNS[name]
		idle = append(idle, IdleNamespace{
			Name:   name,
			Pods:   activePodCountByNS[name],
			ReqCPU: float64(r.cpuMilli) / 1000.0,
			ReqMem: float64(r.memBytes) / (1024.0 * 1024.0 * 1024.0),
		})
	}
	sort.Slice(idle, func(i, j int) bool { return idle[i].Pods < idle[j].Pods }) // “emptiest” first

	// ---- failing/retrying jobs ----
	fjobs := make([]FailingJob, 0, 200)
	for _, j := range jobs.Items {
		failed := j.Status.Failed
		if failed == 0 {
			continue
		}
		reason, msg := jobReason(&j)
		fjobs = append(fjobs, FailingJob{
			Namespace:    j.Namespace,
			Name:         j.Name,
			Active:       j.Status.Active,
			Succeeded:    j.Status.Succeeded,
			Failed:       j.Status.Failed,
			BackoffLimit: j.Spec.BackoffLimit,
			Reason:       reason,
			Message:      msg,
			Age:          age(j.CreationTimestamp.Time),
		})
	}
	sort.Slice(fjobs, func(i, j int) bool { return fjobs[i].Failed > fjobs[j].Failed })

	// ---- cost-by-label (rough = resource share by label) ----
	costByLabel := map[string][]LabelCost{}
	for _, lk := range labelKeyList {
		total := req{0, 0}
		for _, r := range labelsReq[lk] {
			total = addReq(total, r)
		}
		items := make([]LabelCost, 0, len(labelsReq[lk]))
		for val, r := range labelsReq[lk] {
			cpu := float64(r.cpuMilli) / 1000.0
			mem := float64(r.memBytes) / (1024.0 * 1024.0 * 1024.0)
			weight := cpu + mem/4.0 // simple “cost weight”
			pct := 0.0
			tw := (float64(total.cpuMilli)/1000.0 + (float64(total.memBytes)/(1024.0*1024.0*1024.0))/4.0)
			if tw > 0 {
				pct = (weight / tw) * 100.0
			}
			items = append(items, LabelCost{Value: val, CPU: cpu, MemGiB: mem, Weight: weight, Pct: pct})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].Weight > items[j].Weight })
		if len(items) > 25 {
			items = items[:25]
		}
		costByLabel[lk] = items
	}

	out := WasteSignalsResponse{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Warnings:    warnings,
		NodePools:   nodePools,
		UnusedPVCs:  unused,
		IdleNS:      idle,
		FailingJobs: fjobs,
		CostByLabel: costByLabel,
	}

	if !nodeMetricsAvail {
		out.Warnings = append(out.Warnings, "metrics-server unavailable or RBAC denied: actual usage fields will be 0")
	}

	wasteCacheSet(labelKeys, out, 30*time.Second)
	c.JSON(http.StatusOK, out)
}

func kubeRestConfig() (*rest.Config, error) {
	if strings.TrimSpace(cfg.Kube.Kubeconfig) != "" {
		return clientcmd.BuildConfigFromFlags("", cfg.Kube.Kubeconfig)
	}
	return rest.InClusterConfig()
}

func podRequested(p *corev1.Pod) req {
	sumCPU, sumMem := int64(0), int64(0)
	for _, c := range p.Spec.Containers {
		rq := c.Resources.Requests
		sumCPU += rq.Cpu().MilliValue()
		sumMem += rq.Memory().Value()
	}
	// init containers: scheduler uses max(init) vs sum(app); approximate that
	maxInitCPU, maxInitMem := int64(0), int64(0)
	for _, c := range p.Spec.InitContainers {
		rq := c.Resources.Requests
		if v := rq.Cpu().MilliValue(); v > maxInitCPU {
			maxInitCPU = v
		}
		if v := rq.Memory().Value(); v > maxInitMem {
			maxInitMem = v
		}
	}
	if maxInitCPU > sumCPU {
		sumCPU = maxInitCPU
	}
	if maxInitMem > sumMem {
		sumMem = maxInitMem
	}
	return req{cpuMilli: sumCPU, memBytes: sumMem}
}

func addReq(a, b req) req {
	return req{cpuMilli: a.cpuMilli + b.cpuMilli, memBytes: a.memBytes + b.memBytes}
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		x := strings.TrimSpace(p)
		if x != "" {
			out = append(out, x)
		}
	}
	return out
}

func age(t time.Time) string {
	d := time.Since(t)
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	if d < 48*time.Hour {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

func jobReason(j *batchv1.Job) (string, string) {
	for _, c := range j.Status.Conditions {
		if c.Type == batchv1.JobFailed && c.Status == corev1.ConditionTrue {
			return c.Reason, c.Message
		}
	}
	return "", ""
}

func isSystemNamespace(ns string) bool {
	switch ns {
	case "kube-system", "kube-public", "kube-node-lease", "gke-system", "gmp-system", "istio-system", "ingress-nginx":
		return true
	default:
		return false
	}
}

func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func wasteCacheGet(key string) (WasteSignalsResponse, bool) {
	wasteCacheMu.RLock()
	defer wasteCacheMu.RUnlock()
	ent, ok := wasteCache[key]
	if !ok || time.Now().After(ent.expires) {
		return WasteSignalsResponse{}, false
	}
	return ent.val, true
}
func wasteCacheSet(key string, val WasteSignalsResponse, ttl time.Duration) {
	wasteCacheMu.Lock()
	defer wasteCacheMu.Unlock()
	wasteCache[key] = wasteCacheEntry{expires: time.Now().Add(ttl), val: val}
}

// keep unused import if your repo uses it elsewhere:
var _ = resource.MustParse

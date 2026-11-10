// kube_jobs_handlers.go
package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type KubeNamespaceItem struct {
	Name string `json:"name"`
}

type CronJobItem struct {
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace"`
	Schedule    string            `json:"schedule"`
	Suspend     *bool             `json:"suspend,omitempty"`
	Concurrency string            `json:"concurrencyPolicy,omitempty"`
	Active      int               `json:"active"`
	LastRun     string            `json:"lastScheduleTime,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
	Age         string            `json:"age"`
}

type JobItem struct {
	Name        string `json:"name"`
	Namespace   string `json:"namespace"`
	Parallelism *int32 `json:"parallelism,omitempty"`
	Completions *int32 `json:"completions,omitempty"`

	Active    int32 `json:"active"`
	Succeeded int32 `json:"succeeded"`
	Failed    int32 `json:"failed"`

	StartTime      string `json:"startTime,omitempty"`
	CompletionTime string `json:"completionTime,omitempty"`

	Owner string `json:"owner,omitempty"` // e.g. CronJob name if created by one

	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
	Age         string            `json:"age"`
}

// GET /api/kube/namespaces
func kubeNamespacesHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	nsList, err := kubeClient.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list namespaces: %v", err)})
		return
	}

	items := make([]KubeNamespaceItem, 0, len(nsList.Items))
	for i := range nsList.Items {
		items = append(items, KubeNamespaceItem{Name: nsList.Items[i].Name})
	}

	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })

	c.JSON(http.StatusOK, gin.H{"items": items})
}

// GET /api/kube/batch
// Optional: ?namespace=<ns> (if empty or "all", returns all namespaces)
func kubeBatchListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	nsQuery := c.Query("namespace") // may be "", "all" or specific ns

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	var (
		cjList *batchv1.CronJobList
		jList  *batchv1.JobList
		err    error
	)

	if nsQuery != "" && nsQuery != "all" {
		cjList, err = kubeClient.BatchV1().CronJobs(nsQuery).List(ctx, metav1.ListOptions{})
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list cronjobs: %v", err)})
			return
		}
		jList, err = kubeClient.BatchV1().Jobs(nsQuery).List(ctx, metav1.ListOptions{})
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list jobs: %v", err)})
			return
		}
	} else {
		// all namespaces
		cjList, err = kubeClient.BatchV1().CronJobs("").List(ctx, metav1.ListOptions{})
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list cronjobs (all): %v", err)})
			return
		}
		jList, err = kubeClient.BatchV1().Jobs("").List(ctx, metav1.ListOptions{})
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list jobs (all): %v", err)})
			return
		}
	}

	cronItems := make([]CronJobItem, 0, len(cjList.Items))
	for i := range cjList.Items {
		cj := &cjList.Items[i]
		cronItems = append(cronItems, makeCronJobItem(cj))
	}

	jobItems := make([]JobItem, 0, len(jList.Items))
	for i := range jList.Items {
		j := &jList.Items[i]
		jobItems = append(jobItems, makeJobItem(j))
	}

	// Sort: namespace, then name (same as ingresses)
	sort.Slice(cronItems, func(i, j int) bool {
		if cronItems[i].Namespace == cronItems[j].Namespace {
			return cronItems[i].Name < cronItems[j].Name
		}
		return cronItems[i].Namespace < cronItems[j].Namespace
	})
	sort.Slice(jobItems, func(i, j int) bool {
		if jobItems[i].Namespace == jobItems[j].Namespace {
			return jobItems[i].Name < jobItems[j].Name
		}
		return jobItems[i].Namespace < jobItems[j].Namespace
	})

	c.JSON(http.StatusOK, gin.H{
		"cronjobs": cronItems,
		"jobs":     jobItems,
	})
}

// GET /api/kube/cronjobs/:namespace/:name
func kubeCronJobDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	obj, err := kubeClient.BatchV1().CronJobs(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get cronjob %s/%s: %v", ns, name, err)})
		return
	}

	// Return the full object for your right-side detail panel
	c.JSON(http.StatusOK, gin.H{
		"kind":      "CronJob",
		"namespace": ns,
		"name":      name,
		"object":    obj,
	})
}

// GET /api/kube/jobs/:namespace/:name
func kubeJobDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	obj, err := kubeClient.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get job %s/%s: %v", ns, name, err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"kind":      "Job",
		"namespace": ns,
		"name":      name,
		"object":    obj,
	})
}

func makeCronJobItem(cj *batchv1.CronJob) CronJobItem {
	last := ""
	if cj.Status.LastScheduleTime != nil {
		last = cj.Status.LastScheduleTime.Time.Format(time.RFC3339)
	}

	return CronJobItem{
		Name:        cj.Name,
		Namespace:   cj.Namespace,
		Schedule:    cj.Spec.Schedule,
		Suspend:     cj.Spec.Suspend,
		Concurrency: string(cj.Spec.ConcurrencyPolicy),
		Active:      len(cj.Status.Active),
		LastRun:     last,
		Labels:      cj.Labels,
		Annotations: cj.Annotations,
		Age:         ageString(cj.CreationTimestamp.Time),
	}
}

func makeJobItem(j *batchv1.Job) JobItem {
	start := ""
	if j.Status.StartTime != nil {
		start = j.Status.StartTime.Time.Format(time.RFC3339)
	}
	comp := ""
	if j.Status.CompletionTime != nil {
		comp = j.Status.CompletionTime.Time.Format(time.RFC3339)
	}

	owner := ""
	for _, or := range j.OwnerReferences {
		if or.Controller != nil && *or.Controller {
			owner = or.Kind + "/" + or.Name
			break
		}
	}

	return JobItem{
		Name:        j.Name,
		Namespace:   j.Namespace,
		Parallelism: j.Spec.Parallelism,
		Completions: j.Spec.Completions,

		Active:    j.Status.Active,
		Succeeded: j.Status.Succeeded,
		Failed:    j.Status.Failed,

		StartTime:      start,
		CompletionTime: comp,

		Owner: owner,

		Labels:      j.Labels,
		Annotations: j.Annotations,
		Age:         ageString(j.CreationTimestamp.Time),
	}
}

func ageString(t time.Time) string {
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

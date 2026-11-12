package main

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
)

// MetricsHistorySample is one cluster-wide usage sample for the Overview
// page's sparklines. Kept intentionally small (no per-node breakdown) --
// this is a glanceable trend, not a monitoring system.
type MetricsHistorySample struct {
	Ts     int64   `json:"ts"`
	CPUPct float64 `json:"cpuPct"`
	MemPct float64 `json:"memPct"`
}

// metricsHistoryCapacity * metricsHistoryInterval = ~20 minutes of trend,
// which is enough for a sparkline without needing a real time-series store.
const (
	metricsHistoryCapacity = 40
	metricsHistoryInterval = 30 * time.Second
)

var (
	metricsHistoryMu  sync.RWMutex
	metricsHistory    = make([]MetricsHistorySample, 0, metricsHistoryCapacity)
	metricsHistoryErr string
)

// startMetricsHistoryCollector periodically samples cluster-wide CPU/mem
// usage (metrics-server) into an in-memory ring buffer. Best-effort: if
// metrics-server is unavailable, samples are simply skipped and the last
// error is surfaced to the API so the UI can show a warning instead of an
// empty chart with no explanation.
func startMetricsHistoryCollector() {
	go func() {
		collectMetricsHistorySample()
		ticker := time.NewTicker(metricsHistoryInterval)
		defer ticker.Stop()
		for range ticker.C {
			collectMetricsHistorySample()
		}
	}()
}

func collectMetricsHistorySample() {
	if kubeClient == nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	kcfg, err := kubeRestConfig()
	if err != nil {
		setMetricsHistoryErr(err.Error())
		return
	}
	mcs, err := metricsclient.NewForConfig(kcfg)
	if err != nil {
		setMetricsHistoryErr(err.Error())
		return
	}

	nodeMetrics, err := mcs.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{})
	if err != nil {
		setMetricsHistoryErr(err.Error())
		return
	}

	nodes, err := kubeClient.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		setMetricsHistoryErr(err.Error())
		return
	}

	var allocCPUMilli, allocMemBytes int64
	for i := range nodes.Items {
		allocCPUMilli += nodes.Items[i].Status.Allocatable.Cpu().MilliValue()
		allocMemBytes += nodes.Items[i].Status.Allocatable.Memory().Value()
	}

	var useCPUMilli, useMemBytes int64
	for i := range nodeMetrics.Items {
		useCPUMilli += nodeMetrics.Items[i].Usage.Cpu().MilliValue()
		useMemBytes += nodeMetrics.Items[i].Usage.Memory().Value()
	}

	sample := MetricsHistorySample{Ts: time.Now().UnixMilli()}
	if allocCPUMilli > 0 {
		sample.CPUPct = clampPct(float64(useCPUMilli) / float64(allocCPUMilli) * 100)
	}
	if allocMemBytes > 0 {
		sample.MemPct = clampPct(float64(useMemBytes) / float64(allocMemBytes) * 100)
	}

	metricsHistoryMu.Lock()
	metricsHistoryErr = ""
	metricsHistory = append(metricsHistory, sample)
	if len(metricsHistory) > metricsHistoryCapacity {
		metricsHistory = metricsHistory[len(metricsHistory)-metricsHistoryCapacity:]
	}
	metricsHistoryMu.Unlock()
}

func setMetricsHistoryErr(msg string) {
	metricsHistoryMu.Lock()
	metricsHistoryErr = msg
	metricsHistoryMu.Unlock()
}

// GET /api/kube/metrics/history
func metricsHistoryHandler(c *gin.Context) {
	metricsHistoryMu.RLock()
	samples := append([]MetricsHistorySample(nil), metricsHistory...)
	errMsg := metricsHistoryErr
	metricsHistoryMu.RUnlock()

	c.JSON(http.StatusOK, gin.H{
		"samples": samples,
		"warning": errMsg,
	})
}

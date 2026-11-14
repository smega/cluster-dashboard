package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// MetricsHistorySample is one cluster-wide usage sample for the Overview
// page's sparklines. Kept intentionally small (no per-node breakdown) --
// this is a glanceable trend, not a monitoring system.
type MetricsHistorySample struct {
	Ts     int64   `json:"ts"`
	CPUPct float64 `json:"cpuPct"`
	MemPct float64 `json:"memPct"`
}

// metricsHistoryWindow / metricsHistoryStep = 40 points over ~20 minutes,
// the same trend the old in-memory ring buffer kept.
const (
	metricsHistoryWindow = 20 * time.Minute
	metricsHistoryStep   = 30 * time.Second
	// Two backend replicas (and every open tab) share one Prometheus; a
	// short cache keeps the sparkline polling from turning into load.
	metricsHistoryCacheTTL = 15 * time.Second
)

// The history comes from Prometheus (kube-prometheus-stack in the cluster)
// rather than from samples kept in this process, so every backend replica
// draws the same chart and a restart doesn't wipe it.
//
// CPU: node-exporter busy time over allocatable cores. Memory: working set
// (total - free - inactive file cache, roughly what metrics-server reports)
// over allocatable memory.
const (
	cpuHistoryQuery = `100 * sum(rate(node_cpu_seconds_total{mode!~"idle|iowait|steal"}[2m]))` +
		` / sum(kube_node_status_allocatable{resource="cpu"})`
	memHistoryQuery = `100 * sum(node_memory_MemTotal_bytes - node_memory_MemFree_bytes - node_memory_Inactive_file_bytes)` +
		` / sum(kube_node_status_allocatable{resource="memory"})`
)

var (
	metricsHistoryMu      sync.Mutex
	metricsHistoryCache   []MetricsHistorySample
	metricsHistoryCacheAt time.Time
	metricsHistoryClient  = &http.Client{Timeout: 10 * time.Second}
)

// GET /api/kube/metrics/history
func metricsHistoryHandler(c *gin.Context) {
	if cfg.Prometheus.URL == "" {
		c.JSON(http.StatusOK, gin.H{"samples": []MetricsHistorySample{}, "warning": "Prometheus URL not configured"})
		return
	}

	metricsHistoryMu.Lock()
	defer metricsHistoryMu.Unlock()

	if time.Since(metricsHistoryCacheAt) > metricsHistoryCacheTTL {
		samples, err := fetchMetricsHistory(c.Request.Context())
		if err != nil {
			// Keep showing the last good chart, with the reason why it's stale.
			c.JSON(http.StatusOK, gin.H{"samples": metricsHistoryCache, "warning": err.Error()})
			return
		}
		metricsHistoryCache = samples
		metricsHistoryCacheAt = time.Now()
	}

	c.JSON(http.StatusOK, gin.H{"samples": metricsHistoryCache, "warning": ""})
}

func fetchMetricsHistory(ctx context.Context) ([]MetricsHistorySample, error) {
	end := time.Now().Truncate(metricsHistoryStep)
	start := end.Add(-metricsHistoryWindow)

	cpu, err := promQueryRange(ctx, cpuHistoryQuery, start, end, metricsHistoryStep)
	if err != nil {
		return nil, fmt.Errorf("cpu history: %w", err)
	}
	mem, err := promQueryRange(ctx, memHistoryQuery, start, end, metricsHistoryStep)
	if err != nil {
		return nil, fmt.Errorf("memory history: %w", err)
	}

	samples := make([]MetricsHistorySample, 0, len(cpu))
	for ts, cpuPct := range cpu {
		memPct, ok := mem[ts]
		if !ok {
			continue
		}
		samples = append(samples, MetricsHistorySample{Ts: ts, CPUPct: clampPct(cpuPct), MemPct: clampPct(memPct)})
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i].Ts < samples[j].Ts })
	return samples, nil
}

// promQueryRange runs a range query that returns a single series and gives
// back its values keyed by timestamp (unix millis).
func promQueryRange(ctx context.Context, query string, start, end time.Time, step time.Duration) (map[int64]float64, error) {
	params := url.Values{}
	params.Set("query", query)
	params.Set("start", strconv.FormatInt(start.Unix(), 10))
	params.Set("end", strconv.FormatInt(end.Unix(), 10))
	params.Set("step", strconv.Itoa(int(step.Seconds())))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.Prometheus.URL+"/api/v1/query_range?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := metricsHistoryClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var body struct {
		Status string `json:"status"`
		Error  string `json:"error"`
		Data   struct {
			Result []struct {
				Values [][2]any `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("prometheus: %s: %w", resp.Status, err)
	}
	if body.Status != "success" {
		return nil, fmt.Errorf("prometheus: %s", body.Error)
	}

	out := map[int64]float64{}
	if len(body.Data.Result) == 0 {
		return out, nil
	}
	for _, v := range body.Data.Result[0].Values {
		ts, ok := v[0].(float64)
		if !ok {
			continue
		}
		s, ok := v[1].(string)
		if !ok {
			continue
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			continue
		}
		out[int64(ts*1000)] = f
	}
	return out, nil
}

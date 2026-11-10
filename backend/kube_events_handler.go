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
	eventsv1 "k8s.io/api/events/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type KubeEventItem struct {
	Name              string `json:"name"`
	Namespace         string `json:"namespace"`
	Type              string `json:"type,omitempty"` // Normal | Warning
	Reason            string `json:"reason,omitempty"`
	Message           string `json:"message,omitempty"`
	InvolvedKind      string `json:"involvedKind,omitempty"`
	InvolvedName      string `json:"involvedName,omitempty"`
	InvolvedNamespace string `json:"involvedNamespace,omitempty"`
	Source            string `json:"source,omitempty"`
	Count             int32  `json:"count,omitempty"`
	FirstSeen         string `json:"firstSeen,omitempty"`
	LastSeen          string `json:"lastSeen,omitempty"`
	Age               string `json:"age,omitempty"` // relative age based on last seen
}

type KubeEventStats struct {
	Total    int `json:"total"`
	Warnings int `json:"warnings"`
	Normal   int `json:"normal"`
}

type kubeEventSummary struct {
	Type    string `json:"type,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
	Count   int32  `json:"count,omitempty"`
	First   string `json:"first,omitempty"`
	Last    string `json:"last,omitempty"`
	Object  string `json:"object,omitempty"`
	Source  string `json:"source,omitempty"`
}

type kubeObjectRef struct {
	UID       string `json:"uid,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Name      string `json:"name,omitempty"`
	Namespace string `json:"namespace,omitempty"`
}

// -----------------------------
// GET /api/kube/events
// Optional: ?namespace=<ns|all> &type=Warning|Normal &limit=...
// -----------------------------
func kubeEventsListHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	nsQuery := strings.TrimSpace(c.Query("namespace"))
	if nsQuery == "" {
		nsQuery = "all"
	}

	typeQuery := strings.TrimSpace(c.Query("type")) // "", "Warning", "Normal"
	typeQueryLower := strings.ToLower(typeQuery)

	limit := parseLimit(c.Query("limit"), 500, 1, 2000)

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	items, stats, err := listEventsPreferCoreV1(ctx, nsQuery, typeQueryLower, limit)
	if err != nil {
		if apierrors.IsForbidden(err) {
			c.JSON(http.StatusForbidden, gin.H{"error": fmt.Sprintf("forbidden: %v", err)})
			return
		}
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("not found: %v", err)})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list events: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"items": items,
		"stats": stats,
	})
}

// -----------------------------
// GET /api/kube/events/:namespace/:name
// Includes objectRef.uid so UI can fetch related events
// -----------------------------
func kubeEventDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	// 1) Try core/v1 Event
	ev, err := kubeClient.CoreV1().Events(ns).Get(ctx, name, metav1.GetOptions{})
	if err == nil && ev != nil {
		first, last := coreEventFirstLast(ev)
		obj := kubeObjectRef{
			UID:       string(ev.InvolvedObject.UID),
			Kind:      ev.InvolvedObject.Kind,
			Name:      ev.InvolvedObject.Name,
			Namespace: ev.InvolvedObject.Namespace,
		}

		c.JSON(http.StatusOK, gin.H{
			"kind":       "Event",
			"apiVersion": "v1",
			"namespace":  ns,
			"name":       name,
			"age":        eventRelAge(last, time.Now()),
			"objectRef":  obj,
			"summary": kubeEventSummary{
				Type:    ev.Type,
				Reason:  ev.Reason,
				Message: ev.Message,
				Count:   ev.Count,
				First:   eventRelAge(first, time.Now()),
				Last:    eventRelAge(last, time.Now()),
				Object:  fmt.Sprintf("%s/%s", ev.InvolvedObject.Kind, ev.InvolvedObject.Name),
				Source:  coreEventSource(ev),
			},
			"object": ev, // raw
		})
		return
	}

	// 2) Fallback: events.k8s.io/v1
	ev2, err2 := kubeClient.EventsV1().Events(ns).Get(ctx, name, metav1.GetOptions{})
	if err2 != nil {
		if apierrors.IsForbidden(err) || apierrors.IsForbidden(err2) {
			c.JSON(http.StatusForbidden, gin.H{"error": fmt.Sprintf("forbidden: %v", firstErr(err, err2))})
			return
		}
		if apierrors.IsNotFound(err) && apierrors.IsNotFound(err2) {
			c.JSON(http.StatusNotFound, gin.H{"error": "event not found"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get event %s/%s: %v", ns, name, firstErr(err, err2))})
		return
	}

	first, last := eventsV1FirstLast(ev2)
	obj := kubeObjectRef{
		UID:       string(ev2.Regarding.UID),
		Kind:      ev2.Regarding.Kind,
		Name:      ev2.Regarding.Name,
		Namespace: ev2.Regarding.Namespace,
	}

	c.JSON(http.StatusOK, gin.H{
		"kind":       "Event",
		"apiVersion": "events.k8s.io/v1",
		"namespace":  ns,
		"name":       name,
		"age":        eventRelAge(last, time.Now()),
		"objectRef":  obj,
		"summary": kubeEventSummary{
			Type:    ev2.Type,
			Reason:  ev2.Reason,
			Message: ev2.Note,
			Count:   eventsV1Count(ev2),
			First:   eventRelAge(first, time.Now()),
			Last:    eventRelAge(last, time.Now()),
			Object:  fmt.Sprintf("%s/%s", ev2.Regarding.Kind, ev2.Regarding.Name),
			Source:  eventsV1Source(ev2),
		},
		"object": ev2, // raw
	})
}

// -----------------------------
// GET /api/kube/events/related?uid=...&namespace=...&limit=...
// Fetch events linked to the same involvedObject.uid / regarding.uid
// -----------------------------
func kubeEventsRelatedHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	uid := strings.TrimSpace(c.Query("uid"))
	if uid == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing uid"})
		return
	}

	nsQuery := strings.TrimSpace(c.Query("namespace"))
	if nsQuery == "" {
		nsQuery = "all"
	}

	typeQuery := strings.TrimSpace(c.Query("type")) // optional
	typeQueryLower := strings.ToLower(typeQuery)

	limit := parseLimit(c.Query("limit"), 100, 1, 2000)

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	items, stats, err := listEventsByUIDPreferCoreV1(ctx, nsQuery, uid, typeQueryLower, limit)
	if err != nil {
		if apierrors.IsForbidden(err) {
			c.JSON(http.StatusForbidden, gin.H{"error": fmt.Sprintf("forbidden: %v", err)})
			return
		}
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("not found: %v", err)})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list related events: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"items": items,
		"stats": stats,
	})
}

// -----------------------------
// Listing helpers
// -----------------------------
func listEventsPreferCoreV1(ctx context.Context, nsQuery, typeFilterLower string, limit int) ([]KubeEventItem, KubeEventStats, error) {
	ns := metav1.NamespaceAll
	if nsQuery != "" && nsQuery != "all" {
		ns = nsQuery
	}

	now := time.Now()

	// Try core/v1 first
	lst, err := kubeClient.CoreV1().Events(ns).List(ctx, metav1.ListOptions{})
	if err == nil && lst != nil {
		items := make([]KubeEventItem, 0, len(lst.Items))
		stats := KubeEventStats{}

		for i := range lst.Items {
			e := &lst.Items[i]
			typ := strings.TrimSpace(e.Type)

			if typeFilterLower != "" && strings.ToLower(typ) != typeFilterLower {
				continue
			}

			first, last := coreEventFirstLast(e)
			items = append(items, KubeEventItem{
				Name:              e.Name,
				Namespace:         e.Namespace,
				Type:              typ,
				Reason:            e.Reason,
				Message:           e.Message,
				InvolvedKind:      e.InvolvedObject.Kind,
				InvolvedName:      e.InvolvedObject.Name,
				InvolvedNamespace: e.InvolvedObject.Namespace,
				Source:            coreEventSource(e),
				Count:             e.Count,
				FirstSeen:         eventRelAge(first, now),
				LastSeen:          eventRelAge(last, now),
				Age:               eventRelAge(last, now),
			})

			stats.Total++
			if strings.EqualFold(typ, "Warning") {
				stats.Warnings++
			} else {
				stats.Normal++
			}
		}

		// Keep predictable ordering (namespace, Warning first, then reason)
		sort.Slice(items, func(i, j int) bool {
			if items[i].Namespace != items[j].Namespace {
				return items[i].Namespace < items[j].Namespace
			}
			if items[i].Type != items[j].Type {
				return strings.EqualFold(items[i].Type, "Warning")
			}
			if items[i].Reason != items[j].Reason {
				return items[i].Reason < items[j].Reason
			}
			return items[i].Name < items[j].Name
		})

		if len(items) > limit {
			items = items[:limit]
		}
		return items, stats, nil
	}

	// Fallback: events.k8s.io/v1
	lst2, err2 := kubeClient.EventsV1().Events(ns).List(ctx, metav1.ListOptions{})
	if err2 != nil {
		return nil, KubeEventStats{}, firstErr(err, err2)
	}

	items := make([]KubeEventItem, 0, len(lst2.Items))
	stats := KubeEventStats{}

	for i := range lst2.Items {
		e := &lst2.Items[i]
		typ := strings.TrimSpace(e.Type)

		if typeFilterLower != "" && strings.ToLower(typ) != typeFilterLower {
			continue
		}

		first, last := eventsV1FirstLast(e)

		items = append(items, KubeEventItem{
			Name:              e.Name,
			Namespace:         e.Namespace,
			Type:              typ,
			Reason:            e.Reason,
			Message:           e.Note,
			InvolvedKind:      e.Regarding.Kind,
			InvolvedName:      e.Regarding.Name,
			InvolvedNamespace: e.Regarding.Namespace,
			Source:            eventsV1Source(e),
			Count:             eventsV1Count(e),
			FirstSeen:         eventRelAge(first, now),
			LastSeen:          eventRelAge(last, now),
			Age:               eventRelAge(last, now),
		})

		stats.Total++
		if strings.EqualFold(typ, "Warning") {
			stats.Warnings++
		} else {
			stats.Normal++
		}
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].Namespace != items[j].Namespace {
			return items[i].Namespace < items[j].Namespace
		}
		if items[i].Type != items[j].Type {
			return strings.EqualFold(items[i].Type, "Warning")
		}
		if items[i].Reason != items[j].Reason {
			return items[i].Reason < items[j].Reason
		}
		return items[i].Name < items[j].Name
	})

	if len(items) > limit {
		items = items[:limit]
	}
	return items, stats, nil
}

func listEventsByUIDPreferCoreV1(ctx context.Context, nsQuery, uid, typeFilterLower string, limit int) ([]KubeEventItem, KubeEventStats, error) {
	ns := metav1.NamespaceAll
	if nsQuery != "" && nsQuery != "all" {
		ns = nsQuery
	}

	now := time.Now()

	// core/v1 with field selector
	fs := fmt.Sprintf("involvedObject.uid=%s", uid)

	lst, err := kubeClient.CoreV1().Events(ns).List(ctx, metav1.ListOptions{FieldSelector: fs})
	if err == nil && lst != nil {
		type wrap struct {
			item KubeEventItem
			last time.Time
		}

		tmp := make([]wrap, 0, len(lst.Items))
		stats := KubeEventStats{}

		for i := range lst.Items {
			e := &lst.Items[i]
			typ := strings.TrimSpace(e.Type)
			if typeFilterLower != "" && strings.ToLower(typ) != typeFilterLower {
				continue
			}

			first, last := coreEventFirstLast(e)
			tmp = append(tmp, wrap{
				item: KubeEventItem{
					Name:              e.Name,
					Namespace:         e.Namespace,
					Type:              typ,
					Reason:            e.Reason,
					Message:           e.Message,
					InvolvedKind:      e.InvolvedObject.Kind,
					InvolvedName:      e.InvolvedObject.Name,
					InvolvedNamespace: e.InvolvedObject.Namespace,
					Source:            coreEventSource(e),
					Count:             e.Count,
					FirstSeen:         eventRelAge(first, now),
					LastSeen:          eventRelAge(last, now),
					Age:               eventRelAge(last, now),
				},
				last: last,
			})

			stats.Total++
			if strings.EqualFold(typ, "Warning") {
				stats.Warnings++
			} else {
				stats.Normal++
			}
		}

		// Sort newest first
		sort.Slice(tmp, func(i, j int) bool {
			return tmp[i].last.After(tmp[j].last)
		})

		out := make([]KubeEventItem, 0, len(tmp))
		for i := range tmp {
			out = append(out, tmp[i].item)
			if len(out) >= limit {
				break
			}
		}
		return out, stats, nil
	}

	// fallback events.k8s.io/v1
	fs2 := fmt.Sprintf("regarding.uid=%s", uid)
	lst2, err2 := kubeClient.EventsV1().Events(ns).List(ctx, metav1.ListOptions{FieldSelector: fs2})
	if err2 != nil {
		return nil, KubeEventStats{}, firstErr(err, err2)
	}

	type wrap2 struct {
		item KubeEventItem
		last time.Time
	}

	tmp2 := make([]wrap2, 0, len(lst2.Items))
	stats := KubeEventStats{}

	for i := range lst2.Items {
		e := &lst2.Items[i]
		typ := strings.TrimSpace(e.Type)
		if typeFilterLower != "" && strings.ToLower(typ) != typeFilterLower {
			continue
		}

		first, last := eventsV1FirstLast(e)

		tmp2 = append(tmp2, wrap2{
			item: KubeEventItem{
				Name:              e.Name,
				Namespace:         e.Namespace,
				Type:              typ,
				Reason:            e.Reason,
				Message:           e.Note,
				InvolvedKind:      e.Regarding.Kind,
				InvolvedName:      e.Regarding.Name,
				InvolvedNamespace: e.Regarding.Namespace,
				Source:            eventsV1Source(e),
				Count:             eventsV1Count(e),
				FirstSeen:         eventRelAge(first, now),
				LastSeen:          eventRelAge(last, now),
				Age:               eventRelAge(last, now),
			},
			last: last,
		})

		stats.Total++
		if strings.EqualFold(typ, "Warning") {
			stats.Warnings++
		} else {
			stats.Normal++
		}
	}

	sort.Slice(tmp2, func(i, j int) bool {
		return tmp2[i].last.After(tmp2[j].last)
	})

	out := make([]KubeEventItem, 0, len(tmp2))
	for i := range tmp2 {
		out = append(out, tmp2[i].item)
		if len(out) >= limit {
			break
		}
	}

	return out, stats, nil
}

// -----------------------------
// Event time helpers
// -----------------------------
func coreEventFirstLast(e *corev1.Event) (time.Time, time.Time) {
	first := e.FirstTimestamp.Time
	last := e.LastTimestamp.Time
	if last.IsZero() {
		last = e.EventTime.Time
	}
	if last.IsZero() {
		last = e.CreationTimestamp.Time
	}
	if first.IsZero() {
		first = e.CreationTimestamp.Time
	}
	return first, last
}

func coreEventSource(e *corev1.Event) string {
	parts := []string{}
	if e.Source.Component != "" {
		parts = append(parts, e.Source.Component)
	}
	if e.ReportingController != "" {
		parts = append(parts, e.ReportingController)
	}
	if e.Source.Host != "" {
		parts = append(parts, e.Source.Host)
	}
	if e.ReportingInstance != "" {
		parts = append(parts, e.ReportingInstance)
	}
	return strings.Join(eventCompact(parts), "/")
}

func eventsV1FirstLast(e *eventsv1.Event) (time.Time, time.Time) {
	first := e.DeprecatedFirstTimestamp.Time
	last := e.DeprecatedLastTimestamp.Time

	if last.IsZero() {
		last = e.EventTime.Time
	}
	if !e.Series.LastObservedTime.Time.IsZero() {
		last = e.Series.LastObservedTime.Time
	}
	if last.IsZero() {
		last = e.CreationTimestamp.Time
	}
	if first.IsZero() {
		first = e.CreationTimestamp.Time
	}
	return first, last
}

func eventsV1Count(e *eventsv1.Event) int32 {
	if e.Series.Count != 0 {
		return int32(e.Series.Count)
	}
	if e.DeprecatedCount != 0 {
		return int32(e.DeprecatedCount)
	}
	return 1
}

func eventsV1Source(e *eventsv1.Event) string {
	parts := []string{}
	if e.ReportingController != "" {
		parts = append(parts, e.ReportingController)
	}
	if e.ReportingInstance != "" {
		parts = append(parts, e.ReportingInstance)
	}
	if e.DeprecatedSource.Component != "" {
		parts = append(parts, e.DeprecatedSource.Component)
	}
	if e.DeprecatedSource.Host != "" {
		parts = append(parts, e.DeprecatedSource.Host)
	}
	return strings.Join(eventCompact(parts), "/")
}

// -----------------------------
// small utils (unique names to avoid collisions)
// -----------------------------
func parseLimit(v string, def, min, max int) int {
	if strings.TrimSpace(v) == "" {
		return def
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return def
	}
	if n < min {
		n = min
	}
	if n > max {
		n = max
	}
	return n
}

func eventRelAge(t time.Time, now time.Time) string {
	if t.IsZero() {
		return "-"
	}
	d := now.Sub(t)
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

func eventCompact(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func firstErr(a, b error) error {
	if a != nil {
		return a
	}
	return b
}

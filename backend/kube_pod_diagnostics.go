package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// PodWhyNotReady is attached to PodDetail as `diagnostics`.
type PodWhyNotReady struct {
	Ready    bool           `json:"ready"`
	Summary  string         `json:"summary,omitempty"`
	Reasons  []PodWhyReason `json:"reasons,omitempty"`
	Events   []PodDiagEvent `json:"events,omitempty"`
	Warnings []string       `json:"warnings,omitempty"`
}

type PodWhyReason struct {
	Source    string `json:"source,omitempty"`    // condition|container|initContainer|pod|event
	Level     string `json:"level,omitempty"`     // info|warn|error
	Reason    string `json:"reason,omitempty"`    // short reason keyword
	Message   string `json:"message,omitempty"`   // human message
	Since     string `json:"since,omitempty"`     // relative age
	Container string `json:"container,omitempty"` // if container-related
}

type PodDiagEvent struct {
	Type    string `json:"type,omitempty"` // Normal|Warning
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
	Age     string `json:"age,omitempty"`
	Count   int32  `json:"count,omitempty"`
}

// buildPodWhyNotReady produces a best-effort diagnostics object.
// It must never crash the /pods/:ns/:name endpoint: if anything fails, it returns warnings.
func buildPodWhyNotReady(ctx context.Context, ns string, p *corev1.Pod) PodWhyNotReady {
	now := time.Now()

	out := PodWhyNotReady{
		Ready: isPodReadyDiag(p),
	}

	// Helper: add a reason (de-dupe by key)
	seen := map[string]bool{}
	add := func(source, level, reason, message, since string, container string) {
		key := strings.ToLower(strings.TrimSpace(source + "|" + level + "|" + reason + "|" + message + "|" + since + "|" + container))
		if key == "" || seen[key] {
			return
		}
		seen[key] = true
		out.Reasons = append(out.Reasons, PodWhyReason{
			Source:    source,
			Level:     level,
			Reason:    reason,
			Message:   message,
			Since:     since,
			Container: container,
		})
	}

	// Pod-level flags
	if p.DeletionTimestamp != nil {
		add("pod", "warn", "Terminating", "Pod is terminating (deletionTimestamp set)", sinceStr(p.DeletionTimestamp.Time, now), "")
	}
	if p.Status.Reason != "" || p.Status.Message != "" {
		r := p.Status.Reason
		if r == "" {
			r = "PodStatus"
		}
		msg := p.Status.Message
		if msg == "" {
			msg = "Pod has a status reason set"
		}
		add("pod", levelForPhase(p.Status.Phase), r, msg, "", "")
	}

	// Conditions (Ready/ContainersReady/PodScheduled/Initialized)
	for _, c := range p.Status.Conditions {
		if c.Status == corev1.ConditionTrue {
			continue
		}
		// we only care about the main ones
		switch c.Type {
		case corev1.PodReady, corev1.ContainersReady, corev1.PodScheduled, corev1.PodInitialized:
		default:
			continue
		}

		level := "warn"
		if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse {
			level = "error"
		}
		if c.Type == corev1.PodReady && c.Status == corev1.ConditionFalse {
			level = "error"
		}

		reason := conditionReasonOrType(c)
		msg := c.Message
		since := sinceStr(c.LastTransitionTime.Time, now)

		add("condition", level, reason, msg, since, "")
	}

	// Init containers
	for _, cs := range p.Status.InitContainerStatuses {
		if cs.State.Waiting != nil {
			r := cs.State.Waiting.Reason
			if r == "" {
				r = "Waiting"
			}
			msg := cs.State.Waiting.Message
			add("initContainer", "error", r, msg, "", cs.Name)
		}
		if cs.State.Terminated != nil {
			r := cs.State.Terminated.Reason
			if r == "" {
				r = "Terminated"
			}
			msg := cs.State.Terminated.Message
			// treat non-zero exit as error, otherwise warn/info
			lvl := "warn"
			if cs.State.Terminated.ExitCode != 0 {
				lvl = "error"
			}
			add("initContainer", lvl, r, msg, "", cs.Name)
		}
		if !cs.Ready && cs.State.Running != nil {
			add("initContainer", "warn", "NotReady", "Init container is running but not Ready yet", "", cs.Name)
		}
	}

	// Regular containers
	for _, cs := range p.Status.ContainerStatuses {
		if cs.State.Waiting != nil {
			r := cs.State.Waiting.Reason
			if r == "" {
				r = "Waiting"
			}
			msg := cs.State.Waiting.Message
			lvl := "error"
			// some common "less severe" reasons are still warn, but usually this blocks readiness
			add("container", lvl, r, msg, "", cs.Name)
		}
		if cs.State.Terminated != nil {
			r := cs.State.Terminated.Reason
			if r == "" {
				r = "Terminated"
			}
			msg := cs.State.Terminated.Message
			lvl := "warn"
			if cs.State.Terminated.ExitCode != 0 {
				lvl = "error"
			}
			add("container", lvl, r, msg, "", cs.Name)
		}
		if !cs.Ready && cs.State.Running != nil {
			// Running but not ready: typically readiness probe failing (events will often show "Unhealthy")
			add("container", "warn", "NotReady", "Container is running but not Ready (readiness probe failing?)", "", cs.Name)
		}
	}

	// Events (best effort)
	evs, warn := listPodEventsBestEffort(ctx, ns, p)
	if warn != "" {
		out.Warnings = append(out.Warnings, warn)
	}
	out.Events = evs

	// If we have warning events, add top ones as reasons too (helps summary)
	for _, e := range evs {
		if strings.EqualFold(e.Type, "Warning") {
			add("event", "warn", e.Reason, e.Message, e.Age, "")
		}
	}

	// Sort reasons: error first, then warn, then info
	sort.SliceStable(out.Reasons, func(i, j int) bool {
		return levelRank(out.Reasons[i].Level) < levelRank(out.Reasons[j].Level)
	})

	// Summary
	if out.Ready {
		out.Summary = "Pod is Ready."
	} else if len(out.Reasons) > 0 {
		r := out.Reasons[0]
		if r.Container != "" {
			out.Summary = fmt.Sprintf("Not ready: %s (%s)", r.Reason, r.Container)
		} else {
			out.Summary = fmt.Sprintf("Not ready: %s", r.Reason)
		}
	} else {
		out.Summary = "Pod is not Ready."
	}

	return out
}

// --- helpers ---

func isPodReadyDiag(p *corev1.Pod) bool {
	if p == nil {
		return false
	}
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
			return true
		}
	}
	return false
}

func conditionReasonOrType(c corev1.PodCondition) string {
	if strings.TrimSpace(c.Reason) != "" {
		return c.Reason
	}
	return string(c.Type)
}

func sinceStr(t time.Time, now time.Time) string {
	if t.IsZero() {
		return ""
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

func levelRank(level string) int {
	switch strings.ToLower(level) {
	case "error":
		return 0
	case "warn", "warning":
		return 1
	default:
		return 2
	}
}

func levelForPhase(phase corev1.PodPhase) string {
	switch phase {
	case corev1.PodFailed:
		return "error"
	case corev1.PodPending:
		return "warn"
	default:
		return "info"
	}
}

func listPodEventsBestEffort(ctx context.Context, ns string, p *corev1.Pod) ([]PodDiagEvent, string) {
	if kubeClient == nil {
		return nil, "kube client not initialized (events unavailable)"
	}

	// Field selectors work best with involvedObject.uid
	fs := ""
	if p != nil && p.UID != "" {
		fs = fmt.Sprintf("involvedObject.uid=%s", string(p.UID))
	} else if p != nil && p.Name != "" {
		fs = fmt.Sprintf("involvedObject.name=%s", p.Name)
	}

	// core/v1 Events
	lst, err := kubeClient.CoreV1().Events(ns).List(ctx, metav1.ListOptions{
		FieldSelector: fs,
	})
	if err != nil {
		// Forbidden should not break the page
		if apierrors.IsForbidden(err) {
			return nil, "forbidden listing pod events (add RBAC get/list on events to enable)"
		}
		// NotFound / no events API (rare) should be non-fatal
		if apierrors.IsNotFound(err) {
			return nil, "events API not available on this cluster"
		}
		return nil, fmt.Sprintf("failed to list pod events: %v", err)
	}

	now := time.Now()

	type evWrap struct {
		e   corev1.Event
		t   time.Time
		age string
	}
	tmp := make([]evWrap, 0, len(lst.Items))

	for _, e := range lst.Items {
		t := e.LastTimestamp.Time
		if t.IsZero() {
			t = e.EventTime.Time
		}
		if t.IsZero() {
			t = e.CreationTimestamp.Time
		}
		tmp = append(tmp, evWrap{
			e:   e,
			t:   t,
			age: sinceStr(t, now),
		})
	}

	sort.Slice(tmp, func(i, j int) bool {
		return tmp[i].t.After(tmp[j].t)
	})

	out := make([]PodDiagEvent, 0, 12)
	for i := 0; i < len(tmp) && i < 12; i++ {
		e := tmp[i].e
		out = append(out, PodDiagEvent{
			Type:    e.Type,
			Reason:  e.Reason,
			Message: e.Message,
			Age:     tmp[i].age,
			Count:   e.Count,
		})
	}

	return out, ""
}

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

var topo *TopologyManager

func topologySnapshotHandler(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	if topo == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "topology manager not initialized"})
		return
	}
	ns := c.Query("ns")
	if ns == "" {
		ns = "default"
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	g, err := topo.BuildSnapshot(ctx, ns)
	if err != nil {
		// IMPORTANT: don’t silently return empty
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, g)
}

func topologyStreamHandler(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	if topo == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "topology manager not initialized"})
		return
	}
	if !topo.IsReady() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "topology informers not ready"})
		return
	}

	ns := c.Query("ns")
	if ns == "" {
		ns = "default"
	}

	w := c.Writer
	flusher, ok := w.(http.Flusher)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "streaming unsupported"})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	c.Status(http.StatusOK)
	flusher.Flush()

	ctx := c.Request.Context()

	send := func(event string, v any) error {
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}

	// initial snapshot
	{
		callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		g, err := topo.BuildSnapshot(callCtx, ns)
		cancel()
		if err == nil {
			_ = send("snapshot", g)
		} else {
			log.Printf("[topology] stream initial snapshot error: %v", err)
			fmt.Fprintf(w, ": error %v\n\n", err)
			flusher.Flush()
		}
	}

	notifyCh, cancelSub := topo.Subscribe(ns)
	defer cancelSub()

	keepAlive := time.NewTicker(20 * time.Second)
	defer keepAlive.Stop()

	// simple coalesce
	var pending bool
	var timer *time.Timer
	stopTimer := func() {
		if timer != nil {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer = nil
		}
	}

	for {
		select {
		case <-ctx.Done():
			stopTimer()
			return

		case <-keepAlive.C:
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()

		case <-notifyCh:
			if !pending {
				pending = true
				stopTimer()
				timer = time.NewTimer(500 * time.Millisecond)
			}

		case <-func() <-chan time.Time {
			if timer == nil {
				return make(chan time.Time)
			}
			return timer.C
		}():
			// drain burst
			for {
				select {
				case <-notifyCh:
				default:
					goto drained
				}
			}
		drained:

			callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			g, err := topo.BuildSnapshot(callCtx, ns)
			cancel()

			if err == nil {
				_ = send("snapshot", g)
			} else {
				log.Printf("[topology] stream snapshot error: %v", err)
				fmt.Fprintf(w, ": error %v\n\n", err)
				flusher.Flush()
			}

			pending = false
			stopTimer()
		}
	}
}

package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/bson"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

var kubeClient *kubernetes.Clientset

// initKube tries in-cluster config first (for GKE). If that fails and
// cfg.Kube.Kubeconfig is set, it falls back to that kubeconfig (for local dev).
func initKube(ctx context.Context) error {
	var (
		restCfg *rest.Config
		err     error
	)

	// 1. Try in-cluster config (this is what will be used in GKE)
	restCfg, err = rest.InClusterConfig()
	if err != nil {
		// 2. Fallback for local dev: use kubeconfig path from config.yml (optional)
		if cfg.Kube.Kubeconfig == "" {
			// no kubeconfig configured, just return the in-cluster error
			return err
		}

		log.Printf("in-cluster config failed (%v), falling back to kubeconfig: %s", err, cfg.Kube.Kubeconfig)

		restCfg, err = clientcmd.BuildConfigFromFlags("", cfg.Kube.Kubeconfig)
		if err != nil {
			return err
		}
	}

	clientset, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return err
	}

	// Optional lightweight check – this has no context param, just call it
	if _, err := clientset.Discovery().ServerVersion(); err != nil {
		return err
	}

	kubeClient = clientset
	log.Printf("Kubernetes client initialized")
	return nil
}

// requireAdmin: look up the current user in Mongo and ensure role == "admin".
func requireAdmin(c *gin.Context) bool {
	emailVal, ok := c.Get("userEmail")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "user not in context"})
		return false
	}
	email, _ := emailVal.(string)
	email = strings.ToLower(strings.TrimSpace(email))

	var u User // assuming you have type User in your auth/db code
	err := userColl.FindOne(c.Request.Context(), bson.M{"email": email}).Decode(&u)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "admin only"})
		return false
	}

	if u.Disabled || strings.ToLower(u.Role) != "admin" {
		c.JSON(http.StatusForbidden, gin.H{"error": "admin only"})
		return false
	}

	return true
}

func humanAge(t time.Time, now time.Time) string {
	d := now.Sub(t)
	if d.Hours() >= 48 {
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
	if d.Hours() >= 1 {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	if d.Minutes() >= 1 {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	return fmt.Sprintf("%ds", int(d.Seconds()))
}

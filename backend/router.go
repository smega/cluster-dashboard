package main

import "github.com/gin-gonic/gin"

func setupRouter() *gin.Engine {
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery(), corsMiddleware())

	// API routes
	api := r.Group("/api")
	{
		// public
		api.POST("/login", loginHandler)

		// protected (JWT)
		protected := api.Group("/")
		protected.Use(authMiddleware())
		{
			protected.GET("/me", meHandler)
			protected.GET("/protected-example", protectedExampleHandler)

			// pods
			protected.GET("/pods", podsHandler)
			protected.GET("/pods/:namespace/:name", podDetailHandler)
			protected.GET("/pods/stream", podsStreamHandler) // SSE

			// deployments
			protected.GET("/deployments", deploymentsHandler)
			protected.GET("/deployments/:namespace/:name", deploymentDetailHandler)
			protected.GET("/deployments/stream", deploymentsStreamHandler) // SSE

			// rbac
			protected.GET("/rbac/namespaces", rbacNamespacesHandler)
			protected.GET("/rbac/namespace/:namespace/summary", rbacNamespaceSummaryHandler)
			protected.GET("/rbac/role", rbacRoleDetailHandler)

			// services
			protected.GET("/services", servicesListHandler)

			// ingresses
			protected.GET("/ingresses", ingressesListHandler)

			// volumes
			protected.GET("/volumes", volumesListHandler)

			// kube batch (jobs/cronjobs)
			protected.GET("/kube/namespaces", kubeNamespacesHandler)
			protected.GET("/kube/batch", kubeBatchListHandler)
			protected.GET("/kube/cronjobs/:namespace/:name", kubeCronJobDetailHandler)
			protected.GET("/kube/jobs/:namespace/:name", kubeJobDetailHandler)

			// kube config inventory (ConfigMaps only -- Secrets are
			// deliberately not exposed by this API at all)
			protected.GET("/kube/configmaps", kubeConfigMapsListHandler)
			protected.GET("/kube/configmaps/:namespace/:name", kubeConfigMapDetailHandler)

			// autoscaling: HPA / VPA / PDB
			protected.GET("/kube/hpas", kubeHPAsListHandler)
			protected.GET("/kube/hpas/:namespace/:name", kubeHPADetailHandler)

			protected.GET("/kube/pdbs", kubePDBsListHandler)
			protected.GET("/kube/pdbs/:namespace/:name", kubePDBDetailHandler)

			protected.GET("/kube/vpas", kubeVPAsListHandler)
			protected.GET("/kube/vpas/:namespace/:name", kubeVPADetailHandler)

			// events & warnings
			protected.GET("/kube/events", kubeEventsListHandler)
			protected.GET("/kube/events/:namespace/:name", kubeEventDetailHandler)

			// related events for an involved object (uid)
			protected.GET("/kube/events/related", kubeEventsRelatedHandler)

			// statefulsets
			protected.GET("/statefulsets", statefulSetsHandler)
			protected.GET("/statefulsets/:namespace/:name", statefulSetDetailHandler)
			protected.GET("/statefulsets/stream", statefulSetsStreamHandler) // SSE

			// storage inventory
			protected.GET("/kube/storage/pvs", kubePVsListHandler)
			protected.GET("/kube/storage/pvs/:name", kubePVDetailHandler)

			protected.GET("/kube/storage/storageclasses", kubeStorageClassesListHandler)
			protected.GET("/kube/storage/storageclasses/:name", kubeStorageClassDetailHandler)

			protected.GET("/kube/storage/csidrivers", kubeCSIDriversListHandler)
			protected.GET("/kube/storage/csidrivers/:name", kubeCSIDriverDetailHandler)

			protected.GET("/kube/storage/snapshots", kubeVolumeSnapshotsListHandler)
			protected.GET("/kube/storage/snapshots/:namespace/:name", kubeVolumeSnapshotDetailHandler)

			protected.GET("/kube/storage/snapshotclasses", kubeVolumeSnapshotClassesListHandler)
			protected.GET("/kube/storage/snapshotclasses/:name", kubeVolumeSnapshotClassDetailHandler)

			// nodes
			protected.GET("/nodes", nodesListHandler)
			protected.GET("/nodes/:name", nodeDetailHandler)

			// networkpolicies
			protected.GET("/kube/networkpolicies", kubeNetworkPoliciesListHandler)
			protected.GET("/kube/networkpolicies/:namespace/:name", kubeNetworkPolicyDetailHandler)

			// Image provenance
			protected.GET("/kube/provenance", kubeImageProvenanceListHandler)
			protected.GET("/kube/provenance/:kind/:namespace/:name", kubeImageProvenanceDetailHandler)

			// Cost waste signals
			protected.GET("/kube/waste", handleWasteSignals)

			// Kubernetes overview
			protected.GET("/overview", clusterOverviewHandler)

			// Kubernetes topology
			protected.GET("/topology/snapshot", topologySnapshotHandler)
			protected.GET("/topology/stream", topologyStreamHandler)

		}
	}

	// OPTIONAL: simple health endpoint
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	// IMPORTANT: do NOT call r.Static("/", "./static") here,
	// since frontend is served by its own nginx.

	return r
}

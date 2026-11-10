# cluster-dashboard

A Kubernetes cluster dashboard: pods, deployments, services, ingresses,
volumes, logs, RBAC, nodes, jobs/cronjobs, HPAs, storage, network policies,
image provenance, and a resource-waste view. Backend in Go (Gin + client-go),
frontend in Preact.

This started as a copy of a larger internal tool that also had GCP
(Cloud Build, Cloud SQL, Artifact Registry, Secret Manager, Pub/Sub,
Scheduler, Tasks, Load Balancers, GKE snapshots, Logging) and MongoDB Atlas
integrations, built around a specific employer's infrastructure. All of that
has been removed here -- this is Kubernetes-only.

## Known remaining risk areas (read before deploying this anywhere public)

- `kube_exec_handlers.go` / `POST /api/exec/command` and `/api/exec/script`:
  lets an authenticated caller run arbitrary commands inside the cluster.
  `rbac_handlers.go`'s `POST /rbac/binding/add` and `/rbac/binding/remove`
  can also modify RBAC bindings. Several other endpoints can delete pods
  (`DELETE /pods/:ns/:name`) or scale deployments/statefulsets. None of
  this is "readonly" -- decide whether to strip these endpoints (or gate
  them behind a separate admin-only role) before exposing this anywhere
  that isn't fully trusted.
- `kube_cm_secrets_handlers.go`'s `GET /kube/secrets/:namespace/:name` can
  return actual Secret values (base64) when called with `?includeData=1`.
  Fine for a private/authenticated admin view; not something to expose on
  a public instance.
- The in-cluster RBAC this backend's ServiceAccount is bound to needs to be
  written specifically for whatever subset of the above you actually keep --
  don't reuse a ClusterRole that grants more than the app needs.

## Config

Copy `backend/config.yml`, fill in your own `mongo.uri` (used for this app's
own user accounts, not cluster data) and a generated `auth.jwt_secret`
(`openssl rand -hex 32`), and keep your copy out of git.

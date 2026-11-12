# cluster-dashboard

A readonly Kubernetes cluster dashboard: pods, deployments, services,
ingresses, volumes, RBAC, nodes, jobs/cronjobs, HPAs/VPAs/PDBs, storage,
network policies, image provenance, a resource-waste view, and a live
topology graph. Backend in Go (Gin + client-go), frontend in Preact.

## Live demo

Running on a home Raspberry Pi k3s cluster: **https://cluster.smega.eu**

```
email:    demo@cluster.smega.eu
password: zDmKTpZdTt0j5QKTR2uA
```

The demo account is shared on purpose - if it ever gets abused, the
password just gets rotated. Everything behind the login is genuinely
readonly: there is no exec-into-pod, no delete/restart/scale, no write
access of any kind. See `backend/router.go` for the full route list.

## Origin

This started as a stripped copy of a larger personal tool that also had
GCP (Cloud Build, Cloud SQL, Artifact Registry, Secret Manager, Pub/Sub,
Scheduler, Tasks, Load Balancers, GKE snapshots, Logging) and MongoDB Atlas
integrations, built for a cluster that no longer runs. All of that -
along with every write/exec/delete endpoint, the pod-log viewer, and the
raw Secret-value endpoint - has been removed here. This is Kubernetes-only,
and fully readonly.

## Config

Copy `backend/config.yml`, fill in your own `mongo.uri` (used for this
app's own user accounts - login/role, not cluster data) and a generated
`auth.jwt_secret` (`openssl rand -hex 32`), and keep your copy out of git.

Create a user with `go run backend/tools/hash_password.go -password 'yours'`
to get a bcrypt hash, then insert `{email, password_hash, role, disabled: false}`
into the `users` collection yourself, or adapt `backend/tools/create_user`
(a tiny Mongo-upsert tool meant to run as a one-off Kubernetes Job, reading
`MONGO_URI` from the same secret the backend uses - see `job.example.yaml`).

## Deploying

The backend needs a `ClusterRole` with read access to whatever subset of
resources you want visible - don't reuse a broader one. `role: "admin"` on
a user only unlocks the Topology page in this fork; there is no elevated
write capability tied to any role.

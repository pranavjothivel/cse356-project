# Future Improvements

Where the system is today vs. where it could go next. The first section is the honest list of *known limitations* in the current implementation; the second is a more ambitious roadmap for what we'd do if this were a long-lived product instead of a 4-week term project.

---

## Near-term: limitations carried over from the current build

These are the items previously listed under "Limitations that remain" in `SCALING.md` and the "Known issues" block in `DEVELOPER-GUIDE.md`. Each one is either a known regression risk we accepted under time pressure or a follow-on optimization we sketched but didn't ship.

### Data / storage

1. **Dual-table FTS.** The GIN-on-write-path pathology is mitigated (`fastupdate=off` bounds the cost) but not architecturally removed. A `message_search` table populated asynchronously after the message-send response would take FTS off the request path entirely.
2. **Read replica.** All reads still hit the primary. A Postgres read replica for `GET /api/messages` / `/api/search` / `/api/communities` would roughly double peak rate by freeing primary CPU for writes.
3. **AOF on Redis-01.** RDB persistence is disabled to remove BGSAVE fork pauses (see `SCALING.md` Bottleneck 7). AOF with `appendfsync everysec` would buy persistence without the stall; we just haven't switched.

### Operational

4. **No autoscaling.** The cluster is hand-scaled. Adding a node is well-documented (`claude-docs/api-node-bootstrap.md`) but requires a human.
5. **Community find-or-create.** Duplicate-name `POST /api/communities` currently returns `409` + the existing community ID; some clients don't handle `409` and keep reporting failure. Proposed fix: auto-join on duplicate name.
6. **Load-generator client / server URL drift.** The course-side generated client expects `GET /api/unread` while we exposed `/api/conversations/unread`; `POST /api/channels/:id/read` is called with conversation IDs but the channels handler uses `requireChannelMember`. Server-side aliases / fallbacks would smooth this without requiring the client to be regenerated.

---

## Longer-term: rebuilding for the next 10×

If we kept iterating on the system past the term-project window, the next architectural pass would look like this.

### Language & type safety

- **Migrate the server from JavaScript to TypeScript.** The client is already TypeScript; aligning the server stops the type information from being lost at the API boundary, makes refactors safer once the codebase grows past one team, and lets us share request/response types across the wire via a shared `@cse356/types` package.

### Service boundaries — toward macroservices

Keep the **monorepo** structure (one repo, one CI/CD model, shared tooling) but break the single Node monolith into a handful of **macroservices** scoped by *resource usage profile* and *criticality* rather than by line of business. The current monolith mixes auth, message hot-path, presence pub/sub, file storage, and search — each with different scaling shapes, blast radii, and failure modes — into one process. The proposed split:

- **`auth` macroservice.** Local accounts + OAuth providers (Google, GitHub, OIDC) + multi-provider linking. Stateless once a session is issued. Isolated so an OAuth-provider outage or a brute-force-login burst can't starve message delivery.
- **`management` macroservice.** CRUD for communities, channels, and user profiles. Lower request volume, higher consistency requirements (membership state must be transactionally correct). Different scaling shape from the hot path.
- **`messages-pubsub` macroservice.** Cross-node WS broadcast (today's Redis-02 path), the per-worker channel routing, and the presence-aware fanout. Owns the high-volume, low-criticality side of message delivery (an occasional dropped broadcast is recoverable on the next page reload).
- **`presence-pubsub` macroservice.** Online / idle / away / offline state, the per-user mutex, the connection-count semantics. Co-tenanted today with the message hot path; splitting it out means a presence-storm doesn't degrade message latency.
- **`messages-coordinator` macroservice.** Owns the message-send happy path: takes a `POST /api/messages`, accepts it, **enqueues** the durable write to Postgres and the index write to search, **immediately** dispatches the broadcast through `messages-pubsub`, and returns `2xx` to the caller before either persistence step completes. The classic read-your-own-writes invariant is preserved by caching the just-written message body in Redis for the message's lifetime in the client cache window. (See queueing notes below.)
- **`storage` macroservice.** Wraps Postgres with PgBouncer in front and a write-through Redis cache behind. Owns the schema, the migration applier, and the only process allowed to take real Postgres transactions. Other services talk to it via a typed RPC interface so the underlying engine is replaceable.
- **`search` macroservice.** Elasticsearch or Meilisearch with its own indexer that consumes the same message-write queue the storage path uses. Search is no longer on the request path at all — `GET /api/search` hits the search index directly with its own pool sizing.

The `messages-coordinator` is the synchronization point: a `POST /api/messages` becomes three queued writes (pub/sub fanout, Postgres durable write, search index write), all dispatched in parallel. The HTTP response acknowledges the *intent* once the message has been accepted into the queue; the user's optimistic UI shows the message immediately; durability and searchability catch up within milliseconds. This is the **write-behind / queued-acknowledge** pattern — trades a small amount of consistency-on-disk for a large amount of perceived latency.

#### Queuing techniques worth considering

- **Per-recipient ordered queues** for fanout — guarantees in-order delivery per channel without forcing a single global order.
- **At-least-once with idempotency keys** on writes — a queued message carries a UUID so a redelivery on retry doesn't duplicate.
- **Dead-letter queues** for messages that fail durable write or index after N retries, with on-call alerts so they never silently disappear.
- **Async batch flush** for low-priority writes (read-state updates, presence-history audits) — batch up to N or T-ms and write in one transaction.

### Deployment & infrastructure

- **Kubernetes-native, not VM-native.** Move off PM2-on-systemd-on-Linode to a Kubernetes deployment where each macroservice is a Deployment + Service + HPA. Workloads get scheduling, restart, and rollout behavior for free; node failures don't take down a worker pool.
- **Blue/Green deployments gated on latency.** Each release lands in a parallel "green" set of pods; a release-promotion job replays a slice of the course load generator's traffic *and* runs an internal ad-hoc loadgen suite against green, and only flips the Service selector if both gates pass — *internal worker p95*, *end-to-end delivery p95* (browser → DB durable write → recipient WS frame), and the course grader's own latency band. Any regression and the green set is torn down without touching production.
- **Kubernetes-native plumbing.** PgBouncer as a sidecar on each app pod (or as a Deployment fronted by a Service if shared pooling beats per-pod). Gateway API for ingress, replacing HAProxy + Nginx. cert-manager for TLS. ConfigMaps + Secrets for the env vars the deploy pipeline currently rewrites by hand. Vertical and horizontal pod autoscalers tuned per macroservice (the WS pool's scaling signal is open connections; the API pool's is request rate).
- **GitOps continuous delivery.** Argo CD or Flux reconciling the cluster against a Git-tracked manifest. The repo *is* the source of truth — a merge to main applies; a rollback is a revert. Combined with the Blue/Green gate, this is also the disaster-recovery path (rebuild a fresh cluster from the manifest).
- **Everything as code.** No more SSH-and-edit on the LB host or hand-applied migrations. Kustomize/Helm for manifests, Terraform for cloud resources, Ansible for any remaining bare-metal config (sysctl tunes, kernel modules). Reviewing changes happens in the same code-review surface as application changes.

#### Cluster bootstrap depending on host

- **On Clanode (or any "VMs only, no managed Kubernetes" environment):** stand up the cluster ourselves with **k3s** for a slim production-ready setup, or **minikube** / **kind** for ephemeral environments. Maintain the node inventory in a YAML file (the analogue of today's `infra/nodes.yml`) and have the deploy pipeline trigger an **Ansible playbook** that provisions / deprovisions VMs, installs the k3s agent, joins them to the control plane, and registers them with the cluster. Adding capacity becomes: edit the YAML, push, pipeline does the rest. Decommissioning becomes the inverse — Ansible cordons + drains the node, leaves the cluster, and tears down the VM.
- **On a hyperscaler cloud (AWS / GCP / Azure / Linode Kubernetes Engine):** skip the self-managed control plane entirely and use the cloud's managed Kubernetes offering (EKS / GKE / AKS / LKE). We get HA control plane, integrated IAM, native LB-to-Service routing, persistent-volume provisioning, and the cloud's own autoscaler integration — all of which we'd otherwise have to build with Ansible + k3s.

### Observability & SLOs

- **Formal SLOs.** Today the team eyeballed the grading portal and Grafana dashboards. With macroservices we'd codify per-service SLOs (e.g. `messages-coordinator` p99 < 200 ms, `presence-pubsub` p99 < 50 ms) and wire error budgets into the Blue/Green promotion gate so a regression doesn't ship even if it tests green on the happy path.
- **Distributed tracing end-to-end.** We already export OTel from the Node workers; a full deploy would extend tracing to PgBouncer, Redis, and the future macroservice RPC layer so a slow `POST /api/messages` could be traced from the browser through every queue hop to the WS frame at the recipient.
- **Replay-from-traffic-tap test environments.** Tap a small percentage of grading-load-generator traffic into a "shadow" pod that doesn't write anywhere, just runs the code path and compares responses. Catches regressions before they ship.

### Security

- **Per-macroservice mTLS** via a service mesh (Linkerd / Istio) so a compromise in one service doesn't trivially extend to another.
- **Replace the secured impersonation endpoint with a properly-scoped grading-service principal** — today the load-generator-debug endpoint is gated by an out-of-band shared secret, which works for a term project but isn't the long-term shape.

---

The above is a sketch, not a commitment. The point is that the current build is shaped by *learning what scales* on a fixed VM cluster in 4 weeks; the next build would be shaped by *operating something the team can hand off*. Different goals, different architecture.

# Future Improvements

Where the system is today vs. where it could go next. The first section is the honest list of *known limitations* in the current implementation; the second is a more ambitious roadmap for what we'd do if this were a long-lived product.

---

## Near-term: limitations carried over from the current build

These are the items previously listed under "Limitations that remain" in `SCALING.md` and the "Known issues" block in `DEVELOPER-GUIDE.md`. Each one is either a known regression risk we accepted under time pressure or a follow-on optimization we sketched but didn't ship.

### Data / storage

1. **Dual-table FTS.** The GIN-on-write-path pathology is mitigated (`fastupdate=off` bounds the cost) but not architecturally removed. A `message_search` table populated asynchronously after the message-send response would take FTS off the request path entirely.
2. **Read replica.** All reads still hit the primary. A Postgres read replica for `GET /api/messages` / `/api/search` / `/api/communities` would roughly double peak rate by freeing primary CPU for writes.
3. **AOF on Redis-01.** RDB persistence is disabled to remove BGSAVE fork pauses (see `SCALING.md` Bottleneck 7). AOF with `appendfsync everysec` would buy persistence without the stall; we just haven't switched.

### Operational

4. **No autoscaling.** The cluster is hand-scaled. Adding a node is well-documented (`claude-docs/api-node-bootstrap.md`) but requires a human.
5. **Replace `scripts/setup-node.sh` with Ansible playbooks.** Today's per-node bootstrap is a bash script (deploy-user creation + Node + PM2 install) invoked over SSH per host by the `api-node-bootstrap` runbook. Moving the same steps into an idempotent Ansible playbook would buy dry-run support, ordered multi-host execution, declarative state convergence, and the same code-review surface application changes get. We didn't migrate during the term because the script was already in heavy use across team workflows by the time we had the Ansible context to apply — rewriting it would have cost a sprint that was better spent chasing Live-Period bottlenecks. The longer-term *k3s + Ansible playbook* flow described in the cluster-bootstrap section below is the natural endpoint of this migration; the near-term move is to lift the existing script's logic into a playbook without yet changing what it produces.

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

#### Session cookie vs JWT for inter-service auth

Today the API issues a server-side **session cookie** backed by Redis (`connect-redis`); every request resolves the session via a Redis lookup, partly mitigated by the in-memory cache on `passport.deserializeUser`. Fine for a monolith — the lookup is cheap and revocation (logout / force-logout / linked-account changes) is a `DEL`.

In a macroservice world the tradeoff shifts. Each cross-service RPC either re-verifies the session against the same central Redis (a network hop per service per request) or trusts the upstream service's identity claim (and now `messages-coordinator` and `storage` are mutually trusting in a way that complicates a security review). The natural alternative is to issue a **short-lived JWT** at the `auth` service after the initial session check; every other macroservice verifies the JWT signature locally against the `auth` service's public key with no network call.

- **Pro JWT** — stateless cross-service auth, no Redis lookup on internal hops, scales linearly with macroservice count.
- **Con JWT** — revocation is harder. A logout / forced-revoke needs a short token TTL (5–15 min) plus an in-memory blacklist of revoked-but-not-yet-expired token IDs at every service. Token payload is bigger than a session ID — worth measuring against the 4 KB cookie limit.
- **Recommended shape** — keep the session cookie at the browser edge for backwards compatibility and for the cleanest CSRF story; at the Gateway API, **exchange** the session cookie for a short-lived JWT and inject it into downstream RPCs. Revocation handled by short TTL plus a `revoked-tokens` set in Redis-01 (TTL matching the longest token lifetime). Browser-facing auth flow stays unchanged; internal services stop touching Redis for every hop.

##### Preserving per-session logout

The project spec requires that signing out of one session does *not* sign the user out of their other sessions (each login is its own session). The recommended shape preserves this naturally because the session cookie still backs every browser session at the edge:

1. Login → one session row in Redis-01, one cookie issued. Same as today.
2. Browser sends the cookie → Gateway resolves it against Redis-01 → exchanges for a short-lived JWT for downstream RPCs.
3. Logout-on-one-device → Gateway deletes *that* session row.
4. The now-invalid cookie → Gateway lookup misses → `401`. The user's *other* sessions still resolve their own cookies to their own (still-valid) Redis rows.

The wrinkle is the JWT's own TTL: a JWT minted moments before logout stays valid for the remaining 5–15 min, since downstream services verify by signature alone. Three ways to handle that window:

- **Accept the small window.** For a chat app, ≤15 min of stale auth on one logged-out device is acceptable; nothing privileged is gated behind freshness this fine-grained.
- **Per-request `jti` blacklist.** Write the JWT's `jti` (token-ID) claim into a `revoked-tokens` set in Redis-01 on logout; every downstream service checks the set. Correct but puts Redis back on every hop, defeating part of the JWT win.
- **Bind the JWT to the session_id (recommended).** Each JWT carries the issuing session's ID as a claim. The Gateway refuses to mint *new* JWTs for a revoked session because the lookup misses; existing JWTs naturally expire within TTL. No per-request Redis lookup, but the in-flight JWTs cap any logged-out window at the TTL.

##### Does this make `auth` a single point of failure?

*Issuing* tokens and *validating* tokens are two different paths, and under the recommended shape `auth` only sits on the issuing one (login + token refresh). It does **not** sit on the validation path: the Gateway resolves the session cookie against Redis-01 (one hop, no `auth` involvement); the JWT is verified at every downstream service by signature check against `auth`'s public JWKS, cached locally at each service and refreshed hourly in the background. So:

- `auth` down for **minutes**: no new logins, but existing sessions still work and all in-flight requests still verify.
- `auth` down for **hours** (longer than the JWT TTL): refresh requests fail and users are eventually logged out as their JWTs expire. Mitigation: replicate `auth` (N pods behind a Service, multi-AZ on a hyperscaler; the macroservice is stateless once the session is in Redis-01).
- `auth`'s **signing key rotated** while a downstream JWKS cache is stale: verification fails until the cache refreshes. Mitigation: standard JWKS rotation — publish the new key alongside the old for a window longer than the JWKS cache TTL, then retire the old key.

Net: `auth` is a failure dependency for login, not for steady-state request validation. K8s replica count + standard JWKS rotation hygiene keep it from being a true SPOF.

##### Handling CPU bursts on the issuing path

The above tackles *availability*. A related but separate concern is *CPU pressure*: `auth` is CPU-bound on the issuing path because of **bcrypt** — at cost 10 each password verify or signup is ~100–150 ms of pure CPU, and bursts of signups or password logins can saturate the service even at moderate request volume. Validation isn't affected (same reason as above — local JWT verify at each downstream service, no `auth` involvement), but issuing degrades.

The macroservice split already buys the most important property: a CPU-saturated `auth` degrades login latency but does *not* degrade message delivery, presence, or any other macroservice. That's the macroservice win. The remaining options apply *within* `auth`:

- **Horizontal scaling on CPU.** bcrypt is embarrassingly parallel — one hash per request, no shared state. K8s HPA targeting ~70 % CPU across N replicas is the cheapest fix; KEDA can scale on queue depth of pending signup/login work for more responsiveness under burst. Each pod's worker count should match `nproc` so bcrypt threads can each claim a core.
- **Split `auth` further into a control plane + a hash worker pool.** `auth-control` issues JWTs, manages session-cookie state in Redis, handles OAuth callbacks — all light I/O. `auth-hash` is a stateless CPU pool that does nothing but bcrypt verify and signup hashes; scales independently on CPU. `auth-control` calls `auth-hash` over gRPC with a deadline; if `auth-hash` is saturated, `auth-control` returns `429` instead of timing out a TCP connection.
- **Async signup with deferred hash.** Signup returns `202 Accepted` immediately and enqueues the bcrypt work; the account isn't usable until the hash commits, which is gated on email-verification anyway (link in the welcome email). Decouples signup ack latency from CPU pressure. Doesn't help login bursts — you can't ack a login without verifying the password — but signup-driven bursts are the more common abuse vector.
- **Passkeys / WebAuthn for new accounts (long-term).** Passkeys are public-key crypto — fast to verify, no CPU-cost dial. Existing password accounts stay supported; new accounts skip bcrypt entirely. Doesn't help today but removes the bottleneck class permanently for tomorrow.

#### Language and runtime choice per macroservice

The macroservices only need to agree on the wire protocol (gRPC + protobuf, see below), so each service can pick the runtime that best fits its workload — there's no rule that says everything has to stay Node + Express because the monolith was.

- **`auth`** — keep Node but swap Express for **[Fastify](https://fastify.dev)**. JSON-Schema-validated routes, faster per-request CPU on the framework hot path, and a stricter contract make sense for a high-volume, security-sensitive public endpoint where you actually want to reject malformed input at the door.
- **`messages-pubsub` and `presence-pubsub`** — **Go**. Goroutine-per-connection is cheap (a few KB per goroutine vs. Node's per-callback closure footprint), the M:N scheduler keeps thousands of idle WS connections off the hot path, and the broadcast-fanout workload maps cleanly onto Go's concurrency primitives (`sync.Map` for the connection registry, buffered channels for per-worker fanout, `context.Context` for deadline propagation).
- **`messages-coordinator`** — Node/TS; async orchestration of three concurrent RPCs is exactly what Node excels at.
- **`storage`** — **Rust** with `sqlx` + `redis-rs` is the right primary choice: zero-GC pauses on the hot write path, fearless concurrency for the write-through cache layer, and compile-time-checked SQL via `sqlx`'s macro means a malformed query fails the build instead of paging the on-call. Node/TS works as a stopgap if the team needs a faster initial implementation and write throughput hasn't yet become binding.
- **`search`** — driven by the engine's SDK quality; Node or Go both work for Elasticsearch / Meilisearch.

The invariant is the gRPC contract — internal callers don't know or care what language a service is written in. The browser-facing edge stays uniform REST + WS regardless.

#### gRPC for internal macroservice communication

Once the macroservices land, internal hops (`messages-coordinator` → `storage`, `presence-pubsub` → `auth`, etc.) need a wire protocol. **gRPC over HTTP/2** is the right default for internal RPCs:

- **Protobuf contracts** caught at compile time, not at runtime when a downstream service silently ignores an unknown field. Versioned, language-agnostic — if we ever add a Go ETL job or a Python ML service it generates a client from the same `.proto`.
- **HTTP/2 multiplexing** lets `messages-coordinator` fire its three concurrent queued writes (Postgres, search, broadcast-publish) over one TCP connection per downstream — no per-RPC connection-pool bloat, no HTTP/1.1 head-of-line wait.
- **Streaming RPCs** map cleanly to a few hot paths — presence-change deltas from `presence-pubsub` → consumers; search-index commit stream from `messages-coordinator` → `search`.
- **Deadline propagation.** A `POST /api/messages` with a 200 ms budget becomes a `200 ms − elapsed` deadline on every downstream hop; services can shed load instead of running to completion on a request the caller already abandoned.
- **Binary wire format** — measurably cheaper to encode/decode than JSON for the chatty inter-service paths, which adds up across the three-hop write fan-out.

Browser-facing edge stays REST + JSON (that's what the SPA and the course grading load generator speak). The Gateway API translates incoming REST → outbound gRPC for downstream hops.

#### Lock-free synchronization in place of the Redis mutex

Today's presence updates take a `simple-redis-mutex` per user before doing a read-modify-write on the presence hash — 5 Redis round-trips per update (`SET NX PX` lock acquire, `HGET body`, `JSON.parse` + JS mutation, `HSET body`, `EVALSHA release`), and the release script publishes a notification fanout to every PM2 worker subscribed to `@simple-redis-mutex:locks-releases`. Under WS connect/disconnect churn that lock-release fanout was a real cost on the data-side Redis instance (it shows up in `commandstats`).

The next-pass replacements, ordered by how much architectural change they require:

- **Server-side atomic ops via Lua.** The simplest swap: one `EVAL` per presence update that reads the hash, mutates the relevant fields in-script, and writes the result atomically on the Redis side. One round-trip, no client-held lock, no lock-release fanout. Doesn't change the architecture; just collapses 5 round-trips into 1.
- **CRDT-like presence state.** Model presence as a join-semilattice so concurrent updates merge deterministically. Each worker writes its own slice (`connections:{workerId}` for that worker's count, last-activity, etc.); the aggregate is computed at read time. Connection count is a sum across slices; status is a fixed priority order (`away > online > idle > offline`) with a per-update timestamp tiebreaker. No coordination needed because no concurrent writer ever touches the same key.
- **Single-writer-per-user routing.** In the `presence-pubsub` macroservice, consistent-hash by `user_id` and pin every operation on a user to one worker. Concurrent updates from the user's N open connections then queue inside that worker's event loop — single-threaded JS already serializes them for free. Redis becomes a *durable write-through cache* of the in-memory state instead of the synchronization point. Cost: the routing layer (Gateway + macroservice mesh) has to be hash-aware.
- **Event-sourced presence.** Append every presence-relevant event (connect, disconnect, status-change, away-message) to a Redis Stream (or Kafka further out). Consumers compute derived state. No writer ever waits on a reader; durability and read-replica scale-out come along for free.

The cumulative direction is "treat Redis-as-coordinator as a tax to remove": each step moves synchronization out of Redis and either into atomic Redis-side ops, into the data model itself, or into single-threaded JS event loops where it's free.

#### Data plane: Postgres scaling

Today's single Postgres primary handles every read and every write. Two improvements:

- **Read replicas** via streaming (physical) replication. Read-only endpoints (`GET /api/messages`, `GET /api/search`, `GET /api/communities`, `GET /api/communities/:id/members`) route to the replica pool; writes still go to the primary. Replicas can be scaled horizontally — adding one is a `pg_basebackup` + register-in-config. Expected impact: roughly 2× peak rate by freeing primary CPU for writes.
- **Read-your-own-writes handling.** Streaming replicas have lag (typically ms, sometimes seconds). Options: route reads issued within N seconds of a write back to the primary; cache-bust the affected keys on write; use `pg_last_wal_replay_lsn()` to wait for replication on critical reads. The `storage` macroservice owns this policy so callers don't have to.
- **Partition `messages` by `community_id`** if write throughput on the primary outgrows a single node. Each partition gets its own write head and its own GIN index; range queries against `WHERE community_id = ?` prune to one partition.

#### Data plane: Redis scaling and per-workload split

The current two Redis instances each carry multiple workloads. The future architecture splits them by access pattern and lifecycle so each can be scaled and tuned for persistence independently:

| Redis instance | Workload | Persistence | Scaling profile |
|---|---|---|---|
| `session-redis` | `connect-redis` sessions; lookup per authenticated request | AOF with `everysec` (losing it logs everyone out) | Primary + read replica, replication for HA |
| `cache-redis` | Channel members, message bodies, unread counts, user profile cache — rebuildable from PG | None | Primary + 1–2 read replicas to fan out cache reads |
| `presence-redis` | Per-user presence hash, the mutex (or its lock-free replacement) | None — presence is inherently ephemeral, reconstructs itself on reconnect | Single primary; failover to standby on failure, eat the brief reconnect storm |
| `pubsub-redis` | Cross-node WS broadcast fanout (today's Redis 02) | None — pub/sub is fire-and-forget | Single primary; app reconnects to standby on failure. Replication doesn't help pub/sub. |
| `queue-redis` | Work queues for write-behind durable writes, deferred bcrypt, message-coordinator fan-out tracking | AOF with `everysec` (losing queued work = losing user actions) | Redis Streams with consumer groups; horizontally shardable by `XGROUP` per stream |

Within each instance, two scaling axes:
- **HA / failover** — Redis Sentinel for VM deployments, the operator's leader-election for K8s deployments.
- **Horizontal scale** — Redis Cluster (hash-slot partitioning) when a single primary's memory or CPU stops being enough. Multi-key ops across hash slots are restricted, so this is selectively useful per workload.

#### Where Postgres + Redis actually run

Three deployment targets for the stateful tier, each with a sensible default:

- **Self-managed VMs (today's Clanode-style model).** Postgres on dedicated VMs with streaming replication to read-replica VMs; PgBouncer in front of each. For automated failover / leader election / replication management without going to K8s, **[Patroni](https://patroni.readthedocs.io/)** is the standard tool — it uses etcd / Consul / ZooKeeper as a distributed configuration store and is essentially "what an operator does, but for VMs." Redis instances as standalone processes behind **redis-sentinel** for HA. Manual scaling (resize / add replicas via ops runbook). Lowest abstraction overhead and easiest to debug, but the ops burden grows linearly with the cluster.
- **Self-managed Kubernetes with operators.** Run Postgres via [**CloudNativePG**](https://cloudnative-pg.io/) or **Zalando postgres-operator**; Redis via **redis-operator** or **KubeBlocks**. Operators handle replication topology, leader election, automated backups (WAL shipping to S3-compatible storage), version upgrades, and replica scaling — all declarative via custom resources. Right choice if we self-manage K8s on Clanode-style VMs and want the stateful tier to live by the same GitOps rules as the stateless macroservices.
- **Managed cloud services.** **RDS** / **Cloud SQL** / **AlloyDB** for Postgres; **ElastiCache** / **Memorystore** for Redis. The cloud provider handles replication, automated failover, point-in-time recovery, version upgrades, parameter-group management. Highest dollar cost per resource, lowest ops-hour cost. Right choice if we're on a hyperscaler — pair it with managed K8s (EKS / GKE / AKS / LKE) for the stateless tier.

The choice mirrors the cluster-bootstrap decision in the deployment section: VMs → either dedicated stateful VMs *or* operators if K8s is already in play; managed cloud → managed everything. Mixing dedicated-stateful-VMs *with* self-managed K8s is what we have today and works fine; it just means stateful upgrades stay manual.

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

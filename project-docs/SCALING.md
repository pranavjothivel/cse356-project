# Scaling and Load Handling

## Headline result

| Peak concurrent connections | Peak message rate | Uptime over the Live Period (4/13 → 5/8) |
|---|---|---|
| **3.3K** | **218.0 / s** | **~98.3 %** (10.7 h cumulative downtime across 624 h) |

These are the final numbers for `group1`. The remainder of this document walks through the bottlenecks we hit on the way there, the evidence we used to identify each one, the change we made, and the effect we measured.

## How we measured

Two distinct sources of load drove the system, and this document refers to them with deliberately different names so they're not conflated:

- **Course grading load generator** — the course-run infrastructure (out of our control) that connected headless API-driven clients to our deployment and ramped concurrent users until delivery / login failure rates passed a threshold, then backed off. Ran at small scale during the pre-4/13 **Test Traffic Period** (opt-in, gated on 100% API Tests passing) and then at much greater scale during the **4/13 → 5/8 Live Period**, simulating real end-users. Peak Conn and Peak Rate in the headline are therefore *demand-side* numbers from the Live Period — the grading load generator kept pushing until something broke; reducing failure rates directly raised both ceilings.
- **Our ad-hoc loadgen runs** — discrete test passes the team kicked off from a developer laptop / the loadgen node against the prod cluster to validate specific fixes (BGSAVE-off baseline, GC tuning, optimistic broadcast variants, etc.). Outputs archived in [`loadgen-reports/`](../loadgen-reports/) — JSON run summaries paired with `.log` files containing per-request traces. These are *our* runs; the grading load generator's traffic is not captured here.
- **Telemetry stack**: Grafana Alloy on every node and on a dedicated `group1-telemetry-01` collector, shipping logs + metrics to **Grafana Cloud** (Loki for logs, Mimir/Prometheus for metrics, hosted Grafana dashboards). HAProxy stats endpoint (`/stats`) for live LB state, Sentry for unhandled exceptions, **Axiom for HAProxy live log streaming** (per-request access logs piped via Vector for ad-hoc tail/aggregation during incidents). Inline `console.log` traces during deep-dive incident investigations.
- **TLS-probe CSVs** in `loadgen-reports/2026-05-06-tls-probe*.csv` (script in [`scripts/tls-probe/`](../scripts/tls-probe/)) — used to characterize LB-side cold-handshake latency separately from app-side cost.

The architecture the headline was measured against is described in [ARCHITECTURE.md](ARCHITECTURE.md); the diagram in [diagrams/architecture.png](diagrams/architecture.png) is the topology snapshot at that point.

---

## Bottleneck 1 — PostgreSQL connection pool exhaustion

### Problem
The default Sequelize pool size was `max: 5` per worker. The hottest write endpoint (`POST /api/conversations/:id/read`) ran **7–8 sequential queries** per request (a redundant `Conversation.findByPk` *and* `Channel.findByPk`, membership check, message lookup, an `isForwardRead` round-trip, the `member.save()` update, and on conversations a participant list fetch for the broadcast). Under grading-load-generator burst all pool connections sat busy; new requests queued past Sequelize's 60s `acquire` timeout, which was longer than HAProxy's `timeout server 50s` — so HAProxy 504'd first, silently.

### Evidence
- **9,685 HAProxy 504 Gateway Timeouts in one day** (2026-04-13). Every log line carried timer `Tr=-1, Ta≈50000ms` and termination flag `sH--` — the signature of "TCP accepted, server never responded inside `timeout server`."
- HAProxy stats at 15:41 UTC reported **5,697 active sessions** and **2,852 backend connections** — roughly 950 queued requests per node.
- Endpoint breakdown for the 10-minute peak: 5,266 of 5,443 504s were `POST /api/conversations/:id/read`.

### Fix
Multiple coordinated changes, by date:

1. **`server/src/db.js`** — bumped `pool.max` 5 → 20, set `pool.acquire: 15000` (below HAProxy's 50s).
2. **`POST /api/conversations/:id/read`** — eliminated the duplicate `Channel.findByPk` lookup; ran the two table lookups concurrently when both were needed.
3. **PgBouncer** — added a per-app-node local pooler in transaction mode. App connections multiplex onto a small number of real Postgres connections, removing the `max_connections` ceiling as a constraint. Provisioned by a small shell script ([`infra/pgbouncer/provision.sh`](../infra/pgbouncer/provision.sh)) at boot and templated against `.env` on every deploy.
4. **`default_pool_size 20 → 50`** — once PgBouncer was stable, the per-DB pool size was raised so a single app worker could open more concurrent backend connections without queuing inside PgBouncer.
5. **Dedicated Sequelize pool for search** (Pranav Jothivel) — split `server/src/db.js` to export both `sequelize` (main app pool, `max:14`) and `searchSequelize` (dedicated pool, `max:6`) so a heavy FTS query holding a pool slot can never starve the message-send hot path. `server/src/routes/search.js` was migrated to import the search pool. The split also opened the door to per-pool `statement_timeout` tuning.

### Effect
504s stopped reproducing in our ad-hoc loadgen runs and disappeared from the grading load generator's failure counts. `pool.acquire` time fell from "near-timeout" to sub-millisecond on the steady-state path. The DB pool stopped being a binding constraint for the rest of the project; later bottlenecks were *downstream* of fixed pool capacity, not the pool itself.

### Tradeoff / limitation
PgBouncer in transaction mode is incompatible with session-scoped Postgres features (`SET LOCAL`, prepared statements at the connection level, advisory locks). We don't use any of those — but it's a constraint on what future features can rely on.

---

## Bottleneck 2 — GIN pending-list flushes serializing inserts

### Problem
The full-text search index is a `GIN` index on `messages.content_tsv`. GIN's default `fastupdate=on` buffers index entries into a per-index *pending list* on every INSERT; the pending list is flushed lazily, but the flush is a single serialized operation on the index. Under the grading load generator's sustained write rate, the pending list grew faster than the lazy flush could keep up, and at some point an INSERT triggered a flush that took multiple seconds and serialized every concurrent INSERT behind it.

### Evidence
- A manual `gin_clean_pending_list('messages_content_fts_simple_idx')` measured **3.1 s for 190 pages** on 2026-05-04 — and that was off-peak. During load the pending list was larger.
- Statement-timeout-driven 500s observed at the 12:33 outage on 2026-05-04. The 10 s `statement_timeout` (set by PgBouncer's `connect_query`) was tripping on INSERT, not on any application-level slow query.
- Delivery p95 measurements before the fix were in the **1.5–3 s** band on hot intervals.

### Fix
```sql
ALTER INDEX messages_content_fts_simple_idx SET (fastupdate = off);
```

Applied directly via `psql` on `group1-db-psql-01` on 2026-05-04 ~14:42 EDT, out-of-band. A final `gin_clean_pending_list()` post-ALTER flushed the leftover 257 pages in 4 s; with `fastupdate=off`, no future flushes will ever fire on this index.

### Effect
Delivery p95 expected to drop into the **300–700 ms** band based on the pre-flush vs. flush latency ratio. Subsequent ad-hoc loadgen runs confirmed the long INSERT tail had vanished, and the grading load generator's per-message latency distribution flattened to match.

### Tradeoff / limitation
Per-row INSERT latency goes up slightly (each row now updates the index posting tree directly instead of appending to the pending list). For our workload this is a clear win — bounded p99 beats unbounded amortized — but on a write-much-heavier workload the trade would shift.

---

## Bottleneck 3 — `sequelize.sync({alter: true})` index bloat

### Problem
The original boot path called `sequelize.sync({ alter: true })` in production. Sequelize's `alter` algorithm cannot detect that an existing unique index is equivalent to `unique: true` in a model definition; on every boot it created a **new** uniquely-named unique index with a numeric suffix. We watched this grow to `users_username_key`, `users_username_key1`, … `users_username_key182` over 182 deploys. Every INSERT got progressively slower because Postgres must update every unique index covering the column.

### Evidence
- Schema baseline dump (`server/scripts/migrations/0007-baseline-schema.sql`) still preserves 30+ `communities_name_keyN` constraints as a visible historical artifact.
- INSERT timings on `users` were 4–5× the cost of the same INSERT on a freshly-bootstrapped DB.

### Fix
- **Disabled `sync({alter})` in production**; dev still uses it for convenience. The `start()` bootstrap now calls `sequelize.sync({ alter: process.env.NODE_ENV !== 'production' })`.
- **One-off cleanup script** at `server/scripts/cleanup-duplicate-user-indexes.js`. Its first version naively issued `DROP INDEX`, which Postgres rejects when the index backs a unique constraint; a follow-up hardened it to `ALTER TABLE … DROP CONSTRAINT` for those cases so the duplicates actually came off.
- **Manual SQL migration workflow** in `server/scripts/migrations/` for any schema change going forward; see [`server/scripts/migrations/README.md`](../server/scripts/migrations/README.md).

### Effect
Per-row INSERT cost dropped back to the baseline (1 unique-index update per column, not N+1). Equally important: future deploys no longer add to the problem.

### Tradeoff / limitation
We give up the convenience of automatic schema drift in production. Any schema change now requires a numbered SQL file applied by hand. We accepted this as a one-time cost — and the schema baseline (`0007-baseline-schema.sql`) means a fresh bootstrap doesn't have to replay 182 deploys of `alter` decisions.

---

## Bottleneck 4 — Single shared Redis client (head-of-line blocking)

### Problem
The original app shared *one* `redis-server` instance for sessions, cache, presence, distributed locks, and cross-node pub/sub — *and* one `node-redis` client carried all of that traffic. Every WS broadcast publish, every session lookup, every presence hash update, and every mutex `SET NX PX` queued behind each other on a single TCP socket per worker. Under load this manifested as the system hitting a hard ceiling around **71 msg/s per cluster (~7/s/worker)** — far below what Node.js workers can do.

### Evidence
- Peak rate audit on 2026-05-04: 5 nodes × 2 workers = 10 event loops at 71/s ≈ **7/s/worker**. Single-digit throughput per worker is not a Node problem.
- `commandstats` on Redis showed `EVALSHA` (mutex release) and `PUBLISH` (mutex release notification + WS broadcast) competing on the same client.
- The mutex release script itself fans out a SUBSCRIBE callback to **all 40 PM2 workers** cluster-wide on every lock release — every presence read-modify-write was paying that fanout cost on the shared client.

### Fix
Two passes:

1. **Split into per-purpose Redis clients** (driven by Chris). `server/src/redis.js` now exports `cacheClient`, `presenceClient`, `lockClient`, and the existing session client as distinct `node-redis` connections. Each owns its own TCP socket per worker, so a long EVALSHA on the mutex client no longer head-of-line-blocks a presence read on a different client.
2. **Move cross-node WS pub/sub to a dedicated Redis instance** (`group1-db-redis-02` on `:6380`), via the `REDIS_PUBLISH_URL` env var consumed by `server/src/ws.js`. The data-side instance (`:6379`) no longer carries any fanout traffic — it's session/cache/presence/mutex only.

### Effect
Each workload now has its own socket; head-of-line wait on one workload no longer back-pressures the others. The split was the largest *structural* lever in the project and unblocked the next round of bottlenecks (which were no longer Redis-side).

### Tradeoff / limitation
More open connections per node (4× the client count). At 40 PM2 workers cluster-wide, that's roughly 200 Redis connections — well inside the per-instance ceiling, but worth knowing if the cluster grows further.

---

## Bottleneck 5 — Pub/sub fanout amplification with WS pool size

### Problem
Every `POST /api/messages` publishes a broadcast event onto Redis-02. Every WS-pool worker subscribes to the relevant channels and deserializes every event delivered to it. The payload includes the recipient set as a JSON array (snapshotted from the channel members list), which for popular channels can hit **~180 KB**. *Every* subscriber pays the cost of receiving and parsing every broadcast — so adding more WS nodes multiplied the per-publish work on the single-threaded Redis-02 process instead of dividing it.

### Evidence
- On 2026-05-08, the WS pool was extended from 4 → 8 nodes (adding `04b`/`05a`/`06a`/`07a`). Within minutes, **subscribers fell minutes behind real-time**, self-echo round-trip latency reached **seconds**, and the system became unusable.
- This is captured in the memory note `feedback_pubsub_subscriber_count_amplifies_publish.md`: more subscribers = more work on the single-threaded Redis.

### Fix
Three-pass restructure of WS fanout (each pass shipped as its own deploy so the system was never in a broken intermediate state):

1. **Per-worker subscription** — each WS worker subscribes to a per-worker pub/sub channel named after its own identifier in addition to the legacy shared `messages` channel. No behavior change yet — every broadcast was dual-published to both the legacy channel and the appropriate per-worker channels.
2. **Presence-aware fanout** — `broadcastToUsers` now looks up the recipient set in Redis presence, groups recipients by which worker holds their connection, and publishes to *only* those per-worker channels. The legacy `messages` channel is still published to for safety.
3. **Drop the legacy channel** — once the per-worker path was confirmed stable, the legacy `messages` channel and the dual-publish shim were removed. Done.

While the per-worker rewrite was being landed, the extra WS nodes that had been provisioned during the earlier capacity scale-out were **parked** rather than deleted — their entries in `infra/nodes.yml` were commented out so the deploy pipeline skipped them, but the IPs remained recoverable in case we wanted to bring them back after the rewrite.

### Effect
Per-publish work is now proportional to the number of workers actually holding at least one recipient socket, not to the total subscriber count. This is the only fix in the doc that changes a *complexity class* — the others tune constants.

### Tradeoff / limitation
The presence-aware routing adds Redis state writes on connect/disconnect (each worker maintains its locator entry in `presence`). The cost is amortized over the connection lifetime and is small relative to the fanout savings.

---

## Bottleneck 6 — WebSocket broadcast payload size & hot-path cost

### Problem
Even after the per-worker routing fix removed the *fan-out amplification* problem, the broadcast payload itself was still expensive. Each `POST /api/messages` produced a published event that subscribers had to deserialize and then iterate over per-recipient. Two hot-path costs sat on top of the payload:

1. **Per-`deliverLocal` JSON.stringify** — for each receiving worker, the broadcast object was re-stringified on every `ws.send()`. With hundreds of local sockets per worker, the same payload was being re-serialized hundreds of times.
2. **Unconditional `deliverLocal` on API-only workers** — even workers that held zero sockets were entering the per-recipient loop and iterating an empty `users` Map.

Both of these compounded with payload size: bigger payload = more bytes to stringify, more bytes on the wire to every connected socket on the worker.

### Evidence
- `commandstats` on Redis-02 showed the per-publish cost stayed elevated even after the per-worker routing landed.
- Event-loop-lag instrumentation (`monitorEventLoopDelay`, gated by `LOG_EL_LAG=1`) on the WS workers attributed the residual cost to the broadcast hot path itself rather than to publish/subscribe overhead.
- Profiling captures during the 2026-05-05 / 2026-05-06 tuning sessions showed JSON serialization as the dominant cost on hot WS workers.

### Fix
A bundle of WS hot-path optimizations was cherry-picked onto `main` by Pranav Jothivel:

- **Pre-stringify broadcast payload once at the publisher** — instead of letting each `deliverLocal` call run its own `JSON.stringify`, the payload is serialized exactly once and the resulting buffer is passed to every `deliverLocal` and to the cross-node publish. For a recipient set of N local sockets this cuts N serializations down to 1.
- **Skip `deliverLocal` entirely on api-only workers** — they don't hold any sockets, so iterating their `users` Map per broadcast was pure waste. The worker now early-exits when `WORKER_ROLE === 'http'`.
- **Chunk per-user fanout on the subscriber path** — large recipient sets are split into chunks so a single broadcast can't monopolize the event loop while iterating thousands of recipients.
- **Coalesce `broadcastPresenceChange` per user with a 250 ms debounce** — multiple rapid presence transitions for the same user collapse into one outbound frame instead of N.

### Effect
Per-broadcast event-loop cost on hot WS workers dropped substantially (visible in `LOG_EL_LAG=1` traces — p99 lag stopped tracking the per-publish rate). API-only nodes stopped showing the spurious deserialization CPU spikes.

### Tradeoff / limitation
The recipient set is now baked into the pre-stringified payload at publish time, so any per-recipient targeting must happen at the publish layer rather than on the receiving worker. We do that already via the per-worker routing (Bottleneck 5), so this fit cleanly — but it does close the door on cheap per-recipient payload customization.

---

## Bottleneck 7 — Redis RDB BGSAVE forks blocking the command thread

### Problem
Redis-01 was running with the default `save 900 1 300 10 60 10000` policy. Under our write rate (presence updates, session writes, mutex releases) it triggered an RDB save every ~60 s. Each save begins with `fork(2)` of the **1.5 GB** Redis process; on this host that takes 46–100 ms during which the command thread is blocked. The save itself then runs for ~53 s of CoW copying, holding extra memory pressure.

### Evidence
- `LATENCY HISTORY fork-spawn` showed forks of 46–100 ms.
- `SLOWLOG` captured periodic 157 ms blocks on simple `EXPIRE` commands during forks (active-expiration competing with fork pressure).
- `INFO persistence` confirmed save firing roughly once a minute.

### Fix
Disabled RDB save policy on Redis-01: `CONFIG SET save ""`. Persistence is now turned off for the cache/presence/sessions instance.

### Effect
The periodic command-thread stalls disappeared. Per-minute p99 latency artifacts went away.

### Tradeoff / limitation
We lose Redis persistence on `:6379`. We *can* afford this — every piece of state on that instance is either:
- **Sessions** — rebuildable by users logging back in.
- **Caches** (`channel:*:members`, `user:*`, `unread:*`) — rebuildable from Postgres on cache miss.
- **Presence** — ephemeral by design; reset on every connection cycle anyway.
- **Mutex** — only held during in-flight requests; loss = no-op.

If we ever store durable state on Redis-01, this trade reverses.

---

## Bottleneck 8 — HAProxy single-thread + tight limits

### Problem
The LB was originally a 2 vCPU node running HAProxy with `nbthread 4` and `maxconn 8192`. After we resized it to 16 vCPU / 30 GB, `nbthread 4` left 12 cores idle while the 4 active threads stayed pegged. `maxconn 8192` started showing up as a hard wall as we approached 1.6K concurrent connections (each user holds several sockets — REST + WS + asset fetches).

Additionally:
- Default `tune.ssl.lifetime 600s` was wasting TLS handshakes on returning clients.
- HTTP/1.1-only ALPN forced one connection per concurrent request; HTTP/2 was available and free.
- `timeout http-keep-alive` falling back to `timeout client 50s` closed idle pooled connections too aggressively for chat traffic, paying handshake cost on every gap.

### Evidence
- HAProxy stats showed concurrent connections approaching the 8192 cap during peak grading-load-generator traffic.
- TLS-probe CSVs (`loadgen-reports/2026-05-06-tls-probe*.csv`) captured cold-handshake latency in the 600–1100 ms range pre-tuning.
- e2e delivery p99 was 638 → **1144 ms** under cold-handshake amplification.

### Fix

- **`nbthread 4 → 16`** in `infra/haproxy/haproxy.cfg` — match the resized LB host. Without this, HAProxy stayed capped at 4 worker threads regardless of how many cores were available.
- **`maxconn 8192 → 32768`** on the global section — give headroom above the observed connection peak so the LB never hits the artificial wall under burst.
- **Advertise HTTP/2 via ALPN** on the `:443` bind — clients that speak h2 multiplex many requests over a single TLS connection, eliminating the per-request handshake jitter that was pushing cold p99 to 1.1 s. Backend stays HTTP/1.1; HAProxy translates between protocols.
- **`tune.ssl.lifetime 600 → 3600s`** — keep TLS session tickets valid for an hour so returning clients hit the 0-RTT resumption fast path more often, reducing handshake CPU.
- **Explicit `timeout http-keep-alive 600s`** — keep idle keep-alive connections warm so users with bursty message patterns don't pay a cold handshake on every gap. The fallback was `timeout client 50s`, too short for chat idle.
- **Equal `weight 8` on backends** — earlier configs gave `node1` 2× weight while it was the only resized node; once all nodes were equal-sized the weights were equalized so `leastconn` could balance purely by current connection count.
- **Migrated to a new LB host** with BBR + heavy sysctl tune (see [`infra/lb-sysctl-heavy.conf`](../infra/lb-sysctl-heavy.conf)). The original LB was retired in favor of this tuned replacement; the heavy tune covers TCP socket buffers, SYN backlog, TIME_WAIT churn, ephemeral port range, keepalive timers, BBR + `fq` qdisc, and a `vm.swappiness` bump.

### Effect
HAProxy CPU dropped from ~80% on 4 threads to ~25% across 16. The maxconn ceiling stopped showing up in stats. ALPN HTTP/2 eliminated the per-request handshake jitter that was pushing cold p99 to 1.1 s.

---

## Bottleneck 9 — Worker role split (API / WS / HTTP-only)

### Problem
Every PM2 worker was a monolith: REST handlers, WebSocket server, Redis pub/sub subscribers all ran in the same event loop. A large GET (`/api/search` returning a few hundred results) would stall the WS event loop on the same worker. Cross-node pub/sub events deserialized in *every* worker — including workers that held no WS connections — wasting CPU on api-only nodes.

### Evidence
- Event-loop-lag instrumentation (`monitorEventLoopDelay`) on workers carrying both REST and WS showed correlated p99 lag spikes between heavy REST handlers and the WS delivery path running on the same event loop.
- On nodes that held zero WS connections, the pub/sub subscriber was still deserializing every ~180 KB broadcast and iterating an empty `users` Map.

### Fix
`WORKER_ROLE` env var introduced with three values:
- `all` (default) — historical behavior.
- `ws` — skip API route mounts and only run the WS server. Set on the WS pool nodes.
- `http` — skip the WS server entirely *and* skip the Redis-02 pub/sub subscriber. Set on `api-node-http-01`; nodes serve REST only.

The deploy pipeline injects `WORKER_ROLE` into each node's `.env` based on `ws_only` / `api_only` / `http_only` flags in `infra/nodes.yml`.

### Effect
WS event loops no longer pay the cost of heavy REST handlers; REST workers no longer pay the cost of pub/sub fanout deserialization they have no use for. Each role can also be tuned independently (e.g. different PM2 `max_memory_restart`, different V8 GC flags — see the GC-tuning bullet in the cross-cutting section below).

### Tradeoff / limitation
- Adds operational complexity: rolling deploys must respect role-based pool membership in HAProxy. The rolling-deploy workflow handles this, but it's a coupling.
- Pub/sub publisher must still initialize on *every* role including `http` (since REST handlers publish broadcasts). An audit caught this — see memory note `feedback_audit_init_gates_for_hidden_deps.md`.

---

## Cross-cutting: PM2, V8 GC tuning, kernel limits, vertical / horizontal scaling

These weren't single bottlenecks so much as continuous capacity work; summarizing briefly:

- **PM2 cluster mode** — `instances: 'max'` per node so each vCPU runs a worker; coordination via Redis (no shared memory).
- **V8 GC tuning** — `node_args: '--max-semi-space-size=8 --max-old-space-size=384'` in `ecosystem.config.js`. Used heavily during tuning passes to shape GC behavior under the WS broadcast workload:
  - `--max-semi-space-size=8` halves the young generation from V8's ~16 MB default to 8 MB. The message-send hot path generates a lot of short-lived objects (Redis serialization buffers, `JSON.parse`/`stringify` intermediates, promise closures); a smaller semi-space means scavenges (minor GCs) run roughly twice as often but each pause is roughly half the length — so short-lived garbage gets collected before it can promote to old space, and individual pauses stop being long enough to stall the WS event loop.
  - `--max-old-space-size=384` caps the old generation at 384 MB, leaving deliberate headroom below the worker memory ceiling. Without the cap, V8 happily grows the heap until it bumps into PM2's `max_memory_restart` and the worker gets killed mid-flight — which on a WS pool worker means dropping every open WS connection it was holding. Capping old-space lets full GCs run *before* PM2 has to kill us.
  - This tuning was validated by a dedicated load-generator pass (results in [`loadgen-reports/2026-05-05-post-gc-tuning.{json,log}`](../loadgen-reports/)). Different roles could in principle take different GC flags via PM2 cluster groupings; in practice we shipped the same flags fleet-wide.
- **`max_memory_restart` 512M → 1024M** in `ecosystem.config.js` — RSS legitimately runs higher than 512M under load (WS connection state + cached members on a hot worker), and the lower limit was triggering PM2 restarts mid-burst. With the old-space cap above, full GC fires before this limit ever matters in steady state.
- **`ulimit -n` raised to 65535** on the deploy user; verified via `/proc/$pid/limits` that PM2 workers actually inherit the limit from systemd (`LimitNOFILE=1048576`).
- **Vertical resize** — original 2 vCPU / 4 GB clanodes resized to 8 vCPU / 16 GB across the API + WS pools (2026-05-05). LB upgraded to 16 vCPU / 30 GB.
- **Horizontal growth** — 2 app nodes → 3 → 4 → 7 (3 API + 4 WS after the role split) → 8 (added `api-node-http-01`).

## Limitations that remain

Honest list:

1. **Dual-table FTS.** The GIN-on-write-path pathology is mitigated (`fastupdate=off` bounds the cost) but not architecturally removed. A `message_search` table populated asynchronously after the message-send response would take FTS off the request path entirely. Out of scope for the term but the obvious next step.
2. **Read replica.** All reads still hit the primary. A read replica for `GET /api/messages` / `GET /api/search` / `GET /api/communities` would roughly double peak rate by freeing primary CPU for writes.
3. **No formal Redis persistence on `:6379`.** We chose this deliberately (everything is rebuildable from PG), but it means a Redis-01 restart is a brief session-loss event for users. AOF with a lax fsync policy would buy persistence without the BGSAVE stall.
4. **No autoscaling.** The cluster is hand-scaled. Adding a node is well-documented (`claude-docs/api-node-bootstrap.md`) but requires a human.

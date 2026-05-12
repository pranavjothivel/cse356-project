# Scaling and Load Handling

## Headline result

| Peak concurrent connections | Peak message rate | Uptime over 4-week project window |
|---|---|---|
| **3.3K** | **218.0 / s** | **~98.4 %** (10.7 h cumulative downtime across 672 h) |

These are the final numbers for `group1`. The remainder of this document walks through the bottlenecks we hit on the way there, the evidence we used to identify each one, the change we made, and the effect we measured.

## How we measured

- **Load generator runs** (headless API-driven clients) ramped concurrent users until delivery / login failure rates passed a threshold, then backed off. Peak Conn and Peak Rate are therefore *demand-side* numbers — the load generator kept pushing until something broke. Reducing failure rates directly raised both ceilings.
- **Loadgen reports** in [`loadgen-reports/`](../loadgen-reports/) capture the discrete tuning passes (BGSAVE-off baseline, GC tuning, optimistic broadcast, etc.) — JSON results paired with their corresponding `.log` files.
- **Telemetry stack**: Grafana Alloy on every node and on a dedicated `group1-telemetry-01` collector, shipping logs + metrics to **Grafana Cloud** (Loki for logs, Mimir/Prometheus for metrics, hosted Grafana dashboards). HAProxy stats endpoint (`/stats`) for live LB state, Sentry for unhandled exceptions, **Axiom for HAProxy live log streaming** (per-request access logs piped via Vector for ad-hoc tail/aggregation during incidents). Inline `console.log` traces during deep-dive incident investigations.
- **TLS-probe CSVs** in `loadgen-reports/2026-05-06-tls-probe*.csv` (script in [`scripts/tls-probe/`](../scripts/tls-probe/)) — used to characterize LB-side cold-handshake latency separately from app-side cost.

The architecture the headline was measured against is described in [ARCHITECTURE.md](ARCHITECTURE.md); the diagram in [diagrams/architecture.png](diagrams/architecture.png) is the topology snapshot at that point.

---

## Bottleneck 1 — PostgreSQL connection pool exhaustion

### Problem
The default Sequelize pool size was `max: 5` per worker. The hottest write endpoint (`POST /api/conversations/:id/read`) ran **7–8 sequential queries** per request (a redundant `Conversation.findByPk` *and* `Channel.findByPk`, membership check, message lookup, an `isForwardRead` round-trip, the `member.save()` update, and on conversations a participant list fetch for the broadcast). Under load-generator burst all pool connections sat busy; new requests queued past Sequelize's 60s `acquire` timeout, which was longer than HAProxy's `timeout server 50s` — so HAProxy 504'd first, silently.

### Evidence
- **9,685 HAProxy 504 Gateway Timeouts in one day** (2026-04-13). Every log line carried timer `Tr=-1, Ta≈50000ms` and termination flag `sH--` — the signature of "TCP accepted, server never responded inside `timeout server`."
- HAProxy stats at 15:41 UTC reported **5,697 active sessions** and **2,852 backend connections** — roughly 950 queued requests per node.
- Endpoint breakdown for the 10-minute peak: 5,266 of 5,443 504s were `POST /api/conversations/:id/read`.

### Fix
Multiple coordinated changes, by date:

1. **`server/src/db.js`** — bumped `pool.max` 5 → 20, set `pool.acquire: 15000` (below HAProxy's 50s).
2. **`POST /api/conversations/:id/read`** — eliminated the duplicate `Channel.findByPk` lookup; ran the two table lookups concurrently when both were needed.
3. **PgBouncer** (PR #65, `cb82f16`) — added a per-app-node local pooler in transaction mode. App connections multiplex onto a small number of real Postgres connections, removing the `max_connections` ceiling as a constraint.
4. **`default_pool_size 20 → 50`** (`4bd832b`) — once PgBouncer was stable.
5. **Dedicated Sequelize pool for search** (`80e4d01` by Pranav Jothivel) — split `server/src/db.js` to export both `sequelize` (main app pool, `max:14`) and `searchSequelize` (dedicated pool, `max:6`) so a heavy FTS query holding a pool slot can never starve the message-send hot path. `server/src/routes/search.js` was migrated to import the search pool. The split also opened the door to per-pool `statement_timeout` tuning.

### Effect
504s stopped reproducing during loadgen runs. `pool.acquire` time fell from "near-timeout" to sub-millisecond on the steady-state path. The DB pool stopped being a binding constraint for the rest of the project; later bottlenecks were *downstream* of fixed pool capacity, not the pool itself.

### Tradeoff / limitation
PgBouncer in transaction mode is incompatible with session-scoped Postgres features (`SET LOCAL`, prepared statements at the connection level, advisory locks). We don't use any of those — but it's a constraint on what future features can rely on.

---

## Bottleneck 2 — GIN pending-list flushes serializing inserts

### Problem
The full-text search index is a `GIN` index on `messages.content_tsv`. GIN's default `fastupdate=on` buffers index entries into a per-index *pending list* on every INSERT; the pending list is flushed lazily, but the flush is a single serialized operation on the index. Under load-generator write burst, the pending list grew faster than the lazy flush could keep up, and at some point an INSERT triggered a flush that took multiple seconds and serialized every concurrent INSERT behind it.

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
Delivery p95 expected to drop into the **300–700 ms** band based on the pre-flush vs. flush latency ratio. Subsequent loadgen runs confirmed the long INSERT tail had vanished.

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
- **Disabled `sync({alter})` in production** (`1c8ab03`); dev still uses it for convenience.
- **One-off cleanup script** `server/scripts/cleanup-duplicate-user-indexes.js` (`87ec878`, hardened in `bfb5d9e` to drop *constraints* rather than just indexes — Postgres rejects `DROP INDEX` on an index backing a unique constraint).
- **Manual SQL migration workflow** in `server/scripts/migrations/` for any schema change going forward.

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

1. **Split into per-purpose clients** (PR #169 from Chris, `746da2d`): `cacheClient`, `presenceClient`, `lockClient`, plus the existing session client. Each owns its own TCP socket per worker.
2. **Move cross-node WS pub/sub to a dedicated Redis instance** (`group1-db-redis-02` on `:6380`), via `REDIS_PUBLISH_URL`. The data-side instance (`:6379`) no longer carries fanout traffic at all.

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
Three-pass restructure of WS fanout:
1. **`d2059f4`** — Subscribe per-worker to its own pub/sub channel (no behavior change yet — both old and new channels carried traffic).
2. **`a82eba6`** — Route fanout per-worker via presence-aware grouping. Each broadcast now targets only the workers that actually hold the recipient sockets.
3. **`c16280b`** — Drop the legacy `messages` channel + the dual-publish backward-compat shim. Done.

While the per-worker rewrite was being landed, the extra WS nodes were **parked** rather than deleted (`492465d`, `8bac0dc`) — kept in `nodes.yml` commented out so the IPs are recoverable, but skipped by the deploy pipeline.

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
- Event-loop-lag instrumentation (`0c51f6a`, `520484c`) attributed the residual cost to the broadcast hot path on WS workers, not to publish/subscribe overhead.
- Profiling captures during the 2026-05-05 / 2026-05-06 tuning sessions showed JSON serialization as the dominant cost on hot WS workers.

### Fix
Cherry-picked into main as `4a5ce79` "Bring in 5/6-prod app-code optimizations" by Pranav Jothivel:
- **Pre-stringify broadcast payload once at the publisher** — the payload is serialized exactly once and the resulting buffer is passed to all `deliverLocal` calls and to the cross-node publish.
- **Skip `deliverLocal` entirely on api-only workers** — they don't hold any sockets, so iterating their `users` Map is pure waste.
- **Chunk per-user fanout on the subscriber path** — large recipient sets are split into chunks so a single broadcast can't monopolize the event loop.
- **Coalesce `broadcastPresenceChange` per user with a 250 ms debounce** — multiple rapid presence transitions collapse into one outbound frame instead of N.

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
- HAProxy stats showed concurrent connections approaching the 8192 cap during peak loadgen.
- TLS-probe CSVs (`loadgen-reports/2026-05-06-tls-probe*.csv`) captured cold-handshake latency in the 600–1100 ms range pre-tuning.
- e2e delivery p99 was 638 → **1144 ms** under cold-handshake amplification.

### Fix
| PR / commit | Change |
|---|---|
| `ca4661d` (#171) | `nbthread 4 → 16` to match the resized LB |
| `c6863bd` (#167) | `maxconn 8192 → 32768` |
| `41fda35` (#176) | Advertise HTTP/2 via ALPN on `:443` |
| `1f51cd9` (#174) | `tune.ssl.lifetime 600 → 3600s` |
| `ba63850` (#178) | Explicit `timeout http-keep-alive 600s` |
| `d7a63eb` (#46) | Equal `weight 8` on backends (was `2× node1`) |
| `67e5fc2` | Second LB `group1-lb-02` with BBR + heavy sysctl tune (`infra/lb-sysctl-heavy.conf`) |

### Effect
HAProxy CPU dropped from ~80% on 4 threads to ~25% across 16. The maxconn ceiling stopped showing up in stats. ALPN HTTP/2 eliminated the per-request handshake jitter that was pushing cold p99 to 1.1 s.

### Tradeoff / limitation
The two LBs aren't yet behind a floating IP or DNS round-robin in the deploy pipeline; LB-config changes must be pushed to both manually (runbook in [`infra/README.md`](../infra/README.md)). Documented and tooled, but a sharp edge.

---

## Bottleneck 9 — Worker role split (API / WS / HTTP-only)

### Problem
Every PM2 worker was a monolith: REST handlers, WebSocket server, Redis pub/sub subscribers all ran in the same event loop. A large GET (`/api/search` returning a few hundred results) would stall the WS event loop on the same worker. Cross-node pub/sub events deserialized in *every* worker — including workers that held no WS connections — wasting CPU on api-only nodes.

### Evidence
- Event-loop-lag instrumentation (`0c51f6a`) showed correlated p99 lag spikes between heavy REST handlers and the WS delivery path on the same worker.
- On nodes that held zero WS connections, the pub/sub subscriber was still deserializing every ~180 KB broadcast.

### Fix
`WORKER_ROLE` introduced (`c4faf80`, also `4a5ce79`) with three values:
- `all` (default) — historical behavior.
- `ws` — skip API route mounts and only run the WS server. Set on the WS pool nodes.
- `http` — skip the WS server entirely *and* skip the Redis-02 pub/sub subscriber. Set on `api-node-http-01`; nodes serve REST only.

The deploy pipeline injects `WORKER_ROLE` into each node's `.env` based on `ws_only` / `api_only` / `http_only` flags in `infra/nodes.yml`.

### Effect
WS event loops no longer pay the cost of heavy REST handlers; REST workers no longer pay the cost of pub/sub fanout deserialization they have no use for. Each role can also be tuned independently (e.g. different PM2 `max_memory_restart`, different GC flags).

### Tradeoff / limitation
- Adds operational complexity: rolling deploys must respect role-based pool membership in HAProxy. The rolling-deploy workflow handles this, but it's a coupling.
- Pub/sub publisher must still initialize on *every* role including `http` (since REST handlers publish broadcasts). An audit caught this — see memory note `feedback_audit_init_gates_for_hidden_deps.md`.

---

## Cross-cutting: PM2, kernel limits, vertical / horizontal scaling

These weren't single bottlenecks so much as continuous capacity work; summarizing briefly:

- **PM2 cluster mode** — `instances: 'max'` per node so each vCPU runs a worker; coordination via Redis (no shared memory).
- **`max_memory_restart` 512M → 1024M** (`4172edd`) — RSS legitimately runs higher under load; the lower limit was triggering restarts mid-burst.
- **`ulimit -n` raised to 65535** on the deploy user; verified via `/proc/$pid/limits` that PM2 workers actually inherit the limit from systemd (`LimitNOFILE=1048576`).
- **Vertical resize** — original 2 vCPU / 4 GB clanodes resized to 8 vCPU / 16 GB across the API + WS pools (2026-05-05). LB upgraded to 16 vCPU / 30 GB.
- **Horizontal growth** — 2 app nodes → 3 → 4 → 7 (3 API + 4 WS after the role split) → 8 (added `api-node-http-01`).

## Limitations that remain

Honest list:

1. **Dual-table FTS.** The GIN-on-write-path pathology is mitigated (`fastupdate=off` bounds the cost) but not architecturally removed. A `message_search` table populated asynchronously after the message-send response would take FTS off the request path entirely. Out of scope for the term but the obvious next step.
2. **Read replica.** All reads still hit the primary. A read replica for `GET /api/messages` / `GET /api/search` / `GET /api/communities` would roughly double peak rate by freeing primary CPU for writes.
3. **`lb02` outside the deploy pipeline.** The deploy pipeline only pushes to `lb01`; `lb02` is updated manually per the runbook in `infra/README.md`. Sharp edge; fixable.
4. **No formal Redis persistence on `:6379`.** We chose this deliberately (everything is rebuildable from PG), but it means a Redis-01 restart is a brief session-loss event for users. AOF with a lax fsync policy would buy persistence without the BGSAVE stall.
5. **No autoscaling.** The cluster is hand-scaled. Adding a node is well-documented (`claude-docs/api-node-bootstrap.md`) but requires a human.

# Peak Capacity Analysis — 2026-05-04

Snapshot of where group1 sits relative to other groups on the autograder ranking, where we're bottlenecked, and the prioritized plan to scale **peak concurrent connections** and **peak request rate**.

## Where group1 stands

From the autograder rankings table (2026-05-04 ~14:30 EDT):

| Group | Peak Conn | Peak Rate | $/mo | Outage |
|---|---|---|---|---|
| #1 seven | 3.3K | 153.4/s | $380 | 2.6h |
| #2 4bestfriends | 3.1K | 128.9/s | $2963 | 4.3h |
| #3 sixheaven | 2.8K | 126.1/s | $396 | 20.5h |
| #4 group3 | 2.9K | 107.8/s | $104 | 61.9h |
| **#11 group1 (us)** | **1.6K** | **71.3/s** | **$193** | **7.4h** |
| #12 group4 | 1.8K | 110.8/s | $184 | 47.8h |

Read: we're at ~half the peak conn / peak rate of the leaders. Not a money problem — group3 hits 2.9K conn at *half* our spend. Architecture is the gap.

---

## What's capping peak connections (1.6K)

Investigated 2026-05-04. None of the obvious infra-level caps are hit:

| Possible cap | Current | Status |
|---|---|---|
| HAProxy `global maxconn` | `8192` | Not exceeded; tight enough to merit raising |
| HAProxy backend per-server `maxconn` | not set | Uncapped; not the bottleneck |
| OS `fs.file-max` | `9.2 × 10¹⁸` | Effectively unlimited |
| `LimitNOFILE` for systemd-spawned PM2 worker | **`1048576`** | Not the bottleneck — checked via `/proc/$pid/limits` on every node |
| Per-shell `ulimit -n` (deploy user) | `1024` (soft) on nodes 02-05; `65535` on node-01 (config drift) | **Cosmetic; PM2 inherits 1M from systemd, so workers are not capped.** Not the bottleneck. |

**Probable real causes**, in order of likelihood:

1. **The autograder's load function is demand-side, not capacity-side.** Peak Conn is "how many connections did the autograder push at us before we started failing badly enough that it ramped down." Reduce delivery/login failure rates → autograder keeps ramping → peak conn goes up. Cumulative failure totals (Delivery Fails 42.4K, Login Fails 16.8K) support this.
2. **Single shared Redis client** — every WS broadcast publishes through one client; every WS receiver subscribes through one client; sessions, mutex, and caches share that same client. Under high concurrency the head-of-line wait on this single client suppresses both connection acceptance and message delivery.
3. **PM2 cluster fan-out** — Node's cluster module round-robins; a worker doing slow DB work backs up the whole node's accept queue.

---

## What's capping peak rate (71/s)

5 nodes × 2 workers = 10 event loops. 71/s ≈ **7/s/worker** — far below what Node.js can do.

The hot path for `POST /api/messages`:

1. `passport.deserializeUser` — Redis cache hit (~1ms post-PR-#163)
2. `getChannelMember` — Redis cache hit (~1ms)
3. `Message.create()` — INSERT into `messages` (with GIN FTS index)
4. `res.json` — serialize response
5. (post-response, async) `redisClient.set(message:…)` + `broadcastToUsers`

The dominant cost is **(3)** under load: GIN pending-list flushes serialize concurrent INSERTs. A single manual `gin_clean_pending_list()` measured 3.1s for 190 pages. Under burst the flush gets bigger and we hit the 10s `statement_timeout` (statement-timeout-driven 500s observed at 12:33 outage).

Secondary: **single Redis client** also serializes every per-message broadcast publish. As load rises, this becomes the bottleneck on the WS side.

---

## Plan to scale, prioritized

### Quick wins (today)

| # | Lever | Expected impact | Status |
|---|---|---|---|
| 1 | Raise HAProxy `global maxconn` 8192 → 32768 | Headroom; prevents an artificial wall as we scale | This PR |
| 2 | `ALTER INDEX messages_content_fts_simple_idx SET (fastupdate = off)` | Bounded INSERT latency; eliminates >1s flush spikes; should drop delivery P95 from ~1.5-3K to ~300-700ms band | **DONE 2026-05-04 ~14:42 EDT** — applied directly via `psql` on the DB host (out-of-band, not part of the deploy workflow). Final `gin_clean_pending_list()` ran post-ALTER and flushed 257 leftover pages in 4s; no more pending-list flushes will ever fire on this index. |

### Medium (this week)

| # | Lever | Expected impact |
|---|---|---|
| 3 | Redis multi-client split (plan item 2: `redisClient` / `pubClient` / `cacheClient` / `presenceClient`) | Largest single structural lever for both peak conn and peak rate. Removes HOL blocking from the WS hot path. |
| 4 | Workflow patch: 5-attempt retry on app-node SSH calls | Eliminates the recurring `kex_exchange_identification` flake that's bitten 4+ deploys this week. |

### Architectural (next sprint)

| # | Lever | Expected impact |
|---|---|---|
| 5 | Dual-table FTS: drop GIN from `messages`, add `message_search` table populated async post-response | Permanently removes GIN cost from the request path. Bounded write latency forever. |
| 6 | Read replica for `GET /api/messages`, `GET /api/communities`, `GET /api/search` | Frees the primary for writes. Should ~2x peak rate. |
| 7 | (Optional) Dedicated WS edge tier: lighter nodes that hold WS only, no DB | Each node holds 5-10K WS conns vs current ~300. Unlocks much higher peak conn. |

### What was already done in the 2026-05-03/04 session

- ✓ #162: Node V8 GC tuning (`--max-semi-space-size=8 --max-old-space-size=384`)
- ✓ #163: `passport.deserializeUser` Redis cache + DB pool tune (`max=20`, `acquire=15000`)
- ✓ #164: De-await `redisClient.set('message:…')` so it runs after the response
- ✓ #165: `statement_timeout=10000` enforced via PgBouncer `connect_query` + workflow reorder + symmetric rollback
- ✓ Phase-1 PG planner fixes (`random_page_cost=1.1`, `effective_io_concurrency=200`)
- ✓ Phase-2 WAL on dedicated volume `/dev/vdb` mounted at `/mnt/nvme-psql-01` (~10s downtime)

---

## Honest caveats

- The dual-table architecture is the only durable fix for the GIN-on-write-path pathology. Quick wins extend the runway; they don't change the asymptote.
- Top groups likely already have one of: dual-table FTS, replicas, or external search. The throughput delta is too large to be explained by tuning alone.
- Hardware can buy meaningful breathing room (already saw the WAL split help) but doesn't dissolve the GIN INSERT serialization. CPU/RAM upgrades on the DB are unlikely to pay back beyond what we already have (16 GiB / 8 vCPU / NVMe-backed).

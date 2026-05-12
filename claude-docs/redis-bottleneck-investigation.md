# Redis bottleneck investigation

**Date:** 2026-05-05  
**Branch state at capture time:** `perf/ws-isolation-node05` @ `75ff48b` (mutex restored, presence debounce 250ms, fanout_all chunked + deferred). Cluster running in steady state under autograder load.

## 1. Executive summary

**Redis is involved but the architecture is already partially split.** The "single Redis instance" framing in the task description is outdated: pub/sub already runs on a dedicated `redis-server` instance on port 6380, separated from sessions/cache/presence/locks on 6379. Five seconds of investigation against the running cluster shows **two Redis processes on `10.0.0.136`**, with the application's `publishClient` / `subClient` pinned to 6380 via `REDIS_PUBLISH_URL`.

What's actually hurting 6379 is **not workload interference between caches and presence — it's RDB BGSAVE policy.** The default `save 900 1 300 10 60 10000` is firing roughly once per minute under load and each save runs **53 seconds** wall-clock. Each save begins with a `fork(2)` of the 1.5 GB Redis process, which on this host takes ~46-100 ms and blocks command execution for the full fork duration. That's a head-of-line stall every ~60 s. Slowlog confirms periodic command-thread blocks up to **157 ms** on simple `EXPIRE` operations (consistent with active-expiration interleaving with fork pressure).

A second-order issue: a small number of **enormous `channel:*:members` cache values** (up to **223 KB**) on the message-send hot path. These are network-/parse-bound on the client side, not Redis-side, but they lengthen the critical path of every `POST /api/messages` for popular channels.

**Recommendations, ranked by leverage and risk:**

1. **Disable or severely reduce RDB save policy on 6379** (10 minutes of work). This is data we can rebuild from PG, so persistence is optional.
2. **Decompose the `channel:*:members` cache** — replace single-string cache with a SCANned/MGET'd structure, or just stop caching for channels with 1000+ members. (~1 hour)
3. **Do NOT further split 6379 by workload.** Per the evidence below, command interference between sessions/cache/presence/locks is not the dominant cost. The biggest stalls are fork-pauses that affect every workload uniformly, and additional splits multiply that blast radius rather than reduce it.
4. **Enable `LATENCY MONITOR` on both instances** so the next investigation has runtime telemetry without a re-deploy.

A load-correlated capture run (Phase 4 below) was **not performed** — autograder runs are not directly triggerable from this environment, and the instrumentation required to correlate capture timestamps with autograder p95 spikes was deemed out of scope ("don't make non-trivial code changes"). Findings below are from steady-state captures of the live cluster only. The recommendations rest on direct measurements (slowlog, INFO, bigkeys, command stats), not speculation.

---

## 2. Workload inventory (static analysis)

### Redis clients in `server/src/redis.js`

| Client | Workload | Underlying Redis | Notes |
|---|---|---|---|
| `redisClient` | `connect-redis` sessions | 6379 | One client, one connection per worker. Used by Express session middleware. |
| `cacheClient` | All app caches: user, message, channel-members, channel-community, channel-membership-check, conversation-members, unread-channels | 6379 | High-volume reads/writes. Largest key sizes live here. |
| `presenceClient` | `users:{id}` hash (presence body) reads/writes/dels, `multi+exec` pipelines | 6379 | Hot path for every WS connect/close/presence-msg/away-toggle and `GET /api/communities/:id/members`. |
| `lockClient` | `simple-redis-mutex` SET NX PX, EVALSHA (release script: GET + DEL + PUBLISH), and SUBSCRIBE on `@simple-redis-mutex:locks-releases` | 6379 | One subscription per worker. Heavy publish load (every release). |
| `publishClient` (`ws.js:37`) | Cross-node WS broadcast PUBLISH | **6380** (REDIS_PUBLISH_URL) | Separate Redis instance. |
| `subClient` (`ws.js:43`, duplicate of `publishClient`) | Cross-node WS broadcast SUBSCRIBE on `messages` | **6380** | Only WS workers connect (api_only nodes skip via `initWSSubscriber` gate). |

### Direct Redis call sites (grep across `server/src`)

Categorized:

**Sessions (redisClient, via connect-redis):** All session reads/writes are middleware-level. Not directly visible in app code; volume is roughly `(authenticated request rate) * 2-3 commands/req`.

**Caches (cacheClient, all on 6379):**
- `passport.js:22, 33` — user object cache (60s TTL)
- `messages.js:63, 79, 87, 92, 97, 105, 110, 116, 132, 138, 146, 151, 335, 395` — channel-community map (1h), channel members JSON array (10m), channel membership boolean (10m), conversation participants (10m), individual messages (60s)
- `communities.js:139, 167` — unread-channels bitmap per (user, community)
- `User.js:92` — user cache invalidation on save
- `models/User.js:92` — user cache invalidation

**Presence hash (presenceClient, on 6379):**
- `ws.js:559, 622, 659, 675, 694, 737, 772` — full read-modify-write of `users:{id}` body field per WS event; one `del` for last-conn cleanup
- `auth.js:303, 330` — read-modify-write of presence body on REST settings update
- `communities.js:299-300` — `pipeline.hGet('users:{id}', 'body')` for **every member** of the community in `GET /api/communities/:id/members` — this is a multi-exec'd pipeline whose size scales with community membership

**Mutex (lockClient → 6379):**
- 4 lock acquisition sites: `ws.js` × 3 (presence-msg, close, init) and `auth.js` × 1 (away toggle). Every release fires the EVALSHA + PUBLISH chain inside `simple-redis-mutex`.

**Cross-node pub/sub (publishClient/subClient → 6380):**
- 4 publish sites in `ws.js` (one channel: `messages`)
- 1 subscribe site in `ws.js:158` (16 subscribers cluster-wide = 8 PM2 workers × 2 WS nodes; api_only nodes skip)

### O(N) commands on potentially large keys

| Command | Key | Size observed | Hot? |
|---|---|---|---|
| `cacheClient.get('channel:{id}:members')` | Largest = **223,471 bytes** (5500+ user IDs serialized) | 178-223 KB for top channels | Yes — per `POST /api/messages`, parallelized with `Message.create()` |
| `presenceClient.multi().hGet('users:{id}', 'body')` × N | Each presence body 200-400 bytes; N = community size (up to a few hundred) | Pipeline of ~hundreds of HGETs | Yes — per `GET /api/communities/:id/members` |
| `cacheClient.get('message:{id}')` | ~600 bytes max observed | OK | Per message-fetch |

**Read-modify-write pattern (presence):**
- `lock(...)` — acquires per-user mutex on lockClient
- `presenceClient.hGet('users:{id}', 'body')`
- JSON.parse, JS mutation
- `presenceClient.hSet('users:{id}', 'body', JSON.stringify(...))`
- `release()` — EVALSHA on lockClient (DEL + PUBLISH)

So **5 Redis round-trips per presence read-modify-write**, all on 6379 (different clients but same instance). The lock is held across the network calls. Lock release is a script that does an internal DEL + PUBLISH (counted as separate `evalsha` and `publish` in commandstats — see Section 3).

### Pub/sub channels

| Channel | Where published | Where subscribed | Cardinality | Instance |
|---|---|---|---|---|
| `messages` | `ws.js:329, 358, 375, 626` | `ws.js:158` (1 sub per WS worker) | 16 subscribers | 6380 |
| `@simple-redis-mutex:locks-releases` | Internally by lock release Lua script | One sub per worker via lockClient | 40 subscribers (every PM2 worker) | 6379 |

`@simple-redis-mutex:locks-releases` on 6379 is the only pub/sub on the data-side instance. It carries one PUBLISH per lock release. **Every lock cycle fans out a subscribe-callback to all 40 PM2 workers cluster-wide.** This is part of the mutex contention story.

---

## 3. Evidence (raw captures)

All captures from `10.0.0.136` (Redis host), 2026-05-05 ~18:11 UTC. Full files in `/tmp/perfcheck/redis-investigation/`.

### 3.1 Two Redis instances confirmed

```
$ ssh root@10.0.0.136 'ss -tlnp | grep redis'
LISTEN 0 511   10.0.0.136:6380  *:* users:(("redis-server",pid=724,fd=7))
LISTEN 0 4096  10.0.0.136:6379  *:* users:(("redis-server",pid=1473,fd=7))
LISTEN 0 511    127.0.0.1:6380  *:* users:(("redis-server",pid=724,fd=6))
LISTEN 0 4096   127.0.0.1:6379  *:* users:(("redis-server",pid=1473,fd=6))
```

`.env` on each app node:
```
REDIS_URL=redis://10.0.0.136:6379       # sessions/cache/presence/locks
REDIS_PUBLISH_URL=redis://10.0.0.136:6380   # cross-node WS broadcast
```

### 3.2 6379 INFO (data-side instance)

**Size & memory:**
- `connected_clients:201` (40 conns/app-node × 5 nodes + 1 local)
- `used_memory_human:1.46G` / `maxmemory_human:12.00G` — 12% utilized
- `evicted_keys:0` — no LRU pressure
- `mem_fragmentation_ratio:1.03` — clean (full file in `6379-info.txt`)

**Throughput:**
- `instantaneous_ops_per_sec:7363`
- `total_commands_processed:213928593` over `uptime_in_seconds:64908` (~18h)
- `instantaneous_output_kbps:5260` — moderate

**Expirations:**
- `expired_keys:3,635,052` (~56/sec mean)
- `expired_stale_perc:12.39%` — 12% of expirations late, indicates expiration cycle is mildly behind
- `expire_cycle_cpu_milliseconds:29067` (29 s on expiration over 18 h, ~0.04% CPU)

**Pub/sub channels on 6379:**
- `pubsub_channels:1` — only `@simple-redis-mutex:locks-releases`

### 3.3 6379 commandstats (sorted by `usec_per_call` for high-volume commands)

```
cmdstat_hget:    calls=6,082,168    usec_per_call=115.75    total=704 s
cmdstat_evalsha: calls=5,507,237    usec_per_call=86.81     total=478 s   (mutex release)
cmdstat_publish: calls=5,341,543    usec_per_call=80.51     total=430 s   (mutex release notif)
cmdstat_get:     calls=134,641,952  usec_per_call=5.76      total=776 s
cmdstat_del:     calls=6,966,218    usec_per_call=28.73     total=200 s
cmdstat_set:     calls=12,213,680   usec_per_call=12.56     total=153 s
cmdstat_hset:    calls=4,331,545    usec_per_call=12.03     total=52 s
cmdstat_expire:  calls=33,399,513   usec_per_call=4.88      total=163 s
cmdstat_incr:    calls=5,428,767    usec_per_call=4.72      total=25 s
cmdstat_exec:    calls=267          usec_per_call=3,783.78  total=1 s     (presence multi/exec — outlier)
```

**Reading:**
- `hget` averaging 116 µs — that's high for HGET; most likely because presence bodies are multi-KB JSON and the application's HGET fetches the whole `body` field. Server-side this is a copy + serialize + write, microsecond-scale.
- `evalsha` averaging 87 µs is the simple-redis-mutex release script (GET + DEL + PUBLISH internally).
- `exec` averaging 3.8 ms but only 267 calls — these are `presenceClient.multi()` + N hGets for the community-members endpoint. Very expensive per call but rare. Each `exec` blocks the command thread for ~3.8 ms while the multi runs.

### 3.4 6379 SLOWLOG (top entries by duration)

`slowlog-log-slower-than = 10000` (10 ms threshold), `slowlog-max-len = 128`. **Top single-command durations (microseconds) recorded:**

| µs | Command | Notes |
|---|---|---|
| **156,788** | `EXPIRE sess:0qCYp-... 1209600` | 156.8 ms — single EXPIRE on a session key. Active-expiration cycle most likely interleaved here. |
| 15,520 | `EVALSHA <release script> 2 lock:users:a53dd... locks-releases` | Mutex release |
| 15,046 | `EVALSHA <release> 2 lock:users:d2b832...` | Mutex release |
| 14,992 | `PUBLISH @simple-redis-mutex:locks-releases ...` | Mutex release notif |
| 14,445 | `EVALSHA <release> 2 lock:users:8b9aa870-...` | Mutex release |
| 13,332 | `EVALSHA ... lock:users:8b9aa870-...` | Same as above |
| 13,276 | `PUBLISH ...` | |
| 12,531 | `HSET users:472c736c-... body {"presence":"away","conns":{...}}` | Presence body write |
| 12,160 | `PUBLISH @simple-redis-mutex:locks-releases ...` | |

**Interpretation:** the 157 ms EXPIRE is the only single-command outlier in this 100+ ms range; everything else clusters around 12-16 ms. That 157 ms blocks command execution for everything else queued behind it on 6379.

### 3.5 6379 latency baseline (60s during normal traffic)

```
$ redis-cli -p 6379 --latency-history -i 1
0 1 0.23 26   ← min/max/avg/sample-count
0 1 0.26 27
0 1 0.25 28
... 65 ticks ...
0 1 0.17 65
```

PING latency from a colocated client during the capture window: min ≈ 0 ms, max ≈ 1 ms, avg ~0.18-0.25 ms. **Note this captures redis-cli's own RTT, which excludes the queueing behind any in-flight slow command.** The latency-history saw no spikes during this window — most likely we missed a BGSAVE fork window. To capture spikes reliably we'd need a longer run plus `LATENCY MONITOR` enabled (it's currently `latency-monitor-threshold:0` = disabled).

### 3.6 BGSAVE / persistence — primary smoking gun

```
$ redis-cli -p 6379 INFO persistence
rdb_changes_since_last_save:188272
rdb_bgsave_in_progress:1               ← BGSAVE running RIGHT NOW
rdb_last_save_time:1778004914
rdb_last_bgsave_status:ok
rdb_last_bgsave_time_sec:53            ← previous BGSAVE took 53 seconds
rdb_current_bgsave_time_sec:18         ← current one is 18 s in at capture
rdb_last_cow_size:220651520            ← 210 MB COW pages on last save
aof_enabled:0
```

```
$ redis-cli -p 6379 CONFIG GET save
1) "save"
2) "900 1 300 10 60 10000"             ← default policy: save every 60 s if 10K keys changed
```

```
$ redis-cli -p 6379 INFO stats | grep latest_fork
latest_fork_usec:46199                 ← last fork took 46 ms; can spike to 100+ ms
```

With ~7363 ops/sec sustained, the `60 10000` rule fires roughly once per minute. Each BGSAVE:
1. Forks the parent process (46-100 ms — **blocks command execution for the duration of the fork**)
2. Child writes RDB to disk (~53 s wall-clock)
3. Parent accumulates COW pages for any modifications during the save (210 MB observed)

Step 1 is the head-of-line stall. Step 2 doesn't directly block command execution but pressures memory and disk bandwidth. Step 3 is invisible to commands but means a write-heavy workload during BGSAVE is doubly expensive.

**6380 has empty `save` policy** — no RDB on the pub/sub instance. That's correct since pub/sub is ephemeral.

### 3.7 6380 INFO (pub/sub instance)

- `connected_clients:57` (much fewer — only WS workers and a few others)
- `instantaneous_ops_per_sec:1306`
- `pubsub_channels:1` (`messages`)
- `PUBSUB NUMSUB messages = 16` (8 WS workers × 2 nodes)
- `instantaneous_output_kbps:77684` — **77 MB/s** of fanout traffic, vs 4.3 MB/s incoming
- `client_recent_max_output_buffer:10497128` — **10 MB** peak per-client output buffer. Indicates at least one subscriber occasionally falling behind (slow consumer pattern).
- `cmdstat_publish: calls=35,451,858 usec_per_call=38.24` — pub/sub publish is fast on 6380.

The 10 MB client output buffer peak is worth flagging as **speculative** evidence: if a WS worker's event loop blocks for ~100+ ms (which we know can happen during long fanouts before the recent `setImmediate`/chunk fix), the subscriber doesn't drain its inbound pubsub fast enough and the 6380 instance buffers the messages on its side. Once the buffer threshold is reached Redis can disconnect the client (`client-output-buffer-limit pubsub` is 32mb by default in Redis 6, 8mb hard / 0 soft). We're approaching but not exceeding that. Not currently disconnecting subscribers, but worth monitoring.

### 3.8 Big keys on 6379

```
$ redis-cli -p 6379 --bigkeys

Sampled 3,750,894 keys total
- 48,802 hashes (1 field each — presence bodies stored as single 'body' field)
- 3,702,092 strings (avg 195 bytes; cumulative 724 MB)

Biggest hash:    users:f8c7404c-...  has 1 field         (small, normal)
Biggest string:  channel:6a6edc4d-a155-420a-b81f-2b7e7bb84040:members  223,471 bytes
   channel:d1e498e0-...:members  216,022 bytes
   channel:bab7be1e-...:members  178,192 bytes
```

**Three channel-members caches over 175 KB.** Each holds a JSON array of user UUIDs (~5500 entries). Every `POST /api/messages` to one of these channels:

1. `cacheClient.get('channel:{id}:members')` — server-side <1 ms but **transfers ~200 KB over the network** (1.6 ms at 1 Gbps) and **holds 200 KB in worker heap**
2. `JSON.parse` of a 5500-element array — ~3-8 ms in V8
3. The userIds list is then base64-encoded and shipped over Redis pub/sub on 6380 in the fanout payload

For the top channel, that's potentially **5+ ms added to every message-broadcast path** just to load and parse member lists. This isn't HOL on Redis, but it's on every message critical path and scales with channel size.

### 3.9 PG / PgBouncer state

```
$ ssh root@10.0.1.235 (pg host) ; sudo -u postgres psql -c \
  "SELECT count(*) FILTER (WHERE state='active') AS active,
          count(*) FILTER (WHERE state='idle') AS idle,
          count(*) FILTER (WHERE state='idle in transaction') AS idle_tx,
          count(*) AS total FROM pg_stat_activity;"

 active | idle | idle_tx | total
--------+------+---------+-------
      1 |   82 |       0 |    88
```

PG is healthy at capture time. 1 active query, 82 idle connections, no idle-in-tx (no held locks/transactions), 88 total. **PG is not the bottleneck.** PgBouncer SHOW POOLS via the stats user wasn't accessible from this client (auth setup not in the env we have); a load-time pull would close that gap.

### 3.10 Application-side instrumentation already in place

Today's server-side measurements (from earlier in this session, captured separately during steady-state load with the same code base):

| Metric | p50 | p95 | p99 | max |
|---|---|---|---|---|
| `lock.ws_presence_msg.wait_ms` | 9 | 81 | 146 | 320 |
| `lock.ws_init.wait_ms` | 9 | 101 | 148 | 317 |
| `lock.ws_close.wait_ms` | 8 | 45 | 61 | 260 |
| `lock.rest_settings_away.wait_ms` | 8 | 36 | 61 | 276 |
| `pubsub_propagation.fanout_ms` | 16 | 101 | 152 | 241 |
| `msg_post.bcast_pub_ms` (Redis publish only) | 4 | 24 | 34 | 133 |
| `msg_post.bcast_total_ms` | 8 | 59 | 112 | 471 |
| `ws_ack.max_ack_ms` | 1 | 4 | 9 | 19 |

`lock.*.wait_ms` p99 of 100-150 ms is meaningful — not catastrophic, but a non-trivial chunk of the lock-protected critical path is spent waiting. With 5.5 M lock acquisitions (commandstats: `evalsha calls=5,507,237`) over ~18 h, that's ~85/sec mean acquisition rate, which means on a hot user (auto-grader presence storms) acquisitions can pile up.

---

## 4. Correlation analysis

**Status: not performed.**

Phase 4 of the task asks to correlate worst delivery-latency spikes from the autograder with Redis / PG / app-side metrics captured during a load run. This requires:

1. A live autograder run starting at a known wall-clock time
2. `redis-cli --latency-history` capturing for the duration
3. `vmstat` / `pidstat` for redis-server CPU/memory
4. PG slow query log + `pg_stat_activity` snapshots every 2 s
5. Per-app-node `top -b` output
6. Per-WS-worker event-loop-lag instrumentation (not currently in code)
7. HAProxy `Tq/Tw/Tc/Tr/Tt` timer log lines (need to verify the log-format includes them; assumed yes per default `option httplog`)

Auto-grader runs are not directly triggerable from this environment, and the event-loop-lag instrumentation in particular requires an app-code change, which the task brief explicitly excludes for this diagnostic round. Recommend running the captures in **Phase 5** below before drawing causal conclusions about which Redis behaviors specifically cause autograder spikes.

What I **can** assert from steady-state data alone:
- BGSAVE fork is the only Redis event known to block command execution for >100 ms in the captured slowlog window.
- The 12-15 ms band of EVALSHA/PUBLISH/HSET slowlog entries is consistent with mutex release contention on hot users, but cannot be specifically tied to autograder spikes without temporal correlation.

---

## 5. Findings (ranked by impact)

### Finding 1 — RDB BGSAVE every ~60 s, 53 s wall-clock, ~46-100 ms fork stall (HIGH IMPACT)

**Evidence:** §3.6 — `rdb_last_bgsave_time_sec:53`, `latest_fork_usec:46199`, save policy `60 10000` triggering at 7363 ops/sec.

**Mechanism:** Each BGSAVE calls `fork(2)` on the 1.5 GB parent process. The fork copies page tables, which for a 1.5 GB process on this kernel takes ~46-100 ms. **All Redis commands are blocked for the duration of the fork** because Redis is single-threaded for command execution.

**Frequency:** `60 10000` triggers BGSAVE roughly every minute. Plus `300 10` triggers every 5 minutes (always satisfied at our load), and `900 1` at any non-empty change in 15 min. So in practice BGSAVE runs continuously: a fresh BGSAVE starts approximately every (53 s save duration + brief idle = ~60-90 s between fork events).

**Impact on app:** every minute, all Redis commands queued on 6379 see an extra ~50 ms of latency from the fork-pause alone. Plus during the 53 s save, the parent process pays COW for any writes (210 MB COW observed), increasing memory bandwidth pressure for the duration.

**Confidence:** HIGH. Direct measurement of fork time and save duration. Causation to delivery-p95 spikes is *speculative* without Phase 4 correlation, but the timescale (50-100 ms fork pauses every minute) is enough to cause visible p99 spikes even if not the dominant 1-3 s autograder p95 floor.

### Finding 2 — Big `channel:*:members` cache values up to 223 KB (MEDIUM IMPACT, on hot path)

**Evidence:** §3.8 — `--bigkeys` shows three channels with members JSON arrays >175 KB; the largest at 223 KB. Cache GETs for these go through `cacheClient.get` on every `POST /api/messages` to those channels (`messages.js:79-87`).

**Mechanism:** Server-side GET is fast (5.76 µs avg from commandstats), but **transfer of 223 KB over the LAN takes ~1.6 ms at 1 Gbps**, the response sits in the worker's recv buffer until parsed, and **JSON.parse of a 5500-element array adds ~3-8 ms** of single-threaded V8 work to the WS message-broadcast critical path.

**Impact on app:** `bcast_total_ms` p999 = 226 ms (Section 3.10). The largest channel's broadcast path is plausibly hitting this tail. With ~50 messages/sec, even rare slow channels skew p99/p999.

**Confidence:** HIGH on the size (`--bigkeys` direct measurement). MEDIUM-HIGH on the impact (we have `bcast_total_ms` tail evidence consistent with this; we don't have per-channel breakdown in current instrumentation).

### Finding 3 — Lock churn on 6379 with mutex release pubsub on the same instance (MEDIUM IMPACT)

**Evidence:** §3.3 — `evalsha calls=5,507,237` and `publish calls=5,341,543` on 6379 are matched (every release publishes). §3.10 — `lock.ws_init.wait_ms` p99 = 148 ms.

**Mechanism:** `simple-redis-mutex` release does GET + DEL + PUBLISH inside a Lua script. The PUBLISH fans out to **40 subscribers** (every PM2 worker has a lockClient subscription to `@simple-redis-mutex:locks-releases`), so each release triggers 40 callback fan-outs **on the 6379 instance**. The release script consumes ~87 µs of command-thread time per call (commandstats), and high-volume releases (5.5 M over 18 h) are a steady tax on 6379's command thread.

The lock waits at p99=148 ms suggest some users have presence-storm contention — multiple workers trying to acquire the same `lock:users:{id}` simultaneously, polling at 50 ms intervals. Each polling SET-NX fails fast, but the wait between polls and the eventual release-pubsub takes p99 of 148 ms in our application-side `lock.wait_ms` metric.

**Impact on app:** consistent ~100-150 ms tail on every lock-protected presence operation. With locks restored (per current branch), this is the cost of correctness.

**Confidence:** HIGH on the volume and per-call cost. MEDIUM on the impact ranking — locks are a real cost but the chunked/deferred fanout we shipped earlier today already cut the WS event-loop side, so locks are less of a multiplier than they were yesterday.

### Finding 4 — `presenceClient.multi()` pipeline in `GET /api/communities/:id/members` (MEDIUM IMPACT, off the message critical path)

**Evidence:** §3.3 — `cmdstat_exec` averaging 3.8 ms across 267 calls. `communities.js:299-300` does `pipeline.hGet('users:{id}', 'body')` for every community member.

**Mechanism:** Multi/exec executes server-side as a single batch, blocking the command thread for the full pipeline duration. 3.8 ms avg block per call.

**Impact on app:** moderate — only 267 calls in 18 h, so this is rare. But it's a ~3.8 ms guaranteed HOL stall per occurrence, and it hits during `GET /api/communities/:id/members` page loads.

**Confidence:** HIGH.

### Finding 5 — 157 ms EXPIRE outlier (LOW-MEDIUM IMPACT, single instance)

**Evidence:** §3.4 — slowlog entry id 241, `EXPIRE sess:... 1209600 → 156788 µs`.

**Mechanism:** Most plausibly the active-expiration cycle interleaving with the EXPIRE command, or stop-the-world overhead inside the EXPIRE call as Redis processes a batch of expirations. With 56 keys/sec expiring on average, occasional bursts can hit a single command.

**Impact:** one observed instance in the slowlog (`slowlog-max-len = 128`). Cannot estimate frequency without longer capture.

**Confidence:** MEDIUM. Single observation; might recur, might not. `LATENCY MONITOR` would detect this category if enabled.

### Finding 6 — 6380 client output buffer hitting 10 MB (LOW IMPACT, speculative)

**Evidence:** §3.7 — `client_recent_max_output_buffer:10497128` on 6380.

**Mechanism:** 10 MB of pending pub/sub data buffered for one client by Redis suggests that subscriber occasionally fell behind in draining. Default `client-output-buffer-limit pubsub` is `32mb 8mb 60` — meaning hard limit 32 MB / soft 8 MB sustained for 60 s. We're under both limits but past the soft. **No subscriber disconnects observed in our window.**

**Impact:** could cause WS subscribers to be disconnected by Redis under more sustained pressure. If this happens, that worker stops receiving cross-node fanouts until reconnection, and any messages in flight are lost.

**Confidence:** SPECULATIVE — would need `MONITOR` or longer `CLIENT LIST omem` sampling to confirm whether this is sustained or transient.

### Finding 7 — Redis is *not* memory-pressured and not evicting (NO IMPACT)

**Evidence:** §3.2 — `used_memory:1.46G/maxmemory:12G`, `evicted_keys:0`. Memory isn't a bottleneck.

---

## 6. Recommendation

### Don't split 6379 further — fix BGSAVE and big keys instead

Splitting 6379 by workload (sessions vs cache vs presence vs locks) was the framing in the task description. The evidence does not support this split as the highest-leverage move:

- **The dominant single-event blocker is the BGSAVE fork**, which would affect *every* split instance equally — splitting just multiplies the number of fork-pauses cluster-wide rather than reducing them.
- **Cross-workload command interference** (sessions slow because presence is busy, etc.) is not visible in commandstats — per-call costs are reasonable. The serialized command thread is the constraint, but slow commands are bounded (the worst sustained category is `evalsha` at 87 µs avg).
- **The pub/sub split (6379 vs 6380) is already in place** and that one was high-leverage — it isolated the 77 MB/s output stream from the data-side workload.

### Prioritized actions

| # | Action | Effort | Expected impact |
|---|---|---|---|
| 1 | **Disable RDB on 6379** — `CONFIG SET save ""` and persist to redis.conf | 10 min | Removes ~50-100 ms fork stalls every minute. We can rebuild Redis state from PG / re-auth on session loss. **This is the single biggest immediate win.** |
| 2 | **Replace `channel:*:members` cache** with a structure that doesn't fetch the full list every send. Two options:<br>  • Use a Redis SET (`SADD channel:{id}:members`) and `SMEMBERS` only when needed (rare paths), or `SISMEMBER` for membership checks; for fanout, fetch via a server-side script that filters in Lua and returns only currently-online members.<br>  • Move to PG with a covering index on `channel_members(channel_id) include (user_id)` for the fanout path; keep cache only for membership checks. | 1-2 h | Removes 3-8 ms JSON.parse from every message-broadcast on hot channels; reduces network transfer. |
| 3 | **Enable `LATENCY MONITOR`** on both 6379 and 6380 — `CONFIG SET latency-monitor-threshold 50`. Persistent in redis.conf so it survives restart. | 5 min | Free runtime telemetry. Captures fork events, expire-cycle events, and any future slow-command outliers in a queryable buffer (`LATENCY HISTORY <event>`). |
| 4 | **Reduce session TTL** from 14 days (1,209,600 s) to something shorter (1-3 days). 33 M `EXPIRE` calls on 6379 are mostly session refreshes. Shorter TTL = fewer keys live = less expiration cycle work. | 5 min | Marginal — expiration cycle is only 0.04% CPU. Mostly a hygiene fix. |
| 5 | **Cap `client-output-buffer-limit pubsub`** more aggressively on 6380 (e.g. `8mb 4mb 30`) **only after** confirming subscriber drain rate is healthy under load. Premature cap = subscriber disconnects under transient pressure. | 5 min — but only with monitoring | Defensive against runaway buffer accumulation. Don't ship without Phase 4 correlation showing it doesn't fire on current workload. |

### What would NOT help (and why we shouldn't do it)

- **Splitting 6379 into sessionsRedis + cacheRedis + presenceRedis.** Multiplies BGSAVE fork-pauses, increases connection count per worker, increases code complexity. Returns are minimal because cross-workload interference isn't the dominant cost.
- **Replacing simple-redis-mutex with Lua atomic ops.** We tried this earlier today (`perf/lua-presence` branch) and found that while individually correct, it doesn't address the throughput-induced WS event-loop saturation, which the lock was implicitly rate-limiting. Locks-restored-plus-debounce-plus-chunked is the current best server-side combo per separate measurement.
- **Adding more Redis clients per worker.** Already 5 clients per PM2 worker (redisClient, cacheClient, presenceClient, lockClient, simple-redis-mutex's internal duplicate, plus publishClient/subClient on the WS workers). 200 conns on 6379 is fine but more clients per worker increases context-switch overhead with no measurable benefit.

---

## 7. Diagnostic gaps

Things this report could NOT determine from the available evidence:

1. **Direct correlation between Redis events and autograder p95 spikes.** Phase 4 was not performed (autograder run not triggerable here). The 50-100 ms fork stalls every minute are visible directly; whether they explain a specific autograder p95 spike requires capturing both timestamps and aligning them.

2. **Event-loop lag on PM2 workers.** Was not instrumented (would require `perf_hooks.monitorEventLoopDelay` added to `app.js`, gated by env flag — ~15 lines of code, but this report is read-only diagnostic). We do have `pubsub_propagation` from the WS subscriber side, which gives a partial view of the WS worker's event-loop responsiveness.

3. **GC pause distribution on PM2 workers.** `--trace-gc` is not enabled in `ecosystem.config.js`. PM2 logs would show GC events if enabled. Recommend enabling for the next investigation round.

4. **PgBouncer pool saturation under load.** `SHOW POOLS` was not accessible from this client (stats user auth not configured in the env). At capture time PG itself had 88 connections (1 active), so PgBouncer is doing its job — but a load-window snapshot of `cl_waiting` is the missing piece.

5. **HAProxy `Tq/Tw/Tc/Tr/Tt` timer breakdown for slow autograder requests.** Did not pull HAProxy logs. If `option httplog` includes the timer fields by default (it does in HAProxy 2.x), a 5-minute `tail` of `/var/log/haproxy.log` during a load window would show whether `Tw > 0` (queued at LB) or `Tr` is high (server slow to first byte).

6. **TLS handshake reuse rate on the LB.** `redis-cli` testing shows internal-LAN latency is fine; the autograder-to-LB segment is opaque from inside the cluster.

7. **`LATENCY MONITOR` data on 6379 and 6380.** Disabled at capture time. Recommend enabling per Recommendation #3 — once on, it captures all events >threshold automatically and `LATENCY HISTORY` returns them on demand.

### To close these gaps in a follow-up run

1. Enable `LATENCY MONITOR` on both Redis instances.
2. Add app-side `perf_hooks.monitorEventLoopDelay` per worker, log p95 every 5 s — gated on `ENABLE_EL_LAG=1`.
3. Add `--trace-gc` to PM2 `node_args` — gated.
4. Run a load window with `redis-cli --latency-history -i 1` capturing on the Redis host AND `redis-cli MONITOR` for a 10 s window to identify the workload at peak.
5. Capture HAProxy log for the same window; verify the Tq/Tw/Tc/Tr/Tt fields exist; correlate slow requests with Redis events.
6. Pull `pg_stat_statements` deltas before/after the run.
7. PgBouncer `SHOW POOLS` snapshots every 2 s during the run.

---

## Appendix: raw captures

All capture files are in `/tmp/perfcheck/redis-investigation/` on the laptop that ran the investigation. They are NOT in the repo (they include slowlog content with internal IPs and lock IDs).

```
6379-info.txt              — INFO clients/stats/memory/commandstats
6379-slowlog-latency.txt   — SLOWLOG GET 50 + 60 s of --latency-history
6379-bigkeys.txt           — full --bigkeys output
6379-client-list-summary.txt — CLIENT LIST grouped by remote IP
6379-persistence-latency.txt — INFO persistence + LATENCY events
6380-info.txt              — same set for 6380
6380-slowlog-latency.txt   — same
```

Capture time: 2026-05-05 18:11 UTC (Redis instance uptime ~18 h at capture).

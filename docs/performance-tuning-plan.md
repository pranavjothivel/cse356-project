# Performance Tuning Plan: Search Latency, Delivery, & WebSocket Reliability

## Context

The messaging app suffers from three interrelated problems:
1. **High search latency** — global FTS uses correlated subqueries to compute channel/conversation access on every search
2. **Elevated delivery latency** — a single Sequelize pool (max 10) is shared by search, message CRUD, and presence, so slow search queries starve the fast path
3. **Intermittent WS delivery failures** — dead connections accumulate (no heartbeat), Redis mutex expires mid-critical-section (200ms timeout), fire-and-forget publishes silently drop

The changes below address all three via: dedicated DB pools, multi-client Redis, scope/audience caching, and mutex tuning.

---

## Progress (as of 2026-04-29)

| Item | Status | Notes |
|---|---|---|
| 1A — search DB pool | **DONE** (diverged) | Implemented as named export in `db.js`, not new `db-search.js`. `pool.max=6` (plan said 5). `statement_timeout` not added. |
| 1B — main DB pool tune | **DONE** | `pool.max=20`, `pool.acquire=15000`, `statement_timeout=10000` on main pool. Pgbouncer's `ignore_startup_parameters` now allows `statement_timeout`; deploy workflow reordered to push pgbouncer config before app reload, with snapshot/rollback symmetric to the existing app-code rollback. |
| 1C-0 — node-04 4G + HAProxy weight | **DONE** | `nodes.yml` type label corrected to `2vcpu-4gb` and `haproxy.cfg` `node4` weight=2 as of PR #152. |
| 1C — PgBouncer tune | **PENDING** | `max_client_conn=200` and `default_pool_size=50` unchanged. No `server_idle_timeout`. (Note: a separate option to drop `default_pool_size` to 35 was discussed during the 2026-04-29 PG capacity review.) |
| 1D — Postgres `max_connections` | **DONE+** | Bumped 200→**300** on 2026-04-29 (exceeds plan). Same maintenance window also raised `shared_buffers` 128MB→2GB and installed `pg_stat_statements` (not in original plan). |
| 1E — Node.js GC tuning | **DONE** | `node_args: '--max-semi-space-size=8 --max-old-space-size=384'` added to `ecosystem.config.js`. |
| 1F — Redis mutex config | **PARTIAL** | `timeout=500` (target 2000). `pollingInterval=50` ✓. No `failAfter`. |
| 2 — Redis multi-client | **DONE** | `redis.js` exports `redisClient` (mutex/sessions), `cacheClient` (caches), `presenceClient` (HGET/HSET on `users:[id]`). 7 importers updated. Pub/sub `publishClient`/`subClient` already split via `REDIS_PUBLISH_URL`. |
| 3A–3E — multi-client importers | **PENDING** | Blocked on Phase 2. |
| 3F — `search.js` uses `searchSequelize` | **DONE** | `routes/search.js:4` imports `{ searchSequelize: sequelize } from '../db'`. |
| 4 — Search scope cache | **PENDING** | No `user:*:search_scope` keys in code. Blocked on Phase 2. |
| 5 — Presence audience cache | **PENDING** | No `user:*:presence_audience` keys in code. Blocked on Phase 2. |
| 6 — Startup sequencing | **PENDING** | No `connectAll()`. Blocked on Phase 2. |
| 7A — restore `conns:` keys | **PENDING** | `ws.js:605` notes the SET was removed; not yet re-added. |
| 7B — cleanup job mutex config | **PENDING** | `jobs/redis-cleanup/index.js:14` still `{ timeout: 200, pollingInterval: 5 }`. |
| 7C — crontab as code | **PENDING** | `jobs/crontab` does not exist; `deploy.yml` has no `Install crontab` step. |

> **Status legend:** **DONE** — implemented; **DONE+** — implemented and exceeded plan; **DONE (diverged)** — implemented but the shape differs; **PARTIAL** — some sub-items in place; **PENDING** — not started.

---

## Phase 1: Infrastructure & Pool Tuning (no downstream deps)

### 1A. Create dedicated search DB pool — **DONE (diverged)**
> Live as a named export in `server/src/db.js` (`searchSequelize`, `pool.max=6`). The original plan called for a separate `db-search.js` file with `pool.max=5` and a 4 s `statement_timeout`; the file/timeout never materialized. Importers use `const { searchSequelize: sequelize } = require('../db')`.

**New file:** `server/src/db-search.js`

```js
const { Sequelize } = require('sequelize');
const searchSequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  pool: { max: 5, min: 0, idle: 10000, acquire: 10000 },
  dialectOptions: {
    ...(process.env.NODE_ENV === 'production'
      ? { ssl: { require: true, rejectUnauthorized: false } }
      : {}),
    prepareThreshold: 0,
    statement_timeout: 4000, // 4s hard cutoff for FTS queries
  },
});
module.exports = searchSequelize;
```

### 1B. Tune main DB pool — **DONE**
> Live: `pool.max=20`, `pool.acquire=15000`, `dialectOptions.statement_timeout=10000` on main pool. Search pool's `dialectOptions` is split off so the main-pool timeout doesn't bleed into FTS queries.
>
> Pgbouncer.ini's `ignore_startup_parameters` was updated to allow `statement_timeout` so the pg client's startup-packet param is accepted. Deploy workflow was reordered: `Snapshot PgBouncer config` → `Configure PgBouncer` → `Install deps and reload PM2` so the app reloads against the new pgbouncer config. A symmetric `Rollback PgBouncer config` step (after the existing app-code `Rollback`) restores the snapshot on any pipeline failure.

**File:** `server/src/db.js`
- `pool.max`: 10 → **20**
- Add `pool.acquire: 15000` (fail instead of hang forever)
- Add `dialectOptions.statement_timeout: 10000` (10s safety net)

### 1C-0. Merge node-04 4G upgrade + update HAProxy weight — **DONE**
> `node4` is at weight 2 in `haproxy.cfg`. `nodes.yml` `type` label for node-04 corrected to `2vcpu-4gb` in PR #152 (was stale `1vcpu-2gb`).

**Pending branch:** `infra/node04-upgrade-2026-04-19` (commit `6e24858`) — updates `nodes.yml` and `infra/README.md` to reflect 2G→4G.

**File:** `infra/haproxy/haproxy.cfg` (line 45)
- `server node4 10.0.3.44:3000 check weight 1` → `weight 2` (now equal to other 4G nodes)
- **Manual step required:** HAProxy config is on the LB node (`130.245.136.254`), not auto-deployed. After merging, SSH to LB and reload: `ssh root@130.245.136.254 'cp /path/to/haproxy.cfg /etc/haproxy/ && systemctl reload haproxy'`

### 1C. Tune PgBouncer — **PENDING**
> Note: 2026-04-29 capacity review surfaced an alternative — drop `default_pool_size` from 50 → 35 to keep cluster-wide backend demand under PG's `max_connections` (now 300). That's a different direction from raising `max_client_conn` to 400; pick one before implementing.

**File:** `infra/pgbouncer/pgbouncer.ini`
- `max_client_conn`: 200 → **400**
- `default_pool_size`: 50 → **25** (4 nodes × 25 = 100 backend connections, within Postgres limits)
- Add `server_idle_timeout = 300`

### 1D. Raise Postgres `max_connections` — **DONE+**
> Applied 2026-04-29 via `ALTER SYSTEM`: `max_connections=300` (exceeds plan target of 200), `shared_buffers='2GB'`, `shared_preload_libraries='pg_stat_statements'` + `CREATE EXTENSION pg_stat_statements`. Restart took ~5 s; pgbouncer reconnected lazily, no client-visible failures.

**On DB server** (`10.0.1.235`): Edit `postgresql.conf`
- `max_connections`: 100 (default) → **200**
- Requires Postgres restart (`sudo systemctl restart postgresql`)
- Rationale: 4 PgBouncer instances × 25 pool_size = 100 backend connections at peak. 200 gives headroom for admin/monitoring connections and any direct connections (migrations, psql sessions).
- Each connection uses ~5-10MB RAM — 200 connections ≈ 1-2GB, well within a 4GB DB node.

### 1E. Node.js GC tuning — **DONE**
> Live: `node_args: '--max-semi-space-size=8 --max-old-space-size=384'` in `ecosystem.config.js`. PM2 cluster reload picks up the new args one worker at a time.

**File:** `server/ecosystem.config.js`
- Add `node_args: '--max-semi-space-size=8 --max-old-space-size=384'`
- `--max-semi-space-size=8` — halves the V8 young generation from ~16MB to 8MB. Scavenges (minor GC) run ~2x more often but each pause is ~2x shorter. Short-lived objects (Redis serialization buffers, JSON.parse/stringify, promise closures) get collected sooner instead of accumulating into big GC pauses that stall the event loop.
- `--max-old-space-size=384` — caps old generation at 384MB, leaving 128MB headroom below the 512MB `max_memory_restart`. Without this, V8 can grow the heap to ~512MB, trigger PM2's memory kill, and drop all WS connections on that worker mid-flight.

### 1F. Fix Redis mutex config — **PARTIAL**
> Live: `{ timeout: 500, pollingInterval: 50 }`. `pollingInterval` matches plan; `timeout` is at 500 (target 2000). `failAfter` not added.

**File:** `server/src/ws.js` (line 24)
- `timeout`: 200 → **2000** (lock TTL — prevent expiry while code is still in critical section)
- `pollingInterval`: 5 → **50** (reduce Redis chatter from 200 ops/s to 20 ops/s per waiter)
- Add `failAfter: 5000` (throw after 5s instead of blocking forever)

---

## Phase 2: Redis Multi-Client — **PENDING**

### 2. Refactor `server/src/redis.js`

Replace single client with 4 purpose-specific clients:

| Client | Purpose | Why isolated |
|---|---|---|
| `redisClient` | Mutex (`lock()`), sessions (connect-redis) | General fallback; mutex lib internally calls `.duplicate()` |
| `pubClient` | `PUBLISH` in ws.js broadcasts | Fire-and-forget; shouldn't block presence reads |
| `cacheClient` | `GET/SET/DEL` for member cache, search scope cache, presence audience cache | Cache stampedes shouldn't block presence/sessions |
| `presenceClient` | `HGET/HSET/DEL` on `users:*` hashes | Latency-critical for WS; must never be blocked |

All clients get `reconnectStrategy` (exponential backoff capped at 5s) and `connectTimeout: 5000`.

Export `connectAll()` to await all connections before server starts.

The existing `subClient` in `ws.js:39` stays as-is (via `redisClient.duplicate()`).

---

## Phase 3: Update All Importers (depends on Phase 2)

> 3A–3E **PENDING** (blocked on Phase 2). 3F **DONE**.

### 3A. `server/src/app.js`
- Import `{ redisClient, connectAll }` from `./redis`
- Session store keeps using `redisClient`
- Add `await connectAll()` at top of `start()` before `sequelize.authenticate()`

### 3B. `server/src/ws.js`
- Import `{ redisClient, pubClient, cacheClient, presenceClient }` from `./redis`
- Replace `redisClient.publish(...)` → `pubClient.publish(...)` at lines 200, 228, 249, 416
- Replace `redisClient.hGet/hSet` on `users:*` → `presenceClient.hGet/hSet` at lines 349, 412, 449, 465, 484, 526, 561
- Keep `lock(redisClient, ...)` — mutex stays on general client
- Move `User.findOne({ where: { id } })` (line 387) **outside** the lock critical section (currently inside the lock acquired at line 347)

### 3C. `server/src/routes/messages.js`
- Import `{ cacheClient }` from `../redis`
- Replace all `redisClient.get/set/del` in `getChannelMemberIds`, `getConversationParticipantIds`, and invalidation functions → `cacheClient.*`

### 3D. `server/src/routes/communities.js`
- Import `{ presenceClient }` from `../redis`
- Line 281: `redisClient.hGet(...)` → `presenceClient.hGet(...)`

### 3E. `server/src/routes/auth.js`
- Import `{ redisClient, presenceClient }` from `../redis`
- Keep `lock(redisClient, ...)` at line 301
- Lines 303, 330: `redisClient.hGet/hSet` → `presenceClient.hGet/hSet`

### 3F. `server/src/routes/search.js` — **DONE**
- ~~Import `searchSequelize` from `../db-search` instead of `../db`~~ → live as `const { searchSequelize: sequelize } = require('../db')` (no separate `db-search.js` was created)
- ~~Replace `sequelize` → `searchSequelize` for all 3 query calls~~ → covered by the import alias above

---

## Phase 4: Search Scope Cache (depends on Phase 2 + 3) — **PENDING**

### 4A. Cache user's accessible IDs in `server/src/routes/search.js`

For global scope (no explicit scope/communityId/conversationId), before the main FTS query:

1. Check `cacheClient.get(`user:${userId}:search_scope`)`
2. **Cache hit** → parse `{ channelIds, conversationIds }`, use `m.channel_id = ANY($arr) OR m.conversation_id = ANY($arr)` — eliminates all correlated subqueries
3. **Cache miss** → run two simple queries to compute the IDs (same logic as lines 96-111 but as separate queries, not correlated subqueries), cache result with TTL 300s
4. Community/conversation scopes are already fast (single `IN` or `=`) — no caching needed

### 4B. Invalidation hooks

Add `cacheClient.del(`user:${userId}:search_scope`)` at these points:

| File | Trigger | Line area |
|---|---|---|
| `communities.js` | Join community | After line 207 (end of transaction) |
| `communities.js` | Leave community | After line 239 (membership.destroy) |
| `communities.js` | Delete community | After line 256 (for each memberIds) |
| `channels.js` | Invite to channel | After line 115 (ChannelMember.create) |
| `channels.js` | Leave channel | After line 129 (member.destroy) |
| `channels.js` | Private→public transition | After line 65 (bulkCreate) — invalidate all community members |
| `conversations.js` | Create DM | After line 152 (both participant IDs) |
| `conversations.js` | Create group | After line 170 (all participant IDs) |
| `conversations.js` | Add participant | After line 322 (target.id) |
| `conversations.js` | Leave conversation | After line 347 (req.user.id) |

---

## Phase 5: Presence Audience Cache (depends on Phase 2 + 3) — **PENDING**

### 5. Cache `getPresenceAudienceUserIds` in `server/src/ws.js`

Modify `getPresenceAudienceUserIds(userId)` (lines 275-297):
1. Check `cacheClient.get(`user:${userId}:presence_audience`)`
2. Cache hit → return parsed array
3. Cache miss → run existing DB queries, cache with TTL 120s

**Invalidation:** Co-locate with search scope invalidation — add `cacheClient.del(`user:${userId}:presence_audience`)` at the same trigger points listed in Phase 4B. For community join/leave/delete, also invalidate all co-community members (they need to see the new/departed member's presence). Use a helper that fetches member IDs and bulk-deletes their `presence_audience` keys.

---

## Phase 6: Startup Sequencing — **PENDING** (blocked on Phase 2)

### `server/src/app.js` — `start()` function

```
1. await connectAll()           // all 4 Redis clients
2. await sequelize.authenticate()  // main DB
3. await searchSequelize.authenticate()  // search DB
4. await sequelize.sync(...)
5. await setupOidcStrategy()
6. await initWS()               // subClient connect + subscribe
7. server.listen(port)
```

`searchSequelize` does NOT need `.sync()` — it runs only raw SQL against the same database/schema.

---

## File Change Summary

| File | Action |
|---|---|
| `server/src/db-search.js` | **Create** — dedicated search Sequelize instance |
| `server/src/db.js` | Edit — raise pool.max, add acquire timeout + statement_timeout |
| `server/src/redis.js` | Edit — export 4 clients + connectAll() |
| `server/src/app.js` | Edit — update import, add connectAll() + search DB auth in startup |
| `server/src/ws.js` | Edit — multi-client imports, pubClient for publish, presenceClient for hGet/hSet, cacheClient for audience cache, mutex config fix, move User.findOne outside lock |
| `server/src/routes/search.js` | Edit — use searchSequelize, add scope cache |
| `server/src/routes/messages.js` | Edit — use cacheClient |
| `server/src/routes/auth.js` | Edit — use presenceClient for hGet/hSet |
| `server/src/routes/communities.js` | Edit — use presenceClient, add scope/audience invalidation |
| `server/src/routes/channels.js` | Edit — add scope/audience invalidation |
| `server/src/routes/conversations.js` | Edit — add scope/audience invalidation |
| `infra/pgbouncer/pgbouncer.ini` | Edit — raise max_client_conn, lower default_pool_size, add server_idle_timeout |
| `postgresql.conf` (on DB server) | Edit — raise max_connections to 200 (requires restart) |
| `server/ecosystem.config.js` | Edit — add node_args for GC tuning (semi-space + old-space caps) |
| `jobs/redis-cleanup/index.js` | Edit — fix mutex config to match app |
| `jobs/crontab` | **Create** — crontab file deployed by pipeline |
| `.github/workflows/deploy.yml` | Edit — add "Install crontab" step to deploy-jobs |

---

## Phase 7: Fix redis-cleanup job + crontab-as-code — **PENDING**

> 7A blocked on Phase 2 (uses `presenceClient`). 7B and 7C are independent and can ship anytime.

### Problem

The redis-cleanup job (`jobs/redis-cleanup/index.js`) checks `conns:<connId>` keys (line 54) to determine if a connection is alive. These keys were removed in PR #140 when ping/pong was disabled. Without them, **every connection looks dead** — the cleanup job deletes all user presence state on every run.

### 7A. Restore lightweight `conns:` keys (no ping/pong needed)

**File:** `server/src/ws.js`

The original `conns:` keys were SET on every pong (heartbeat), which caused Redis contention. Instead, SET once on connect with a long TTL, and DEL on close:

- **On WS connect** (after line 571, where the old SET was removed):
  ```js
  await presenceClient.set(`conns:${connId}`, serverId, { EX: 7200 }); // 2 hour TTL
  ```
- **On WS close** (inside the close handler, before `connections.delete(connId)` at line 459):
  ```js
  await presenceClient.del(`conns:${connId}`);
  ```

This is one SET per connection open and one DEL per close — no periodic writes. If a process crashes without clean close, the key expires after 2 hours and the hourly cleanup job catches it on the next run.

Uses `presenceClient` (not the shared `redisClient`) per Phase 2.

### 7B. Fix cleanup job's mutex config

**File:** `jobs/redis-cleanup/index.js` (line 14)

The cleanup job uses the same broken mutex settings:
```js
const lockOptions = { timeout: 200, pollingInterval: 5 };
```

Change to match the app:
```js
const lockOptions = { timeout: 2000, pollingInterval: 50, failAfter: 5000 };
```

### 7C. Crontab as code

**New file:** `jobs/crontab`
```crontab
# Managed by deploy pipeline — do not edit manually on the server
# Redis stale-connection cleanup (hourly at :28)
28 * * * * /root/.nvm/versions/node/v24.0.2/bin/node /root/redis-cleanup/index.js >> /root/redis-cleanup/output.txt 2>&1
```

**File:** `.github/workflows/deploy.yml` — add step after "Install deps" (after line 165):
```yaml
      - name: Install crontab
        run: |
          $SSH root@$TELEMETRY 'cat > /root/crontab' < ./jobs/crontab
          $SSH root@$TELEMETRY 'crontab /root/crontab'
```

This replaces root's crontab with the file from the repo on every deploy. To add future cron jobs, just add lines to `jobs/crontab`.

---

## Verification

1. **Startup**: `npm run dev` — confirm all 4 Redis clients log "connected", both DB pools authenticate
2. **Search**: Run global search — confirm uses cached scope on 2nd call (check Redis for `user:*:search_scope` key). Verify `EXPLAIN ANALYZE` shows GIN index scan with `= ANY()` filter
3. **Delivery**: Send messages in a channel — confirm broadcast works across multiple tabs/sessions
4. **Presence**: Connect/disconnect — confirm presence.changed broadcasts, check `user:*:presence_audience` cache populates
5. **Pool isolation**: Trigger concurrent searches while sending messages — confirm message delivery is not delayed
6. **Mutex**: Open multiple tabs rapidly — confirm no lock timeout errors in logs, presence state stays consistent
7. **Invalidation**: Join/leave a community, then search — confirm scope cache is invalidated (key deleted from Redis)
8. **Cleanup job**: Run `node jobs/redis-cleanup/index.js` manually — confirm it only removes connections whose `conns:<connId>` key is missing (expired/crashed), not live ones
9. **Crontab**: After deploy, `ssh root@telemetry crontab -l` — confirm it matches `jobs/crontab`

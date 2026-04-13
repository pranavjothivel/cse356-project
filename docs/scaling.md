# Scaling Analysis

## Current State (as of 2026-04-12)

### Hardware

| Node | Role | Public IP | CPU | RAM |
|---|---|---|---|---|
| `group1-api-node-01` | App (PM2 / Node.js) | `130.245.136.217` | 1 core | 4 GB |
| `group1-api-node-02` | App (PM2 / Node.js) | `130.245.136.149` | 1 core | 4 GB |
| `group1-db-psql-01` | PostgreSQL | `130.245.136.224` | 1 core | 2 GB |
| `group1-db-redis-01` | Redis | `130.245.136.86` | 1 core | 2 GB |
| `group1-web-lb01` | HAProxy + Nginx | `130.245.136.254` | 1 core | 2 GB |

### Bottleneck Stack

| Layer | Current Config | Ceiling |
|---|---|---|
| PM2 workers per node | 1 (`instances: 'max'` on 1 CPU) | 1 event loop per node |
| Sequelize pool per worker | 5 (default, unconfigured) | 5 concurrent DB ops |
| Total DB connections (1 node) | 5 | Exhausts under light load |
| Postgres `max_connections` | 100 | Hard system-wide ceiling |
| HAProxy `maxconn` | 4096 | Not a bottleneck |
| Node RAM | ~1.5 GB free | Not a bottleneck |

**Realistic concurrent user ceiling (current):** ~15–20 before DB pool exhaustion causes request queuing, event loop stall, and PM2 worker crashes.

The primary failure mode observed under grader load: unhandled errors (multer `UPLOAD_DIR` undefined, route conflict matching `"unread"` as a UUID) cause uncaught exceptions that crash PM2 workers. HAProxy marks the node DOWN and returns 503s until PM2 restarts the worker. Node-01 accumulated **114 restarts** in a single grading session.

---

## Immediate Fixes (unlock ~300–400 concurrent users)

### 1. Fix crash-causing bugs
The crash loop is the single biggest issue — raw capacity doesn't matter if workers are constantly restarting.
- Set `UPLOAD_DIR` env var, or default it in code so multer never receives `undefined`
- Add `/conversations/unread` route **before** `/:id` in the router to prevent `"unread"` being passed as a UUID to Postgres

### 2. Tune Sequelize connection pool
In `server/src/db.js`, add explicit pool config:
```js
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  pool: { max: 20, min: 2, acquire: 30000, idle: 10000 },
  ...
});
```
2 workers × pool 20 = 40 DB connections per node, well within Postgres's 100-connection limit with both nodes active.

### 3. Run 2 PM2 workers per node
Set `instances: 2` in `ecosystem.config.js`. On a 1-CPU machine this still helps — while one worker awaits a DB/Redis response, the other handles incoming requests. OS scheduler interleaves I/O wait efficiently.

### 4. Raise file descriptor limit on app nodes
Default `ulimit -n` is 1024, which caps open WS connections. Add to the PM2 systemd unit or `/etc/security/limits.conf`:
```
deploy soft nofile 65536
deploy hard nofile 65536
```

---

## Path to Thousands of Concurrent Users

### PgBouncer (highest impact, unblocks everything else)

Postgres `max_connections: 100` is a hard ceiling shared across all app nodes. With 2 nodes × 2 workers × pool 20, you'd use 80 connections — leaving only 20 for migrations, admin, and future nodes.

**PgBouncer** is a lightweight connection pooler that sits on the DB node and multiplexes thousands of app-side connections onto a small number of real Postgres connections using transaction-level pooling. A connection is only held open for the duration of a transaction, then returned to the pool.

```
App nodes → PgBouncer (:5432) → Postgres (:5433)
```

With PgBouncer:
- Postgres can stay at `max_connections: 100`
- Each app worker's `pool.max` can safely be set to 50+
- Total app-side connection capacity: effectively unlimited
- PgBouncer overhead: negligible (~2MB RAM, sub-millisecond latency)

Install on `group1-db-psql-01`, point app nodes at port 5432 (PgBouncer), move Postgres to 5433.

### More App Nodes

Node.js throughput scales linearly with workers. Each additional Clanode 2G adds 2 more workers and 100+ more req/s of API capacity. The HAProxy config and deploy pipeline already support adding nodes via `infra/nodes.yml`.

| App Nodes | Workers | DB Connections (pool 20) | Estimated Concurrent Users |
|---|---|---|---|
| 1 | 2 | 40 | ~300–400 |
| 2 | 4 | 80 | ~600–800 |
| 4 | 8 | 160 (needs PgBouncer) | ~1,500–2,000 |
| 4 + PgBouncer | 8 | 160 → muxed to ~40 real | ~3,000–5,000 |

### WebSocket Scaling

WS connections are persistent but mostly idle — they don't hold DB connections while waiting for messages. Redis pub/sub already handles cross-node fan-out. The per-node WS ceiling is:
- File descriptors: 65,536 after raising ulimit
- RAM: ~50 KB/connection × 1.5 GB free ≈ 30,000 connections per node

WS is not the bottleneck at any realistic user count for this hardware.

---

## Recommended Priority Order

1. **Fix crashes** — eliminates the 503 storm under any load
2. **Tune pool + workers** — 4× throughput improvement, no new infrastructure
3. **PgBouncer** — removes the Postgres connection ceiling, prerequisite for scaling beyond 2 nodes
4. **Raise ulimit** — unblocks WS scaling
5. **Add app nodes** — linear throughput scaling once the above are in place

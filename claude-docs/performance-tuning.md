# Performance Tuning Plan

## Context

All nodes are currently Clanode 2G (1 CPU, 2 GB RAM, $12/mo). The primary bottleneck is the Sequelize connection pool defaulting to max:5 — with PM2 spawning 1 worker per node, both app nodes have only 10 total DB connections before requests queue and workers crash. Secondary issues are Nginx/HAProxy running at default settings and Redis having no reconnect/timeout config.

**Current topology (5 × Clanode 2G = $60/mo):**
| Node | Role |
|---|---|
| group1-api-node-01 | Node.js app (PM2) |
| group1-api-node-02 | Node.js app (PM2) |
| group1-web-lb01 | HAProxy + Nginx |
| group1-db-psql-01 | PostgreSQL |
| group1-db-redis-01 | Redis |

---

## Part 1: Free Config Fixes

### 1. Sequelize connection pool — `server/src/db.js`
```js
pool: { max: 20, min: 2, acquire: 30000, idle: 10000 }
```
2 workers × pool 20 = 40 DB connections per node. Current default (max:5) exhausts under any real load.

### 2. PM2 workers — `server/ecosystem.config.js`
```js
instances: 2,
```
On a 1-CPU machine, 2 workers still helps — while one worker awaits DB/Redis I/O, the other handles requests. `instances: 'max'` currently spawns only 1.

### 3. File descriptor limits — each app node
```
# /etc/security/limits.conf
deploy soft nofile 65536
deploy hard nofile 65536
```
Default 1024 caps WebSocket connections. Required for any real WS load.

### 4. Redis client reconnect — `server/src/redis.js`
```js
createClient({
  url: process.env.REDIS_URL,
  socket: {
    reconnectStrategy: retries => Math.min(retries * 50, 500),
    connectTimeout: 5000,
    keepAlive: 30000,
  },
})
```

### 5. Nginx worker_connections — `infra/nginx/nginx.conf`
```nginx
events {
    worker_connections 2048;   # was 768
    multi_accept on;
}
```

### 6. Nginx gzip + keepalive — `infra/nginx/nginx.conf`
```nginx
gzip_comp_level 4;
gzip_types text/plain text/css application/json application/javascript text/javascript;
gzip_min_length 1024;
keepalive_timeout 65;
```

### 7. Nginx upstream keepalive — `infra/nginx-lb.conf`
```nginx
upstream api {
    server 10.0.3.93:3000;
    server 10.0.1.121:3000;
    keepalive 32;
}
# In location /api/:
proxy_http_version 1.1;
proxy_set_header Connection "";   # required for upstream keepalive
```

### 8. HAProxy — `infra/haproxy/haproxy.cfg`
```haproxy
global
    maxconn 16384          # was 4096

defaults
    option  http-keep-alive
    timeout queue 10s      # queue before 503

backend app_servers
    option  http-keep-alive
    timeout connect 3s     # fail fast on dead node
```

---

## Part 2: PgBouncer (free software, highest infrastructure impact)

Postgres hard limit: 100 connections. With 2 nodes × 2 workers × pool 20 = 80 connections, nothing is left for future nodes or admin connections.

**Install on `group1-db-psql-01`:**
```bash
apt install pgbouncer
```

**`/etc/pgbouncer/pgbouncer.ini`:**
```ini
[databases]
* = host=127.0.0.1 port=5433 dbname=cse356

[pgbouncer]
listen_port = 5432
listen_addr = 0.0.0.0
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 25
server_reset_query = DISCARD ALL
```

Move Postgres to port 5433. App nodes keep pointing at port 5432 (PgBouncer). With PgBouncer in place, raise `pool.max` to 50+ safely.

> **Note:** `sequelize.sync({ alter: true })` uses DDL which is incompatible with transaction-mode pooling. Use a direct port-5433 connection for the startup sync, or switch PgBouncer to session mode.

---

## Part 3: Node Restructure (budget-neutral, $60/mo)

Current 5-node setup already maxes the $60/mo budget. To get a meaningful hardware upgrade within budget:

**Colocate Redis onto the PostgreSQL node** — Redis uses < 100 MB RAM, no meaningful resource conflict with Postgres.

- Remove dedicated Redis node → **save $12/mo**
- Upgrade PostgreSQL node: Clanode 2G → **Clanode 4G** (+$12)

**New topology ($60/mo):**
| Node | Spec | Cost | Role |
|---|---|---|---|
| group1-api-node-01 | Clanode 2G | $12 | Node.js (2 workers) |
| group1-api-node-02 | Clanode 2G | $12 | Node.js (2 workers) |
| group1-web-lb01 | Clanode 2G | $12 | HAProxy + Nginx |
| group1-db-psql-01 | **Clanode 4G** | $24 | PostgreSQL + Redis |

**PostgreSQL tuning after upgrade** (`/etc/postgresql/*/main/postgresql.conf`):
```
shared_buffers = 1GB
effective_cache_size = 3GB
work_mem = 16MB
max_connections = 100
```

**Steps to colocate Redis:**
1. `apt install redis-server` on `group1-db-psql-01`
2. Set `bind 10.0.1.235` in `/etc/redis/redis.conf` (private IP)
3. Update `REDIS_URL` in `.env` on both app nodes
4. Resize PG node to Clanode 4G via control panel
5. Delete the old `group1-db-redis-01` node

---

## Implementation Order

| Step | What | How |
|---|---|---|
| 1 | Sequelize pool + PM2 instances | Deploy pipeline (zero downtime) |
| 2 | Redis reconnect strategy | Deploy pipeline |
| 3 | Nginx worker_connections + gzip | Deploy LB configs workflow job |
| 4 | HAProxy maxconn + keep-alive | Deploy LB configs workflow job |
| 5 | File descriptor limits | SSH to each app node once |
| 6 | PgBouncer | SSH to DB node, manual install |
| 7 | Colocate Redis + upgrade PG node | Control panel + manual config |

## Expected Impact

| Change | Benefit |
|---|---|
| Sequelize pool max:20 | ~4× more concurrent DB ops before queuing |
| PM2 instances:2 | Hides I/O latency; effective ~2× throughput per node |
| FD limit 65536 | Removes WS connection cap |
| PgBouncer | Removes Postgres 100-connection hard ceiling |
| PG node → Clanode 4G | Larger buffer cache → fewer disk reads, faster queries |

**Estimated concurrent user capacity:**

| Config | Workers | DB Conns | ~Concurrent Users |
|---|---|---|---|
| Current (no changes) | 2 total | 10 | ~15–20 |
| Config fixes only | 4 total | 80 | ~300–400 |
| Config + PgBouncer + PG upgrade | 4 total | muxed to 25 real | ~600–800 |

## Verification

```bash
# Before and after — confirm no regressions
node ~/.claude/tests/presence_receipt_test.mjs

# Check worker count (should show 2 per node)
pm2 list

# Check DB connections under load
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity;"

# Quick load test
wrk -t4 -c50 -d10s https://group1.cse356.compas.cs.stonybrook.edu/api/auth/me
```

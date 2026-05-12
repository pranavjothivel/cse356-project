# Infrastructure

All nodes are Linodes on the CSE356 course cluster.

## Node Inventory

| Label | Role | Type | Public IP | Private IP |
|---|---|---|---|---|
| `group1-api-node-01` | API-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.217` | `10.0.3.93` |
| `group1-api-node-02` | API-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.149` | `10.0.1.121` |
| `group1-api-node-03` | API-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.239` | `10.0.0.177` |
| `group1-api-node-http-01` | HTTP-only API app node (PM2 / Node.js, `WORKER_ROLE=http`) | Clanode 16G | `130.245.136.221` | `10.0.1.119` |
| `group1-api-node-04` | WS-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.223` | `10.0.3.44` |
| `group1-api-node-04b` | Parked — WS pool ext stopped 2026-05-08 (redis-02 fanout) | Clanode 16G | `130.245.136.230` | `10.0.2.240` |
| `group1-api-node-05` | WS-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.72` | `10.0.3.79` |
| `group1-api-node-05a` | Parked — WS pool ext stopped 2026-05-08 (redis-02 fanout) | Clanode 16G | `130.245.136.85` | `10.0.0.7` |
| `group1-api-node-06` | WS-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.112` | `10.0.3.32` |
| `group1-api-node-06a` | Parked — WS pool ext stopped 2026-05-08 (redis-02 fanout) | Clanode 16G | `130.245.136.220` | `10.0.1.133` |
| `group1-api-node-07` | WS-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.53` | `10.0.2.10` |
| `group1-api-node-07a` | Parked — WS pool ext stopped 2026-05-08 (redis-02 fanout) | Clanode 16G | `130.245.136.79` | `10.0.1.4` |
| `group1-db-psql-01` | PostgreSQL database | Clanode 16G | `130.245.136.224` | `10.0.1.235` |
| `group1-db-redis-01` | Redis (sessions, cache, presence) | Clanode 16G | `130.245.136.86` | `10.0.0.136` |
| `group1-db-redis-02` | Redis (pub/sub for cross-node WS broadcast) | Clanode 32G | `130.245.136.207` | `10.0.0.106` |
| `group1-loadgen-01` | Load generator (off-cluster harness) | Clanode 64G | `130.245.136.20` | `10.0.2.157` |
| `group1-telemetry-01` | Grafana Alloy telemetry node | Clanode 2G | `130.245.136.96` | `10.0.0.235` |
| `group1-web-lb01` | Load balancer (HAProxy) + frontend (Nginx) + MinIO (`10.0.1.28:9000`) | Clanode 32G | `130.245.136.254` | `10.0.1.28` |
| `group1-lb-02` | Active second load balancer (HAProxy + Nginx, BBR + heavy TCP tune). `/minio/` proxies to lb01's MinIO over private LAN | Clanode 64G | `130.245.136.142` | `10.0.0.97` |

> App nodes and the LB connect to PostgreSQL and Redis over the **private network** (10.x addresses). Public IPs for DB/cache nodes are for direct SSH access only — never exposed to application traffic.
>
> The `*a`/`*b` nodes were provisioned during the 2026-05-06 24.04+ultimate-ws migration spike and rolled into the WS pool on 2026-05-08. They run Ubuntu 24.04 (the others are 22.04); their HAProxy server entries (`node8`–`node11`) start `disabled` until the first rolling-hot-deploy lands app code and the re-enable step flips them to `ready`.

## Config Files

- [`nodes.yml`](nodes.yml) — app node and LB IPs read by the CI/CD deploy pipeline
- [`haproxy/haproxy.cfg`](haproxy/haproxy.cfg) — HAProxy config deployed to `group1-web-lb01` (`:80` → 301 to HTTPS)
- [`haproxy/haproxy-lb02.cfg`](haproxy/haproxy-lb02.cfg) — `lb02`-specific HAProxy config. Same backends/ACLs, but `:80` is served alongside `:443` instead of redirected. `X-Forwarded-Proto` is set to `http` on the plain frontend so the app can distinguish
- [`nginx/nginx.conf`](nginx/nginx.conf) — Nginx config deployed to `group1-web-lb01`
- [`nginx/sites-enabled/frontend`](nginx/sites-enabled/frontend) — Nginx virtual host on `lb01` serving the built React frontend on `127.0.0.1:8080` and proxying `/minio/` to local MinIO
- [`nginx/lb02/frontend`](nginx/lb02/frontend) — `lb02`-specific Nginx vhost. Same SPA serving, but `/minio/` proxies to `lb01`'s MinIO at `10.0.1.28:9000` (lb02 has no local MinIO). NOT under `sites-enabled/` because the deploy pipeline rsyncs that whole dir and would otherwise drop a duplicate `listen 127.0.0.1:8080` onto lb01
- [`lb-sysctl.conf`](lb-sysctl.conf) — minimal SYN-backlog/somaxconn bump deployed to `group1-web-lb01`
- [`lb-sysctl-heavy.conf`](lb-sysctl-heavy.conf) — aggressive TCP/IP stack tune (BBR + fq, 65535 backlog, 16 MiB buffers, 10000-65535 ephemeral range, FastOpen, TW reuse) deployed to `group1-lb-02`

## Adding a New API Node

Full runbook: [`docs/api-node-bootstrap.md`](../docs/api-node-bootstrap.md). Covers `scripts/setup-node.sh`, PgBouncer install, Grafana Alloy install + config mirror, the required edits to `nodes.yml`/`haproxy.cfg`/this README, and the deploy/verification steps.

## Deploying to both LBs

The `deploy.yml` / `rolling-hot-deploy.yml` pipelines read scalar `lb_node` from `nodes.yml` and only push haproxy/nginx/frontend artifacts to `group1-web-lb01`. Until the pipeline is updated to fan out, mirror changes to `group1-lb-02` (`130.245.136.142`) manually after each deploy:

```bash
KEY=~/.ssh/id_ed25519_356_clanode_prod

# frontend bundle (build locally with `cd client && npm ci && npm run build`)
rsync -az --delete -e "ssh -i $KEY" client/dist/ root@130.245.136.142:/srv/frontend/dist/

# haproxy.cfg (lb02 variant — http frontend serves traffic instead of redirecting)
scp -i $KEY infra/haproxy/haproxy-lb02.cfg root@130.245.136.142:/etc/haproxy/haproxy.cfg
ssh -i $KEY root@130.245.136.142 'haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl reload haproxy'

# nginx vhost (lb02 variant — proxies /minio/ to lb01)
scp -i $KEY infra/nginx/lb02/frontend root@130.245.136.142:/etc/nginx/sites-available/frontend
ssh -i $KEY root@130.245.136.142 'nginx -t && systemctl reload nginx'
```

For traffic distribution between the two LBs, add a second A record for `group1.cse356.compas.cs.stonybrook.edu` pointing to `130.245.136.142` (DNS round-robin) or front them with a Linode floating IP.

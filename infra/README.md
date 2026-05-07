# Infrastructure

All nodes are Linodes on the CSE356 course cluster.

## Node Inventory

| Label | Role | Type | Public IP | Private IP |
|---|---|---|---|---|
| `group1-api-node-01` | API-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.217` | `10.0.3.93` |
| `group1-api-node-02` | API-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.149` | `10.0.1.121` |
| `group1-api-node-03` | API-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.239` | `10.0.0.177` |
| `group1-api-node-04` | WS-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.223` | `10.0.3.44` |
| `group1-api-node-04b` | Orphan — 24.04 ultimate-ws spike (not in deploy) | Clanode 16G | `130.245.136.230` | `10.0.2.240` |
| `group1-api-node-05` | WS-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.72` | `10.0.3.79` |
| `group1-api-node-05a` | Orphan — 24.04 ultimate-ws spike (not in deploy) | Clanode 16G | `130.245.136.85` | `10.0.0.7` |
| `group1-api-node-06` | WS-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.112` | `10.0.3.32` |
| `group1-api-node-06a` | Orphan — 24.04 ultimate-ws spike (not in deploy) | Clanode 16G | `130.245.136.220` | `10.0.1.133` |
| `group1-api-node-07` | WS-only app node (PM2 / Node.js) | Clanode 16G | `130.245.136.53` | `10.0.2.10` |
| `group1-api-node-07a` | Orphan — 24.04 ultimate-ws spike (not in deploy) | Clanode 16G | `130.245.136.79` | `10.0.1.4` |
| `group1-db-psql-01` | PostgreSQL database | Clanode 16G | `130.245.136.224` | `10.0.1.235` |
| `group1-db-redis-01` | Redis (sessions, cache, presence) | Clanode 16G | `130.245.136.86` | `10.0.0.136` |
| `group1-db-redis-02` | Redis (pub/sub for cross-node WS broadcast) | Clanode 32G | `130.245.136.207` | `10.0.0.106` |
| `group1-loadgen-01` | Load generator (off-cluster harness) | Clanode 64G | `130.245.136.20` | `10.0.2.157` |
| `group1-telemetry-01` | Grafana Alloy telemetry node | Clanode 2G | `130.245.136.96` | `10.0.0.235` |
| `group1-web-lb01` | Load balancer (HAProxy) + frontend (Nginx) | Clanode 32G | `130.245.136.254` | — |

> App nodes and the LB connect to PostgreSQL and Redis over the **private network** (10.x addresses). Public IPs for DB/cache nodes are for direct SSH access only — never exposed to application traffic.
>
> The `*a`/`*b` orphan nodes were provisioned during the 2026-05-06 24.04+ultimate-ws migration spike and remain powered on for potential future use, but are excluded from `infra/nodes.yml` and the HAProxy backends.

## Config Files

- [`nodes.yml`](nodes.yml) — app node and LB IPs read by the CI/CD deploy pipeline
- [`haproxy/haproxy.cfg`](haproxy/haproxy.cfg) — HAProxy config deployed to `group1-web-lb01`
- [`nginx/nginx.conf`](nginx/nginx.conf) — Nginx config deployed to `group1-web-lb01`
- [`nginx/sites-enabled/frontend`](nginx/sites-enabled/frontend) — Nginx virtual host serving the built React frontend on `127.0.0.1:8080`

## Adding a New API Node

Full runbook: [`docs/api-node-bootstrap.md`](../docs/api-node-bootstrap.md). Covers `scripts/setup-node.sh`, PgBouncer install, Grafana Alloy install + config mirror, the required edits to `nodes.yml`/`haproxy.cfg`/this README, and the deploy/verification steps.

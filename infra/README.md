# Infrastructure

All nodes are Linodes on the CSE356 course cluster (Clanode 4G unless noted).

## Node Inventory

| Label | Role | Public IP | Private IP |
|---|---|---|---|
| `group1-api-node-01` | API app node (PM2 / Node.js) | `130.245.136.217` | `10.0.3.93` |
| `group1-api-node-02` | API app node (PM2 / Node.js) | `130.245.136.149` | `10.0.1.121` |
| `group1-api-node-03` | API app node (PM2 / Node.js) | `130.245.136.239` | `10.0.0.177` |
| `group1-api-node-04` | API app node (PM2 / Node.js) — Clanode 2G | `130.245.136.223` | `10.0.3.44` |
| `group1-db-psql-01` | PostgreSQL database | `130.245.136.224` | `10.0.1.235` |
| `group1-db-redis-01` | Redis (sessions, pub/sub, presence) | `130.245.136.86` | `10.0.0.136` |
| `group1-web-lb01` | Load balancer + frontend (Nginx) | `130.245.136.254` | — |
| `group1-telemetry-01` | Grafana Alloy telemetry node | `130.245.136.96` | `10.0.0.235` |

> App nodes and the LB connect to PostgreSQL and Redis over the **private network** (10.x addresses). Public IPs for DB/cache nodes are for direct SSH access only — never exposed to application traffic.

## Config Files

- [`nodes.yml`](nodes.yml) — app node and LB IPs read by the CI/CD deploy pipeline
- [`haproxy/haproxy.cfg`](haproxy/haproxy.cfg) — HAProxy config deployed to `group1-web-lb01`
- [`nginx/nginx.conf`](nginx/nginx.conf) — Nginx config deployed to `group1-web-lb01`
- [`nginx/sites-enabled/frontend`](nginx/sites-enabled/frontend) — Nginx virtual host serving the built React frontend on `127.0.0.1:8080`

# Deployment & Running the System

This document covers how to get the system running — both for someone bringing up a fresh copy and for the day-to-day prod deploy workflow.

## Prerequisites

### Local development
- **Node.js** 20.x (the engine used by both `server/` and `client/`).
- **PostgreSQL** 14+ and **Redis** 6+, either local or reachable.
- **MinIO** (or any S3-compatible bucket) for attachment storage in non-trivial development.

### Production
Everything below runs on Linodes on the CSE356 course cluster. Full hardware inventory in [`infra/README.md`](../infra/README.md). Summary:
- 1× LB (HAProxy + Nginx + MinIO), 16 vCPU / 30 GB
- 4× API-pool nodes (`WORKER_ROLE=http`/`all`), 8 vCPU / 16 GB each
- 4× WS-pool nodes (`WORKER_ROLE=ws`), 8 vCPU / 16 GB each
- 1× Postgres node with WAL on a dedicated NVMe volume
- 2× Redis nodes (sessions/cache/presence and pub/sub fanout)
- 1× telemetry node (Grafana Alloy receiver)

## Environment variables

The server reads from `/srv/app/.env` on each app node in production; locally it reads `server/.env`. The CI deploy writes the file from the `ENV_FILE` GitHub secret on every deploy.

For local development, copy [`server/.env.example`](../server/.env.example) to `server/.env` and fill in real values:

```bash
cp server/.env.example server/.env
# then edit server/.env with your local DB / Redis / OAuth / MinIO settings
```

The example file is sanitized (placeholder credentials) but mirrors the structure of the production `.env` exactly, so every required key is present.

### Required

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development` or `production` |
| `PORT` | Express listen port (3000 in prod; WS server is attached to the same HTTP server) |
| `DATABASE_URL` | Postgres connection string (in prod points at local PgBouncer on `127.0.0.1:6432`) |
| `REDIS_URL` | Redis-01 — sessions, cache, presence, mutex |
| `REDIS_PUBLISH_URL` | Redis-02 — cross-node WS pub/sub. Defaults to `REDIS_URL` if absent (single-instance fallback). |
| `SESSION_SECRET` | `express-session` signing secret |
| `FRONTEND_URL` | Used for CORS and OAuth redirect targets |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | Attachment storage |

### Auth providers

| Variable | Notes |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | Google OAuth app |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_CALLBACK_URL` | GitHub OAuth app |
| `OIDC_ISSUER` | `https://infra-auth.cse356.compas.cs.stonybrook.edu/realms/oauth` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_CALLBACK_URL` | Course Keycloak realm |

All OAuth/OIDC callback URLs use the `/api/auth/...` prefix (HAProxy routes by `/api/*`).

### Worker role (per-node)

| Variable | Values | Effect |
|---|---|---|
| `WORKER_ROLE` | `all` (default), `ws`, `http` | `ws` skips API route mounts; `http` skips the WS server entirely and skips Redis-02 pub/sub subscription. Set per-node via `ws_only` / `api_only` flags in `infra/nodes.yml` (the deploy pipeline injects it). |

### Telemetry (optional)

| Variable | Notes |
|---|---|
| `AXIOM_TOKEN`, `AXIOM_DATASET`, `SENTRY_DSN` | Currently disabled in production after a perf-vs-value tradeoff (`7149649`); kept in code path for re-enable. |

A reference `.env` template lives at [`server/.env.example`](../server/.env.example) (sanitized prod structure with placeholder values); long-form per-variable notes are in [`claude-docs/env_structure.md`](../claude-docs/env_structure.md).

## Building & running locally

```bash
# Backend
cd server
npm ci
npm run dev     # nodemon-based auto-restart

# Frontend (in another shell)
cd client
npm ci
npm run dev     # Vite dev server, defaults to :5173
```

For local Postgres bootstrap, apply the schema:
```bash
psql "$DATABASE_URL" -f server/scripts/migrations/0007-baseline-schema.sql
```

(See [`server/scripts/migrations/README.md`](../server/scripts/migrations/README.md) for the migration workflow.)

## Production deploy

Two pipelines, both in `.github/workflows/`:

### `deploy.yml` — full deploy on `main` push (currently disabled)

1. **`setup`** — reads `infra/nodes.yml`, emits the app-node matrix + LB IP.
2. **`deploy-app`** — fan-out matrix job, one parallel SSH job per app node:
   - Writes `.env` from `ENV_FILE` secret to `/srv/app/.env`.
   - `rsync server/` → `/srv/app/` (excludes `.env`, `node_modules/`).
   - `rsync infra/pgbouncer/` → `/srv/app/infra/pgbouncer/`, regenerates `pgbouncer.ini` from the template with env vars sourced from `.env`.
   - `npm ci --omit=dev`.
   - `pm2 reload ecosystem.config.js --update-env` — graceful zero-downtime reload.
3. **`deploy-frontend`** — builds `client/` with Vite, rsyncs `client/dist/` to `root@<lb>:/srv/frontend/dist/`.
4. **HAProxy / Nginx config** — pushed when `infra/haproxy/` or `infra/nginx/` changes (separate job).

Auto-deploy was disabled on `main` push (`e11e6ab`) to keep prod stable during the term project window; deploys are now triggered via `workflow_dispatch`.

### `rolling-hot-deploy.yml` — node-by-node deploy

For situations where the fan-out parallel approach is too aggressive (large code changes, mid-incident hot deploys). Walks each app node in sequence: HAProxy drain → wait for connections to bleed off → rsync + `pm2 reload` → poll PM2 health → un-drain → next node. Configurable retry on SSH flake (5 attempts) and a rollback path on PM2 health failure.

### LB02

`deploy.yml` only pushes haproxy/nginx/frontend to `lb01`. Updates to `lb02` are pushed manually per the runbook in [`infra/README.md`](../infra/README.md#deploying-to-both-lbs):

```bash
KEY=<PATH TO CLANODE (OR OTHER CLOUD VPC) SSH KEY>

scp -i $KEY infra/haproxy/haproxy-lb02.cfg root@130.245.136.142:/etc/haproxy/haproxy.cfg
ssh -i $KEY root@130.245.136.142 'haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl reload haproxy'

scp -i $KEY infra/nginx/lb02/frontend root@130.245.136.142:/etc/nginx/sites-available/frontend
ssh -i $KEY root@130.245.136.142 'nginx -t && systemctl reload nginx'

rsync -az --delete -e "ssh -i $KEY" client/dist/ root@130.245.136.142:/srv/frontend/dist/
```

## Starting / stopping the system

In production everything is managed by PM2 on each app node, running under the `deploy` user. **PM2 has a per-user daemon — running `pm2 ...` as `root` sees a different (empty) daemon than the deploy user's.** To inspect prod state on a node, SSH as root and use `sudo -u deploy`:

```bash
sudo -u deploy pm2 list
sudo -u deploy pm2 logs --lines 200
sudo -u deploy pm2 jlist | jq .
```

Start / stop / restart the app cluster on a node:
```bash
sudo -u deploy pm2 start /srv/app/ecosystem.config.js
sudo -u deploy pm2 reload cse356    # graceful, used in deploys
sudo -u deploy pm2 stop cse356
sudo -u deploy pm2 delete cse356
```

HAProxy and Nginx are managed via systemd on the LB nodes:
```bash
systemctl reload haproxy     # zero-downtime config reload
systemctl reload nginx
```

PgBouncer also runs as systemd on each app node (`infra/pgbouncer/provision.sh` is the bootstrap):
```bash
systemctl restart pgbouncer
```

## Testing

Verification layers, lightest to heaviest:

- **Smoke tests** — [`smoke-tests/run.sh`](../smoke-tests/run.sh) hits a target (defaults to the prod LB) and verifies the SPA bundle serves, `/api/me` returns 401 unauthenticated, `/api/communities` returns 401 unauthenticated (also confirms the API-pool routing), the Google OAuth redirect is wired, and the WebSocket upgrade ACL routes to the WS pool. Exits non-zero on any failure — safe to run from CI or as a post-deploy gate.

  ```bash
  ./smoke-tests/run.sh                              # default = prod LB
  TARGET=http://localhost:3000 ./smoke-tests/run.sh  # local dev backend
  ```

- **Manual smoke tests** through the React SPA after each deploy — log in, send a message, open a DM.
- **Load-generator runs** against the cluster — headless API-driven clients in [`loadgen-reports/`](../loadgen-reports/) (the JSON files are run summaries; the corresponding `.log` files have per-request traces).
- **TLS-probe** — [`scripts/tls-probe/tls-probe.sh`](../scripts/tls-probe/tls-probe.sh) characterizes LB-side cold-handshake latency over a configurable window. Output CSVs in `loadgen-reports/2026-05-06-tls-probe*.csv`.
- **Production telemetry** — Grafana Cloud dashboards (Loki for logs, Prometheus/Mimir for metrics) fed from the telemetry node via Grafana Alloy; HAProxy `/stats`; Axiom for HAProxy access-log tail; Sentry for unhandled exceptions (Sentry is currently disabled in the codepath, kept for re-enable).

A future improvement would be a dockerized integration test suite that exercises the auth flow + message-send + WS broadcast against an ephemeral PG + Redis stack. Out of scope for the term project.

## Common operational checks

| Question | Answer |
|---|---|
| Is HAProxy healthy? | `curl http://127.0.0.1:8404/stats` on the LB; or `sudo systemctl status haproxy`. |
| Are all PM2 workers up? | SSH any app node; `sudo -u deploy pm2 jlist \| jq '.[] \| {name,status,restarts,memory: (.monit.memory / 1048576)}'`. |
| Is the LB hot-pool routing correctly? | HAProxy stats UI at `:8404/stats` — check `app_servers` and `app_ws_servers` backend health columns. |
| Is Redis-02 fanout backed up? | SSH to Redis-02 host; `redis-cli -p 6380 INFO replication; redis-cli -p 6380 PUBSUB NUMSUB messages`. |
| What's the WAL on the DB doing? | SSH to `psql-01`; `sudo -u postgres psql -c "SELECT pg_last_wal_replay_lsn();"`. |

## Cloud resource assumptions

- Linode "Clanode" instance type with private networking enabled.
- All app/DB/cache traffic uses the **private network** (10.x addresses). Public IPs are SSH-only.
- A single domain (`group1.cse356.compas.cs.stonybrook.edu`) with a Let's Encrypt cert on the LB.
- No CDN; the SPA bundle is small enough to serve directly from Nginx.

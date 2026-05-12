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

A reference `.env` template lives at [`server/.env.example`](../server/.env.example) — sanitized prod structure with placeholder values; every required key is present.

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

## CI/CD pipelines

Five workflows live under [`.github/workflows/`](../.github/workflows/). Two run automatically on push/PR; three are triggered by hand via `workflow_dispatch`.

| Workflow | Trigger | What it does |
|---|---|---|
| [`ci.yml`](../.github/workflows/ci.yml) | Push to any non-`main` branch + PRs targeting `main` | Branch validation. Currently runs the client (Vite) `npm ci` + `npm run build` so a broken SPA fails CI before it can be merged. A server smoke-test job exists in the file but is commented out (OIDC discovery against the course Keycloak realm hangs in the CI runner; the smoke-tests/ Jest suite covers post-deploy verification instead). |
| [`deploy.yml`](../.github/workflows/deploy.yml) | `workflow_dispatch` (auto-deploy on push to `main` was disabled in `e11e6ab` to keep prod stable during the term window) | Full parallel deploy of every app node + the LB. Five jobs (see below). |
| [`rolling-hot-deploy.yml`](../.github/workflows/rolling-hot-deploy.yml) | `workflow_dispatch` with optional `target_node` + `drain_wait` inputs | Same artifact deployment as `deploy.yml`, but node-by-node with HAProxy drain → un-drain bracketing each step. Used when the parallel approach is too aggressive (large code changes, mid-incident hot fixes) or to deploy to one specific node. |
| [`minio-volume-ci.yml`](../.github/workflows/minio-volume-ci.yml) | Push to any non-`main` branch + PRs targeting `main`, **only** when [`infra/minio-volume.yml`](../infra/minio-volume.yml) changes | Guard rail: validates the new volume size is not a *reduction* against the base branch. Fails the PR if someone accidentally lowers the volume size, since Linode block volumes cannot be shrunk in place. |
| [`minio-volume-resize.yml`](../.github/workflows/minio-volume-resize.yml) | Push to `main` when [`infra/minio-volume.yml`](../infra/minio-volume.yml) changes | Auto-applies the volume size change. SSHes to the LB (where MinIO's block volume is attached), runs the Linode CLI to resize the volume, then `resize2fs` to grow the filesystem. Pairs with the CI guard above so the size only ever grows. |

### `deploy.yml` — full deploy (jobs)

1. **`setup`** — reads `infra/nodes.yml`, emits the app-node matrix + LB IP + telemetry IP as job outputs.
2. **`deploy-app`** — fan-out matrix job, one parallel SSH job per app node:
   - Writes `.env` from the `ENV_FILE` secret to `/srv/app/.env`.
   - `rsync server/` → `/srv/app/` (excludes `.env`, `node_modules/`).
   - `rsync infra/pgbouncer/` → `/srv/app/infra/pgbouncer/`, regenerates `pgbouncer.ini` from the template with env vars sourced from `.env`.
   - `npm ci --omit=dev`.
   - `pm2 reload ecosystem.config.js --update-env` — graceful zero-downtime reload.
   - Injects `WORKER_ROLE` per-node based on the `ws_only` / `api_only` / `http_only` flags in `nodes.yml`.
3. **`deploy-jobs`** — runs background-job scripts under [`jobs/`](../jobs/) (e.g. the periodic orphan-attachment cleanup) — currently a no-op slot the team can wire into.
4. **`deploy-frontend`** — builds `client/` with Vite (`VITE_BACKEND_URL` injected at build time), rsyncs `client/dist/` to `root@<lb>:/srv/frontend/dist/`.
5. **`deploy-lb-configs`** — pushes `infra/haproxy/` + `infra/nginx/` to the LB and reloads HAProxy / Nginx via `systemctl reload`. Only runs when those paths changed in the deploy revision.

### Required GitHub Actions secrets

Set under **Settings → Secrets and variables → Actions** on the repo. Both are read by every deploy job.

| Secret | Format | Used for |
|---|---|---|
| `SSH_PRIVATE_KEY` | Single-key PEM body, including the `-----BEGIN OPENSSH PRIVATE KEY-----` / `-----END OPENSSH PRIVATE KEY-----` lines. Must correspond to a public key in `deploy@<app-node>:~/.ssh/authorized_keys` (and `root@<lb>:~/.ssh/authorized_keys` for LB pushes). | All SSH/rsync calls from the workflow runners. |
| `ENV_FILE` | The full contents of `/srv/app/.env` as a single string — same `KEY=value` lines that `server/.env.example` documents, one per line, no surrounding quotes. **Production-secret values** for `DATABASE_URL`, `PG_DIRECT_URL`, `SESSION_SECRET`, `JWT_SECRET`, the OAuth `*_CLIENT_SECRET` keys, `OIDC_CLIENT_SECRET`, `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`, `SENTRY_DSN`, `AXIOM_TOKEN`. | Written verbatim to `/srv/app/.env` on every node on every deploy. |

The structure of `ENV_FILE` mirrors [`server/.env.example`](../server/.env.example) one-to-one; copy that file, replace placeholders with real values, and paste into the GitHub secret. `WORKER_ROLE` is the only key the workflow injects per-node (based on the `ws_only` / `api_only` / `http_only` flags in `infra/nodes.yml`) — set it to `all` in `ENV_FILE` and let the pipeline override.

For local development, no GitHub secrets are involved — copy `server/.env.example` to `server/.env` and fill in dev values directly.

### `rolling-hot-deploy.yml` — node-by-node deploy (jobs)

Same five-job spine as `deploy.yml` (`setup`, `deploy-node`, `deploy-jobs`, `deploy-frontend`, `deploy-lb-configs`), but `deploy-node` walks each app node in sequence instead of fanning out:

1. **Take a rsync backup** of `/srv/app/` on the node into `/tmp/app-backup/` on the runner — used to roll back if PM2 health fails.
2. **HAProxy drain** the node — sets the backend server to `MAINT` via the admin socket on the LB so existing connections bleed off and no new requests arrive.
3. **Poll for in-flight connections** to drop to zero (bounded by `drain_wait` input, default 180 s).
4. **rsync code + pgbouncer config** and run `pm2 reload`, with **5-attempt retry on SSH flake** (`kex_exchange_identification` was flaky on the course cluster).
5. **Poll PM2 health** for the worker count and `restarts` not to be increasing; on failure, rsync the backup back and `pm2 reload` again.
6. **HAProxy un-drain** the node, mark as `READY`, then move to the next.

Optional `target_node` input deploys to a single node only (1–4) — useful for testing config changes on one box before fanning out.

### LB updates

LB updates are handled by the same deploy pipeline. `deploy-frontend` rsyncs the built SPA bundle to the LB, and the HAProxy / Nginx config job pushes `infra/haproxy/` + `infra/nginx/` changes to the LB and reloads each daemon. The current LB host is the BBR + heavy-sysctl-tuned successor that replaced the original LB mid-term; the historical `infra/haproxy/haproxy-lb02.cfg` filename is retained for the migration record but the active path is `infra/haproxy/haproxy.cfg`.

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

- **Smoke tests** — Jest-based black-box suite under [`smoke-tests/`](../smoke-tests/). Verifies the SPA bundle serves, `/api/me` returns 401 unauthenticated, `/api/communities` returns 401 unauthenticated (also confirms the API-pool routing), the Google OAuth redirect is wired, and the WebSocket upgrade ACL routes to the WS pool. Exits non-zero on any failure — safe to run from CI or as a post-deploy gate.

  ```bash
  cd smoke-tests
  npm install                                       # one-time
  npm test                                          # default = prod LB
  TARGET=http://localhost:3000 npm test             # local dev backend
  ```

- **Manual smoke tests** through the React SPA after each deploy — log in, send a message, open a DM.
- **Our ad-hoc loadgen runs** against the cluster — headless API-driven clients we drove from a developer laptop / the loadgen node during tuning passes; outputs in [`loadgen-reports/`](../loadgen-reports/) (the JSON files are run summaries; the corresponding `.log` files have per-request traces). This is distinct from the **course grading load generator** that ran continuously against the deployment during the 4-week Test Traffic Period and which we did not control.
- **TLS-probe** — [`scripts/tls-probe/tls-probe.sh`](../scripts/tls-probe/tls-probe.sh) characterizes LB-side cold-handshake latency over a configurable window. Output CSVs in `loadgen-reports/2026-05-06-tls-probe*.csv`.
- **Production telemetry** — Grafana Cloud dashboards (Loki for logs, Prometheus/Mimir for metrics) fed from the telemetry node via Grafana Alloy; HAProxy `/stats`; Axiom for HAProxy access-log tail; Sentry for unhandled exceptions (Sentry is currently disabled in the codepath, kept for re-enable).

A future improvement would be expanding the Jest suite into a full integration test pass — auth flow + message-send + WS broadcast — against an ephemeral PG + Redis stack.

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

# Developer Guide

Enough information for a new team member to be productive. For *running* the system, see [DEPLOYMENT.md](DEPLOYMENT.md); for *why* it looks the way it does, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Repository layout

```
cse356-project/
├── README.md                  ← entry point (links here)
├── CLAUDE.md                  ← guidance for AI coding tools; mirrors much of this file
├── client/                    ← React SPA (Vite + TypeScript)
│   └── src/
│       ├── App.tsx, main.tsx
│       ├── api.ts             ← typed fetch wrappers for the backend
│       ├── auth/              ← login + OAuth-link UI
│       └── components/        ← chat UI, search, settings, etc.
├── server/                    ← Node backend (Express 5, ws, Sequelize, Redis)
│   ├── .env.example           ← sanitized prod env template; copy to .env locally
│   ├── src/
│   │   ├── app.js             ← entry: middleware, route mounts, listen
│   │   ├── db.js              ← Sequelize instances (main + search pool)
│   │   ├── redis.js           ← Redis clients (cache, presence, mutex, publish)
│   │   ├── ws.js              ← WebSocket server + cross-node fanout
│   │   ├── upload.js          ← MinIO/S3 upload helpers
│   │   ├── auth/passport.js   ← Local + Google + GitHub + OIDC strategies
│   │   ├── models/            ← Sequelize models (User, Community, Channel, …)
│   │   ├── routes/            ← REST handlers per resource (auth, communities,
│   │   │                         channels, conversations, messages, search,
│   │   │                         upload, users)
│   │   └── util/              ← shared helpers
│   ├── scripts/
│   │   ├── cleanup-duplicate-user-indexes.js   ← one-off DB cleanup
│   │   └── migrations/        ← numbered SQL migrations + legacy/
│   │       ├── 0007-baseline-schema.sql        ← current production schema
│   │       └── legacy/0002-…0006-…
│   ├── ecosystem.config.js    ← PM2 cluster config
│   └── package.json
├── infra/
│   ├── nodes.yml              ← node inventory, source of truth for the deploy pipeline
│   ├── README.md              ← infra-level runbook
│   ├── haproxy/               ← HAProxy config(s) for the LB
│   ├── nginx/                 ← Nginx vhost(s) for the LB
│   ├── pgbouncer/             ← pgbouncer.ini template + provision.sh
│   └── lb-sysctl-heavy.conf   ← LB TCP/IP tune (BBR + buffers + backlog)
├── project-docs/              ← this folder
│   ├── ARCHITECTURE.md
│   ├── DEPLOYMENT.md
│   ├── SCALING.md
│   ├── DEVELOPER-GUIDE.md     ← (you are here)
│   ├── TEAM.md
│   └── diagrams/
├── claude-docs/               ← raw session notes / decision logs (source for the
│                                 public docs in project-docs/)
├── loadgen-reports/           ← archived outputs from our ad-hoc loadgen runs
│                                (not the course grading load generator — that's external)
├── scripts/                   ← repo-level scripts (e.g. tls-probe)
├── smoke-tests/               ← Jest-based post-deploy sanity checks
└── .github/workflows/         ← CI/CD pipelines (deploy.yml, rolling-hot-deploy.yml,
                                 ci.yml, minio-volume-*.yml)
```

## Key files to know

| File | Why it matters |
|---|---|
| `server/src/app.js` | Single entry point. Reads `WORKER_ROLE` from env and gates WS server init accordingly. Session middleware, all route mounts, and the `async start()` bootstrap live here. |
| `server/src/ws.js` | The realtime layer. Connection state in `users` and `connections` maps, per-worker pub/sub channels, fanout helpers (`broadcastToUsers`, `broadcastToAllConnected`), and the post-connect `"ready"` handshake. |
| `server/src/redis.js` | All Redis clients defined in one place. **Use the right client for the workload** — don't introduce a new client that mixes presence with cache, etc. |
| `server/src/routes/messages.js` | Hottest write path. Member-lookup caching, the deferred broadcast publish, and the FTS column update all live here. |
| `server/src/auth/passport.js` | Passport strategies, the `User.providers` JSONB multi-provider model, and `setupOidcStrategy` (fire-and-forget at boot so a Keycloak outage doesn't crash workers). |
| `server/ecosystem.config.js` | PM2 cluster config — `instances: 'max'`, `max_memory_restart`, log paths. |
| `infra/nodes.yml` | Node inventory. Editing this *is* the way to add/remove an app node — the deploy workflow reads it as a matrix. |
| `infra/haproxy/haproxy.cfg` (and the historical `haproxy-lb02.cfg` retained for the migration record) | HAProxy config for the LB. Serves `:80` and `:443` with identical ACLs. |
| `.github/workflows/deploy.yml` | The full-deploy pipeline (matrix + frontend + HAProxy/Nginx fan-out). |
| `.github/workflows/rolling-hot-deploy.yml` | Node-by-node drain → deploy → un-drain pipeline for mid-incident hot deploys. |
| `server/scripts/migrations/0007-baseline-schema.sql` | The current production schema, dumped from `psql-01`. Use this when bootstrapping a fresh DB. |

## How to add or modify a feature

### Adding a REST endpoint
1. Add the route handler in the appropriate `server/src/routes/<resource>.js`. Keep the file's surface narrow — one resource per file.
2. If the response involves a new SQL shape, run an ad-hoc query against a dev DB to confirm the plan is sensible before committing.
3. If the handler is on a hot path (message send, presence update, anything called per WebSocket event), check whether the lookup can come from `cacheClient` instead of Postgres. The pattern is "miss → Postgres → write-through to Redis with a TTL".
4. If the handler broadcasts a WS event, **return the HTTP response first** and publish the broadcast after. The pattern in `messages.js` is the reference.
5. Add the URL to `client/src/api.ts` (typed wrapper) before consuming it in a component.

### Adding a WebSocket event
1. Pick or extend the appropriate `case` in the message handler in `ws.js`.
2. If the event needs cross-node delivery, use `broadcastToUsers(userIds, payload)`; for "everyone connected", `broadcastToAllConnected(payload)`.
3. If the event needs presence state, take the per-user mutex via `withUserPresenceLock` before the read-modify-write — see existing presence-update sites.
4. Update the client-side WebSocket handler (`client/src/api.ts` or relevant component) to consume the new event.

### Adding a database table or column
1. Edit the Sequelize model in `server/src/models/`.
2. Write the migration SQL in `server/scripts/migrations/NNNN-<short-name>.sql`. The next number after `0007` is `0008`. Make it idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
3. Apply manually against production from any app node — there is no automatic migration runner:
   ```bash
   ssh deploy@<node>
   psql "$DATABASE_URL" -f /srv/app/scripts/migrations/NNNN-<short-name>.sql
   ```
4. Dev DBs still get auto-altered by Sequelize (`sync({ alter: true })` in non-prod). Do **not** enable that in prod (see [SCALING.md](SCALING.md#bottleneck-3--sequelizesyncalter-true-index-bloat)).

### Adding a node
Append a block to `infra/nodes.yml` and push. The deploy pipeline picks it up on the next run. Full runbook in [`claude-docs/api-node-bootstrap.md`](../claude-docs/api-node-bootstrap.md) (PgBouncer install, Grafana Alloy install, HAProxy backend entry, `WORKER_ROLE` injection).

## Running tests

The verification surface, lightest to heaviest:

- **Smoke tests** — Jest-based suite under [`smoke-tests/`](../smoke-tests/). Verifies the SPA, REST routing, OAuth redirect, and WebSocket upgrade all behave. Safe to run from a laptop or as a post-deploy gate; exits non-zero on any failure. See [`smoke-tests/README.md`](../smoke-tests/README.md) for the checklist of checks.

  ```bash
  cd smoke-tests
  npm install                                          # one-time
  npm test                                             # default: prod LB
  TARGET=http://localhost:3000 npm test                # local dev backend
  ```

- **Manual smoke** — open the SPA at `https://group1.cse356.compas.cs.stonybrook.edu`, log in, send a message in a community and a DM. Check the per-component sections of [SCALING.md](SCALING.md) for the regression risks that have bitten us before.
- **Our ad-hoc loadgen runs** — headless API-driven clients we drove against the cluster during tuning to validate specific fixes (different mechanism from the **course grading load generator**, which is course-run — small scale through the pre-4/13 Test Traffic Period, much greater scale through the 4/13 → 5/8 Live Period — and which we did not control). Both kinds of clients hit the same REST + WS surface. Reports from our runs archived under `loadgen-reports/`; filename convention `2026-MM-DD-<scope>-<state>.{json,log}` — the JSON is the run summary, the `.log` has per-request traces.
- **TLS-probe** — `scripts/tls-probe/tls-probe.sh` measures cold-handshake latency at the LB; useful to isolate LB-side jitter from app-side cost.
- **PM2 health** — `sudo -u deploy pm2 jlist | jq` after a deploy; rising `restarts` is a smell.
- **HAProxy stats** — `:8404/stats` on either LB. Backend column color = health.
- **Telemetry stack** — Grafana Cloud dashboards (Loki for logs + Prometheus/Mimir for metrics, fed by Grafana Alloy on `group1-telemetry-01`); Axiom for HAProxy access-log tail; Sentry for unhandled exceptions (currently disabled in the codepath, kept for re-enable).

A future improvement would be expanding the existing Jest suite into a full integration pass (auth flow + message-send + WS broadcast) against an ephemeral PG + Redis stack.

## Debugging common problems

### "I logged in but `/me` returns 401" (the plain-HTTP cookie trap)
The session cookie is set with `secure: process.env.NODE_ENV === 'production'`, i.e. `Secure` in prod. If the LB is serving plain HTTP (currently on `:80` alongside `:443`), the `Set-Cookie` header is silently dropped by the browser on the HTTP response, so the login succeeds (200) but no session cookie comes back. Either:
- Route through `https://` only, or
- Relax `secure` to `'auto'` in `server/src/app.js` (the comment near that line warns about this exact symptom).

### Workers in a crash loop
SSH the node, `sudo -u deploy pm2 logs --lines 200`. Common culprits historically:
- OIDC failing to reach Keycloak at boot. Mitigated by the fire-and-forget `setupOidcStrategy().catch(...)` pattern; if you've removed that, the worker will exit on boot.
- `UPLOAD_DIR` env var undefined (an old multer artifact). Mitigated by having a default.
- A route conflict where a literal path segment is being parsed as a UUID (`/:id` defined before `/unread`). Always declare literal-prefix routes before parametric ones.

### 504s on `/api/conversations/:id/read`
This is the failure mode that drove the 2026-04-13 incident. Causes: DB pool exhaustion (see [SCALING.md, Bottleneck 1](SCALING.md#bottleneck-1--postgresql-connection-pool-exhaustion)) — check `pm2 logs` for `pool.acquire` timeouts, check PgBouncer `SHOW POOLS`, and check Postgres `pg_stat_activity` for queue depth.

### "Subscribers fell minutes behind"
Pub/sub fanout overload on Redis-02. The fix is structural (per-worker channels are already in place). If it recurs, it's because someone added a new pub/sub channel that publishes a large payload to many subscribers. See [SCALING.md, Bottleneck 5](SCALING.md#bottleneck-5--pubsub-fanout-amplification-with-ws-pool-size).

### Rolling deploy left a node disabled in HAProxy
`deploy-lb-configs` reloads HAProxy after a deploy, which **wipes runtime `state ready` overrides**. If you marked a backend `disabled` in the config and re-enabled it via socket, the reload reverts. The fix: don't ship new backends as `disabled` in the config; rely on the default health-check window to hold them DOWN until they pass. See `feedback_haproxy_runtime_state_lost_on_reload` in the memory store, and the parked-pool comments in `infra/haproxy/haproxy.cfg`.

### "Logged in but no presence updates"
The init race: `enableRealtime()` may resolve when the WS opens at the TCP level, **before** the server's async init finishes and sends the `"ready"` frame. Clients must await the literal string `"ready"` from the server before sending. The course grading load generator's clients have hit this bug too — the client-side fix is a one-time pre-filter on the raw WebSocket message event that holds the connect Promise unresolved until the exact frame `"ready"` arrives.

### `sendMessage` returning 403 "not a channel member" right after a successful join
Historical incident, 2026-04-15. A surge of 403s on `POST /api/messages` was traced to the **course grading load generator** silently treating failed `POST /api/communities/:id/join` responses (500 under load) as successful, then attempting `sendMessage` as a non-member. The fix landed on the course side (the grading load generator was updated to surface join errors explicitly). A temporary fall-back in `sendMessage` that auto-joined the user on a missing-membership lookup was used during the incident window and then reverted once the upstream patch was deployed. If a similar pattern reappears, first confirm whether the client is correctly distinguishing success from failure on the join call before reaching for a server-side workaround.

## Known issues / future improvements

The full list of carried-over limitations (correctness drift on a couple of routes, dual-table FTS, read replica, AOF on Redis-01, no autoscaling) plus the longer-term roadmap (TypeScript migration, macroservice split, Kubernetes-native deployment, GitOps CD) lives in **[IMPROVEMENTS.md](IMPROVEMENTS.md)**.

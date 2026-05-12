# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For additional project context, runbooks, and historical session notes, look in [`claude-docs/`](claude-docs/).

## Commands

All commands run from `server/`:

```bash
npm start        # Production (PM2 cluster mode via ecosystem.config.js)
npm run dev      # Development with auto-restart
```

Frontend (`client/`):
```bash
npm run build    # Vite production build → dist/
npm run dev      # Vite dev server
```

No test runner or linter is configured.

## Environment Variables

A `server/.env` file is required. Key variables:

```
DATABASE_URL=          # PostgreSQL connection string
REDIS_URL=             # Redis connection string
SESSION_SECRET=        # Secret for express-session
GOOGLE_CLIENT_ID= / GOOGLE_CLIENT_SECRET= / GOOGLE_CALLBACK_URL=
GITHUB_CLIENT_ID= / GITHUB_CLIENT_SECRET= / GITHUB_CALLBACK_URL=
OIDC_ISSUER=           # Keycloak realm URL
OIDC_CLIENT_ID= / OIDC_CLIENT_SECRET= / OIDC_CALLBACK_URL=
NODE_ENV=              # development | production
PORT=                  # defaults to 3000
FRONTEND_URL=          # For CORS and OAuth redirects
MINIO_ACCESS_KEY= / MINIO_SECRET_KEY=  # S3-compatible object storage
AXIOM_TOKEN=           # Optional, for log shipping
```

## Architecture

**Stack:** Node.js + Express 5, PostgreSQL (Sequelize ORM), Redis (sessions + pub/sub + presence), WebSocket (`ws`), MinIO (file storage), PM2 (process management).

**Entry point:** `server/src/app.js` — bootstraps middleware, mounts routes, syncs DB, starts server. `sequelize.sync()` uses `alter: true` in non-production only. Production schema changes go in `server/scripts/migrations/` (applied manually).

**Real-time:** `src/ws.js` — WebSocket server using Redis pub/sub for cross-node message fanout. No sticky sessions needed; any node can serve any client.

**Auth (`src/auth/passport.js`):** Four Passport strategies (Local, Google, GitHub, OIDC/Keycloak). Multi-provider account linking via `User.providers` JSONB array. OAuth flow uses `req.session.pendingOAuth` → `/auth/oauth-connect` frontend page.

**Sessions:** Stored in Redis via `connect-redis` (migrated from PostgreSQL). 14-day maxAge. Per-login logout.

**Models (`src/models/`):** User, Community, CommunityMember, Channel, ChannelMember, Message, Conversation, ConversationParticipant. All UUID primary keys, `underscored: true` convention.

**Search:** PostgreSQL full-text search with GIN-indexed tsvector on messages.

**File uploads:** MinIO (S3-compatible). Upload route in `src/routes/upload.js`, up to 4 attachments per message.

**Presence:** Tracked in Redis with TTLs (online/idle/away/offline).

## Deployment

**CI/CD:** GitHub Actions (`deploy.yml`) reads `infra/nodes.yml` for server IPs. Deploys app via SSH+rsync to 4 nodes in parallel, builds frontend and deploys to LB.

**Production topology:**
- **HAProxy** (LB, `130.245.136.254`) — SSL termination, routes `/api/*` and `/ws/*` to app nodes, `/*` to Nginx
- **Nginx** (on LB) — serves React SPA from `/srv/frontend/dist/`
- **4 app nodes** — PM2 cluster mode, ~2 workers each
- **PostgreSQL** (`10.0.1.235`) — primary data store
- **Redis (`group1-db-redis-01`, `10.0.0.136:6379`)** — sessions, cache, presence
- **Redis (`group1-db-redis-02`, `10.0.0.106:6380`)** — pub/sub for cross-node WS broadcast (offloaded 2026-05-07 to isolate fanout traffic from session/cache load)

Config files: `infra/haproxy/haproxy.cfg`, `infra/nginx/`, `infra/pgbouncer/`.

## Key Docs

See `claude-docs/` for detailed documentation: `spec.md` (requirements), `architecture.md` (topology & design), `scaling.md` (bottleneck analysis), `performance-tuning.md` (tuning plan), `incident-2026-04-13-504s.md` (504 post-mortem), `deployment.md` (CI/CD details).

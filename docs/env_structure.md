# Environment Variables

The server reads from `/srv/app/.env` on each app node. In CI, the `ENV_FILE` GitHub secret is written to that path on every deploy.

---

## Server `.env`

### Non-sensitive (actual production values)

| Variable | Production Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `PORT` | `3000` | PM2 binds here; Nginx proxies to it |
| `FRONTEND_URL` | `https://group1.cse356.compas.cs.stonybrook.edu` | Used for CORS and redirect targets |
| `REDIS_URL` | `redis://10.0.0.136:6379` | Internal network — Redis node |
| `OIDC_ISSUER` | `https://infra-auth.cse356.compas.cs.stonybrook.edu/realms/oauth` | Keycloak realm |
| `OIDC_CLIENT_ID` | `web-service` | |
| `OIDC_CALLBACK_URL` | `https://group1.cse356.compas.cs.stonybrook.edu/api/auth/oidc/callback` | |
| `GOOGLE_CALLBACK_URL` | `https://group1.cse356.compas.cs.stonybrook.edu/api/auth/google/callback` | |
| `GITHUB_CALLBACK_URL` | `https://group1.cse356.compas.cs.stonybrook.edu/api/auth/github/callback` | |

### Sensitive (stored in `ENV_FILE` GitHub secret only)

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string — internal host `10.0.1.235:5432`, db `cse356` |
| `SESSION_SECRET` | Random hex string |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console OAuth app |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console OAuth app |
| `GITHUB_CLIENT_ID` | From GitHub OAuth app settings |
| `GITHUB_CLIENT_SECRET` | From GitHub OAuth app settings |
| `OIDC_CLIENT_SECRET` | From course Keycloak config |

---

## Client `.env` (build-time only)

Set during the `deploy-frontend` CI job via `env:` block — not stored in a file.

| Variable | Production Value | Notes |
|---|---|
| `VITE_BACKEND_URL` | `https://group1.cse356.compas.cs.stonybrook.edu` | Injected at Vite build time |

---

## Callback URL Note

All OAuth/OIDC callback URLs use the `/api/auth/...` prefix (e.g. `/api/auth/google/callback`). If you register a new OAuth app or update the course OIDC config, use this prefix — **not** `/auth/...`.

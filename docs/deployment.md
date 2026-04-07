# Deployment

## Overview

Every push to `main` triggers GitHub Actions, which:
1. Reads `infra/nodes.yml` to get app node IPs and the LB IP
2. Deploys the server in parallel to all app nodes (one job per node)
3. Builds and deploys the frontend to the LB node (after app nodes are healthy)

**Flow:**
```
push to main
  └── setup job          reads infra/nodes.yml → emits matrix + LB IP
        └── deploy-app   parallel SSH deploy to each app node
              └── deploy-frontend   rsync client/dist → LB node
```

---

## Infrastructure Config (`infra/nodes.yml`)

Node IPs live here — adding or removing a node only requires editing this file.

```yaml
app_nodes:
  - 130.245.136.217   # add more IPs here to scale out

lb_node: 130.245.136.254
```

---

## Pipeline Jobs (`.github/workflows/deploy.yml`)

### `setup`
- Installs `yq`, parses `infra/nodes.yml`
- Emits `matrix` (JSON array of app node IPs) and `lb` (LB IP) as job outputs

### `deploy-app`
- `strategy.matrix.host` fans out over the app node array — one parallel job per node
- Each job:
  1. Writes `.env` from the `ENV_FILE` secret to `/srv/app/.env`
  2. `rsync`s `server/` to `/srv/app/` (excludes `.env` and `node_modules/`)
  3. `npm ci --omit=dev` — deterministic install from lockfile, no devDependencies
  4. `pm2 reload ecosystem.config.js --update-env` — graceful reload (or `pm2 start` on first deploy)

### `deploy-frontend`
- Runs after `deploy-app` completes
- Skipped entirely if `client/package.json` does not exist
- Builds the Vite app with `VITE_BACKEND_URL=https://group1.cse356.compas.cs.stonybrook.edu`
- `rsync`s `client/dist/` to `root@<lb>:/srv/frontend/dist/`

---

## GitHub Secrets Required

| Secret | Description |
|---|---|
| `SSH_PRIVATE_KEY` | Private key for the `deploy` user on app nodes and `root` on the LB |
| `ENV_FILE` | Full contents of `/srv/app/.env` — written to each app node on every deploy |

> `APP_NODE_1` and `LB_NODE` secrets are no longer used — they can be deleted.

---

## Notes

- App nodes deploy **in parallel** — all nodes update simultaneously
- `pm2 reload` (not `pm2 restart`) — graceful reload; new workers start before old ones stop, giving zero downtime
- `npm ci` is faster and deterministic vs `npm install`
- The LB node is only touched for frontend deploys; backend never runs there
- To add a new app node: append its IP to `infra/nodes.yml` — no workflow changes needed

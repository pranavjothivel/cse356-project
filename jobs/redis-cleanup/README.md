# redis-cleanup

Cron job that runs on the telemetry node (`group1-telemetry-01`, `130.245.136.96`) to garbage-collect stale Redis user/connection state.

## What it does

Scans all `users:*` keys in Redis, checks each user's `conns` map against live `conns:<id>` keys, and removes any connection IDs that no longer exist. If a user has no remaining connections, their `users:*` key is deleted entirely.

## Deployment

The deploy pipeline (`deploy.yml` / `rolling-hot-deploy.yml`) syncs this directory to `/root/redis-cleanup/` on the telemetry node and writes `.env`. It runs as part of the `deploy-jobs` job, in parallel with the app node rollout.

The cron entry on the telemetry node (runs at :28 every hour):

```
28 * * * * /root/.nvm/versions/node/v24.0.2/bin/node /root/redis-cleanup/index.js >> /root/redis-cleanup/output.txt 2>&1
```

## Environment

`.env` is written by the pipeline — only `REDIS_URL` is required:

```
REDIS_URL=redis://10.0.0.136:6379
```

## Manual run

```bash
ssh root@130.245.136.96
cd /root/redis-cleanup
node index.js
```

Logs are appended to `output.txt` when run via cron (`npm start`).

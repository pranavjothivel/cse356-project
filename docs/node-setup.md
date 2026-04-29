# App Node Setup

> **For adding a new node from scratch, follow [`api-node-bootstrap.md`](api-node-bootstrap.md)** — this page covers only the `setup-node.sh` step (deploy user + Node + PM2). The bootstrap doc additionally covers PgBouncer, Grafana Alloy, the repo edits, and the deploy run.

Run once on each app node as a user with sudo. Pass the public key that corresponds to your `SSH_PRIVATE_KEY` GitHub secret.

```bash
bash scripts/setup-node.sh "ssh-ed25519 AAAA... you@yourhost"
```

This script:
1. Creates the `deploy` user
2. Installs your public key into `~deploy/.ssh/authorized_keys`
3. Creates `/srv/app` and `/var/log/pm2` owned by `deploy`
4. Installs Node.js 22 LTS via NodeSource
5. Installs PM2 globally
6. Configures PM2 to restart on reboot (`pm2 startup`)

---

After the first push to `main`, verify the deploy worked:

```bash
ssh deploy@<app-node-ip> "pm2 list"
# Should show 'cse356' online with N workers
```

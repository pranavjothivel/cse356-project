# Deployment

## CI/CD: GitHub Actions → SSH

On every push to `main`, GitHub Actions SSHes into each app node sequentially, pulls the latest code, and does a graceful PM2 reload.

**Flow:** `push to main → GitHub Action → SSH into each node → git pull → npm ci → pm2 reload`

### GitHub Secrets required

| Secret | Value |
|---|---|
| `SSH_PRIVATE_KEY` | Private key for the `deploy` user on each app node |
| `APP_NODE_1` | IP or hostname of app node 1 |
| `APP_NODE_2` | IP or hostname of app node 2 |

Add more `APP_NODE_N` secrets as you scale out, and add them to the loop in the workflow.

### Workflow (`.github/workflows/deploy.yml`)

```yaml
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to app nodes
        env:
          SSH_KEY: ${{ secrets.SSH_PRIVATE_KEY }}
        run: |
          eval $(ssh-agent -s)
          echo "$SSH_KEY" | ssh-add -
          for HOST in ${{ secrets.APP_NODE_1 }} ${{ secrets.APP_NODE_2 }}; do
            ssh -o StrictHostKeyChecking=no deploy@$HOST "
              cd /srv/app &&
              git pull origin main &&
              npm ci --omit=dev &&
              pm2 reload ecosystem.config.js --update-env
            "
          done
```

### Notes

- Nodes are deployed **sequentially** — at least one node is always serving traffic during a deploy
- `pm2 reload` (not `pm2 restart`) — graceful reload starts new workers before killing old ones, giving zero downtime
- `npm ci --omit=dev` — faster than `npm install`, deterministic from lockfile, skips devDependencies
- The deploy user on each node needs read access to the repo directory and PM2 permissions

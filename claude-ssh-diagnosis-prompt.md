# Claude Code: SSH Prod Diagnosis + Plan Prompt

You have SSH access to two production nodes for this project. Use them to diagnose issues,
pull logs, and propose fixes.

## SSH credentials

- Key: ~/.ssh/id_ed25519_356_clanode_prod
- User: deploy
- Load Balancer (LB): 130.245.136.254
- App Node 1 (APP1): 130.245.136.217

## Useful commands to run via Bash tool

```bash
# PM2 app logs (last 200 lines)
ssh -i ~/.ssh/id_ed25519_356_clanode_prod deploy@130.245.136.217 "pm2 logs --nostream --lines 200"

# PM2 process status
ssh -i ~/.ssh/id_ed25519_356_clanode_prod deploy@130.245.136.217 "pm2 status"

# HAProxy stats/errors on LB
ssh -i ~/.ssh/id_ed25519_356_clanode_prod deploy@130.245.136.254 "sudo tail -100 /var/log/haproxy.log"

# Nginx logs on LB
ssh -i ~/.ssh/id_ed25519_356_clanode_prod deploy@130.245.136.254 "sudo tail -100 /var/log/nginx/error.log"

# Current app source on node
ssh -i ~/.ssh/id_ed25519_356_clanode_prod deploy@130.245.136.217 "ls /srv/app/"
```

## Workflow

1. SSH into the relevant node(s) and pull logs/status
2. Read the relevant source files in this repo to understand context
3. Enter plan mode (EnterPlanMode) to propose a fix strategy
4. Propose edits to local source files — do NOT edit files directly on the server
   (deploys go through GitHub Actions → rsync → pm2 reload)

## Architecture context

- Backend: Node.js/Express 5 in server/, PM2 cluster mode at /srv/app/
- Frontend: React/Vite SPA at /srv/frontend/dist/ on the LB (served by Nginx :8080)
- HAProxy on LB routes /api/* and /ws/* → app node :3000; /* → Nginx :8080
- Sessions in Redis, DB is PostgreSQL (Sequelize ORM)
- Real-time: ws library + Redis pub/sub
- CD: GitHub Actions (.github/workflows/deploy.yml) rsyncs server/ and client/dist/ on push to main

## Notes for collaborators

- The SSH key (~/.ssh/id_ed25519_356_clanode_prod) needs to exist on your local machine — get a copy from the repo owner
- Never edit files directly on the server; all changes go through git → GitHub Actions → deploy
- Plan mode (EnterPlanMode) is what makes Claude propose a strategy before touching any files
- Describe the symptom or error you're seeing, and Claude will SSH in, pull logs, read the code, and propose a fix

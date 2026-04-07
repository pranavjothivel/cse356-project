# Load Balancer Configuration

**Host:** `130.245.136.254`  
**Domain:** `https://group1.cse356.compas.cs.stonybrook.edu`

## Overview

HAProxy handles SSL termination and request routing. Nginx serves the React SPA statically on a local port. Both run on the same LB node.

```
Client
  └─ HTTPS :443 → HAProxy
                    ├─ /api/* → App node(s) (port 3000)
                    ├─ /ws/*  → App node(s) (port 3000)
                    └─ /*     → Nginx :8080 → /srv/frontend/dist/
```

---

## HAProxy

**Config:** `/etc/haproxy/haproxy.cfg`

```haproxy
global
    log /dev/log local0
    maxconn 4096
    ssl-default-bind-options ssl-min-ver TLSv1.2

defaults
    log     global
    mode    http
    option  httplog
    option  forwardfor
    timeout connect 5s
    timeout client  50s
    timeout server  50s
    timeout tunnel  3600s

frontend http_front
    bind *:80
    redirect scheme https code 301

frontend https_front
    bind *:443 ssl crt /etc/haproxy/certs/group1.cse356.compas.cs.stonybrook.edu.pem

    http-request set-header X-Forwarded-Proto https
    http-request set-header X-Real-IP %[src]

    acl is_api  path_beg /api
    acl is_ws   path_beg /ws

    use_backend app_servers if is_api or is_ws
    default_backend static_files

backend app_servers
    balance roundrobin
    option httpchk GET /api/health
    http-check expect status 200

    cookie SERVERID insert indirect nocache

    server node1 10.0.3.93:3000 check cookie node1

backend static_files
    server nginx 127.0.0.1:8080
```

**Adding an app node:**
```haproxy
server node2 10.0.X.X:3000 check cookie node2
```

**Reload after changes:**
```bash
haproxy -c -f /etc/haproxy/haproxy.cfg  # validate
systemctl reload haproxy
```

---

## Nginx

**Config:** `/etc/nginx/sites-available/frontend` (symlinked to `sites-enabled/`)

```nginx
server {
    listen 127.0.0.1:8080;

    root /srv/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Listens only on loopback — not reachable directly from outside, only via HAProxy.  
`try_files` falls back to `index.html` so React client-side routing works.

**Frontend files location:** `/srv/frontend/dist/`  
**Deployed by:** pipeline on every push to `main` (rsync from CI runner)

**Reload after config changes:**
```bash
nginx -t && systemctl reload nginx
```

---

## SSL Certificate

**Path:** `/etc/haproxy/certs/group1.cse356.compas.cs.stonybrook.edu.pem`

HAProxy expects a combined PEM file (cert + key concatenated). To renew:
```bash
cat fullchain.pem privkey.pem > /etc/haproxy/certs/group1.cse356.compas.cs.stonybrook.edu.pem
systemctl reload haproxy
```

---

## GitHub Secrets

| Secret | Value |
|---|---|
| `SSH_PRIVATE_KEY` | Private key for `deploy` user on app nodes |
| `APP_NODE_1` | `10.0.3.93` (private IP of app node 1) |
| `LB_NODE` | `130.245.136.254` (public IP of LB node) |
| `ENV_FILE` | Full `.env` file contents — must include all vars below |

### ENV_FILE contents

```
DATABASE_URL=postgresql://user:password@<db-host>:5432/cse356
REDIS_URL=redis://<redis-host>:6379
SESSION_SECRET=<random 32-byte hex>
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=https://group1.cse356.compas.cs.stonybrook.edu/auth/google/callback
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=https://group1.cse356.compas.cs.stonybrook.edu/auth/github/callback
OIDC_ISSUER=https://infra-auth.cse356.compas.cs.stonybrook.edu/realms/oauth
OIDC_CLIENT_ID=web-service
OIDC_CLIENT_SECRET=web-service-secret
OIDC_CALLBACK_URL=https://group1.cse356.compas.cs.stonybrook.edu/auth/oidc/callback
NODE_ENV=production
PORT=3000
```

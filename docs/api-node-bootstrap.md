# Bootstrapping a New API Node

End-to-end runbook for adding an app node to the cluster. Captures everything that's manual (CI doesn't provision new hosts) plus the repo edits that wire the node into the deploy pipeline.

> Reference run: `group1-api-node-05` was bootstrapped with this process on 2026-04-29 (PR #152).

---

## Prerequisites

- Fresh Linode running Ubuntu 22.04, public + private IPs assigned, root SSH reachable from your local machine
- Local SSH key for `root@<node>`: `~/.ssh/id_ed25519_356_clanode_prod` (matches `infra/pgbouncer/provision.sh`)
- Local SSH key matching the `SSH_PRIVATE_KEY` GitHub secret — the public half of this is what the deploy pipeline uses to reach the `deploy` user
- `gh` CLI authenticated for this repo

---

## 1. Reachability + sanity check

```bash
ssh -i ~/.ssh/id_ed25519_356_clanode_prod -o ConnectTimeout=5 \
    root@<NEW_PUBLIC_IP> 'uname -a && nproc'
```

Confirm Ubuntu 22.04 and the expected vCPU count.

---

## 2. Run `scripts/setup-node.sh`

Creates the `deploy` user, installs Node 22 LTS + PM2, and wires up the PM2 systemd unit.

```bash
DEPLOY_PUBKEY=$(ssh -i ~/.ssh/id_ed25519_356_clanode_prod \
                  root@130.245.136.217 'cat /home/deploy/.ssh/authorized_keys')

ssh -i ~/.ssh/id_ed25519_356_clanode_prod root@<NEW_PUBLIC_IP> \
    "bash -s -- '$DEPLOY_PUBKEY'" < scripts/setup-node.sh
```

> **Known quirk:** `setup-node.sh` ends with a `pm2 startup` step that occasionally exits non-zero when run non-interactively (PM2 emits `EACCES` warnings spawning the daemon without a TTY, which `set -euo pipefail` may catch). If the script bails after PM2 install, finish manually:
>
> ```bash
> ssh -i ~/.ssh/id_ed25519_356_clanode_prod root@<NEW_PUBLIC_IP> \
>   'env PATH=$PATH:/usr/bin pm2 startup systemd -u deploy --hp /home/deploy'
> ```

Verify:

```bash
ssh -i ~/.ssh/id_ed25519_356_clanode_prod root@<NEW_PUBLIC_IP> \
  'id deploy && node -v && systemctl is-enabled pm2-deploy'
```

---

## 3. Install PgBouncer

Just the package — `/etc/pgbouncer/pgbouncer.ini` and `userlist.txt` are templated by the deploy workflow's "Configure PgBouncer" step from `PG_DIRECT_URL` in the `ENV_FILE` secret.

```bash
ssh -i ~/.ssh/id_ed25519_356_clanode_prod root@<NEW_PUBLIC_IP> \
  'apt-get update -qq && apt-get install -y -qq pgbouncer && systemctl enable pgbouncer'
```

Service may fail to start until the deploy job writes the config — that's expected.

---

## 4. Install Grafana Alloy

We install Alloy directly from the Grafana apt repo (no need for the Grafana Cloud onboarding script — we'll mirror an existing API node's config rather than start from the script's defaults, so we don't need to re-inject the API key).

```bash
ssh -i ~/.ssh/id_ed25519_356_clanode_prod root@<NEW_PUBLIC_IP> 'bash -s' <<'EOF'
set -euo pipefail
mkdir -p /etc/apt/keyrings
wget -qO - https://apt.grafana.com/gpg.key | gpg --dearmor -o /etc/apt/keyrings/grafana.gpg
echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" \
  > /etc/apt/sources.list.d/grafana.list
apt-get update -qq
apt-get install -y -qq alloy
systemctl enable alloy
EOF
```

Then mirror an existing API node's config (it uses `constants.hostname` for every `instance` label, so each node ships under its own hostname — see [`grafana-alloy-api-node.md`](grafana-alloy-api-node.md)):

```bash
ssh -i ~/.ssh/id_ed25519_356_clanode_prod root@130.245.136.217 'cat /etc/alloy/config.alloy' \
  | ssh -i ~/.ssh/id_ed25519_356_clanode_prod root@<NEW_PUBLIC_IP> \
      'cat > /etc/alloy/config.alloy
       chown root:alloy /etc/alloy/config.alloy
       chmod 640 /etc/alloy/config.alloy
       systemctl restart alloy'
```

Verify samples are flowing:

```bash
ssh -i ~/.ssh/id_ed25519_356_clanode_prod root@<NEW_PUBLIC_IP> \
  'sleep 8; curl -s http://127.0.0.1:12345/metrics \
    | grep "^prometheus_remote_storage_samples_total"'
```

A non-zero, increasing counter confirms metrics are being shipped to Grafana Cloud Prometheus. Also check Loki — `host=<new-hostname>` should produce journal lines within ~1 minute.

---

## 5. Repo edits (single PR)

Branch off `main`. Three files change:

### `infra/nodes.yml`
Append the new node. The `setup` job in deploy workflows derives the HAProxy server name (`node1`, `node2`, …) from list ordering — keep ordering stable.

```yaml
  - name: group1-api-node-XX
    ip: <PUBLIC_IP>
    private_ip: <PRIVATE_IP>
    type: <vcpu>vcpu-<ram>gb
```

### `infra/haproxy/haproxy.cfg`
Add a `server` line in the `app_servers` backend. **Weight = vCPU count** (PM2 uses one worker per vCPU; RAM/vCPU is uniform at ~2 GB/core across all nodes, so vCPU also tracks memory headroom).

```
server nodeXX <PRIVATE_IP>:3000 check weight <vcpu_count>
```

### `infra/README.md`
Append the inventory row.

---

## 6. Open + merge PR

```bash
gh pr create --title "..." --body "..."
```

Wait for review/CI/merge.

---

## 7. Run a deploy

For adding a new node, **`Deploy`** is preferred over `Rolling Hot Deploy`:

- `Deploy` runs `deploy-app` (per-node) and `deploy-lb-configs` (HAProxy push) in parallel. The new node stays DOWN in HAProxy until its app starts answering on `:3000` — safe for existing nodes.
- `Rolling Hot Deploy` issues `set server app_servers/nodeXX state drain` on the LB *before* `deploy-lb-configs` runs. For a freshly added node, that drain command targets a server HAProxy doesn't know about yet — it returns "No such server" but `socat` still exits 0, so the workflow doesn't fail. End state is the same.

```bash
gh workflow run deploy.yml --ref main
```

If targeting just the new node with rolling hot deploy:

```bash
gh workflow run rolling-hot-deploy.yml --ref main -f target_node=<idx>
```

(`target_node` is 1-indexed against `infra/nodes.yml` order.)

---

## 8. Verify

1. **HAProxy stats** — new server visible and UP:
   ```bash
   ssh root@130.245.136.254 \
     'echo "show servers state" | socat stdio /run/haproxy/admin.sock' \
     | grep nodeXX
   ```
2. **PM2 on new node** — workers online (one per vCPU):
   ```bash
   ssh deploy@<PUBLIC_IP> 'pm2 list'
   ```
3. **Traffic landing on new node**:
   ```bash
   for i in $(seq 1 30); do
     curl -s -D- https://group1.cse356.compas.cs.stonybrook.edu/api/health \
       -o /dev/null | grep -i X-Served-By
   done | sort | uniq -c
   ```
4. **PgBouncer**: `systemctl status pgbouncer` → active
5. **Grafana Cloud**:
   - Prometheus: `up{instance="<new-hostname>"}` = 1
   - Loki: `host=<new-hostname>` shows journal lines
   - Tempo: `service.name=cse356-api` filtered to the new hostname (after sending traffic)

---

## Common pitfalls

- **`pm2 startup` fails silently** — see Step 2 quirk above.
- **PgBouncer fails to start before first deploy** — config doesn't exist yet, expected. The deploy job's "Configure PgBouncer" step creates `/etc/pgbouncer/pgbouncer.ini` and reloads.
- **Forgetting to update `infra/haproxy/haproxy.cfg`** — node-XX will appear in `nodes.yml`, get code deployed, but never receive traffic because HAProxy doesn't know about it. Both edits are required.
- **HAProxy weight mismatch with vCPU** — leastconn balancing with weights treats `weight` as a connection ratio cap. A weight-2 node next to a weight-8 node receives ~25% of the larger node's connections, which matches their relative capacity.

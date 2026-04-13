#!/usr/bin/env bash
set -euo pipefail

# Install PgBouncer on all app nodes listed in infra/nodes.yml.
# Run once before the first deploy: bash infra/pgbouncer/provision.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SSH_KEY=~/.ssh/id_ed25519_356_clanode_prod

for ip in $(yq '.app_nodes[].ip' "$REPO_ROOT/infra/nodes.yml"); do
  echo "Provisioning PgBouncer on $ip..."
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no root@"$ip" \
    "apt-get update -qq && apt-get install -y -qq pgbouncer && systemctl enable pgbouncer"
  echo "  Done: $ip"
done

echo "All nodes provisioned."

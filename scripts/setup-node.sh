#!/usr/bin/env bash
# Run once on each app node as a user with sudo.
# Usage: bash setup-node.sh <public-key>
# Example: bash setup-node.sh "ssh-ed25519 AAAA... user@host"
set -euo pipefail

PUBLIC_KEY="${1:?Usage: $0 '<public-key>'}"

# 1. Create the deploy user
if ! id deploy &>/dev/null; then
  sudo adduser --disabled-password --gecos "" deploy
fi

# 2. Authorize the deploy SSH key
sudo mkdir -p /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
echo "$PUBLIC_KEY" | sudo tee /home/deploy/.ssh/authorized_keys > /dev/null
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh

# 3. Create app and log directories
sudo mkdir -p /srv/app /var/log/pm2
sudo chown deploy:deploy /srv/app /var/log/pm2

# 4. Install Node.js v22 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 5. Install PM2 globally
sudo npm install -g pm2

# 6. Configure PM2 to start on reboot
STARTUP_CMD=$(sudo -u deploy pm2 startup systemd -u deploy --hp /home/deploy 2>&1 | grep "sudo")
eval "$STARTUP_CMD"

echo ""
echo "Setup complete. Verify SSH access from your local machine:"
echo "  ssh -i <path-to-private-key> deploy@<this-node-ip>"

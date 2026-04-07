# App Node Setup

Run these once on each app node as a user with sudo.

## 1. Create the deploy user

```bash
sudo adduser --disabled-password --gecos "" deploy
```

## 2. Authorize the deploy SSH key

```bash
sudo mkdir -p /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
# paste the PUBLIC key that corresponds to the SSH_PRIVATE_KEY GitHub secret:
echo "<your-public-key>" | sudo tee /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh
```

## 3. Create app and log directories

```bash
sudo mkdir -p /srv/app /var/log/pm2
sudo chown deploy:deploy /srv/app /var/log/pm2
```

## 4. Install Node.js (v22 LTS via NodeSource)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 5. Install PM2 globally

```bash
sudo npm install -g pm2
```

## 6. Configure PM2 to start on reboot

```bash
# Run as the deploy user:
sudo -u deploy pm2 startup systemd -u deploy --hp /home/deploy
# PM2 will print a command — run it exactly as printed (it starts with sudo)
```

## 7. Verify SSH access from your local machine

```bash
ssh -i <path-to-private-key> deploy@<app-node-ip> "echo ok"
```

Should print `ok`. If it does, the pipeline is ready to deploy.

---

After the first `git push` to `main`, verify the deploy worked:

```bash
ssh deploy@<app-node-ip> "pm2 list"
# Should show 'cse356' online with N workers
```

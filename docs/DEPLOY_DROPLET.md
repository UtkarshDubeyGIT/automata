# Deploy to a DigitalOcean Droplet

This setup runs three containers on one Droplet:

- Caddy accepts public traffic on ports 80 and 443.
- The Next.js web service is reachable only through Caddy.
- The worker polls and executes scheduled workflows.

Supabase, OpenAI, Composio, Stripe, and Resend remain external services.

## 1. Prepare the Droplet

Use Ubuntu 24.04 with at least 2 GB RAM. In the DigitalOcean Cloud Firewall, allow inbound TCP 22, 80, and 443 and inbound UDP 443. Do not expose port 3000.

Connect as root, install Docker and Git, and enable the firewall:

```bash
ssh root@YOUR_DROPLET_IP
apt update
apt install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
```

For a 2 GB Droplet, add swap so the image build has headroom:

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 2. Clone the repository

For a public repository:

```bash
mkdir -p /opt/automata
git clone YOUR_REPOSITORY_URL /opt/automata
cd /opt/automata
```

For a private repository, add a read-only GitHub deploy key to the repository and clone over SSH. Do not store a personal access token in shell history.

## 3. Configure the environment

```bash
cp .env.example .env.local
chmod 600 .env.local
nano .env.local
```

For immediate access through the Droplet IP, set both URLs to HTTP:

```env
APP_HOST=http://YOUR_DROPLET_IP
NEXT_PUBLIC_APP_URL=http://YOUR_DROPLET_IP
```

For a domain or free subdomain, omit the protocol from `APP_HOST`. Caddy obtains and renews the TLS certificate automatically:

```env
APP_HOST=automata-example.duckdns.org
NEXT_PUBLIC_APP_URL=https://automata-example.duckdns.org
```

Fill in the remaining Supabase and provider variables. Generate the cron secret with:

```bash
openssl rand -base64 48
```

Never commit `.env.local`. The Docker build excludes it, and Compose injects it only when the containers start.

## 4. Prepare external services

Before public signup:

1. Apply every file in `supabase/migrations/` to the production Supabase project in filename order.
2. Set the Supabase Auth Site URL to `NEXT_PUBLIC_APP_URL`.
3. Add `NEXT_PUBLIC_APP_URL/auth/callback` to the Supabase redirect allow list.
4. Configure the Stripe webhook as `NEXT_PUBLIC_APP_URL/api/billing/webhook` after HTTPS is available.
5. Use the webhook signing secret Stripe returns as `STRIPE_WEBHOOK_SECRET`.

Raw-IP HTTP access is suitable for a smoke test, but Google OAuth and production Stripe webhooks require a stable HTTPS hostname.

## 5. Build and start

```bash
cd /opt/automata
docker compose --env-file .env.local config --quiet
docker compose --env-file .env.local up -d --build
docker compose ps
```

Watch startup logs:

```bash
docker compose logs -f --tail=100 proxy web worker
```

Then open `NEXT_PUBLIC_APP_URL`. Check the deployment from the server with:

```bash
curl -I "$NEXT_PUBLIC_APP_URL"
```

## 6. Deploy updates

Every push to `main` runs `.github/workflows/deploy.yml`: lint, typecheck, and
tests on a GitHub runner, then `git reset --hard origin/main` and a Compose
rebuild over SSH, followed by a wait on the web container's healthcheck. It needs
four repository secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (an
ed25519 private key whose public half is in the Droplet's `authorized_keys`), and
`DEPLOY_KNOWN_HOSTS` (`ssh-keyscan -H YOUR_DROPLET_IP`).

`.env.local` is never in git, so CI leaves it untouched. Push secret changes from
your machine:

```bash
scripts/sync-env.sh          # rsyncs .env.local, then rebuilds and restarts
RESTART=0 scripts/sync-env.sh  # copy only
```

To deploy by hand:

```bash
cd /opt/automata
git pull --ff-only
docker compose --env-file .env.local up -d --build
docker image prune -f
```

`restart: unless-stopped` brings all containers back after a Droplet reboot. Caddy certificate state is stored in Docker volumes and survives container replacement.

## Operations

```bash
# Status and health
docker compose ps

# Recent logs
docker compose logs --tail=200 proxy web worker

# Restart without rebuilding
docker compose restart

# Stop the app
docker compose down
```

Do not run the `/api/cron` endpoint from another scheduler while the worker is enabled. Monitor failed workflow runs, Stripe webhook failures, disk usage, memory, and certificate renewal logs.

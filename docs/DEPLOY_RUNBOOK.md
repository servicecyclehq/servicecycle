# ServiceCycle - Droplet Deploy Runbook

Last updated: 2026-06-10. Target: a single DigitalOcean droplet running the
self-hosted Docker Compose stack (Postgres + migrate init + API + client)
behind a Caddy reverse proxy with automatic HTTPS. Written for the brother
demo; works for any single-box self-hosted install.

> Why build-on-droplet: there is currently **no CI publishing images to GHCR**,
> so `docker-compose.ghcr.yml` would pull stale/absent images. Build on the box
> with the default `docker-compose.yml`. It now includes a `server-migrate`
> init container that applies the squashed `20260606000000_init` baseline
> automatically before the API starts.

---

## 0. Architecture (what comes up)

`docker compose up --build` brings up four services in order:

1. **db** - Postgres 16, hardened (statement_timeout / lock_timeout / idle timeout), named volume `postgres_data`.
2. **server-migrate** - runs `prisma migrate deploy` once, applies the baseline, exits 0. The API waits on its success.
3. **server** - Express/Prisma API on :3001 (bound to 127.0.0.1 by default). Health: `/api/health` (no DB), `/api/ready` (DB).
4. **client** - the SPA. In `docker-compose.yml` the client service runs `npm run build && npm run preview` (a production build served by Vite preview, console-stripped and minified - NOT the dev server). Vite preview does not proxy `/api`, which is why the Caddy config below routes `/api` to the server separately.

Caddy (installed separately, on the host) terminates TLS and proxies the domain to the client + `/api` to the server.

> More production-grade option: the repo also ships `client/Dockerfile.prod` (vite build -> nginx static serve on :80, with gzip, long-cache headers, scan-path blocking, and an internal `/api` -> `server:3001` proxy). It's what the GHCR images use. For a longer-lived or higher-traffic deployment, switch the client service to `build: { dockerfile: Dockerfile.prod }`, publish container port 80, and simplify Caddy to a single `reverse_proxy 127.0.0.1:<client-port>` (nginx then handles `/api` itself). For a short brother demo, the `vite preview` path is fine and needs no changes.

---

## 1. Provision the droplet

- Size: **2 GB RAM minimum, 4 GB recommended** (server and db each have a 1 GB mem_limit; the build itself needs headroom). 2 vCPU, 50 GB disk.
- OS: Ubuntu 24.04 LTS.
- Point an **A record** for your demo hostname (e.g. `servicecycle.app`) at the droplet IP before you start Caddy (Let's Encrypt needs it resolving).

SSH in and install Docker + the Compose plugin:

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker   # log out/in if the group change doesn't take
```

---

## 1.5 Harden the droplet (do this BEFORE exposing anything)

A fresh droplet is reachable by the whole internet. Lock it down before `docker compose up`:

```bash
# Non-root sudo user (skip if you created one at droplet creation).
sudo adduser deploy && sudo usermod -aG sudo,docker deploy
# Copy your SSH key to it, then log in as `deploy` for everything below.

# SSH: key-only, no root, no passwords. CONFIRM a new session logs in BEFORE closing this one.
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# Firewall: deny inbound except SSH + HTTP + HTTPS. Do NOT open 3001 or 5432.
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443
sudo ufw enable

# Brute-force protection + automatic security patches.
sudo apt-get install -y fail2ban unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades

# Swap - fresh droplets ship with NONE; this prevents OOM kills during the
# client build (vite/rollup) and migrations on a 2 GB box.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf && sudo sysctl --system >/dev/null

# Timezone (optional; crons are scheduled in server time).
sudo timedatectl set-timezone America/New_York   # adjust to yours
```

> **Critical gotcha - Docker bypasses UFW.** Docker writes its own iptables rules, so publishing a container port on `0.0.0.0` is **internet-reachable even with UFW set to deny**. This stack already binds the API to `127.0.0.1` and never publishes Postgres (5432), so you're safe out of the box - but never flip a port mapping to `0.0.0.0` (e.g. via `SERVICECYCLE_HOST_BIND`) without re-checking the firewall.

---

## 2. Clone the repo

```bash
git clone https://github.com/servicecyclehq/servicecycle.git
cd servicecycle
```

The `.env` file lives in the **repo root** (next to `docker-compose.yml`), NOT in `server/`.

---

## 3. Generate secrets

Run these and copy each value into `.env` (next step). **Back up MASTER_KEY somewhere safe** - it encrypts TOTP secrets and DB-stored credentials; lose it and that data is unrecoverable.

```bash
# POSTGRES_PASSWORD
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
# JWT_SECRET (>=32 chars)
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
# MASTER_KEY (must decode to exactly 32 bytes = 44-char base64)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

(No Node on the box yet? Run each inside Docker: `docker run --rm node:20-alpine node -e "..."`.)

---

## 4. Create `.env`

The server refuses to boot if a required var is missing or weak. Minimum for a production demo:

```ini
# ---- Required ----
POSTGRES_PASSWORD=<from step 3>
JWT_SECRET=<from step 3, >=32 chars>
MASTER_KEY=<from step 3, 44-char base64>
NODE_ENV=production
CLIENT_URL=https://servicecycle.app        # required in prod; locks CORS to this origin

# ---- Demo-friendly (no external accounts needed) ----
EMAIL_MOCK=true            # otherwise BREVO_API_KEY is required in prod
AI_ENABLED=false           # otherwise an AI provider key is required
REGISTRATION_OPEN=false    # demo accounts are seeded, not self-signup

# ---- Behind Caddy (reverse proxy) ----
TRUST_PROXY=127.0.0.1      # Caddy runs on the host; trust the local hop so per-IP rate limits see real client IPs
VITE_API_URL=https://servicecycle.app
# API stays bound to 127.0.0.1 by default so only Caddy can reach it.
# Set SERVICECYCLE_HOST_BIND=0.0.0.0 ONLY if you must hit :3001 directly from another box.
```

Note: `POSTGRES_USER` / `POSTGRES_DB` default to `servicecycle` in compose - leave them unset unless you have a reason. (`.env.example` still shows legacy `servicecycle` defaults in a few comments; harmless, cosmetic.)

**`DEMO_MODE` - leave it `false` (the default) for a curated demo.** Setting `DEMO_MODE=true` forces email-mock + AI-off, but also **opens self-signup**, prunes inactive accounts, and **wipes + re-seeds the database nightly at 03:30 server time**. That's good for an always-fresh public sandbox, but for a controlled walkthrough it would erase anything you set up mid-demo. The explicit `EMAIL_MOCK=true` / `AI_ENABLED=false` / `REGISTRATION_OPEN=false` above give you the safe defaults without the nightly reset.

**Lock the file down** once written - it holds your DB password and keys:

```bash
chmod 600 .env && chown "$USER:$USER" .env
```

(`.env` is already gitignored and excluded from Docker images via `.dockerignore`, so it never reaches git or an image layer.)

---

## 5. Deploy

```bash
docker compose up -d --build
```

Order of operations: db becomes healthy -> **server-migrate applies the baseline and exits 0** -> server starts -> client starts. Watch it:

```bash
docker compose logs -f server-migrate     # should end with "Done. Exiting 0."
docker compose ps                          # server-migrate = Exited (0); db / server / client = Up
docker compose logs -f server              # "ServiceCycle API running on port 3001"
```

If `server` never starts, check `server-migrate` logs first - a failed migration intentionally blocks the API instead of letting it crash-loop against an un-migrated DB.

---

## 6. Seed demo data

The baseline DB is empty. Seed the standards library, then the demo account:

```bash
docker compose exec server node node_modules/tsx/dist/cli.mjs scripts/seed-standards.js
docker compose exec server node node_modules/tsx/dist/cli.mjs scripts/seed-demo.js
```

Verified result: 14 standards + 85 task definitions, then 1 account / 4 users / 18 assets / 2 sites / 23 work orders.

**Demo logins:**

| Email | Password | Role |
|---|---|---|
| admin@demo.local | Admin1234! | admin |
| manager@demo.local | Manager1234! | manager |
| viewer@demo.local | Viewer1234! | viewer |
| consultant@demo.local | Consultant1234! | consultant |

---

## 7. Caddy reverse proxy + HTTPS

Install Caddy on the host and create `/etc/caddy/Caddyfile`:

```
servicecycle.app {
    encode gzip
    handle /api/* {
        reverse_proxy 127.0.0.1:3001
    }
    handle {
        reverse_proxy 127.0.0.1:5173
    }
}
```

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
sudo systemctl reload caddy
```

Caddy fetches a Let's Encrypt cert automatically once the A record resolves. The ACME challenge connects back to your hostname, so **DNS must point at the droplet and have propagated before you start Caddy**, or issuance fails. Verify first:

```bash
dig +short A servicecycle.app     # must return the droplet IP
dig +short AAAA servicecycle.app  # if you set an AAAA record, it must also be correct (or omit it)
```

Lower the record TTL to ~300s before cutover so you can correct mistakes quickly. Confirm the client and server container host ports match what Caddy proxies (`docker compose ps`); by default the API is on 127.0.0.1:3001. Adjust the client port in the Caddyfile to whatever the client service publishes.

Optional belt-and-suspenders security headers (the app already sets HSTS/nosniff/frame headers via helmet, but you can also enforce at the edge) - add inside the site block:

```
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options    "nosniff"
        Referrer-Policy           "strict-origin-when-cross-origin"
    }
```

---

## 8. Verify

```bash
curl -fsS https://servicecycle.app/api/health   # liveness, no DB
curl -fsS https://servicecycle.app/api/ready    # readiness, checks DB connectivity
```

Then open the domain in a browser and log in as `admin@demo.local / Admin1234!`.

---

## 9. Operational notes

- **Backups:** the API runs a nightly `pg_dump` cron (02:00 server time, 30-day retention) into `./backups` on the host. Copy that directory plus the named volume off-box for a full backup. Manual dump: `docker compose exec db pg_dump -U servicecycle servicecycle | gzip > backup.sql.gz`.
- **Single instance only:** crons (backups, prunes, digests) are guarded by a Postgres advisory lock so they fire exactly once. Do **not** scale the `server` service to more than one replica without revisiting that design - the guard prevents double-fire, but the stack assumes one box.
- **Updating:** `git pull && docker compose up -d --build`. The `server-migrate` init container re-runs `migrate deploy` and applies any new migrations before the API restarts.
- **Resetting the DB:** `docker compose down -v` destroys the `postgres_data` volume (full wipe), then `up --build` + re-seed for a clean slate.
- **MASTER_KEY rotation:** set `OLD_MASTER_KEY` to the previous value alongside a new `MASTER_KEY` during a rotation window (same dual-key pattern as `OLD_JWT_SECRET`).

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Server container exits immediately, log says "Refusing to start" | Missing/weak required env var | Check the named var in `.env` (JWT_SECRET >= 32, MASTER_KEY 44-char base64, CLIENT_URL set in prod). |
| `server` never starts; `server-migrate` Exited (1) | Migration failed to apply | `docker compose logs server-migrate`. On a fresh DB the baseline applies clean (verified); a failure here usually means a bad DATABASE_URL or an unhealthy db. |
| Browser API calls blocked by CORS | `CLIENT_URL` doesn't match the real origin | Set `CLIENT_URL=https://<your-domain>` exactly, then `docker compose up -d`. |
| Rate limits trip immediately / all clients share one bucket | `TRUST_PROXY` not set behind Caddy | Set `TRUST_PROXY=127.0.0.1` (or the proxy CIDR). |
| 502 from Caddy | Container host-port mismatch | `docker compose ps`, then align the Caddyfile `reverse_proxy` ports with the published ports. |

---

## 11. Production hardening checklist (best-practice gap-check)

Mapped against standard go-live best practices for a Dockerized app on a fresh VM (DigitalOcean/Docker/OWASP/PostgreSQL/Caddy guidance). Split into what the app/stack already handles vs. what you must do on the box.

### Already handled by the app / compose (no action needed)

- API and Postgres **bound to `127.0.0.1`**; 5432 never published. (compose)
- **Per-container memory/CPU/pids limits** and `restart: unless-stopped` on db/server/client. (compose)
- **Container log rotation** (`json-file`, 10m x 3) on every service. (compose)
- **Postgres on a named volume** (`postgres_data`); survives `down`/rebuilds.
- **Postgres hardening flags**: `statement_timeout=30s`, `lock_timeout=10s`, `idle_in_transaction_session_timeout=60s`; bounded Prisma pool (`connection_limit=10`).
- **Nightly `pg_dump`** (02:00, 30-day retention) into `./backups`, plus an automated **restore-test** cron. Pinned `postgres:16-alpine`.
- **Healthchecks**: db `pg_isready`; server `/api/ready` (real DB probe); liveness `/api/health`. Migrate runs as a gated init container.
- **Migrations** use `prisma migrate deploy` (forward-only, advisory-locked) - never `migrate dev`/`reset`.
- **App-level security headers** via helmet (HSTS, nosniff, frame), strict CORS, edge-ish rate limiting on auth + global routes, body-size cap.
- **Secrets out of git/images** (`.gitignore` + `.dockerignore`); no secrets logged (audited); startup refuses to boot on missing/weak required vars.
- Non-root container users (server runs `USER node`; nginx/postgres drop privileges).
- Cron **single-instance advisory-lock guard** so scheduled jobs never double-fire.

### You must do on the droplet (covered in steps 1.5 / 4 / 7 above)

- [ ] Non-root sudo user; **SSH key-only**, root + password login disabled. (1.5)
- [ ] **UFW** default-deny inbound; only 22/80/443 open. (1.5)
- [ ] **fail2ban** + **unattended-upgrades**. (1.5)
- [ ] **Swap** (fresh droplets have none) + `vm.swappiness=10`. (1.5)
- [ ] `.env` **`chmod 600`**, owned by the deploy user. (4)
- [ ] **Back up `MASTER_KEY` off-box, encrypted, before first boot** - its loss makes encrypted data unrecoverable. (3/4)
- [ ] **DNS A/AAAA** resolve to the droplet *before* starting Caddy; verify with `dig`; low TTL during cutover. (7)

### You should set up soon after go-live (operator, not in repo)

- [ ] **Enable DigitalOcean droplet backups** (usage-based) for one-click system recovery, and take a **manual snapshot** of the known-good box right after go-live.
- [ ] **Copy `pg_dump` backups off-box** (DO Spaces or another host) - on-box-only backups die with the box. The app writes them to `./backups`; sync that dir + `./uploads` off the droplet (e.g. nightly `rclone`/`scp`).
- [ ] **External uptime monitor** on the public HTTPS URL (UptimeRobot / Better Stack / healthchecks.io). The app already supports `HEALTHCHECKS_PING_KEY` for cron heartbeats and Better Stack log ingest - wire those up if you want job-level alerting.
- [ ] **Disk-space alert** at ~75-80% on `/` and `/var/lib/docker` - full disks are the most common silent demo outage (logs + images + backups accumulate). `docker system prune` periodically.
- [ ] **Before any future update that includes a migration**: `docker compose exec db pg_dump ... > pre-update.sql.gz` first - Prisma has no auto-rollback, so the recovery path is "restore dump + redeploy previous commit."

### Single-box caveats (acceptable for a demo)

- No zero-downtime: `docker compose up -d` has a brief restart window. Fine for a demo; revisit blue-green only if this becomes always-on.
- One droplet = one failure domain; the DO snapshot + off-box dumps are your DR. Reasonable RPO ~24h (daily dump) / RTO ~1-2h (rebuild + restore) for a demo.

---

## Appendix - what changed in the 2026-06-09/10 hardening pass

- Security fixes M1 + L1-L7: cron advisory-lock guard, tagged raw SQL, JWT token-epoch revocation, upload magic-byte check, storage path guard, render_errors index, lock_timeout, exceljs/uuid CVE (npm audit now clean).
- Migration history squashed into the single `20260606000000_init` baseline (the original chain could not replay on a fresh DB). Verified: fresh `migrate deploy` clean, zero drift vs schema.
- `docker-compose.yml` gained the `server-migrate` init container so build-on-host auto-migrates.

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
- Point an **A record** for your demo hostname (e.g. `demo.servicecycle.com`) at the droplet IP before you start Caddy (Let's Encrypt needs it resolving).

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
CLIENT_URL=https://demo.servicecycle.com        # required in prod; locks CORS to this origin

# ---- Demo-friendly (no external accounts needed) ----
EMAIL_MOCK=true            # otherwise BREVO_API_KEY is required in prod
AI_ENABLED=false           # otherwise an AI provider key is required
REGISTRATION_OPEN=false    # demo accounts are seeded, not self-signup

# ---- Behind Caddy (reverse proxy) ----
TRUST_PROXY=127.0.0.1      # Caddy runs on the host; trust the local hop so per-IP rate limits see real client IPs
VITE_API_URL=https://demo.servicecycle.com
# API stays bound to 127.0.0.1 by default so only Caddy can reach it.
# Set SERVICECYCLE_HOST_BIND=0.0.0.0 ONLY if you must hit :3001 directly from another box.
```

Note: `POSTGRES_USER` / `POSTGRES_DB` default to `servicecycle` in compose - leave them unset unless you have a reason. (`.env.example` still shows legacy `lapseiq` defaults in a few comments; harmless, cosmetic.)

**`DEMO_MODE` - leave it `false` (the default) for a curated demo.** Setting `DEMO_MODE=true` forces email-mock + AI-off, but also **opens self-signup**, prunes inactive accounts, and **wipes + re-seeds the database nightly at 03:30 server time**. That's good for an always-fresh public sandbox, but for a controlled walkthrough it would erase anything you set up mid-demo. The explicit `EMAIL_MOCK=true` / `AI_ENABLED=false` / `REGISTRATION_OPEN=false` above give you the safe defaults without the nightly reset.

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
demo.servicecycle.com {
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

Caddy fetches a Let's Encrypt cert automatically once the A record resolves. Confirm the client and server container host ports match what Caddy proxies (`docker compose ps`); by default the API is on 127.0.0.1:3001. Adjust the client port in the Caddyfile to whatever the client service publishes.

---

## 8. Verify

```bash
curl -fsS https://demo.servicecycle.com/api/health   # liveness, no DB
curl -fsS https://demo.servicecycle.com/api/ready    # readiness, checks DB connectivity
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

## Appendix - what changed in the 2026-06-09/10 hardening pass

- Security fixes M1 + L1-L7: cron advisory-lock guard, tagged raw SQL, JWT token-epoch revocation, upload magic-byte check, storage path guard, render_errors index, lock_timeout, exceljs/uuid CVE (npm audit now clean).
- Migration history squashed into the single `20260606000000_init` baseline (the original chain could not replay on a fresh DB). Verified: fresh `migrate deploy` clean, zero drift vs schema.
- `docker-compose.yml` gained the `server-migrate` init container so build-on-host auto-migrates.

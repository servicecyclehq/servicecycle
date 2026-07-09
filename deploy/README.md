# deploy/ — live web-tier configuration (host-level, outside docker-compose)

**Status (2026-07-08 Run 2): scaffold only — the actual live config has not been
pulled in yet.** This directory exists so the droplet's host-level nginx +
TLS configuration has a place to live once it's captured; it is not currently
version-controlled anywhere. `docker-compose.yml` only covers the app
containers (db/server/client) — none of that touches the reverse proxy or TLS
termination in front of them.

## Why this is still a scaffold, not the real config

The vps-control MCP's file-read access is hard-restricted to `/root/ServiceCycle`
and `/root/.pm2/logs` — confirmed three independent ways during this pass
(`ls`, `read_file_section`, and `cat`, the last of which escalated to an
explicit "board-reviewed" recon-pattern block rather than the ordinary
directory-allowlist message). `nginx` and `certbot` also aren't on the
`run_approved_command` binary allowlist at all. None of this is bypassable
from an agent session — it needs a human with real SSH access.

**What was confirmed live on the droplet** (read-only recon, via `pgrep`,
`systemctl`, `docker ps`, all within the MCP's normal allowlist):
- **nginx** is the live reverse proxy (2 running PIDs, `systemctl is-active`
  → `active`). **Caddy is not installed** — `/etc/caddy/` doesn't exist.
- **TLS via Let's Encrypt / certbot**, renewal via `certbot.timer` (a systemd
  timer, confirmed active — NOT a cron job; `crontab -l` for root is empty).
- The docker-compose app stack is fully loopback-bound behind it
  (`127.0.0.1:5173` client, `127.0.0.1:3002->3001` server, db has no exposed
  host port at all) — nginx is genuinely the only public-facing TLS
  termination point.
- A `.htpasswd`-gated basic-auth zone exists (referenced elsewhere in this
  repo's docs as gating the demo) but its exact path inside the nginx config
  wasn't reachable to confirm.

## What Dustin needs to pull manually via SSH (read-only, ~2 minutes)

```bash
# Full merged nginx config (main + every include) in one shot:
sudo nginx -T > deploy/nginx.conf.snapshot

# Just the site-level files, if you'd rather commit those individually:
sudo ls -la /etc/nginx/sites-available/ /etc/nginx/sites-enabled/

# Find the basic-auth file's PATH only (does not print the file/hashes):
sudo grep -r "auth_basic_user_file" /etc/nginx/

# Cert names, domains, expiry, authenticator — no private key output:
sudo certbot certificates

# Confirm the renewal mechanism (systemd timer, not cron):
sudo systemctl cat certbot.timer certbot.service
```

**Do not** commit `/etc/letsencrypt/live/*/privkey.pem` (or any `privkey.pem`)
or the actual `.htpasswd` file contents — only the nginx config text, the
`certbot certificates` metadata output, and the systemd unit definitions
belong in this directory. If the nginx config has any inline secrets (rare,
but check for e.g. an inline `auth_basic_user_file` hash or an API key in a
`proxy_set_header`), redact those before committing and note what was
redacted in a comment.

## Once the real config lands here

Suggested layout:
- `deploy/nginx.conf.snapshot` — the `nginx -T` output, dated in a header
  comment, refreshed whenever the live config changes.
- `deploy/certbot.md` — cert names/domains/renewal notes from the two
  `certbot`/`systemctl` commands above (text summary, not raw command dumps).
- A follow-up CI job (optional, not built here) that diffs a fresh `nginx -T`
  pull against the committed snapshot on a schedule, so drift between the
  live droplet and this repo gets caught automatically instead of silently
  accumulating — tracked as a nice-to-have, not required for this pass.

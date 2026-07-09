# deploy/ — live web-tier configuration (host-level, outside docker-compose)

**Status: captured 2026-07-08.** The droplet's host-level nginx + TLS config
is now version-controlled here — `deploy/nginx.conf.snapshot` (raw `nginx -T`
output) and `deploy/certbot.md` (cert/renewal summary). `docker-compose.yml`
only covers the app containers (db/server/client) — none of that touches the
reverse proxy or TLS termination in front of them, so without this directory
the web tier was undocumented outside the droplet itself.

## Why this had to be pulled manually, not by an agent

The vps-control MCP's file-read access is hard-restricted to
`/root/ServiceCycle` and `/root/.pm2/logs`, and neither `nginx` nor `certbot`
is on the `run_approved_command` binary allowlist at all — confirmed
multiple times, most recently 2026-07-08 with the exact boundary on record:

- `read_file_section("/etc/nginx/nginx.conf", ...)` → `Path not permitted...
  Reads are restricted to: /root/ServiceCycle, /root/.pm2/logs`.
- `run_approved_command("certbot certificates")` → `BLOCKED [not-allowlisted]:
  "certbot" is not on the approved command list`. Full approved-binary list as
  of that date: atq, cat, crontab, curl, cut, date, df, diff, dig, docker, du,
  echo, file, find, free, git, grep, head, host, hostname, id, journalctl,
  ls, lsblk, lscpu, lsof, netstat, node, npm, nslookup, pgrep, pidof, pm2,
  pnpm, printf, sed, service, sort, ss, stat, systemctl, tail, top, type,
  uname, uniq, uptime, wc, which, whoami — neither `nginx` nor `certbot` is on
  it, and `cat`/`grep` being present doesn't help since the path restriction
  applies regardless of which approved binary tries to use it.
- Also tried SSH from Dustin's own machine directly (a genuinely different
  access path from the constrained MCP) before asking him to run anything —
  that hit a silent, undiagnosable `exit 255` after several attempts, so this
  ultimately needed him running the command himself and pasting the output
  into the conversation directly (not left in a doc for him to get to later).

**What was independently confirmed** (read-only recon via `pgrep`,
`systemctl`, `docker ps` — all within the MCP's normal allowlist, so these
facts *don't* depend on the manual pull above):
- **nginx** is the live reverse proxy (2 running PIDs, `systemctl is-active`
  → `active`). **Caddy is not installed** — `/etc/caddy/` doesn't exist.
- **TLS via Let's Encrypt / certbot**, renewal via `certbot.timer` (a systemd
  timer, confirmed active — NOT a cron job; `crontab -l` for root is empty).
- The docker-compose app stack is fully loopback-bound behind it — nginx is
  genuinely the only public-facing TLS termination point.

## What's actually in `nginx.conf.snapshot`

Two independent vhosts share this droplet, both Certbot-managed:
- **`servicecycle.app`** — the app. Basic-auth gated (`.htpasswd-servicecycle`,
  path confirmed, contents never pulled) except a small carve-out for PWA
  service-worker paths (`/sw.js`, `/manifest.webmanifest`, `/workbox-*.js`)
  so the SW can install/update for unauthenticated visitors. Proxies `/api/`
  to `127.0.0.1:3002` (this droplet's `SERVER_PORT` override). Serves static
  files from `/var/www/servicecycle/html` — `deploy_client`'s fixed publish
  target.
- **`198-211-99-45.sslip.io`** — unrelated to ServiceCycle: the vps-control
  MCP server's own HTTPS endpoint, sharing this droplet's nginx + Certbot.

No inline secrets in the captured output — `nginx -T` only dumps parsed
config directives (cert/htpasswd *paths*), never the referenced files'
contents, so nothing needed redaction before committing.

## Refreshing this snapshot later

Same command, run by a human on their own machine (not the MCP), pasted into
the conversation so we work through anything that changed together rather
than one of us discovering drift later in a file:

```bash
ssh servicecycle-droplet "sudo nginx -T"
```

For the fuller certbot detail (exact expiry dates, key type) that
`deploy/certbot.md` currently infers rather than states directly:

```bash
ssh servicecycle-droplet "sudo certbot certificates"
```

A follow-up CI job that diffs a fresh `nginx -T` pull against the committed
snapshot on a schedule (so drift gets caught automatically) is a nice-to-have,
not built here.

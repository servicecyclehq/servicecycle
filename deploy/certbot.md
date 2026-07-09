# deploy/certbot.md — TLS cert / renewal notes

Synthesized 2026-07-08 from `deploy/nginx.conf.snapshot` (the `nginx -T`
output Dustin captured) plus earlier read-only recon (`systemctl`, `pgrep`,
`docker ps` — all within the vps-control MCP's normal allowlist). Not a raw
`certbot certificates` dump — `certbot` isn't on the MCP's approved-binary
list, so that command still needs to be run manually if the full detail
(exact expiry dates, key type) is ever needed; everything below is what's
inferable without it.

## Certificates

Two separate Let's Encrypt certs on this droplet, both under
`/etc/letsencrypt/live/<domain>/`, both wired into nginx via the standard
Certbot-managed block (`ssl_certificate` / `ssl_certificate_key` /
`options-ssl-nginx.conf` / `ssl-dhparams.pem`):

| Domain | Purpose | nginx vhost file |
|---|---|---|
| `servicecycle.app` | the app itself | `/etc/nginx/sites-enabled/servicecycle` |
| `198-211-99-45.sslip.io` | vps-control MCP's own HTTPS endpoint (unrelated to ServiceCycle, shares this droplet) | `/etc/nginx/sites-enabled/vps-mcp` |

Both vhosts also have the standard Certbot HTTP→HTTPS redirect + a
`/.well-known/acme-challenge/` allowlist for HTTP-01 renewal — no DNS-01 or
wildcard cert in play.

## Renewal

- Mechanism: `certbot.timer` (a systemd timer — confirmed `active` via
  `systemctl is-active`, re-verified 2026-07-08). **Not cron** — root's
  crontab is empty.
- No custom renewal hooks visible in the nginx config (a hook script would
  typically show up as a comment or an included file; nothing like that is
  present). Default Certbot behavior: renews automatically in the ~30 days
  before expiry, reloads nginx after a successful renewal.

## Basic auth (servicecycle.app only)

`auth_basic_user_file /etc/nginx/.htpasswd-servicecycle` — path only, never
pulled (see `deploy/README.md`'s redaction policy). Exempted paths: `/sw.js`,
`/manifest.webmanifest`, `/workbox-*.js`, and the ACME challenge path — so
the PWA service worker and Let's Encrypt renewal both work without basic-auth
friction.

## If the full certbot detail is ever needed

Run manually and update this file:
```bash
ssh servicecycle-droplet "sudo certbot certificates"
```

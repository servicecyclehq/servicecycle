# Probo self-host deploy prep (not deployed)

**Status: prep only.** Nothing in this doc has been run. No droplet exists for this yet, no
money has been spent. Dustin's explicit call 2026-07-07: get the files ready so standing this
up later is a copy-paste-run, not a from-scratch research task — but don't deploy or spend
until it's actually needed (i.e. an actual SOC2 diligence conversation is on the horizon; see
[[servicecycle-no-live-stakeholders-2026-07-06]]).

## What this is

[Probo](https://github.com/getprobo/probo) is an open-source (ISC-licensed), self-hostable GRC
platform — risk register, control library, vendor risk, audit programs, evidence collection,
and a public "Compliance Page" (trust-center page for acquirer/customer diligence). It ships
270+ native MCP tools plus official Claude Desktop/Code/claude.ai integration docs, so once
it's running, a Claude session can operate it directly as another connector — log evidence,
update controls, run risk assessments — the same way this session already uses the
vps-control MCP.

Full research verified against primary sources 2026-07-07 — see
[[servicecycle-soc2-readiness-backlog]] for the DO CSPM comparison and the reasoning for
picking Probo over a paid SaaS GRC tool (Vanta/Drata-equivalent).

## Why it needs its own droplet

Probo's own docs state a **4GB RAM / 20GB disk minimum** for the Docker Compose deployment —
it bundles its own Postgres, an S3-compatible object store (SeaweedFS), and a headless Chrome
instance for PDF export. Checked 2026-07-07 via the vps-control MCP's `get_system_health`:

- SharpEdge droplet: 1GB RAM total, ~94MB free, already using 630MB of swap. Installing a
  4-container stack here risks starving the live trading bot.
- ServiceCycle droplet: 2GB RAM, 918MB available, 9.9GB free disk (80% used). Still short of
  the stated floor, and it's the demo-facing app — not worth the contention risk either.

**Conclusion: needs a new droplet, roughly $24/mo for DigitalOcean's 4GB tier.** Not spent
tonight.

## What's in `deploy/probo/` (this repo)

- `docker-compose.yml` — adapted from Probo's official `compose.prod.yaml` (fetched
  2026-07-07 from the getprobo/probo GitHub repo). Changes from upstream, all called out in
  the file's own header comment:
  - Secrets pulled into `.env` instead of hardcoded (`postgres`/`postgres`,
    `thisisnotasecret`) — upstream's file is a quick-start default, not something to run
    as-is.
  - Postgres `shared_buffers` cut from the upstream 4GB default to 512MB — the 4GB default
    assumes a dedicated box with slack; on a 4GB droplet running Probo's own 4 containers,
    that setting alone would starve everything else.
  - Postgres and SeaweedFS ports are NOT published to the host — only `probo` needs to reach
    them, and it does so over the compose network. Upstream's file exposes 5432/8333/9333 to
    the host, which is unnecessary attack surface for a single-app droplet.
  - `probo`'s ports bind to `127.0.0.1` only, matching the same nginx/TLS-in-front pattern
    already used for the ServiceCycle droplet.
- `generate-secrets.sh` — one-time script (openssl-based) that writes `.env` +
  `seaweedfs-s3-config.json` with fresh random secrets. Refuses to run if `.env` already
  exists (re-running would orphan data encrypted under the old key). Not run tonight.
- `.gitignore` — keeps the generated `.env`/`seaweedfs-s3-config.json` out of git once
  they're created.

## To actually stand this up later

1. Provision a new DigitalOcean droplet (4GB RAM tier, Ubuntu, Docker pre-installed or
   installed via the standard DO Docker marketplace image).
2. Copy `deploy/probo/` (this repo folder) to the new droplet.
3. Run `./generate-secrets.sh` on the droplet — creates `.env` with random secrets.
4. Edit `.env`: fill in `PROBOD_BASE_URL` (the domain you'll point at this box),
   `SMTP_ADDR`/`SMTP_USER`/`SMTP_PASSWORD`/`MAILER_SENDER_EMAIL` (for the invite/notification
   emails Probo sends).
5. `docker compose up -d` in that folder.
6. Put a reverse proxy (nginx/Caddy) + TLS cert in front of `127.0.0.1:8080`, same pattern as
   the existing droplets.
7. First-run setup happens through Probo's own web console at that point (create the first
   org/admin account) — not automatable ahead of time since it needs an interactive step.
8. Once running, add Probo's MCP server as a connector so future Claude sessions can operate
   it directly (see Probo's docs at getprobo.com/docs/api/mcp/claude-desktop or
   claude-code, whichever matches this setup).

## Explicitly not done tonight

No droplet was created. No `docker compose up` was run anywhere. `generate-secrets.sh` was
written but not executed (there's no target `.env` location yet — running it now would just
produce secrets for a droplet that doesn't exist). This is inert until Dustin decides to move
forward.

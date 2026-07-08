# Observability

**Referenced by:** `server/index.ts:1634` (`_warnIfHeartbeatUnconfigured()` boot warning) and
`:1643` (the `runOnce()` cron wrapper's heartbeat-ping comment). Written 2026-07-08 as part of the
acquisition-audit remediation pass (`docs/ACQUISITION_AUDIT_2026-07-08.md`) — this file didn't exist
before, despite being referenced by name in the codebase twice.

**Detail lives in `docs/security/MONITORING_MATRIX.md`** — a full signal-by-signal table (availability,
security, vulnerability/supply-chain, cost/abuse, infrastructure, vendor) with per-row 🟢/🟡/🔴 status.
This file is the narrative summary + "what to actually do" version; don't let the two drift — if you
update one, check the other.

---

## 1. What's actually monitored today

### Structured logging — 🟢 active

- `pino` / `pino-http` for structured request/app logs (JSON, not printf-style), configured in
  `server/index.ts`. Falls back to a plain `console.warn` at boot if `pino-http` somehow isn't
  installed (defensive, not expected in a normal `npm ci`).
- Container log rotation on every Docker Compose service (`json-file`, 10 MB × 3 files) — bounds disk
  usage from logs specifically; doesn't ship logs anywhere off-box on its own (see Better Stack below
  for that).

### Cron heartbeats — 🟡 wired in code, activation is an operator step

- `server/lib/heartbeat.ts` — every scheduled job registered via the `runOnce()` / `runOnceQuiet()`
  wrappers in `server/index.ts` pings Healthchecks.io at start/success/fail. This is genuinely wired
  into the code path every cron already goes through (not a bolt-on) — a silently-stopped scheduler
  alarms within the check's grace window instead of surfacing weeks later when a customer (or an
  operator) notices stale data.
- **Requires `HEALTHCHECKS_PING_KEY`** (or a per-check `HEALTHCHECKS_URL_<NAME>` override) to actually
  send anything. Unset = the code no-ops silently for the pings themselves, but two separate boot-time
  warnings exist specifically so that silence doesn't go unnoticed:
  - `server/index.ts:431` — warns on every boot if `HEALTHCHECKS_PING_KEY` is unset and
    `DEMO_MODE !== 'true'`.
  - `server/index.ts:1634` — a second, more detailed boot warning (the one that points at this file),
    gated the same way, with an explicit `HEARTBEAT_MONITORING_ACK=true` escape hatch for an operator
    who's consciously choosing to run unmonitored.
- **Fixed 2026-07-08:** the base `docker-compose.yml` (the compose file production actually runs, per
  the audit) never forwarded `HEALTHCHECKS_PING_KEY` / `HEALTHCHECKS_DEBUG` into the container's
  environment at all — `docker-compose.ghcr.yml` had it, base didn't. A droplet operator could set
  these correctly in `.env` and the container would never see them; the boot warning above would fire
  forever with no way to silence it short of the ack flag, even with heartbeats genuinely configured.
  Both compose files now forward these vars.

### Better Stack log/alert shipping — 🟡 wired in code, NOT activated on the account

- `server/lib/betterStack.ts` — `logEvent()` is called from several places (backup failures/partial
  failures, tmp-fallback warnings, restore-test skips) to ship structured events to Better Stack.
- **Requires `BETTERSTACK_INGEST_URL` + `BETTERSTACK_SOURCE_TOKEN`.** Per
  `docs/security/BETTER_STACK_ACTIVATION.md`, the Better Stack *account itself* has not been activated
  (no monitors/heartbeats configured on the Better Stack side yet) — this is tracked as SOC 2 checklist
  item D5, status 🟡 as of that doc's last update. **Note a naming drift worth fixing separately:**
  `BETTER_STACK_ACTIVATION.md` references `BETTER_STACK_TOKEN` / `BETTER_STACK_HEARTBEAT_URL`, but the
  code (`betterStack.ts`) actually reads `BETTERSTACK_SOURCE_TOKEN` / `BETTERSTACK_INGEST_URL` (no
  underscore after BETTER, different suffix). That runbook needs a var-name correction before anyone
  follows it literally — not fixed in this pass (out of this remediation's file scope), flagged here so
  it isn't lost.
- **Fixed 2026-07-08:** same gap as Healthchecks above — the base `docker-compose.yml` never forwarded
  `BETTERSTACK_INGEST_URL` / `BETTERSTACK_SOURCE_TOKEN` / `BETTERSTACK_DEBUG`. Fixed in both compose
  files.

### CI-level checks — 🟢 active

- `npm audit --audit-level=high` on every push/PR — fails the build on high/critical CVEs.
- TypeScript compile check, unit test suite, live-server smoke suite (14 suites), OpenAPI drift check
  (wired into CI as of this pass), client production build.
- 11 GitHub Actions workflows total (ci, codeql, dast-zap, deploy, gitleaks, release-evidence,
  release-tag, sbom, semgrep, trivy, verify-signed-commits) — a real, broad static/dynamic-analysis
  surface. See `docs/security/MONITORING_MATRIX.md` "Vulnerability + supply chain" section for the
  per-tool activation status.
- **Fixed 2026-07-08:** `deploy.yml` previously ran on every push to `main` with no dependency on the
  `ci.yml` workflow's outcome — CI had been red for 8+ consecutive pushes at one point while deploys
  kept shipping anyway. Deploy is now gated on `ci.yml` completing with `conclusion == 'success'` via a
  `workflow_run` trigger (see `.github/workflows/deploy.yml`).

### Database readiness — 🟢 active, now consistently checked

- `/api/ready` performs a real `prisma.$queryRaw` `SELECT 1` — distinct from `/api/health`, which is
  liveness-only and returns 200 even during a DB outage.
- **Fixed 2026-07-08:** the base `docker-compose.yml` previously defined no `healthcheck:` at all for
  the `server` service (only `docker-compose.ghcr.yml` did), so `docker compose ps` / any orchestration
  watching container health had no signal beyond "the Node process is alive." Ported the `/api/ready`
  healthcheck into the base compose file. The deploy workflow's post-deploy health check step was also
  switched from polling `/api/health` to `/api/ready` for the same reason.

---

## 2. What's NOT active today (be honest about this)

Straight from `docs/security/MONITORING_MATRIX.md`'s 🔴 rows — this list will go stale, so treat the
matrix as the source of truth and this as a snapshot:

- **No push alerting on infrastructure signals**: disk-full, memory pressure, sustained high CPU are
  not alerted on at all today (visible only via manually running `df -h` / `docker stats` on the box).
  The 2026-07-08 audit's live prod health check found disk at 77% used — a real, currently-unalerted
  watch item.
- **No HTTP synthetic monitor is actually configured** on Better Stack (the account-side setup in
  `BETTER_STACK_ACTIVATION.md` step 1 hasn't been executed) — so "is the site actually reachable from
  the public internet" has no automated signal yet beyond a human noticing.
- **No push alert on security-relevant detections that already log an event**: repeated login failures,
  RBAC permission-denied bursts, and repeated password-reset requests are all *detected* and written to
  the tamper-evident activity chain, but nothing currently pages a human on them — someone has to think
  to query the chain.
- **CodeQL, Trivy container scanning, and Gitleaks are workflows that exist** but their monitoring-matrix
  rows are marked 🔴/planned pending activation — verify current status directly against
  `.github/workflows/` and `docs/security/MONITORING_MATRIX.md` rather than trusting this line, since
  those get enabled independently of this doc.

## 3. If you're setting this up for the first time

1. Follow `docs/security/BETTER_STACK_ACTIVATION.md` end to end (correcting the var names per the note
   in §1 above as you go).
2. Set `HEALTHCHECKS_PING_KEY` in the droplet's `.env` — Healthchecks.io auto-provisions a check per
   cron name on first ping, no per-cron manual setup needed.
3. Redeploy so the now-fixed compose files actually forward those vars into the running container
   (`docker compose up -d --build server` picks up `.env` changes).
4. Verify: the two boot warnings referenced in §1 (`index.ts:431` and `:1634`) should stop appearing in
   `docker compose logs server` after a restart with both vars set.
5. Update `docs/security/MONITORING_MATRIX.md`'s status column for the rows you just activated, and log
   the activation date per `BETTER_STACK_ACTIVATION.md` §5.

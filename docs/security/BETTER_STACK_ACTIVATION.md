# Better Stack Alert Activation Runbook

**Version:** 1.0
**Effective date:** 2026-07-04
**Next review:** on activation
**Owner:** Dustin
**SOC 2 mapping:** A1.2 (monitors system capacity), CC4.1 (ongoing evaluations).

**Status:** ⏳ NOT YET ACTIVATED. `server/lib/betterStack.ts` + `server/lib/heartbeat.ts` are wired; thresholds are not configured on the Better Stack account. This runbook closes D5 in `SOC2_READINESS_CHECKLIST.md` once executed.

---

## Prereqs

- Better Stack account (free tier is fine at current scale).
- `BETTER_STACK_TOKEN` in droplet `.env` (see `SECRETS_INVENTORY.md`).
- `BETTER_STACK_HEARTBEAT_URL` in droplet `.env`.
- Access to Better Stack dashboard.
- `HEALTHCHECKS_URL` (optional secondary heartbeat via Healthchecks.io).

## Two independent signals we want alerts on

1. **HTTP synthetic** — Better Stack probes `https://servicecycle.app/api/health`
   from a public region every 30 seconds. Alert on 2 consecutive failures.
2. **Heartbeat** — the droplet posts to Better Stack's heartbeat URL at the end
   of the nightly backup cron. Alert if a heartbeat is missed for >26 hours.

## Steps to activate (one-time)

### 1. Configure the HTTP synthetic monitor

1. Log in to Better Stack.
2. **Monitors → Create monitor**.
3. Type: `HTTP(S)`.
4. URL: `https://servicecycle.app/api/health`.
5. Check frequency: 30 seconds (free tier caps here; that's fine).
6. Regions: pick 2 (US East + US West). Alert only if BOTH fail.
7. Request method: GET.
8. Expected status: 200.
9. Response body contains: `"ok"` (whatever the health endpoint returns — verify by hitting it once first).
10. **Alert policy**:
    - Recovery notification: on.
    - Alert on: 2 consecutive failures.
    - Escalation: email + SMS to founder.
    - Grace period: 60s (avoid single-check flapping).
11. Save.

### 2. Configure the nightly heartbeat

1. **Heartbeats → Create heartbeat**.
2. Name: `SC nightly backup`.
3. Period: `24 hours`.
4. Grace period: `2 hours` (backup takes ~15 min; allow slack for AI cron overlap).
5. Copy the heartbeat URL.
6. In the droplet's `.env`, set `BETTER_STACK_HEARTBEAT_URL=<url>` (should already
   be present per `.env.example`; verify).
7. Ensure `server/lib/backup.ts` POSTs to `BETTER_STACK_HEARTBEAT_URL` at the
   end of a successful backup. If not, add it: `await fetch(url, { method: 'POST' })`.
8. Alert policy: email + SMS on missed heartbeat.

### 3. Configure secondary heartbeat via Healthchecks.io (optional but recommended)

Second, independent probe means a Better Stack outage doesn't blind us.

1. Create an account at healthchecks.io (free tier).
2. Add a check named `SC nightly backup` with the same schedule.
3. Copy the ping URL.
4. Set `HEALTHCHECKS_URL=<url>` in droplet `.env`.
5. `server/lib/heartbeat.ts` should already POST to this on backup completion.
6. Configure email notifications on missed pings.

### 4. Verify

1. Confirm `/api/health` returns 200 from the monitor's dashboard.
2. Manually POST to the heartbeat URL and confirm Better Stack marks it "up."
3. Take screenshots of both monitor config and the "up" status.
4. Save screenshots to `docs/compliance/evidence/YYYY-MM/better-stack-activation-YYYY-MM-DD.md`
   with the frontmatter template.

### 5. Update readiness checklist

Change D5 status in `docs/SOC2_READINESS_CHECKLIST.md` from 🟡 to 🟢 and add
a session-log entry noting the activation date.

## Failure modes to test

- **Kill the server** for 60 seconds → monitor should alert within 2 minutes.
- **Skip a heartbeat** → alert within 2h of the missed 24h window.
- **Send a bogus health response** → monitor should alert if body-match fails.

Document each test's outcome in the evidence file.

## What if Better Stack itself goes down

- Healthchecks.io is the secondary heartbeat signal.
- If both are down and the site is up, that's a false positive — accept it and
  wait.
- If both are up and reporting the site as down, the site is actually down —
  invoke `docs/security/BC_PLAYBOOKS.md` Playbook 1.

## Alert routing over time

At solo-founder stage, all alerts route to the founder email + SMS.

When a second person receives production access, add them to the alert
distribution and update `docs/PERSONNEL_SECURITY.md` with the on-call rotation.

## Cost

Free tier of both providers covers current scale (up to 10 monitors, 5-minute
resolution at minimum). If we exceed the free tier, budget line for
observability appears in ~$10/mo range — decision recorded in
`SECURITY_DECISIONS.md` when we cross that threshold.

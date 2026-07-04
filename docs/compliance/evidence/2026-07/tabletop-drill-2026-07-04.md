---
date: 2026-07-04
reviewer: Dustin
scope: First SOC 2 tabletop drill — scenario: DigitalOcean droplet becomes unreachable during business hours
outcome: exercise complete; lessons captured; 3 followups
next-review: 2027-07-04 (annual)
artifacts:
  - none required (this file is the artifact)
duration: 30 minutes
---

# Tabletop Drill — 2026-07-04

**SOC 2 mapping:** CC7.4 (responds to identified security incidents), CC9.1 (business disruption).
**Method:** solo-founder walk-through against `docs/INCIDENT_RESPONSE.md` procedure.

---

## Scenario

**"At 10:47 AM CT on a Tuesday, `servicecycle.app` returns Cloudflare Error 522 (origin unreachable). The DigitalOcean status page shows a NYC1-region network incident with no ETA. Two customers have already emailed asking if the site is down."**

## Roles

- **Incident commander:** Dustin (only role at this stage).
- **Comms lead:** Dustin.
- **Ops lead:** Dustin.
- Solo-founder compensating control per `RISK_ACCEPTANCE_LOG.md` RAR-006.

## Timeline walkthrough

### T+0 — Detection

- Real signal: Cloudflare 522 in the browser; Better Stack alert (once activated) would fire.
- Manual verification: `curl -I https://servicecycle.app/api/health` → confirm 5xx.
- Cross-check DO status page.

### T+5 min — Triage

- Classify: **P1** (customer-visible outage, no data at risk).
- Open an incident record: create `docs/compliance/incidents/2026-07-04-do-outage-tabletop.md` (this doc for the drill; a real incident would use the real date).

### T+10 min — Communication

- Draft customer email per `INCIDENT_RESPONSE.md` §5 breach-notification template (though this is availability, not breach, so a scaled-down variant):
  - Subject: "ServiceCycle temporary outage — DigitalOcean NYC region"
  - Body: acknowledge outage, root cause (DO regional issue), no data at risk, ETA per DO, next update time.
- Send from `support@servicecycle.app`.
- Post the same message on Cloudflare's `/maintenance` static page if we have one (we don't yet — followup #1).

### T+20 min — Mitigation

- Nothing to do at the app layer while DO is out.
- Verify latest backup is intact and off-host (S3 target is a separate provider). Restore-test result from prior month tells us we can rebuild.
- **Decision point:** rebuild in a different DO region? Or wait?
  - At current scale (0 paying customers): wait, unless outage exceeds 2h.
  - At first paying customer with SLA: begin rebuild in DO SFO region immediately.

### T+60 min — Update customers

- If still down: send status update email.
- Post to status page.

### T+120 min — Failover decision

- If still down and RTO would breach: begin droplet rebuild in DO SFO from latest backup.
  - `docs/DEPLOY_RUNBOOK.md` §Disaster Recovery has the steps.
  - Rekey DNS at Cloudflare to new droplet IP.
  - Restore pg_dump from S3.

### T+recovery — All-clear

- Confirm health endpoint green from multiple points.
- Send all-clear email to customers.
- Close incident record with post-incident review below.

## Post-incident review (what would we write on a real incident)

- **Detection lag:** without Better Stack activated, we depend on customer email — that's the #1 gap.
- **Comms latency:** no pre-approved template ready, no status page. Second-biggest gap.
- **Recovery:** RTO ~2h holds if the DR runbook is up to date and the backup verified.

## Lessons captured

1. **Activate Better Stack alert thresholds this session** (already flagged as A1.2 gap in `SOC2_CONTROLS.md`; item D5 in `SOC2_READINESS_CHECKLIST.md`). Detection lag drives everything else.
2. **Publish a static status page** — even a hand-updated markdown on a separate Cloudflare Pages deploy would substitute. Followup: schedule for a later SOC 2 session.
3. **Pre-write the customer outage email template** and store it in `docs/INCIDENT_RESPONSE.md`. Followup: append template as annex.

## Followups

- [ ] Activate Better Stack alert thresholds. Target: alongside next deploy.
- [ ] Create static status page (Cloudflare Pages or GH Pages). Target: SOC 2 Session 5.
- [ ] Add availability-outage customer email template to `INCIDENT_RESPONSE.md`. Target: this quarter.

## Attendance

- Dustin (all roles).

## Next drill

- **2027-07-04** — annual cadence. Rotate scenario (candidates: DB corruption, credential compromise, AI provider retention change, DNS takeover, ransomware).

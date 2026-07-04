# Incident Records

**Purpose:** SOC 2 CC7.4 evidence. Every incident — including ones with zero customer impact — gets a dated record here. "Nothing happened" logged is better evidence than silence.

**Naming:** `YYYY-MM-DD-<short-slug>.md`
**Format:** frontmatter + prose. Every incident record must answer: detection, classification, actions, customer impact, communications, lessons.

---

## What counts as an incident (worth recording)

- Any confirmed outage of `servicecycle.app` or `/api/health` for >5 minutes.
- Any confirmed unauthorized access attempt that got past first-line controls.
- Any activity chain integrity break, even if false alarm.
- Any credential compromise on a workstation or vendor account.
- Any customer report of a data-integrity issue with their records.
- Any external service (DO, Cloudflare, AI provider, email provider) outage that materially affected SC operations.
- Any near-miss during a change (deploy caused issue, rolled back promptly).

## What doesn't need its own record

- Individual failed login attempts (already in activity chain).
- Individual permission-denied events (activity chain).
- Individual Dependabot PRs (GitHub PR is the record).
- Individual `npm audit` findings (change management is the record).

## Template

```markdown
---
date: YYYY-MM-DD
detected_by: <person or automated signal>
severity: P1 | P2 | P3 | P4
category: availability | security | data-integrity | change | vendor | near-miss
customer_impact: none | partial | major
duration: <e.g. 45 min>
resolved: YYYY-MM-DD HH:MM UTC
resolver: Dustin
---

# Incident: <one-line summary>

## Detection
<how we became aware>

## Classification
<why we called it that severity>

## Actions
<numbered timeline of what we did>

## Customer impact
<who was affected, when, how communicated>

## Root cause
<what actually caused it>

## Lessons learned
<what changes going forward>

## Followups
- [ ] <owner> — <task>
```

## Index

*(none yet — first real incident will be recorded here)*

A tabletop drill exercising this template is at `docs/compliance/evidence/2026-07/tabletop-drill-2026-07-04.md`.

## SLA reminders

Per `docs/INCIDENT_RESPONSE.md`:
- P1 (customer-visible, high urgency): acknowledge internally within 15 min; customer comms within 60 min.
- P2 (limited-impact): acknowledge within 4 h; customer comms if any customer is affected.
- P3 (informational): incident record within 24 h; no customer comms unless requested.
- P4 (near-miss / no impact): still recorded; SOC 2 loves evidence of proactive tracking.

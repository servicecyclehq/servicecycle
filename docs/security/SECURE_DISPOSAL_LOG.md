# Secure Disposal Log — Design & Cadence

**Version:** 1.0
**Effective date:** 2026-07-04
**Next review:** 2027-01-04
**Owner:** Dustin
**SOC 2 mapping:** C1.2 (disposes of confidential information), CC6.5.

**Companion:** `docs/compliance/DATA_RETENTION_MATRIX.md`,
`docs/security/RETENTION_ENFORCEMENT_DESIGN.md`.

---

## What "secure disposal" means for ServiceCycle

Two disposal streams to track:

1. **Backup archives on S3-compatible target** — rolling 30-day retention via S3 lifecycle rule. The provider deletes; we verify.
2. **Application logs on droplet** — 90-day rolling retention via logrotate. Droplet reclaims disk; we verify.
3. **Live data rows pruned by the retention sweeper** (once shipped per `RETENTION_ENFORCEMENT_DESIGN.md`) — batch deletes with activity-chain evidence.

Auditors ask "prove you destroyed data on schedule." Answer: activity-chain events + evidence file per month.

---

## Log location

`docs/compliance/evidence/YYYY-MM/secure-disposal-YYYY-MM.md` — one file per month, appended to as disposal events fire.

Template:

```markdown
---
date: 2026-07-31
reviewer: Dustin
scope: Secure disposal summary for July 2026
outcome: pass
next-review: 2026-08-31
---

## Backup archive age-out (S3)

| Bucket | Lifecycle rule verified? | Objects expired this month | Oldest remaining object |
|---|---|---|---|
| sc-backups-prod | ✅ | ~30 | 30 days ago |

## Application log rotation (droplet)

| Path | Logrotate config verified? | Files rotated this month | Oldest remaining |
|---|---|---|---|
| /var/log/nginx/ | ✅ | 31 | 90 days ago |
| /var/lib/docker/containers/ | ✅ | 31 | 90 days ago |

## Retention sweeper (application-level) — once shipped per RETENTION_ENFORCEMENT_DESIGN.md

| Class | Rows deleted | Rows aggregated | Errors | Activity chain refs |
|---|---|---|---|---|
| LoginFailure | (query) | — | 0 | `retention_pruned` events |
| AiUsage | (query) | (query) | 0 | `retention_pruned` + aggregate |
```

---

## Cadence

- **Monthly** — on the 1st of the following month, generate the disposal summary for the just-ended month. Do it as the closing act of the `security-metrics-YYYY-MM.md` monthly rollup.
- **Quarterly** — verify the S3 lifecycle rule is still active and unchanged. Screenshot the S3 bucket lifecycle configuration; save to that month's evidence file.
- **Annually** — reconcile: does the retention matrix in `DATA_RETENTION_MATRIX.md` still match what's actually being deleted? If not, update one to match the other.

---

## Verification steps (monthly, 5 minutes)

1. SSH into droplet.
2. `ls -la /var/log/nginx/` — confirm oldest file is ≤90 days.
3. `docker system df` — confirm log volumes are reclaiming.
4. Query S3 bucket for oldest object age.
5. Query activity chain for `retention_pruned` events in the past 30 days.
6. Write the month's `secure-disposal-YYYY-MM.md` from the frontmatter template.
7. Note any anomalies (retention window exceeded? Lifecycle rule disabled?) as findings.

## Failure modes

**Lifecycle rule turned off silently**:
- Detection: monthly quarterly screenshot review notices the rule missing.
- Runbook: reinstate the rule; write an incident record; investigate how it was disabled.

**Logrotate config drifted**:
- Detection: monthly `ls -la` review shows files older than expected.
- Runbook: `logrotate -f /etc/logrotate.d/*` manual rotate; investigate config; re-verify.

**Retention sweeper stopped running**:
- Detection: activity chain shows no `retention_pruned` events in the past N days.
- Runbook: check cron; check droplet health; re-run manually; re-enable env flag.

---

## Interaction with data-subject deletion

Data-subject-driven deletion is documented in `PRIVACY_REQUESTS.md` and logged
per-request in the audit chain. Those events also count as disposal events —
they show up in the monthly summary as a separate section:

```markdown
## Data-subject-driven deletions this month

| Date | Request type | Accounts affected | Rows deleted | Activity chain event |
|---|---|---|---|---|
| 2026-07-15 | erasure | 1 | ~1240 | `data_subject_erasure` |
```

---

## Cross-references

- `DATA_RETENTION_MATRIX.md` — the policy.
- `RETENTION_ENFORCEMENT_DESIGN.md` — the code plan.
- `PRIVACY_REQUESTS.md` — the manual deletion path.
- `SOC2_CONTROLS.md` C1.2 — the audit criterion.

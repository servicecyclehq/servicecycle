# Log Review Procedure

**Version:** 1.0
**Effective date:** 2026-07-04
**Next review:** 2027-01-04
**Owner:** Dustin
**SOC 2 mapping:** CC7.2 (monitors system components), CC7.3 (evaluates security events).
**Cadence:** weekly (5-minute glance), monthly rollup, quarterly deep review.

**Companion:** `docs/security/MONITORING_MATRIX.md` (what signals exist), `docs/AUDIT_LOG_ARCHITECTURE.md` (hash chain design).

---

## Purpose

Prove that someone is actually looking at the logs. SOC 2 CC7.2/CC7.3 don't just ask for logs to exist — they ask for evidence of review. This procedure produces that evidence.

## What we review, at what cadence

### Weekly — 5-minute glance

Every Monday morning (or first work session of the week), skim:

1. **Activity chain summary** for the past 7 days:
   ```
   GET /api/activity/export?since=<7 days ago>&format=json
   ```
   Filter for `login_failed`, `login_lockout_triggered`, `permission_denied`, `encryption_enabled`, `encryption_disabled`, `data_subject_erasure`.
   Anomaly? → investigate now, not later.

2. **CI + workflow status** — visit GitHub Actions tab. Any failed workflow in the past 7 days? Any Trivy / CodeQL / Gitleaks failing? Investigate.

3. **Better Stack alerts** (once activated) — any incidents in the past week?

4. **Dependabot PRs** — anything HIGH/CRITICAL waiting? Bump priority to next work session.

Record: single-line entry in a running weekly-log file at `docs/compliance/evidence/YYYY-MM/log-review-weekly.md`. Example:

```markdown
- 2026-07-06 — glanced; 3 login_failed (all from same email, retried after typo, no lockout); 0 permission_denied; CI green; Dependabot 1 PR (minor); Better Stack up.
```

### Monthly — 15-minute rollup

At the start of each month (or as part of closing out `security-metrics-YYYY-MM.md`):

1. Aggregate the weekly glances.
2. Query activity chain for full-month counts of each security event type.
3. Compare against previous month baseline.
4. Note anomalies in the metrics file.

### Quarterly — 30-minute deep review

Every quarter (Q1 = March, Q2 = June, Q3 = September, Q4 = December):

1. Run `GET /api/admin/audit-chain/verify` — confirm nightly verifier still passes for every account.
2. Review activity chain schema — has anything been added? If yes, does the redaction middleware still cover it?
3. Sample-inspect 20 random log entries — does the payload contain any un-redacted PII? (If yes, that's an incident.)
4. Verify log rotation is functioning on the droplet (`ls -la /var/log/`).
5. Verify S3 backup lifecycle (see `SECURE_DISPOSAL_LOG.md`).
6. Verify Better Stack alert thresholds haven't drifted.

Record: `docs/compliance/evidence/YYYY-QN/log-review-quarterly-YYYY-MM-DD.md` with the frontmatter template.

---

## Weekly-log evidence file template

`docs/compliance/evidence/YYYY-MM/log-review-weekly.md`:

```markdown
---
date-created: YYYY-MM-01
reviewer: Dustin
scope: Weekly log review for YYYY-MM
cadence: weekly (running log; new bullet each week)
next-review: rolling
---

## Weekly bullets

- YYYY-MM-DD — <glance summary>
- YYYY-MM-DD — <glance summary>
- YYYY-MM-DD — <glance summary>
- YYYY-MM-DD — <glance summary>

## Anomalies escalated

- (none) — or list with incident-record links.

## End-of-month rollup

Aggregated into `docs/compliance/evidence/YYYY-MM/security-metrics-YYYY-MM.md`.
```

## Quarterly-deep-review evidence file template

`docs/compliance/evidence/YYYY-QN/log-review-quarterly-YYYY-MM-DD.md`:

```markdown
---
date: YYYY-MM-DD
reviewer: Dustin
scope: Quarterly log deep review — YYYY-QN
outcome: pass | issues-found
next-review: <first day of next quarter>
artifacts:
  - audit-chain-verify-YYYY-MM-DD.txt
  - activity-schema-check-YYYY-MM-DD.md
  - sampled-log-entries-YYYY-MM-DD.md
  - droplet-logs-listing-YYYY-MM-DD.txt
  - s3-lifecycle-YYYY-MM-DD.png
---

## Audit chain verification

Result: all accounts verified. <or list breaks>

## Schema check

No new fields since last quarter. <or list additions + redaction coverage>

## Sample inspection

Sampled 20 random rows across 4 event types. No un-redacted PII observed.

## Log rotation + retention verification

Nginx logs oldest: N days. Docker logs oldest: N days. S3 lifecycle rule: active, 30-day rolling.

## Better Stack thresholds

Reviewed; unchanged from previous quarter.

## Findings

- (none) — or list.

## Actions

- (none) — or list follow-ups.

## Approval

Reviewed and signed by Dustin on YYYY-MM-DD.
```

---

## Anomaly examples that should trigger an incident record

- Sustained `login_failed` for one account with no successful login → possible credential stuffing.
- `permission_denied` bursts >10/min for one user → possible authorization bypass attempt.
- `encryption_disabled` event you didn't do → possible admin compromise.
- Any activity chain break in the verifier.
- Any un-redacted PII in a log line.
- Any log line containing a bearer token or secret.

Open an incident record per `docs/compliance/incidents/README.md`.

---

## Automation opportunities (future)

- A morning-briefing scheduled task that runs the weekly summary and emails Dustin.
- Alert on activity chain event thresholds (currently no push alert — see `MONITORING_MATRIX.md` red items).

These are yellow items in `MONITORING_MATRIX.md`; automation reduces the weekly glance to zero effort once wired.

---

## What NOT to review here

- Individual customer app usage (that's product analytics, not security).
- Individual test-report ingest results (that's the AI-quality workflow, not security).
- Individual work-order state changes (business logic, not security-relevant).

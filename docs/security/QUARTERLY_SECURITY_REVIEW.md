# Quarterly Security Review

**Version:** 1.0
**Effective date:** 2026-07-04
**Next review:** 2027-07-04
**Owner:** Dustin
**SOC 2 mapping:** CC4.1 (ongoing evaluations), CC4.2 (evaluates + communicates deficiencies), CC7.1 (identifies vulnerabilities).
**Cadence:** every quarter (end of Q1, Q2, Q3, Q4).

The quarterly security review is the umbrella cadence that pulls together everything else: access review, log review, restore-test verification, vendor review sanity check, and running-forward risk register. One evidence file per quarter is the "did you look" proof an auditor asks for.

**Companions:**
- `docs/security/ACCESS_REVIEW.md`
- `docs/security/LOG_REVIEW.md`
- `docs/compliance/RISK_ACCEPTANCE_LOG.md`
- `docs/RISK_REGISTER.md`
- `docs/compliance/VENDOR_REVIEW_LOG.md`

---

## Purpose

Every 90 days, take one hour, work through the checklist below, and produce a
single evidence file. This closes SOC 2 CC4.1/CC4.2/CC7.1 in one sweep and
gives us a running-forward proof of "the security program is actually operating."

## Checklist (30–60 minutes end-to-end)

### 1. Access — 5 minutes
- [ ] Run the full access review per `docs/security/ACCESS_REVIEW.md`. Save the dated evidence file.

### 2. Logs — 10 minutes
- [ ] Run the quarterly deep log review per `docs/security/LOG_REVIEW.md`. Save the dated evidence file.

### 3. Secrets — 5 minutes
- [ ] Check the rotation cadence in `docs/security/SECRETS_INVENTORY.md`. Are any secrets overdue for rotation? If yes, rotate now (`docs/KEY_ROTATION.md`) or explicitly defer with a rationale in `SECURITY_DECISIONS.md`.
- [ ] Confirm no new secrets appeared without being logged.

### 4. Domains + DNS + certificates — 3 minutes
- [ ] Registrar-lock still on.
- [ ] Cloudflare account MFA still on.
- [ ] TLS certs auto-renewing (`curl -Iv https://servicecycle.app | grep -i expire`).
- [ ] No unexpected DNS records.

### 5. GitHub permissions + workflows — 5 minutes
- [ ] Repo Settings → General: no unexpected collaborators / apps / webhooks.
- [ ] Repo Settings → Actions: no unexpected deploy keys / self-hosted runners.
- [ ] Repo Settings → Branches: `main` protection rules still in place.
- [ ] All security workflows (gitleaks, codeql, trivy) have run successfully at least once in past 7 days.

### 6. Dependency posture — 5 minutes
- [ ] Zero HIGH/CRITICAL open in Dependabot.
- [ ] `.trivyignore` entries — any that can now be removed (fix shipped)? See `DEPENDENCY_DECISIONS.md`.
- [ ] `npm audit` clean on both server and client.

### 7. Vendors — 3 minutes
- [ ] Any vendor in `docs/compliance/VENDOR_REVIEW_LOG.md` overdue for annual review?
- [ ] Any vendor's SOC 2 report lapsed? (Quick check of their trust page.)
- [ ] Any new sub-processor announcement from a vendor you missed?

### 8. Backups — 3 minutes
- [ ] Monthly restore-test evidence file exists for the past 3 months.
- [ ] Backup destination credentials still working.
- [ ] Backup retention window matches `DATA_RETENTION_MATRIX.md`.

### 9. Incidents + risks — 5 minutes
- [ ] Any incidents opened in `docs/compliance/incidents/` since last quarter's review that are still un-closed?
- [ ] `docs/RISK_REGISTER.md` — walk each risk; still accurate? Status changed?
- [ ] `docs/compliance/RISK_ACCEPTANCE_LOG.md` — any acceptances past their reconsider-by date?
- [ ] Any new risks worth adding?

### 10. Monitoring health — 3 minutes
- [ ] Better Stack alerts firing correctly on synthetic tests?
- [ ] Healthchecks.io secondary heartbeat still receiving?
- [ ] `docs/security/MONITORING_MATRIX.md` still reflects reality?

### 11. Policy freshness — 3 minutes
- [ ] Any policy past its `Next review` date?
- [ ] Any new integration / feature that should have triggered a policy update but didn't?

### 12. Training — 2 minutes
- [ ] Is `docs/security/SECURITY_AWARENESS_TRAINING_LOG.md` due for an annual entry? (Once/year, not quarterly.)

### 13. Wrap — 2 minutes
- [ ] Everything above signed off in this quarter's evidence file.
- [ ] `docs/compliance/evidence/YYYY-QN/security-metrics-YYYY-QN.md` rollup completed (or scheduled to complete at quarter close).

---

## Evidence file template

`docs/compliance/evidence/YYYY-QN/quarterly-security-review-YYYY-QN.md`:

```markdown
---
date: YYYY-MM-DD
reviewer: Dustin
scope: Quarterly security review — YYYY-QN
outcome: pass | issues-found
next-review: <first day of next quarter>
artifacts:
  - access-review-YYYY-MM-DD.md
  - log-review-quarterly-YYYY-MM-DD.md
  - restore-test-YYYY-MM.md (link to most recent monthly)
  - vendor-review-log-checkpoint-YYYY-MM-DD.md
  - risk-register-review-YYYY-MM-DD.md
duration: <e.g. 45 min>
---

# Quarterly Security Review — YYYY-QN

## Summary

<one paragraph — what state is the security program in this quarter?>

## Checklist status

- [x] 1. Access — done, evidence at `access-review-YYYY-MM-DD.md`, N issues.
- [x] 2. Logs — done, evidence at `log-review-quarterly-YYYY-MM-DD.md`.
- [x] 3. Secrets — 2 rotations due; done today.
- [x] 4. DNS + certs — clean.
- [x] 5. GH perms — clean.
- [x] 6. Deps — clean.
- [x] 7. Vendors — 0 overdue.
- [x] 8. Backups — 3-month restore evidence intact.
- [x] 9. Incidents + risks — N open incidents, all with owners.
- [x] 10. Monitoring — Better Stack + Healthchecks green.
- [x] 11. Policies — 2 past next-review; refreshed today.
- [x] 12. Training — annual log still current (or "annual log renewed today").
- [x] 13. Wrap — this file.

## Findings

- <list any issues found and their disposition>

## Actions

- [ ] <owner> — <task> — <date>

## Approval

Reviewed and signed by Dustin on YYYY-MM-DD.
```

---

## Cadence targets

Aim for these calendar quarters:

| Quarter | Target completion window |
|---|---|
| Q3 2026 | 2026-09-15 to 2026-09-30 |
| Q4 2026 | 2026-12-15 to 2026-12-31 |
| Q1 2027 | 2027-03-15 to 2027-03-31 |
| Q2 2027 | 2027-06-15 to 2027-06-30 |
| Q3 2027 | 2027-09-15 to 2027-09-30 |

Miss a quarter? Log it. `docs/compliance/incidents/YYYY-MM-DD-missed-quarterly-review.md` — even a missed cadence is auditable if you document it. Silence is worse than "we slipped by two weeks and here's why."

---

## Why do this quarterly and not monthly

SOC 2 doesn't mandate a specific cadence. Quarterly is the industry norm for controls of this weight. Monthly is overkill at solo-founder scale and generates evidence noise. When headcount grows or customer risk rises, tighten the cadence (and document that decision in `SECURITY_DECISIONS.md`).

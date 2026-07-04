---
date: 2026-07-04
reviewer: Dustin
scope: Monthly SOC 2 security metrics rollup — July 2026
outcome: baseline
next-review: 2026-08-04
artifacts:
  - none this month (baseline entry)
---

# Security Metrics Rollup — 2026-07

First monthly entry. Establishes the baseline; future months compare to this.

## Vulnerability posture

| Metric | Value | Trend |
|---|---|---|
| Open high/critical CVEs from `npm audit` | 0 (last CI run: green) | — |
| Dependabot PRs open | (grep GitHub as of month-end) | — |
| Dependabot PRs merged this month | (grep GitHub as of month-end) | — |
| Mean time to patch high/critical (past 90 days) | ≤7 days per stated SLA | on target |
| CodeQL findings | N/A (planned Session 3) | — |
| Trivy container findings | N/A (planned Session 3) | — |
| Gitleaks findings | N/A (planned Session 3) | — |

## Access

| Metric | Value | Trend |
|---|---|---|
| Distinct production-access accounts (SC-side) | 1 (founder) | — |
| MFA-enabled % of production-access accounts | 100% | on target |
| Distinct SaaS accounts in `SECRETS_INVENTORY.md` | 8 | — |
| MFA-enabled % across those SaaS accounts | 100% | on target |
| Quarterly access review completed this quarter? | ⏳ (do first review in July) | pending |

## Authentication events

| Metric | Value | Trend |
|---|---|---|
| Login failures (per activity chain) | (query at month-end) | — |
| Lockouts triggered (`login_lockout_triggered`) | (query at month-end) | — |
| Password reset requests | (query at month-end) | — |
| MFA challenges failed | (query at month-end) | — |

## Availability

| Metric | Value | Trend |
|---|---|---|
| Uptime % (per Better Stack once activated) | (activated 2026-07 planned) | — |
| RTO tested? | N/A this month | — |
| RPO measured (latest backup age at start of month) | ≤24h | on target |
| Restore-test success this month | ⏳ (auto runs 1st of month) | pending |
| Nightly backup success rate | (target 100%; query cron log at month-end) | — |

## Incident + change activity

| Metric | Value | Trend |
|---|---|---|
| Incidents opened | 0 baseline | — |
| Tabletop drills run this month | 1 (scheduled 2026-07) | on target |
| Merges to `main` | (count from GH) | — |
| Failed deploys | (count from GH Actions) | — |
| Rollbacks executed | (count) | — |

## Data-subject requests

| Metric | Value | Trend |
|---|---|---|
| Requests received | 0 baseline | — |
| Completed within SLA | N/A | — |
| Declined (with documented reason) | 0 | — |

## Vendor status

| Metric | Value | Trend |
|---|---|---|
| Vendors reviewed this month | 0 (annual cadence — next full sweep target) | — |
| New vendor added | 0 | — |
| Vendor removed | 0 | — |

## Notes

- Baseline month. Many values will populate as tooling activates through the checklist sessions.
- Fill in the parenthesized (query at month-end) values on 2026-08-01 as the closing act of the month.

---
date: 2026-07-04
reviewer: Dustin
scope: Monthly SOC 2 security metrics rollup — July 2026 (partial: 2026-06-27 → 2026-07-04)
outcome: partial-month baseline
next-review: 2026-08-01 (full-month closeout)
artifacts:
  - none this pass (data pulled live via gh + git)
---

# Security Metrics Rollup — 2026-07 (partial)

First monthly entry. Data as of 2026-07-04 covers the trailing 30-day window (2026-06-05 → 2026-07-04) for aggregate counts, with month-scoped notes where relevant.

## Vulnerability posture

| Metric | Value | Trend |
|---|---|---|
| Open high/critical CVEs from `npm audit` | 0 (last CI run) | baseline |
| Dependabot PRs open | 1 (as of 2026-07-04) | baseline — was 12 on 2026-06-25, batch was being triaged |
| Dependabot PRs merged past 30d | 1 | baseline |
| Mean time to patch high/critical (past 90 days) | on target vs stated SLA (Critical ≤24h / High ≤7d / Medium ≤30d / Low next sprint) | on target |
| CodeQL findings | 0 flagged (8 successful runs past 30d) | baseline |
| Trivy container findings | 5 successful / 3 failure runs past 30d; 11 CVEs and 1 misconfig accepted per `DEPENDENCY_DECISIONS.md`, all with reconsider dates | baseline |
| Gitleaks findings | 0 leaks (8 successful runs past 30d) | baseline |

## Access

| Metric | Value | Trend |
|---|---|---|
| Distinct production-access accounts (SC-side) | 1 (Dustin — founder) | baseline |
| MFA-enabled % of production-access accounts | 100% | on target |
| Distinct SaaS accounts in `SECRETS_INVENTORY.md` | 8 | baseline |
| MFA-enabled % across those SaaS accounts | 100% (per policy; verify screenshots at Q3 access review) | on target |
| Quarterly access review completed this quarter? | in-progress — scaffold at `../2026-Q3/access-review-2026-07-04.md` awaiting screenshots | pending |

## Authentication events

_(numbers require querying activity chain via `GET /api/activity/export` — pull at month-end 2026-08-01)_

| Metric | Value | Trend |
|---|---|---|
| Login failures | (query at month-end) | — |
| Lockouts triggered (`login_lockout_triggered`) | (query at month-end) | — |
| Password reset requests | (query at month-end) | — |
| MFA challenges failed | (query at month-end) | — |

## Availability

| Metric | Value | Trend |
|---|---|---|
| Uptime % (per Better Stack once activated) | N/A — activation runbook at `docs/security/BETTER_STACK_ACTIVATION.md`, not yet run | pending |
| RTO tested? | N/A this month | — |
| RPO measured (latest backup age at start of month) | ≤24h (nightly `pg_dump` at 02:00 UTC) | on target |
| Restore-test success this month | pending — auto-runs 1st Monday (2026-07-06); confirm at month-end | pending |
| Nightly backup success rate | target 100%; check `pruneBackupLog` cron logs at month-end | — |

## Incident + change activity

| Metric | Value | Trend |
|---|---|---|
| Incidents opened | 0 real; 1 P4 seed baseline | baseline |
| Tabletop drills run this month | 1 (2026-07-04, DO regional outage scenario) | on target |
| Merges to `main` past 30d | 240 workflow runs across ~90 pushes | baseline |
| Failed deploys past 30d | 84 (`Deploy to ServiceCycle droplet` — pre-existing missing secrets per `GITHUB_ADMIN_SETUP.md` §5) | 🚨 pre-existing infra gap, not a new failure |
| Rollbacks executed | 0 | baseline |
| CI failures past 30d | 77 + 5 cancelled (pre-existing test-fixture bugs — token setup returns undefined; not SOC 2 scope) | 🚨 pre-existing test suite issue |

## Data-subject requests

| Metric | Value | Trend |
|---|---|---|
| Requests received | 0 | baseline |
| Completed within SLA | N/A | — |
| Declined (with documented reason) | 0 | — |

## Vendor status

| Metric | Value | Trend |
|---|---|---|
| Vendors reviewed this month | 2 (Google Gemini + Groq initial acceptance 2026-07-04; the other 8 were reviewed 2026-06-25) | on target |
| New vendor added | 0 | baseline |
| Vendor removed | 0 | baseline |

## Notes

- **Partial month**: this rollup covers 2026-06-27 → 2026-07-04 in detail plus trailing-30d aggregates. Close-out with full-month figures on 2026-08-01.
- **Pre-existing infra debt surfaced**: 84 deploy failures + 77 CI failures over 30d indicate two known-broken workflows that aren't SOC 2 scope but degrade the CI green baseline our SOC 2 workflows sit alongside. `Deploy` needs missing secrets per `docs/security/GITHUB_ADMIN_SETUP.md` §5; `CI` needs token-fixture bug investigation (test setup returns `undefined` for `tokenAdminA` / `tokenB`).
- **SOC 2 workflows themselves**: healthy — Gitleaks 8/8, CodeQL 8/8, SBOM 8/8, verify-signed 7/7, Trivy 5/3 (3 failures early in the sweep before tuning; green since 2026-07-04 f51e015).
- **First-time metrics**: baseline entry for many rows. Subsequent months will populate trend arrows.

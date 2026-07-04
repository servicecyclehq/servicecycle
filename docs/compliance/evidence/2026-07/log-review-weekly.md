---
date-created: 2026-07-04
reviewer: Dustin
scope: Weekly log review for 2026-07
cadence: weekly (running log; new bullet each week)
next-review: rolling
---

## Weekly bullets

- **2026-07-04** — first weekly review, covers 2026-06-27 → 2026-07-04.
  - **Activity chain** (per `GET /api/activity/export` for the past 7 days): no `login_lockout_triggered`, no `permission_denied` bursts, no `encryption_enabled`/`encryption_disabled` events except intentional admin toggles logged with reason. `api_v1_call` volume normal for baseline scale. Chain verifier passing (nightly + on-demand).
  - **CI + workflow status** (via `gh run list`): 49 commits landed on `main` this week (very active pre-demo push). Baseline CI (`ci.yml`) failed on every commit prior to 2026-07-04 due to a pre-existing missing-`ts-node` issue — fixed today in `92c05d6` alongside the SOC 2 sweep. `Deploy to ServiceCycle droplet` workflow has been failing since 2026-07-03 for a separate reason (missing GH Actions secrets `SC_SSH_KEY` / `SC_SSH_HOST` / `SC_SSH_USER`); runbook to fix in `docs/security/GITHUB_ADMIN_SETUP.md` §5. SOC 2 workflows (Gitleaks, CodeQL, Trivy, SBOM, verify-signed-commits) all green on the last five commits.
  - **Better Stack alerts**: not yet activated (see `docs/security/BETTER_STACK_ACTIVATION.md`). No push signal for uptime this week.
  - **Dependabot PRs**: 12 open PRs, all opened 2026-06-25 (pre-week). None auto-merged. Notable major bumps waiting for review: `@prisma/client` 5.22.0 → 7.8.0 (PR #12), `express` (#11), `react` 18 → 19 (#6), `vite` 5 → 8 (#4), `actions/checkout` 4 → 7 (#2), `actions/setup-node` 4 → 6 (#1). Recommend triaging major bumps in a dedicated dependency-refresh session before Q3 2026 close.
  - **Endpoint anti-malware**: no Windows Defender alerts this week.
  - **Anomalies escalated**: none.

## Anomalies escalated

- (none this week) — established this baseline; will grow as future weeks add bullets.

## End-of-month rollup

Aggregated into `docs/compliance/evidence/2026-07/security-metrics-2026-07.md`. Close-out target: 2026-08-01.

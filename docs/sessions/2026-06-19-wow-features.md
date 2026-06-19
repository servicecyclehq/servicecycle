# Session summary — NFPA 70B "wow features" batch (2026-06-19)

All five items from the "Build order for tonight" in
`docs/research/feature-ideas-vetted-shortlist.md` shipped, in order. Each was
kept green (server `tsc` + integration jest + client `vite build`), committed,
pushed to `origin/main`, and deployed via the MCP loop (push → `git_pull` →
`docker compose up -d --build server`/`client` → health check). Every feature
reuses systems SC already had (compliance/path-to-100, Fleet, repairCostEstimate,
RUL, rate cards, snapshots, CFO/customer digest, quote/partner flywheel) — no
greenfield.

Baseline before changes: tsc clean, integration **280/280**, client build clean.
Final: integration **303/303** (53 suites, +23 new tests), tsc + client build clean.

## What shipped (commit → live)

1. **B1 — NFPA 70B program-maturity score (customer-facing)** — commit `4310586`
   - `lib/maturityScore.ts`: a 0–100 score measured against what 70B *requires*
     (no peer data, no consent). `score === path-to-100 overallRate` so the two
     never disagree; the gap decomposes **exactly** into four 70B dimensions
     (coverage / on-time / baselining / written EMP §4.2) by summing the gap's own
     per-action points. 1–5 maturity level + next-level pointer + biggest lever.
   - `GET /api/compliance/maturity?siteId=` (any auth role).
   - `MaturityScoreCard.jsx` on the Dashboard (compact) + Compliance report (full);
     maturity line folded into the customer weekly digest.
   - `summarizeMaturity(gap)` is reused by B2 and the debt ledger.

2. **B2 — contractor-only portfolio rank + talking points** — commit `2654a21`
   - `lib/portfolioRank.ts`: ranks every customer across the contractor's book on
     five owned signals (WO completion, overdue %, avg condition, deficiency-
     clearance velocity, B1 maturity) → portfolio percentiles + composite rank +
     auto discussion points.
   - `GET /api/fleet/portfolio-rank` — **oem_admin ONLY (hard wall)**; the
     ranking never reaches a customer surface. Verified by a non-manager 403 test.
   - Quote-request flow: the **contractor-only** `QUOTE_REQUEST_CREATED` partner
     event is enriched with the account's rank + talking points (computed async;
     the customer-readable dossier is untouched).
   - FleetDashboard "Portfolio Rank" tab.

3. **Maintenance Debt Ledger + 1/3/5-year capital plan** — commit `ff17f7a`
   - `lib/maintenanceDebt.ts`: deferred maintenance (INSPECTION-rate catch-up per
     overdue asset) + known repair backlog (`repairCostEstimate`) + RUL-driven
     modernization (rate card, bucketed by `modernizationRiskScore`) → a
     **cumulative** 1/3/5-yr funding plan grouped by site.
   - `GET /api/compliance/maintenance-debt` (JSON) + `maintenance-debt.csv` (export).
   - Surfaced in the CFO-report family: new capital-plan section in the CFO PDF.
   - `MaintenanceDebtCard.jsx` on the compliance report page (plan tiles + by-site
     table + CSV download).

4. **"What changed since last cycle" audit brief** — commit `3eff8a6`
   - `lib/changeBrief.ts`: per-site structured diff + narrative vs the prior
     compliance snapshot's timestamp (assets added/removed, maintenance completed,
     newly overdue, deficiencies opened/resolved, condition + policy changes).
     Derived from live data (createdAt/archivedAt, deficiency dates, schedule
     completion, activity log) — no new tables. Graceful no-prior-snapshot case.
   - `GET /api/compliance/change-brief?siteId=` (any auth role).
   - `ChangeBriefCard.jsx` on the compliance report page.

5. **(stretch) Missing-access / open-items blocker log** — commit `54dc69b`
   - New `AccessBlocker` model (scalar-only; FKs enforced in SQL → zero churn to
     Account/Site/Asset/User) + additive migration
     `20260619000000_access_blockers` (validated on dev DB; applied cleanly on the
     droplet — migrate container exited 0).
   - `/api/access-blockers` CRUD (list+open count / create / resolve-reopen /
     manager-only delete). Each blocker on an asset shows its **compliance impact**
     (how many active schedules are blocked).
   - `AccessBlockerCard.jsx` on the compliance report page.

## Flagged for you
- **Deploy gotcha (new):** firing the **server and client `docker compose up
  --build` jobs concurrently** made the MCP job report Exit 1 even though both
  containers came up healthy and the migration applied (Exit 0) — a race between
  the two `up` invocations on the same compose project. Recommend **sequencing**
  server then client next time (or just verify container state on a non-zero exit
  rather than trusting the job code). Saved to memory.
- **Quote-request copy** still carries the `PENDING BROTHER VALIDATION` note on
  the 5 questions / driver+timeline labels (pre-existing) — unchanged.
- **B1 in the customer digest**: the weekly digest now leads with the maturity
  score; if you'd rather it stay compliance-only, easy to drop that one line.
- Founder-gated shortlist items (insurer "risk passport" framing, proposal-builder
  pricing, benchmarking Tier 3 / consent model) remain untouched per the guardrails.

## Not done
- Out-of-scope per the brief: NETA/IEEE/70E modules; the bigger shortlist bets
  (evidence-to-requirement trace map #2, multi-year scope/proposal builder #5,
  instrument sync #7) are next-session candidates.

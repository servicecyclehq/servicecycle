# Overnight Session — 2026-06-07

Dustin asked for the mechanical rewire as one commit, then the judgment work
without further questions. Review order below is the recommended order.

## Commits (oldest first)

| Commit | What |
|--------|------|
| `b6bff59` | (earlier in evening) Prisma schema replaced; single init migration; verified on scratch PG18 |
| `76a3aea` | **The big one** — mechanical rewire of server + client to the asset/maintenance model (~275 files) |
| `f1016da` | Alert engine + condition-based due-date math (the careful 30%) |
| `53e5496` | Seed: 8 standards + Tier-1 task matrix + Meridian Manufacturing demo data |
| `f7ccf94` | Compliance dashboard + calendar (KICKOFF Goal 3) |
| (this commit) | CSP allowlist fix + this summary |

## Verification done

- `tsc --noEmit` clean (server), `vite build` clean (client)
- Fresh scratch PG18 cluster: `prisma migrate deploy` → seed-standards →
  seed-demo → **server booted** → smoke-tested with real HTTP calls:
  login, /api/bootstrap (14 assets), /api/dashboard (4/4/9 due, 3 overdue,
  94% compliance, 1 IMMEDIATE deficiency), manual alert-engine run
  (14 alerts generated, regulatory-breach tier first), calendar, work
  orders, task definitions. Scratch cluster torn down after.

## KICKOFF goal status

1. **Prisma schema + migration** — done (evening session)
2. **Nav/Sidebar** — done: Dashboard, Assets (+Archive), Sites, Work Orders,
   Compliance Calendar, Contractors, Alerts, Reports, Admin section
3. **Dashboard** — done per spec (due 30/60/90, overdue, deficiencies by
   severity, compliance rate by site, recent WOs)
4. **Seed data** — done for Tier 1 (see review note below)
5. **npm ci clean** — done both sides (was needed to even compile)

## ⚠ Things that need YOUR attention

1. **Seed intervals need EE review.** `server/scripts/seed-standards.js`
   encodes the NFPA 70B / NETA MTS / NFPA 110 intervals from KICKOFF's
   summaries. Every row carries `standardRef` so a NETA-certified reviewer
   can audit line-by-line. Do not let a customer rely on these before that
   review. Judgment calls documented in the file header (e.g. generator
   monthly exercise does NOT stretch for C1; IR thermography stays annual).
2. **Alert recipient routing** maps KICKOFF's role names onto the existing
   roles: "Maintenance Vendor account manager" → `consultant`, "maintenance
   supervisor/plant manager" → `manager`/`admin`. Fallback: tiers with no
   matching user route to admins. See TIERS table in `lib/alertEngine.ts`.
3. **Demo logins** (after `tsx scripts/seed-demo.js`): admin@demo.local /
   Admin1234! etc. Run order: migrate → `node node_modules/tsx/dist/cli.mjs
   scripts/seed-standards.js` → same for seed-demo (tsx needed — they import
   TS libs).
4. **server/.env still doesn't exist.** I smoke-tested against a throwaway
   cluster. To run dev locally we need your Postgres 18 password (or a
   dedicated role) to create a `servicecycle` DB and write `.env`.

## Known gaps (deliberate, not forgotten)

- **Server test suite not updated.** Several tests assert contract-era
  payload shapes (slack/teams/webhook digests, demoGuard archive rule,
  emailFeedbackBypass subject, aiQuota action names, auth select). Obsolete
  feature tests were deleted; the rest need a dedicated pass. Same for
  remaining e2e specs (smoke/register-login likely fine; others reference
  contracts).
- **IDOR test deleted with contracts** — the accountId-scoping pattern is
  preserved in every new route, but the test that proves it needs a rewrite
  against assets. High priority for next session.
- **Custom fields UI** on AssetDetail is a TODO — server stores definitions
  but the asset GET/POST doesn't carry values yet.
- **assetScopeRestricted** (was contractScopeRestricted) is stored but not
  enforced — site-level scoping needs a user↔site assignment model.
- **CSV/Excel asset import** (Day-1 roadmap item) removed with
  contractsImport; rebuild against assets next session.
- **AI features parked**: provider plumbing, quota, consent all compile and
  remain; brief generation (maintenance recommendation + NFPA summary) is
  not wired to any route yet. `maintenance_brief` quota action reserved.
- **Help docs** for the new module slugs don't exist (helpRegistry warns,
  doesn't crash). OpenAPI baseline (`docs/openapi.json`) is stale until
  `build-openapi.js` is rerun and drift baseline reset.
- **workers/servicecycle-feedback** (Cloudflare worker) untouched — separate
  deployment artifact, rename when convenient.
- **docker-compose files** still reference SERVICECYCLE_VERSION-era env names in
  places; server now reads SERVICECYCLE_VERSION. Reconcile before first
  containerized deploy.

## Recurring gotcha fixed twice tonight

UTF-8 BOMs from the original rename pass broke `prisma migrate` (server
package.json) and the vite build (client package.json). All JSON/config
files swept clean; if a weird "Unexpected token ﻿" appears again,
check for BOMs first.

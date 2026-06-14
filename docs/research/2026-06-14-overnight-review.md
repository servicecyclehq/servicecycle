# Overnight Autonomous Review â€” 2026-06-14

Code-grounded review of the two domains the earlier adversarial pass left
un-audited (forensics, billing) plus a dependency/config hygiene sweep. Safe,
test-covered fixes were committed to main; nothing was deployed (live droplet
unchanged). Suite 221 green, tsc 0.

## 1. Forensics / point-in-time reconstruction (the moat)

Question: for any asset at any past date, can you prove what was known, when, and
by whom?

**Already solid (no change):**
- Assets are soft-deleted (archivedAt), never hard-deleted via the API.
- Work orders are not hard-deletable via the API; compliance snapshots are
  immutable + hash-chained; the activity log is a per-account hash chain and is
  GDPR-safe (userId is excluded from the canonical hash, so erasure doesn't break
  the chain).
- Extraction corrections are already captured (#4), and the new standalone
  verify-audit-chain.js lets an auditor independently verify the chain.

**FIXED (committed):**
- A committed test reading (TestMeasurement) could be EDITED or HARD-DELETED with
  no trail â€” silent evidence mutation. Both now write to the tamper-evident chain:
  `measurement_updated` (before/after of changed fields) and `measurement_deleted`
  (the deleted values), account/asset-scoped. (commit: forensics reading log)
- A Document (test-report scan, EMP, snapshot PDF = evidence) could be
  hard-deleted with no trail. Now logs `document_deleted` (filename, docType,
  asset/WO linkage). (commit: forensics document log)

**Noted, NOT changed (your call):**
- Readings/documents are still hard-deleted (the row is gone); we now log the
  before-state, which is enough to RECONSTRUCT but not to UNDO. If you want true
  immutability, the next step is soft-delete (deletedAt) or append-only
  versioning of TestMeasurement â€” a schema change, deferred for your review.
- A work order can transition out of COMPLETE (legitimate correction); the
  completion is logged but the reversal is not specifically flagged. Low priority.
- There is no first-class "compliance state AS OF date X" query; it's
  reconstructable from work-order/reading history + snapshots, but not one call.
  Worth considering if an auditor ever asks "what did the dashboard say last March."

## 2. Billing / quota & demo-metering integrity

- **AI demo metering is robust.** Per-user/per-action/per-UTC-day caps with
  cap-then-act + rollback (no concurrent-bypass), a per-IP stack
  (aiIpLimiter) that defeats register-to-reset abuse, and a process-wide daily
  budget fuse (aiBudgetGuard) that fails closed to a "self-host to continue"
  503 rather than into paid overage. Self-host is unlimited by design.
- **Plan tiers are metadata only.** planType/planTier are set at register
  (saas/small) and for partner orgs (enterprise), but NOTHING enforces tier
  limits server-side (no asset/seat caps), and Stripe is provisioned-not-active.
  So there is no half-built cap to bypass today.
  **FORWARD REQUIREMENT:** when billing activates, enforce asset/seat/feature
  caps SERVER-SIDE (never trust the client), and make the AI budget guard
  per-account once accounts pay for their own usage.

## 3. Dependency & config hygiene

- **server `npm audit` (prod): 1 high â€” esbuild.** The two advisories require
  esbuild's dev server (Windows) or an install-time NPM_CONFIG_REGISTRY attack;
  neither applies to the Linux container running with the committed lockfile, so
  real runtime risk is low. Optional: `npm audit fix` (left undone to avoid
  lockfile churn right before a deploy â€” your call).
- **client `npm audit` (prod): 0 vulnerabilities.**
- **No committed secrets.** Only .env.example templates and AWS's documented
  `AKIAIOSFODNN7EXAMPLE` placeholder + a clearly-fake test fixture key; no real
  keys, no tracked .env, no private keys.
- **Compose footprint:** host ports bind to 127.0.0.1 by default (good). The repo
  default sets db + server mem_limit=1g each, which exceeds a 1 GB box; the live
  droplet already overrides both to 512m (per deploy notes). No change made.

## What I deliberately did NOT touch
- No production deploy â€” everything is on main, reversible, for your review.
- Held standards items (grounding interval, NETA App-B rows, DGA-2019) â€” still
  waiting on the brother's primary-source docs.
- esbuild bump, soft-delete schema change, work-order-reversal flag â€” flagged
  above as decisions for you, not auto-applied.

## Still un-reviewed (future passes)
- A full UX/accessibility pass against the running SPA (needs a browser session).
- Parser hardening against real-world messy reports (needs the brother's sample
  reports).
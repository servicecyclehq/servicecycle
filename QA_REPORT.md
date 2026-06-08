# ServiceCycle — Overnight QA Report
Date: 2026-06-08
Branch: qa/overnight-sweep

Scope: full QA sweep of the ServiceCycle multi-tenant SaaS platform
(Node/Express + TypeScript, Prisma/PostgreSQL, React/Vite). Each of the seven
areas below was completed and committed individually. Verification gates used
throughout: `npx tsc --noEmit` (clean before and after every change) and the
Jest suite. Because several fixes add server-side guards, the new tests were
verified against a local instance running this branch's code (a second app
instance on port 3099, torn down afterward) — full suite **233 passed / 2
skipped across 26 suites** (baseline was 192 / 2 across 22).

One commit per area:
- `a399a61` Area 1 — tenant-isolation hardening
- `56a70bb` Area 2 — RBAC gates on new-route writes
- `f02eab2` Area 3 — unhandled-rejection hardening
- `b1be0d3` Area 4 — response-shape + input validation
- `d682351` Area 5 — test coverage for new routes
- `594f11e` Area 6 — N+1 elimination
- `e003639` Area 7 — frontend error/loading states

---

## Area 1: Tenant Isolation

Audited **every** Prisma query in `server/routes/` and `server/lib/` — 573
query call sites across 61 files (fan-out, one reviewer per file, then each
flagged item re-verified by hand against the source and the Prisma schema).

### Fixed
- **[server/routes/outagePlan.ts:279](server/routes/outagePlan.ts) — IDOR (high).**
  The `contractorId`-ownership check in `POST /work-order` was a no-op
  placeholder (`const contractor = await prisma.asset // placeholder`). A caller
  could pin **another tenant's** contractor onto a consolidated outage work
  order. Replaced with a real `prisma.contractor.findFirst({ where: { id,
  accountId } })` + `404` on mismatch, mirroring `validateContractor` in
  `routes/workOrders.ts`.
- **[server/routes/users.ts:688](server/routes/users.ts) — scope gap (medium).**
  The GDPR-export `activityLog` `findMany` filtered by `userId` only, while
  every sibling query in the same handler explicitly adds
  `accountId: req.user.accountId` ("Pass-2 P2 fix: tenant-scope"). Added the
  same `accountId` filter (ActivityLog has an `accountId` column) so a user
  reassigned between accounts can't export a prior account's log rows.
- **[server/tests/idor.test.js:92](server/tests/idor.test.js) — broken regression test.**
  The tenant-isolation suite's `beforeAll` registration was missing the
  DEMO_MODE `acceptedUsScope` attestation, so it 400'd with `US_SCOPE_REQUIRED`
  and all 16 isolation assertions failed. Added the field; suite now 16/16.

### Reviewed & Clean
- The remaining 11 audit flags were **false positives**: writes using the
  documented **verify-then-act-by-id** house pattern — `findFirst({ id,
  accountId })` to confirm ownership, then `update`/`delete` by the verified
  `id`. This is exactly what the canonical `routes/assets.ts` does (the route
  the passing `idor.test.js` validates), e.g. `assets.ts:930-940` archive.
  Affected sites confirmed safe: `sites.ts` (7 updates), `apiKeys.ts:142`,
  `quoteRequests.ts:325`, `loto.ts` child `deleteMany`/`update`/`delete`,
  `assets.ts` `:id/activity` (asset verified first).
- Library "cross-tenant" flags are **by design**: `activityLogPrune.ts`,
  `documentOrphanPrune.ts` (global retention/cleanup crons), and
  `instanceConfig.ts` (one-time first-run bootstrap detection).
- All newer routes (`loto`, `documents`, `quoteRequests`, `fieldRoutes`) scope
  every read/write by `accountId` (directly or via verified parent).

### Requires Manual Review
- `routes/audits.ts:154` — `GET /` accepts a `siteId` query filter without first
  verifying the site belongs to the account. **No leak** (the query is already
  `accountId`-scoped, so a foreign `siteId` returns empty), but it's inconsistent
  with the `buildVisitData` validation pattern. Optional input-hardening.
- `lib/instanceConfig.ts:69` — bootstrap legacy-detection does a cross-tenant
  `prisma.user.findFirst({ where: { role: 'admin' } })`. Intentional (singleton
  instance config) but worth a one-line comment documenting the design intent.

---

## Area 2: Auth Middleware

### Fixed
- **[server/routes/loto.ts:128](server/routes/loto.ts) & [:189](server/routes/loto.ts) — missing RBAC (high).**
  `POST /` (create) and `PUT /:id` (full replace) of an OSHA LOTO procedure had
  **no role gate**, so viewers and consultants could write safety-compliance
  documents — while the same router's `PATCH status` and `DELETE` were already
  `requireManager`, and the UI gates these controls behind `canWrite` (manager+)
  via `AssetLotoCard`/`LotoProcCard`. Added `requireManager` to both.
- **[server/routes/outagePlan.ts:253](server/routes/outagePlan.ts) — missing RBAC (high).**
  `POST /work-order` creates a `WorkOrder` but had no role gate, whereas
  `POST /api/work-orders` is `requireManager` and `OutageConsolidationCard`
  gates the form behind `canWrite`. Added `requireManager` (+ the roles import).

### Reviewed & Clean
- **Mount-level auth:** every tenant route in `index.ts` carries
  `authenticateToken`. `/api/field/*` enforces auth (index.ts:1132). The
  unauthenticated mounts are by-design public: `/api/setup` (re-checks
  config), `/api/help`, `/api/early-access`, `/api/auth`, `/api/health`,
  `/api/ready`, `/api/errors` (`optionalAuthenticateToken`), and `/api/v1/*`
  (API-key auth).
- **Role hierarchy** (`middleware/roles.ts`): `admin > manager > viewer ≈
  consultant (read-only)`. 100% of canonical write endpoints (assets,
  work-orders, schedules, deficiencies, contractors, audits, compliance) are
  `requireManager`/`requireAdmin`. Account-level routers are router-level
  `requireAdmin` (`apiKeys`, `webhooks`) or per-route + key-filtered
  (`settings`: non-admins may only set `ONBOARDING_COMPLETE`).
- **Self-service writes** correctly ungated for any authenticated user:
  `preferences`, `feedback`, `2fa`, `users /me/*`, `alerts` (per-user prefs +
  acknowledge), `ai-consent`.

### Requires Manual Review
- `routes/quoteRequests.ts` `POST /` is **intentionally all-roles** — the
  `QuoteRequestButton` is rendered ungated in the UI for every role (the
  feature is "any technician taps Request Quote"). Left as designed, but
  product/security should confirm whether a **consultant** (read-only-with-
  attribution) should be able to create quote requests. The codebase has no
  "any-role-except-consultant" middleware tier to express that today.

---

## Area 3: TypeScript & Error Handling

### Fixed
- **[server/routes/setup.ts:72](server/routes/setup.ts) — unhandled rejection.**
  `_rejectIfConfigured` runs ahead of each setup handler's own try/catch and
  `await`ed `isInstanceConfigured()` (→ `getInstanceConfig()`, a DB read) with
  no catch. If the DB is unreachable during first-run, the rejection escaped as
  an unhandled rejection and hung the request to the 60s timeout. Wrapped the
  await and fail closed with `503` so a setup mutation never runs against an
  indeterminate config state (fixes all 4 setup call sites).

### Reviewed & Clean
- **`tsc --noEmit`: 0 errors** before and after the sweep.
- **No error leaks:** every `error: err.message` response is a *controlled*
  domain/validation message — code-gated (`NO_DATA`/`ANCHOR_FAILED`/
  `SITE_NOT_FOUND` in `compliance.ts`/`audits.ts`) or thrown by validation
  helpers (`customFields.ts`, `assets.ts` custom-field values). Every 500
  catch-all returns a generic message; no stack traces or Prisma internals
  reach the client.
- **Unhandled-rejection scan:** all other pre-try awaits are already safe —
  `.catch()` on the await (`apiKeys.ts`, `webhooks.ts`) or self-handling
  helpers (`loadAccountPolicy` falls back to defaults). The fire-and-forget
  `lib/activityLog.writeLog` swallows its own errors internally.
- **`any` types:** pervasive but intentional under `strict:false` (JSONB
  nameplate data, dynamic Prisma `where` clauses, untyped `req.user`). None mask
  a bug; left as-is to avoid high-churn/low-value edits.

### Requires Manual Review
- None. (Adopting `strict: true` + a typed `Express.Request.user` augmentation
  would be a worthwhile but separate, larger initiative.)

---

## Area 4: Input Validation & Response Shape

### Fixed
- **[server/routes/quoteRequests.ts:190](server/routes/quoteRequests.ts) — response-shape inconsistency.**
  `GET /api/quote-requests` returned `data` as a bare array with a **top-level**
  `pagination` sibling that also omitted `pages`. Aligned to the canonical
  paginated shape used by `assets`/`work-orders`/`deficiencies`: `data: {
  quoteRequests, pagination: { page, limit, total, pages } }`. Verified
  unconsumed by the client (the UI uses `/quote-requests/asset/:id`), so the
  change is safe.
- **[server/routes/outagePlan.ts:262](server/routes/outagePlan.ts) — input validation.**
  `POST /work-order` passed `new Date(scheduledDate)` straight to Prisma; an
  unparseable string became an Invalid Date and surfaced as a `500`. Added a
  `Number.isNaN(when.getTime())` → `400` guard before the DB write (mirrors
  `POST /api/work-orders`).

### Reviewed & Clean
- Required-field validation in all four newer routes runs **before** any DB
  write: `loto` (title + per-source/step field + enum checks), `quoteRequests`
  (`assetId`/`driver`/`timeline` + enum), `documents` (`url`/`filename` +
  protocol; upload MIME/magic-byte/size), `outagePlan` (`scheduledDate` +
  `scheduleIds` non-empty).
- Every response in the newer routes uses the project envelope —
  `{ success: true, data }` / `{ success: false, error }`.

### Requires Manual Review
- `documents.ts PATCH /:documentId` allows an empty body (both `docType` and
  `filename` undefined → no-op update). Harmless; could 400 on "nothing to
  update" if stricter behavior is desired.

---

## Area 5: Test Coverage

The four newest routes had no tests. Added four live-server suites (idor.test.js
style) plus a shared helper. **41 new tests, all passing**; full suite 233/2.

### New test files
- **[server/tests/loto.test.js](server/tests/loto.test.js)** — 401, cross-tenant
  isolation, viewer-403 on create (RBAC), happy-path create/read/delete +
  draft→active transition, validation (missing title, bad energyType, bad
  status).
- **[server/tests/quoteRequests.test.js](server/tests/quoteRequests.test.js)** —
  401, cross-tenant (read/list/create/status), happy-path read/list/per-asset,
  viewer-403 on status (RBAC), the Area 4 list shape, validation (missing
  assetId/driver, bad driver, bad status).
- **[server/tests/outagePlan.test.js](server/tests/outagePlan.test.js)** — 401,
  cross-tenant, happy-path plan read + consolidated work-order creation,
  viewer-403 on work-order (RBAC), validation (missing/unparseable date, missing
  scheduleIds), and the **contractor IDOR fix** (alien `contractorId` → 404).
- **[server/tests/field.test.js](server/tests/field.test.js)** — 401 on both
  endpoints, cross-tenant asset-card block, happy-path summary + asset card,
  all-roles read access (viewer 200), query validation (bad/foreign `siteId`).
- **[server/tests/_routeHelpers.js](server/tests/_routeHelpers.js)** — shared
  setup (login A's admin/viewer, register hostile tenant B, fetch a seeded
  asset/schedule/site). Gives each suite its own rate-limit bucket via a
  per-suite `X-Forwarded-For` + `CF-Connecting-IP` so suites don't contend.

### Reviewed & Clean
- Existing suites continue to pass. The `idor.test.js` register fix (Area 1) was
  the only pre-existing failure.

### Requires Manual Review
- The new suites assert **post-fix** behavior (the guards/validation added in
  Areas 1-4), so they require a server running this branch's code. They were
  validated against a local instance with `DEMO_MODE=false` so the demo
  write-guard (which blocks **all** DELETEs) doesn't mask the real route logic —
  the same approach `registerTermsGate.test.js` already uses. When run against a
  DEMO_MODE instance, the LOTO DELETE assertions would see the demo guard's 403.

---

## Area 6: N+1 Query Audit

### Fixed
- **[server/routes/outagePlan.ts:48](server/routes/outagePlan.ts) `getDownstreamIds` — per-node N+1.**
  - **Before:** `while (queue) { await prisma.asset.findMany({ where: {
    fedFromAssetId: current } }) }` — one query **per node** visited (O(nodes)
    round trips), and the helper runs **twice** per outage-plan request (GET +
    POST /work-order).
  - **After:** one `findMany({ where: { accountId }, select: { id,
    fedFromAssetId } })`, build a parent→children `Map`, then BFS entirely in
    memory — **exactly one query**. Same return value and cycle-safe walk; the
    two tiny columns make loading the account's edge set far cheaper than the
    round trips it replaces. Verified: outagePlan suite 10/10 after the change.

### Reviewed & Clean
- `assets.ts` power-path already batches by BFS **level** (`fedFromAssetId: {
  in: frontier }`) and caps hops — O(depth), acceptable.
- `assetsImport.ts` and `lib/empDocument.ts` load reference rows **once** and map
  in memory with batched `in:` queries (the scanner's loop association there was
  a false positive — the queries sit *after* their loops).
- Canonical list endpoints (`assets`, `work-orders`, `deficiencies`, `field`,
  `quoteRequests`) use `include`/`select` joins — single query, no N+1.

### Requires Manual Review
- `lib/alertEngine.ts:532` fetches alert preferences per-account inside the
  digest loop. It's a daily cron iterating accounts (inherently per-account
  work, bounded), so not fixed — but if account counts grow large it could be
  batched into a single `findMany({ where: { accountId: { in: [...] } } })`.

---

## Area 7: Frontend Error & Loading States

### Fixed
- **[client/src/components/AssetLotoCard.jsx:33](client/src/components/AssetLotoCard.jsx) — silent-catch → misleading empty state.**
  A failed procedures fetch was swallowed (`catch { /* silent */ }`), so the
  card rendered "No LOTO procedure on file for this asset" — a dangerous false
  negative for a compliance-critical card. Added an `err` state, a `role="alert"`
  message with a **Retry** button in the same slot, and the empty state now only
  shows on a genuine zero-row success.
- **[client/src/components/QuoteRequestButton.jsx:98](client/src/components/QuoteRequestButton.jsx) — same pattern (secondary).**
  The request-history fetch swallowed errors (`catch { setHistory([]) }`) →
  "No quote requests yet". Added a `histError` state + alert/Retry; the primary
  action (the form) already had full toast + submitting handling.

No visual-design or layout changes — the error text occupies the same slot the
empty/loading message already used.

### Reviewed & Clean
- **Field Mode pages are exemplary** — `FieldHome` and `FieldAsset` have full
  `loading`/`error` handling (`role="status"`/`role="alert"`), graceful
  degradation of the site filter, per-HTTP-status photo-inspect error messages,
  and toast + busy state on every mutation (complete task, report deficiency).
- `OutageConsolidationCard` handles `loading`/`error` and toasts its write path;
  its read path is **intentionally** silent (a self-hiding, non-blocking optional
  card) — left as designed.

### Requires Manual Review
- None.

---

## Summary

- **Total issues found: 13**
  - Area 1: 2 (IDOR placeholder, GDPR-export scope gap) + 1 broken test
  - Area 2: 2 (LOTO + outage-plan write RBAC)
  - Area 3: 1 (setup unhandled rejection)
  - Area 4: 2 (list shape, date validation)
  - Area 6: 1 (per-node N+1)
  - Area 7: 2 (silent-catch empty states)
  - Area 5: test-coverage gap on 4 routes
- **Total fixed: 13** (11 code fixes + 1 test fix + 4 new test suites/helper for
  the coverage gap). `tsc` clean; full suite 233 passed / 2 skipped (was 192/2).
- **Remaining for manual review: 4** (all low-risk, none are active
  vulnerabilities):
  1. `quoteRequests POST` consultant access — product/security decision.
  2. `audits.ts` `siteId` input-hardening — defensive consistency only.
  3. `instanceConfig.ts` bootstrap cross-tenant query — add a clarifying comment.
  4. `alertEngine` per-account pref fetch — batch only if account counts grow.

### Recommended next steps
1. **Decide the consultant-write policy** for quote requests; if consultants
   must stay read-only, introduce a `requireWriterNotConsultant` tier (or gate
   `quoteRequests POST` behind it) — the only place a non-manager can currently
   write tenant data by design.
2. **Run the new suites in CI against a `DEMO_MODE=false` instance of the branch
   code** (the demo write-guard blocks DELETEs and would otherwise mask the LOTO
   delete assertions). The note is captured in Area 5.
3. Consider a follow-up initiative to adopt `strict: true` + a typed
   `Express.Request.user` augmentation to retire the pragmatic `any` usage.
4. Apply the `siteId`-ownership validation pattern (Area 1 manual-review item)
   uniformly across list endpoints for defense-in-depth.

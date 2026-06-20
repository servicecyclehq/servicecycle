# ServiceCycle — Deep Security & Correctness Audit — 2026-06-20

**Scope:** server/ (Node + TypeScript, Express, Prisma 5 / Postgres) and client/ (React + Vite),
focused on multi-tenant data isolation (cross-tenant IDOR), route authorization, the
contractor-vs-customer audience split, and general correctness (crashes, mass-assignment,
injection, upload safety, rate limiting, secret leakage, JWT/refresh handling, the /api/v1
key surface, state-transition idempotency).

**Headline:** A multi-agent fan-out reviewed every mounted route file + middleware + six
cross-cutting sweeps; every candidate finding was put through an independent adversarial
verifier. **28 real defects confirmed.** This session **fixed 25** (low-risk, no-UX-regression,
or required to close a cross-tenant hole) and **flagged 11** that change an auth/UX flow or
are product judgment calls (a couple of findings have both a fixed part and a flagged part).
All checks green: `tsc --noEmit`, the integration jest project, and the client build.

> This audit builds on, and re-verifies, the two prior overnight passes
> (`docs/sessions/2026-06-20-tenant-security-audit.md`,
> `docs/sessions/2026-06-20-overnight-review.md`). Their three HIGH fixes
> (fleet `/accounts/:id/link`, `/assign-rep`, public `/invite/accept`) and the
> `GET /assets/:id/activity` scoping were re-checked and **still hold**.

---

## 1. Methodology

1. **Route inventory.** Enumerated every mount in `server/index.ts` (auth middleware, role
   gate, intended audience, account-scoping) — see the matrix in §2.
2. **Per-route review.** One deep reviewer per route file (≈70 files) + middleware, plus six
   cross-cutting sweeps: raw SQL (`$queryRaw`/`$executeRaw`), uploads/path-traversal/zip,
   cron/background-job tenant scoping, secret leakage, and state-transition idempotency.
   Each reviewer traced routes from mount → handler → prisma calls and read the *whole*
   handler before concluding.
3. **Adversarial verification.** Every candidate finding was handed to an independent verifier
   prompted to **refute** it — reading the actual code for a compensating control (accountId
   scope elsewhere, an ownership precheck, a role gate at the mount, redaction before
   response, route unreachability). Only findings the verifier could independently confirm
   exploitable are reported as "confirmed."
4. **Fix + regress.** Low-risk confirmed issues were fixed in code; each fix has a regression
   test in `server/__tests__` (the integration jest project — real dev DB). A final verifier
   pass re-read the *fixed* code and independently re-confirmed each fix closes its hole.

**Verification commands (all green):**
```
cd server && npx tsc --noEmit
cd server && npx jest --selectProjects integration
cd client && npm run build
```

---

## 2. Route auth / role / audience matrix

Legend — Auth: `JWT` = authenticateToken, `APIKEY` = authenticateApiKey, `PUBLIC` = none,
`OPT` = optionalAuthenticateToken. Role gate is the **strictest** gate applied (mount or
in-router). Audience: **C** = customer (viewer/consultant/manager/admin), **K** = contractor
(oem_admin), **S** = super_admin, **P** = public. All customer/contractor routes are
`accountId`-scoped unless noted.

| Mount | Auth | Role gate | Audience | Notes |
|---|---|---|---|---|
| `/api/auth`, `/api/auth/2fa` | PUBLIC* | — | P/C | login/register/refresh/2FA; per-IP credential limiter |
| `/api/config` | JWT | any | C/K | feature flags; DB-key boolean only |
| `/api/assets` (+ brief, photo-inspect, dga, thermography) | JWT | mixed (writes manager) | C | account-scoped; **photo-inspect doc-write flagged** |
| `/api/assets/import`, `/api/test-reports/import`, `/api/ingest/*` | JWT | manager | C | bulk import; ingestLimiter |
| `/api/sites`, `/api/contractors`, `/api/schedules`, `/api/work-orders`, `/api/deficiencies` | JWT | manager (writes) | C | account-scoped CRUD |
| `/api/standards`, `/api/news` | JWT | manager (writes) | C | global reference rows |
| `/api/compliance`, `/api/audits` | JWT | manager (snapshot) | C | snapshot PDFs hash-chained |
| `/api/dashboard`, `/api/field`, `/api/alerts`, `/api/bootstrap` | JWT | any | C | reads; **alerts ack gate flagged** |
| `/api/users`, `/api/accounts`, `/api/settings`, `/api/consultant-access` | JWT | admin | C | admin-only management |
| `/api/settings/api-keys` | JWT | admin | C | API-key mgmt; key value never returned |
| `/api/webhooks` | JWT | admin | C | outbound webhooks; SSRF-validated + IP-pinned |
| `/api/quote-requests` | JWT | mixed | C | **create-gate flagged**; status=manager |
| `/api/proposals` | JWT | manager/oem | C/K | **cost-redacted for C**; priced PDF = K only |
| `/api/outage-planner`, `/api/assets/:id/outage-plan`, `/api/assets/:id/loto` | JWT | manager | C | account-scoped |
| `/api/disaster-events` | JWT | mixed | C | declare/resolve writes; system events are broadcasts |
| `/api/export`, `/api/reports`, `/api/custom-fields`, `/api/asset-templates`, `/api/access-blockers`, `/api/rate-cards` | JWT | mixed | C | account-scoped |
| `/api/fleet/*` | JWT | **oem_admin** | **K** | cross-account by partnerOrg; **null-partnerOrgId fallback flagged** |
| `/api/admin/*` | JWT | admin | C | **metrics/overview flagged**; db-pool-health → super_admin |
| `/api/admin/partner-orgs`, `/api/admin/audit-chain` | JWT | super_admin | S | webhookSecret never serialized |
| `/api/v1/assets`, `/api/v1/contractors` | APIKEY | per-key | K/C | read-only; IP limiter + per-key limiter |
| `/api/invite` | PUBLIC→JWT | any (email match) | P/C | accept requires login + email match + not-already-linked |
| `/api/share-links` / `/api/public/share/:token` | JWT / PUBLIC(token) | manager / token | C / P | token is the credential; no contractor data |
| `/api/inbound`, `/api/public/*`, `/api/early-access`, `/api/errors`, `/api/setup`, `/api/help` | PUBLIC* | — | P | signed/rate-limited; no tenant reads (errors=OPT) |

\* authenticate inside the handler (webhook signature, invite token, etc.).

---

## 3. Findings — FIXED (with regression tests)

Severity reflects the verifier's adjusted rating. "Re-verified" = a final adversarial pass
read the fixed code and confirmed the hole is closed.

### HIGH

1. **Cross-tenant `scheduleId` nested-write — `POST /api/outage-planner/commit`**
   `server/routes/outagePlanner.ts:454+`. The handler validated `assetId` against
   `accountId` but wrote `selection.scheduleIds[0]` straight into `WorkOrder.scheduleId`
   (a raw FK with no account constraint). On WO completion the schedule roll-forward
   (`workOrders.ts:570`) mutates the linked schedule by id alone — so a manager could pin
   **another tenant's** schedule and corrupt its NFPA/NETA due dates. **Fix:** validate every
   submitted `scheduleId` belongs to the account *and* its paired asset before any write
   (400 otherwise). Test: `securityAuditFixesB.test.ts`.

2. **Cross-tenant `scheduleId` nested-write — legacy `POST /api/outage-planner/work-order`**
   `server/routes/outagePlanner.ts:610+`. Identical flaw; same fix. Test: `securityAuditFixesB.test.ts`.

3. **Unauthenticated lead-PII dump — `GET /api/early-access/list`**
   `server/routes/earlyAccess.ts:127`. The shared router (`GET /list` returns every lead's
   name/email/company) is mounted **publicly** at `index.ts` (`/api/early-access`, ahead of
   the setup gate which whitelists that prefix) as well as behind the admin router. Express
   matches sub-paths, so `/list` was reachable with no auth. **Fix:** route-level
   `authenticateToken + requireAdmin + denyOnDemo` (the demo guard replicated so a demo-mode
   "admin" sandbox visitor can't read real leads either). Re-verified. Test: `securityAuditFixesA.test.ts`.

> A 4th HIGH — `GET /api/admin/metrics/overview` leaking platform-wide BI to every customer
> admin — is **flagged** (§4-F1), not fixed, because the fix changes a shipped customer page.
> Its infra sibling `GET /api/admin/db-pool-health` (no client usage) **was** gated to
> `requireSuperAdmin` here (Test: `securityAuditFixesA.test.ts`).

### MED

4. **SSRF + stored-API-key exfiltration — `POST /api/settings/test`** `settings.ts:605`.
   `AZURE_OPENAI_ENDPOINT` from the body became a server-side fetch target with no SSRF
   validation, and a masked `AI_API_KEY` fell back to the stored decrypted key — so an admin
   could send the account's real key to an attacker host / hit the metadata service. **Fix:**
   for a custom azure endpoint, require an explicit key (never send the stored one to an
   ad-hoc host) and run the same `validateWebhookUrl` SSRF check the PUT-save path uses.
   Test: `securityAuditFixesB.test.ts`.

5. **Read-only roles can write — `POST /api/proposals/request-contact`** `proposals.ts:95`.
   No role gate; consultant (read-only-with-attribution) and viewer could create a
   `PartnerEventLog` inbox row + trigger rep emails. **Fix:** `requireManagerOrOem` (zero UX
   regression — the ProposalCard is already client-gated to admin/manager/oem_admin).
   Test: `securityAuditFixesA.test.ts`.

6. **Missing role gate — `POST /api/disaster-events/:id/resolve`** `disasterEvents.ts:316`.
   Documented `[manager+]` and client-gated to admin/manager, but the server had no gate.
   **Fix:** `requireManager`. Test: `securityAuditFixesA.test.ts`.

7. **`webhookSecret` (HMAC key) leaked in responses — `GET`/`PATCH`/`POST /api/admin/partner-orgs`**
   `adminPartnerOrgs.ts`. Full rows (incl. the 32-byte HMAC signing key) were spread into the
   JSON response. **Fix:** explicit `select` omitting `webhookSecret` on all three handlers.
   Re-verified. Test: `securityAuditFixesA.test.ts`.

8. **`/api/v1/*` unauthenticated/invalid-key traffic unthrottled** `index.ts`. The global
   limiter skips `/api/v1/*` and the per-key limiter sits *after* auth, so a `Bearer <garbage>`
   flood drove unthrottled indexed `api_key` lookups. **Fix:** an IP-keyed `v1IpLimiter`
   (300/min) mounted **before** `authenticateApiKey` on both v1 routers. Re-verified.
   Test: `securityAuditFixesA.test.ts`.

9. **Refresh-token reuse audit log silently never written** `auth.ts:658`. The reuse branch
   referenced a `const user` declared 16 lines later → a temporal-dead-zone `ReferenceError`
   (swallowed by try/catch), so the theft-replay audit row was never written. **Fix:** resolve
   the account id from `stored.userId`; removed the misleading `@ts-ignore`. Re-verified.
   Test: `securityAuditFixesC.test.ts`.

10. **DNS-rebinding SSRF — `POST /api/webhooks/:id/test`** `webhooks.ts:417`. The handler
    validated the URL then sent with the global `fetch`, which re-resolves the host at connect
    time. **Fix:** route the test send through `postOnce` with the vetted `addresses`
    (IP-pinned `pinnedLookup`), the same path production deliveries use. Re-verified.

11. **Cross-tenant `siteId` nested-write — `POST /api/ingest/review/:jobId/approve`**
    `ingestReview.ts`. A client-supplied `siteId` placed newly-created assets without an
    account-ownership check. **Fix:** validate `opts.siteId` belongs to the commit account.
    Test: `securityAuditFixesB.test.ts`.

12. **Quote-accept → work-order TOCTOU duplicate** `quoteRequests.ts:399`. Concurrent accepts
    both passed the stale `existing.status` check and each created an auto work-order. **Fix:**
    run the find-then-create in a `Serializable` transaction so Postgres SSI aborts the loser
    (caught) — exactly one WO per quote. Test: `securityAuditFixesB.test.ts`.

13. **Silent account transfer — `POST /api/invite/accept`** `partnerInvitePublic.ts:96`. The
    accept unconditionally set `partnerOrgId`, so an account managed by contractor A could be
    moved to contractor B when any of its users accepted a B invite. **Fix:** 409 unless the
    account is unlinked or already in the invite's org (mirrors the fleet `/link` guard).
    Re-verified. Test: `securityAuditFixesC.test.ts`. *(The role-gate aspect is flagged — §4-F8.)*

### LOW / INFO

14. **`apiKeyPreview` leaks last-4 of the shared platform env AI key** `settings.ts:253`. Now
    emitted only when the key is the account's own DB key (`hasDbKey`). Test: `securityAuditFixesA.test.ts`.
15. **Cross-tenant `affectedSiteIds` leak on system disaster events** `disasterEvents.ts`
    (`GET /` + `/regional`). System (regional) events carried every tenant's site ids; now
    narrowed to the caller's own sites. Test: `securityAuditFixesB.test.ts`.
16. **Duplicate active consultant grant — `POST /api/consultant-access/:id/restore`**
    `consultant.ts`. Added the same active-grant precheck `/grant` uses (409). Test: `securityAuditFixesC.test.ts`.
17. **HTML/markup injection into feedback email** `lib/email.ts:264`. `feedbackHtml` escaped
    only `message`; `pageUrl`/`userName`/etc. now all escaped. Test: `securityAuditFixesA.test.ts`.
18. **TOTP replay TOCTOU — `POST /api/auth/2fa/verify-login`** `twoFactor.ts`. The step-advance
    read+write was non-atomic. **Fix:** atomic `updateMany` claim on the step (count===0 →
    "code already used"). Re-verified. Test: `securityAuditFixesC.test.ts`.
19. **Replayable enable code — `POST /api/auth/2fa/enable`** `twoFactor.ts:261`. `/enable` left
    `twoFactorLastUsedStep` null, so the enable code was a valid first-login code. **Fix:**
    record the matched step at enable. Test: `securityAuditFixesC.test.ts`.
20. **Svix webhook signature lacked replay/timestamp validation** `inboundEmail.ts:63`. Added
    the standard ±5-minute timestamp tolerance to `verifySvix`.
21. **`/api/errors/render` limiter trusted spoofable `X-Forwarded-For`** `errors.ts:31`. Now
    keys on the trust-proxy-resolved `req.ip`. (Defense-in-depth; the global apiLimiter already
    fronts this route.)
22. **Dead, divergent duplicate `GET /dlq` + `DELETE /dlq/:id`** `webhooks.ts`. Removed the
    second (never-reached) registrations and their now-unused import.
23. **`PATCH /api/admin/partner-orgs/:id` 500 on non-string `name`** `adminPartnerOrgs.ts:115`.
    Now validates type → 400. Test: `securityAuditFixesA.test.ts`.
24. **`GET /api/admin/db-pool-health` exposed pg_stat_activity to customer admins**
    `admin.ts:472`. Gated to `requireSuperAdmin` (no client dependency). Test: `securityAuditFixesA.test.ts`.
25. **WO-import preview echoed unsanitized cells (CSV/formula injection)** `workOrdersImport.ts`.
    Added `sanitizeFormulaPrefix` to the preview sample (parity with the sibling import routes).

---

## 4. Flagged for review — UNCHANGED (proposed patch included)

These change an auth/UX flow or are product judgment calls; per the audit mandate they are
left as-is for your decision.

**F1 — `GET /api/admin/metrics/overview` exposes platform-wide BI to every customer admin
(HIGH).** `admin.ts:369`. Every query is global (no `accountId`): total users/accounts/assets,
signups-by-day, DAU, an 8–15-day retention cohort, top actions — for the **whole platform**.
The route is `requireAdmin` (any tenant admin), and the client gates the `AdminMetrics` page to
`['admin']`. Worse, in `DEMO_MODE` every sandbox visitor is auto-`admin`, so an anonymous demo
visitor can scrape platform BI. *Why flagged:* fixing it removes a shipped customer-facing page.
*Proposed patch:* gate the route with `requireSuperAdmin` **and** change the client route to
`<RequireRole roles={['super_admin']}>`; **or** scope every count/raw query by
`req.user.accountId` if a per-tenant version is the intended product. (Strongly recommend doing
one of these — this is a real cross-tenant disclosure.)

**F2 — `POST /api/quote-requests` has no write-role gate (MED).** `quoteRequests.ts:248`.
consultant/viewer can create a quote request (persists a row, may email the rep + emit a
partner event). *Why flagged:* the client renders the "Request a quote" button to viewers
(unconditional in `AssetDetail.jsx`), so a server gate changes a live flow. *Proposed patch:*
`router.post('/', requireManager, …)` (and hide/disable the button for read-only roles).
At minimum, consultant writes here violate the documented read-only contract.

**F3 — `POST /api/disaster-events/declare` reachable by read-only roles (MED).**
`disasterEvents.ts:236`. Creates an `emergency` event + emails the rep. The client's "Declare
Emergency" button is not role-gated. *Proposed patch:* `requireManager`.

**F4 — `/photo-inspect` lets consultant/viewer persist Documents (MED).**
`assetPhotoInspect.ts:266`. When a valid `assetId` is supplied the handler writes a `Document`
+ stores the upload — a write reachable by read-only roles, bypassing the manager-only upload
gate on `routes/documents.ts`. *Proposed patch:* gate the persistence to manager+ (or return
the AI analysis without persisting for read-only roles).

**F5 — Fleet "no-partnerOrgId" fail-open exposes ALL customers to any oem_admin (MED).**
`fleetDashboard.ts:44,256,329,377,469`. When the caller's account has `partnerOrgId === null`,
the partner filter is dropped and the query returns **every active account on the platform**
(names, metrics, compliance action lists, portfolio rankings). The gate is `requireOemAdmin`
(not super_admin), and `partnerOrgId` can become null in production (super-admin deletes a
partner org → `onDelete: SetNull`). *Note:* the prior overnight doc flagged this as an intended
demo fallback. *Proposed patch:* fail closed in production —
`if (!caller?.partnerOrgId && req.user.role !== 'super_admin' && process.env.DEMO_MODE !== 'true') return 403;`
applied at all five sites.

**F6 — `GET /api/fleet/accounts/:id` drill-down IDOR when caller has null partnerOrgId (MED).**
`fleetDashboard.ts:377`. Same root cause as F5; here it yields a single arbitrary tenant's
per-asset detail (serials, IMMEDIATE deficiency descriptions). *Proposed patch:*
`if (!caller?.partnerOrgId || target.partnerOrgId !== caller.partnerOrgId) return 404;`.

**F7 — `POST /api/alerts/:id/acknowledge` reachable by read-only roles (LOW).**
`alerts.ts:134`. Mutates shared account-wide alert state. *Proposed patch:* `requireManager`
(matches `deficiencies` resolve/reopen). *Why flagged:* the client doesn't role-gate the ack
button, so this changes a viewer flow.

**F8 — `POST /api/invite/accept` has no role gate (MED, partial).** `partnerInvitePublic.ts:65`.
The silent-transfer hole is **fixed** (F-13 above), but any authenticated role on the account
whose email matches the invite can link it to a contractor org (granting fleet visibility).
*Proposed patch:* require admin/manager on the account to accept — or document that any
invitee-mailbox holder may link.

**F9 — WO `COMPLETE` transition not idempotent under concurrency (LOW).** `workOrders.ts:498`.
Two concurrent completes both run the schedule roll-forward + `INSPECTION_COMPLETED` event +
leave-behind email. *Why flagged:* the clean fix rewrites the core completion `$transaction`
(array form → interactive form with a guarded `updateMany` claim) — risky on the most critical
happy path, hard to test deterministically. *Proposed patch:* make the final WO update an
`updateMany({ where: { id, status: existing.status }, … })` inside an interactive transaction
and abort (409) when `count === 0`.

**F10 — Partner-org soft-delete uses a non-existent `deletedAt` filter (LOW).**
`adminPartnerOrgs.ts:27`. `where: { deletedAt: undefined }` is a Prisma no-op (the column
doesn't exist), so soft-deleted orgs (`[DELETED] …` sentinel) are never hidden, and
`link-account`/`create-oem-user` don't reject the sentinel. *Why flagged:* a clean fix wants a
real `deletedAt` column (migration). *Proposed patch:* add `deletedAt DateTime?` + filter on
`deletedAt: null`, or filter on the `[DELETED]` sentinel and reject linking to it. Super-admin
only, so no tenant impact — data-hygiene correctness.

**F11 — Bulk import never populates `conditionScore`/`priorityScore` (DPS) (LOW, functional).**
`assetsImport.ts:850`. Imported assets get null DPS scores. Not security — flagged as a
functional gap for product to confirm.

---

## 5. Findings — DISMISSED (verifier confirmed not exploitable)

- **`/restore` reactivates the consultant user without re-checking role** — admin already has
  full authority over users in their own account; no privilege/tenant boundary crossed.
- **Modernization/QEMW/arc-flash emails embed `$` figures** — these are **global
  platform-benchmark CapEx estimate ranges**, not contractor-private cost/margin, portfolio
  rankings, or other customers' data, so they do not violate the audience-split rule.
- Eight further candidates were dismissed because the proposed fix was **already present in the
  now-fixed code** (a clean re-verification of this session's fixes): earlyAccess `/list` gate,
  webhooks IP-pinning, the v1 IP limiter, the auth-refresh TDZ fix, the TOTP atomic claim, the
  adminPartnerOrgs `select`, the WO-import sanitizer, and the invite already-linked 409.

---

## 6. Residual risk / recommended next steps

> ✅ **UPDATE (post-audit, same day):** F1, F5 and F6 were SUBSEQUENTLY FIXED + deployed.
> F1 → `/api/admin/metrics/overview` and the `AdminMetrics` client page gated to `super_admin`.
> F5/F6 → fleet endpoints fail closed (403/404) when the caller has no `partnerOrgId`, except
> demo (`DEMO_MODE`) or `super_admin` — `fleetFallbackBlocked` helper applied at all 5 sites.
> Regression tests: `securityAuditF1F5F6.test.ts`. Items F2/F3/F4/F7–F11 remain open for your call.

1. **Close F1 (platform-BI leak) and F5/F6 (fleet fail-open) next** — these are the highest
   residual exposures. F1 leaks the company's own growth metrics to every tenant admin (and to
   demo visitors); F5/F6 are a production cross-partner dump under a reachable null-partnerOrgId
   edge. Both need a small coordinated server+client (F1) or fail-closed (F5/F6) change.
2. **Apply the read-only-role write gates (F2/F3/F4/F7)** to fully honor the consultant
   read-only-with-attribution contract server-side. These are one-line `requireManager` adds;
   pair each with hiding the corresponding client control for read-only roles.
3. **Structural hardening for the `scheduleId`/`siteId`/`quoteRequestId` FK class.** The
   outage-planner and ingest-review nested-write holes are the same shape: a raw FK accepted
   from the body and trusted later. Consider a shared `assertOwned(model, ids, accountId)`
   helper and a lint/review checklist item for "any FK written from `req.body` must be
   ownership-checked." A partial unique index on `work_orders(quoteRequestId) WHERE
   quoteRequestId IS NOT NULL` would make the quote→WO idempotency guard structural rather than
   isolation-level-dependent.
4. **Idempotency on critical state transitions (F9).** The WO `COMPLETE` path remains a
   double-fire risk under concurrency; adopt the guarded-`updateMany` claim pattern used in
   the refresh-token and TOTP fixes.
5. **Infra (carried over, your call):** demo droplet disk ~75%; `BACKUP_DEST=local` and
   `HEALTHCHECKS_PING_KEY` unset remain the documented demo-box warnings.

---

*Audit performed 2026-06-20. Fixes committed on a branch; not deployed. Re-run the three
verification commands before any deploy.*

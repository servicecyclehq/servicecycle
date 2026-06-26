# DEMO LANDMINES v2
*8-agent adversarial scan — 2026-06-26*

Personas: M&A Due Diligence · Red Team Security · NETA/PE Domain Expert · Customer Implementation · SRE · Accessibility/UX · Data Integrity/QA · Competitive PM

Each item is grounded in actual file reads. File paths and line numbers are exact.

---

## 🚫 STANDARDS VIOLATIONS — a PE would not stamp work containing these

### S1. DANGER signal word fires on ANY voltage > 600 V — wrong threshold
**Severity: CRITICAL (safety)**
**Files:** `server/lib/arcFlashLabelDoc.ts:47`, `server/lib/arcFlashMitigation.ts:91`, `server/lib/arcFlashPermit.ts:57`, `server/lib/arcFlashGap.ts:68`

```ts
const danger = (ie != null && ie > 40) || (v != null && v > 600);  // ← WRONG
```

NFPA 70E signal word is driven by incident energy vs. 40 cal/cm², not voltage class. A 13.8 kV bus at 14.2 cal/cm² prints DANGER when the correct label is WARNING + PPE Cat 3. This directly contradicts §130.5(H) and ANSI Z535.4. A NETA contractor in a demo room will catch this immediately.

**Fix:** Remove `v > 600` from the `danger` expression entirely. Voltage class is an input to the study, not a surrogate for hazard severity. The seed's 13.8 kV bus at 14.2 cal/cm² should print WARNING.

---

### S2. NFPA 70E §130.5(G) five-year clock stated as a mandatory normative requirement
**Severity: HIGH (mis-citation, legal exposure)**
**Files:** `server/lib/arcFlashIntegrity.ts:229,289`, `server/lib/arcFlashConfidence.ts:31-32`

The code and all user-facing messages say: *"NFPA 70E §130.5(G) requires review every 5 years."* §130.5(G) has no such requirement in the 2018 or 2024 editions. The 5-year interval appears only in Annex D as a recommendation. The normative trigger is any system change. We're firing mandatory compliance alerts based on a non-existent rule.

**Fix:** Reframe as best-practice recommendation from Annex D. The change-detection logic (drift, load growth, device deficiency) is the correct normative path — promote those as the standards-grounded triggers.

---

### S3. §130.5(H) generated label missing required PE/firm identity
**Severity: HIGH (label non-compliance)**
**File:** `server/lib/arcFlashLabelDoc.ts` — `buildLabelModel()` has no `peName` / `performedBy` field

NFPA 70E-2024 §130.5(H) requires the arc flash label to identify the person, company, or AHJ who performed the study. The footer shows `"Printed from ServiceCycle"` (the software vendor, not the PE). Labels printed from SC are non-compliant for this field.

**Fix:** Add `peName` and `firmName` from the study record to `buildLabelModel()` and render in the label footer: *"Study by: [Firm Name] / [PE Name], PE."*

---

### S4. DANGER label cites NFPA 70E §130.2(B) incorrectly
**Severity: MEDIUM (wrong standard section)**
**File:** `server/lib/arcFlashLabelDoc.ts:92-97`

Label text: *"Energized work not permitted without documented justification (NFPA 70E 130.2(B))"* — §130.2(B) is the Energized Electrical Work Permit requirement, which actually *permits* energized work under specific conditions. The label should reference §130.5 and the >40 cal/cm² threshold, not §130.2(B).

**Fix:** Replace citation with: *"Incident energy exceeds 40 cal/cm² — no PPE category applies. De-energize before working. Per NFPA 70E §130.5."*

---

### S5. PPE Category 0 entirely missing from the band lookup
**Severity: MEDIUM (incomplete standards coverage)**
**File:** `server/lib/arcFlashMitigation.ts:106-114`

```ts
if (ie < 1.2) return null;  // ← wrong — Cat 0 exists for this range
```

NFPA 70E-2024 Table 130.7(C)(15)(a) defines Category 0 for tasks where IE is below 1.2 cal/cm². Returning `null` could be read as "no PPE required," which the standard does not support. Cat 0 still requires arc-rated daily wear.

**Fix:** Add `0: 1.2` to `PPE_CATEGORY_CAL`, return Cat 0 for `ie < 1.2`, and include Cat 0 in the sanity range check.

---

### S6. Prior arc-flash study seed cites IEEE 1584-2018 for a study performed in 2017
**Severity: MEDIUM (impossible — standard wasn't published until Sept 2018)**
**File:** `server/scripts/seed-demo.js:1401-1403`

```js
performedDate: addDays(now, -Math.round(9 * 365)),  // ≈ 2017
method: 'IEEE 1584-2018'  // ← published September 2018
```

**Fix:** Change `method` to `'IEEE 1584-2002'`. The narrative of "old study → re-study after upgrade" is actually stronger with the correct 2002 citation.

---

## 🔴 DEMO DATA DISASTERS — will embarrass in front of a customer

### D1. T-2 oil quality WO note says "138 kV class" — T-2 is a 13.8 kV transformer
**Severity: CRITICAL (factor-of-10 error)**
**File:** `server/scripts/seed-demo.js:1185`

```js
notes: 'Annual oil quality screen per ASTM D877; moisture content 28 ppm (IEEE C57.106 Action Level 1 for 138 kV class).'
```

T-2's nameplate (line 620): `primaryVoltage: '13.8 kV delta'`. IEEE C57.106 moisture limits are voltage-class dependent. A NETA engineer will catch this immediately.

**Fix:** Change to `'IEEE C57.106 Action Level 1 for 15 kV class'`.

---

### D2. LOTO document title says "1500kW Emergency Generator" — GEN-1 is 750 kW
**Severity: CRITICAL (2× nameplate error, cross-reference visible in UI)**
**File:** `server/scripts/seed-demo.js:1978`

The LOTO procedure title and the Asset Detail card are both visible on the same screen in the UI. A buyer who clicks both will see the discrepancy instantly.

**Fix:** Change title to `'750 kW Emergency Generator GEN-1 Lockout Procedure Draft'`.

---

### D3. Deficiency def5 linked to wrong work order (cross-asset FK)
**Severity: HIGH (data integrity, visible in drill-through)**
**File:** `server/scripts/seed-demo.js:1249-1255`

`def5` has `assetId: assets['SWGR-1A-1'].id` but `workOrderId: wo17.id` — and `wo17` is the GEN-1 monthly exercise (a completely different asset). Clicking the linked WO on a SWGR-1A-1 deficiency lands on a generator job ticket.

**Fix:** Link `def5` to the SWGR-1A-1 IR scan WO instead.

---

### D4. PPE Cat 3 shown alongside DANGER badge on 13.8 kV bus — contradictory display
**Severity: HIGH (NFPA 70E prohibits PPE-category method above 600 V)**
**File:** `server/scripts/seed-demo.js:1423-1424`

Root cause is S1 (voltage-based DANGER trigger). After S1 is fixed this becomes correct (WARNING + Cat 3). But in the current demo the label simultaneously says DANGER + PPE Cat 3, which any trained person will flag.

**Fix depends on S1.** Also set `ppeCategory: null` on all MV bus bindings that use the incident-energy method.

---

### D5. `conditionScore` never seeded — all DPS (Deficiency Priority Score) cells are blank
**Severity: MEDIUM (demo looks broken on the priority queue)**
**File:** `server/scripts/seed-demo.js` — no `conditionScore` set in any `assetSpec`

Every DPS cell in the Work Orders priority queue renders empty because `priorityScore = conditionScore × criticalityScore` and `conditionScore` is always null in the demo.

**Fix:** Add `conditionScore` to each seeded asset that has `criticalityScore`. E.g., SWGR-2M (C3 environment, known hotspot): `conditionScore: 4`.

---

## 🔒 SECURITY ISSUES

### SEC1. Email enumeration oracle on `/api/auth/register`
**Severity: HIGH — CWE-204**
**File:** `server/routes/auth.ts:340-347`

HTTP 409 + `"An account with this email already exists"` vs. HTTP 201 on unknown email. The code even comments this as "Pass-3 audit MED #5" but defers the fix. With distributed IP rotation (see SEC2) the rate limiter doesn't protect it.

**Fix:** Return HTTP 200 for both paths and send an out-of-band email regardless. Never differentiate in the HTTP response.

---

### SEC2. Rate limiter IP spoofing via CF-Ray + CF-Connecting-IP header forgery
**Severity: HIGH — CWE-290**
**File:** `server/routes/auth.ts:165-173`

The credential limiter keys on `CF-Connecting-IP` when a `CF-Ray` header matching `^[a-f0-9]{16}-[A-Z]{3}$` is present. Both headers are trivially forgeable by anyone connecting directly to the origin IP (bypasssing Cloudflare). Result: brute-force rate limiting is effectively infinite for attackers who know the origin IP.

**Fix:** Only trust CF headers when the socket's `req.ip` is itself in the verified Cloudflare CIDR allowlist. Application-layer header checking is insufficient.

---

### SEC3. Partner invite token leaks email address and account existence — no rate limit
**Severity: HIGH — CWE-200**
**File:** `server/routes/partnerInvitePublic.ts:15-57`

Public `GET /api/invite/accept?token=` (no auth required) returns `inviteeEmail` in plaintext, plus `existingAccount: true/false`. No rate limiting on this endpoint.

**Fix:** Rate-limit the endpoint. Return only valid/expired status; reveal email only to the authenticated user who matches during the POST.

---

### SEC4. Document upload accepts arbitrary MIME types — browser-supplied Content-Type echoed back
**Severity: HIGH — CWE-434**
**File:** `server/routes/documents.ts:71-79`

The `multer` `fileFilter` calls `cb(null, true)` for ALL types. Magic-byte check only runs for known types; unknown types return `false` (allow). `doc.fileType` is set from `req.file.mimetype` — attacker-controlled.

**Fix:** Add explicit MIME allowlist to `fileFilter` using the `ALLOWED_DOC_MIME` set that already exists — currently intentionally bypassed.

---

### SEC5. In-memory login lockout clears on every process restart
**Severity: MEDIUM — CWE-613**
**File:** `server/routes/auth.ts:207-247`

`loginFailMap`, `forgotResetMap`, `accountTouchCache`, and `_lastUsedCache` are all module-level `Map()`. A deploy or PM2 restart resets every lockout to zero failed attempts.

**Fix:** Back lockout state with a DB table (`FailedLoginAttempt` with windowStart, count, lockedUntil) with a TTL index.

---

### SEC6. `/api/errors` accepts unauthenticated POSTs — log injection risk
**Severity: MEDIUM — CWE-117**
**File:** `server/index.ts` — `app.use('/api/errors', optionalAuthenticateToken, errorsRoutes)`

Any unauthenticated party can POST to `/api/errors`. If the error message is logged via `console.error`, arbitrary strings land in the errors table and log stream.

**Fix:** Validate and sanitize all fields in `errorsRoutes`. Add body size limit.

---

## 💀 RELIABILITY / OUTAGE RISKS

### R1. Advisory lock fail-open → all crons fire twice on multi-instance boot
**Severity: CRITICAL (double backup, double alert emails, double seed)**
**File:** `server/index.ts:1667-1673`

The `pg_try_advisory_lock` catch block explicitly says "fail OPEN so a single-instance demo box still runs its crons." On a multi-instance or briefly-split deployment, all 12 crons run simultaneously on both instances: double `pg_dump`, double `runAlertEngine` (customers get duplicate alert emails), double `demoReset`.

**Fix:** Fail CLOSED on lock probe failure. Log a loud error. A box that can't reach its DB at boot has bigger problems.

---

### R2. S3 upload has no timeout — a hung connection locks the backup cron forever
**Severity: CRITICAL (no backups after one hung upload)**
**File:** `server/lib/backup.ts:232`

`getS3().send(new PutObjectCommand({...}))` with no `requestTimeout` or `AbortSignal`. If the S3 endpoint hangs mid-transfer, `_cronInFlight['backup'] = true` stays set forever. Future backup crons are silently skipped via `runOnce`. After 30 days, the local pruner deletes all existing backups.

**Fix:** Wrap upload in `Promise.race` with a 10-minute timeout that throws, so `runOnce` catches it and pings `fail`.

---

### R3. `pingHeartbeat` called before `try/catch` in 8 different crons — false success signals
**Severity: HIGH (monitoring lies)**
**File:** `server/index.ts:2308-2413` — `deficiencyAlerts`, `modernizationAlerts`, `arcFlashIntegrity`, `customerCfo`, `qemwAlerts`, `standardRevisionCron`, `partnerDigest`, `partnerRetentionArchival`

Pattern:
```ts
async () => {
  pingHeartbeat('deficiencyAlerts');  // ← fires BEFORE the run
  try {
    await runDeficiencyAlerts();       // ← if this throws...
  } catch (e) { throw e; }            // ← runOnce pings 'fail', but healthchecks.io already got 'success'
}
```

Healthchecks.io receives a success signal before knowing whether the run succeeded.

**Fix:** Remove bare `pingHeartbeat` calls from inside these callbacks — `runOnce` already handles start/success/fail pings.

---

### R4. `serviceOpportunityTrigger` has unguarded N+1 write loop — one DB error kills entire batch
**Severity: HIGH (silent incomplete processing)**
**File:** `server/index.ts:2196-2303`

Fetches up to 500 deficiencies + 500 C3 schedules then calls `maybeCreate` in a serial loop with a single outer `try/catch`. One constraint violation mid-loop throws, and all remaining assets in the batch never get quote requests that run. Accounts with >500 escalated deficiencies are silently undertreated on all subsequent runs.

**Fix:** Wrap `maybeCreate` calls individually. Paginate `findMany` queries rather than relying on `take: 500`.

---

### R5. No circuit breaker on weather/news/AI external API calls
**Severity: HIGH (pool exhaustion during outages)**
**File:** `server/lib/weatherScanner.ts:96-109`, `server/index.ts:1754-1760`

The weather poller runs every 15 minutes with a 15-second timeout per call. During an NWS outage, every tick holds a Prisma pool connection for 15 seconds. Four concurrent timeout waits saturate `connection_limit=10`. No exponential backoff.

**Fix:** Track consecutive failures per external dependency and skip the next N ticks after K consecutive failures.

---

### R6. `SHUTDOWN_TIMEOUT_MS = 25s` but Docker `stop_grace_period` defaults to 10s
**Severity: MEDIUM (in-flight DB writes hard-killed on deploy)**
**File:** `server/index.ts:2469`, `docker-compose.yml` (no `stop_grace_period` on server service)

**Fix:** Add `stop_grace_period: 30s` to the `server` service in `docker-compose.yml`.

---

### R7. `pg_dump` runs with no timeout — a slow dump locks backup cron in-flight
**Severity: MEDIUM**
**File:** `server/lib/backup.ts:150-163`

`child_process.spawn` wrapping `pg_dump` has no timeout. DB statement_timeout=30s applies to individual SQL queries, not the dump process.

**Fix:** Add `AbortSignal.timeout()` or `setTimeout` + `proc.kill()` bounding `pg_dump` to a maximum (20 minutes).

---

### R8. Backup failures are not logged to Better Stack — invisible in ops dashboard
**Severity: MEDIUM (blind during failure)**
**File:** `server/lib/backup.ts:267-291`

Failures send an admin email and ping healthchecks.io, but `betterStack.logEvent` is never called. The ops dashboard stays green while backups fail.

**Fix:** Add `betterStack.logEvent('backup_failed', {...})` alongside the existing email.

---

### R9. Sub-5-second cron completions leave zero log trail
**Severity: LOW (diagnosability)**
**File:** `server/index.ts:1533-1534`

```ts
if (ms > 5_000) console.log(...)  // fast crons (pruning, chain settler) are invisible
```

**Fix:** Remove the `> 5_000` condition — log all completions.

---

### R10. `uploads` bind mount unbounded — disk fill crashes Postgres
**Severity: MEDIUM**
**File:** `docker-compose.yml` — `./uploads` bind with no size constraint

A customer bulk-importing PDF test reports (5–50 MB each) can fill the droplet SSD. When disk fills, Postgres WAL write fails and the server returns 500s on all DB requests.

**Fix:** Add a Better Stack cron alert for disk < 20%. Add a soft per-account storage quota check before accepting uploads.

---

## 🏗️ M&A / ARCHITECTURE RISKS

### A1. `server/index.ts` is 2,607 lines — single file for all routing, crons, middleware, startup
**Severity: HIGH (post-close integration hazard)**

An integration team adding an enterprise feature will find this file a merge-conflict generator. The seller acknowledges `AssetDetail.jsx` (1,423 lines) as truncation-danger; `index.ts` is 2.5× worse and not flagged in handoff docs.

**Fix:** Extract crons → `server/crons/index.ts`, middleware → `server/middleware/stack.ts`, route mounts → `server/routes/index.ts`.

---

### A2. 5,000-row JavaScript sort for assets with `nextDue` — silent ceiling before enterprise scale
**Severity: HIGH (scalability)**
**File:** `server/routes/assets.ts:521-538`

The sort-by-nextDue query hard-caps at `take: 5000` and sorts in Node memory. Any account exceeding 5,000 assets gets silently wrong sort order for page 2+. The comment names the fix ("raw-SQL LATERAL join") but it's unimplemented.

**Fix:** Replace the JS sort with a raw SQL `LATERAL JOIN` or PostgreSQL window function.

---

### A3. AI budget guard is in-process memory only — resets to zero on every deploy
**Severity: HIGH (AI spend untracked after any restart)**
**File:** `server/lib/aiBudgetGuard.ts:80-89`

Module-level `_monthlyCloudflare` object. A PM2 restart, container restart, or deploy resets the monthly counter. On multi-instance, no shared state at all.

**Fix:** Move counters to a Postgres `ai_budget_counters` table with monthly partition key.

---

### A4. Stripe billing is a stub — no revenue collection wired
**Severity: HIGH (post-close build cost)**
**File:** `server/lib/stripe.ts:37-50`

`planType`, `planTier`, `stripeSubscriptionId` exist in schema. No Checkout session, no webhook handler, no dunning. `STRIPE_ENABLED: false` in docker-compose.

**Fix:** Complete the Stripe integration per `docs/stripe-integration.md`. Estimated: 2–3 engineer-weeks.

---

### A5. CI does not run on pushes to `main` — only on PRs and non-main branches
**Severity: MEDIUM**
**File:** `.github/workflows/ci.yml`

```yaml
on:
  push:
    branches-ignore: [main]
```

Direct push to `main` (the VPS-MCP deploy flow) bypasses TypeScript type checking and the full jest suite.

**Fix:** Remove `branches-ignore: [main]` from the CI trigger. Add `main` to the push trigger.

---

### A6. Python subprocess deps are unpinned — silent regression risk on Docker rebuild
**Severity: MEDIUM**
**File:** `server/Dockerfile:65-75`

`"pdfplumber>=0.11"` is an open lower bound. A `pdfplumber 0.12+` breaking change will downgrade ingest to pdfjs fallback silently. No `requirements.txt`, no lockfile.

**Fix:** Add `server/pyextract/requirements.txt` with pinned versions (`pdfplumber==0.11.4`). Run `pip install -r requirements.txt` in Dockerfile.

---

### A7. All date/currency formatting hardcoded to `en-US` — internationalization is zero
**Severity: MEDIUM (post-close blocker for non-US customers)**
**Files:** `server/lib/alertEngine.ts:131,231,596`, `server/lib/monthlyDigest.ts:233,259`, `server/lib/cfoReport.ts:37`, `server/lib/digestExcel.ts:54-55`

`toLocaleDateString('en-US')` and hardcoded `$` prefix throughout all emails, PDFs, and exports.

**Fix:** Replace with per-account locale settings using `Intl.NumberFormat` and `Intl.DateTimeFormat`.

---

## 🎨 ACCESSIBILITY / UX FAILURES

### UX1. Leave-behind PDF uses raw `fetch` without auth token — always returns 401
**Severity: CRITICAL (complete feature failure)**
**File:** `client/src/pages/WorkOrderDetail.jsx:172-199`

`fetch('/api/work-orders/:id/leave-behind-pdf', { method: 'POST' })` — no Authorization header. User gets `alert('Could not generate leave-behind PDF.')` with no useful explanation. This is a customer-facing deliverable.

**Fix:** Replace raw `fetch` with `api.post(...)` from the Axios client.

---

### UX2. AcceptInvite tagline reads "Software Renewal Management"
**Severity: HIGH (first thing a new field tech sees)**
**File:** `client/src/pages/AcceptInvite.jsx:81`

A NETA contractor's field tech gets an invite, clicks the link, and sees "Software Renewal Management." They question whether they clicked the right link.

**Fix:** Change to `"Electrical Asset Management"` or `"NFPA 70B Compliance Platform"`.

---

### UX3. No CSV import template download — bulk import is unusable without it
**Severity: HIGH (Day-1 customer blocker)**
**File:** `client/src/pages/ImportAssets.jsx:178-224`

The import page shows a drop zone with a single sentence of column guidance. No downloadable template, no valid enum values list. Customers open Excel, guess column names, upload, get mismatches.

**Fix:** Add "Download template CSV" link serving a pre-built file with correct headers and one example row showing valid `EQUIPMENT_TYPE` enum values.

---

### UX4. Complete modal — no definition of C1/C2/C3 condition ratings
**Severity: HIGH (field techs pick randomly, permanently changes maintenance schedule)**
**File:** `client/src/pages/WorkOrderDetail.jsx:107-147`

The complete modal asks for As-Found and As-Left condition with C1/C2/C3 dropdowns but no explanation. The modal's own description says "a degraded as-left immediately compresses the next interval" — techs don't know C3 just changed the maintenance schedule permanently.

**Fix:** Add the `CONDITION_TIP` InfoTip that already exists in `NewAsset.jsx:52-56`. Copy it into the modal.

---

### UX5. Reset password placeholder says "At least 8 characters" — server enforces 12
**Severity: HIGH (confusing admin failure)**
**File:** `client/src/pages/UsersPage.jsx:67`

`placeholder="At least 8 characters"` is hardcoded. `minLen` is fetched dynamically (defaults to 12) but never applied to the placeholder.

**Fix:** `placeholder={\`At least \${minLen} characters\`}`

---

### UX6. Field tech manual search fallback returns all account assets — scope leak
**Severity: HIGH (security + UX)**
**File:** `client/src/pages/field/FieldScan.jsx:53-59`

QR scan fallback calls `/api/assets` (global endpoint). The `field_tech` role is documented as assignment-scoped, but this search returns any asset in the account.

**Fix:** Change fallback endpoint to a scoped `/api/field/assets?search=` route.

---

### UX7. `outline: none` on `.search-input:focus` with no replacement — WCAG 2.4.7 failure
**Severity: HIGH (WCAG AA, legal liability)**
**File:** `client/src/index.css:19-20`

`.form-control:focus` has a box-shadow replacement (adequate). `.search-input:focus` has only `border-color` — no shadow. On browsers that override border-color, zero focus indicator remains. Affects every search box in the app.

**Fix:** Add `box-shadow: 0 0 0 3px rgba(var(--color-primary-rgb), 0.18)` to `.search-input:focus`.

---

### UX8. 12 unlabeled inputs in the NETA DeviceTests as-found/as-left grid
**Severity: HIGH (WCAG 1.3.1 / 4.1.2 — Level A failure)**
**File:** `client/src/components/ArcFlashAssetTab.jsx:836-915`

`<label>` and `<input>` are siblings (not parent-child) for all 12 trip-setting fields. Screen readers announce "edit number" with no accessible name. These are safety-critical fields.

**Fix:** Use `<label htmlFor="...">` + `<input id="...">` or restructure so input is direct child of label (pattern at line 828 is correct — apply it to the nested fields).

---

### UX9. Mobile hamburger button is 40×40px — below 44×44 minimum for gloved hands
**Severity: MEDIUM (field tech UX)**
**File:** `client/src/index.css:399-400`

The only way to access the sidebar on mobile. Field techs with work gloves will frequently miss it.

**Fix:** `width: 44px; height: 44px;` — `.btn` already sets this pattern for coarse-pointer.

---

### UX10. VoiceCaptureButton — no `aria-live` on transcription output
**Severity: MEDIUM (WCAG 4.1.3)**
**File:** `client/src/components/field/VoiceCaptureButton.jsx:79-96`

Screen reader users can't tell when recording started or what was transcribed. `aria-pressed` conveys toggle state but the live transcript div has no `aria-live`.

**Fix:** Add `role="status" aria-live="polite"` to transcript div. Add visually-hidden `aria-live="assertive"` span announcing "Recording started/stopped."

---

### UX11. FieldHome section collapse buttons have no `aria-controls` 
**Severity: MEDIUM (WCAG 4.1.2)**
**File:** `client/src/pages/field/FieldHome.jsx:82-109`

`aria-expanded` present but no `aria-controls` pointing to the content div. Screen reader users can't jump to the expanded content.

**Fix:** Add `aria-controls="section-{title}-content"` to buttons, matching `id` on content divs.

---

### UX12. DPS column in work order priority queue has no tooltip or scale explanation
**Severity: LOW (UX quick win)**
**File:** `client/src/pages/WorkOrdersList.jsx:382-401`

Scores like `24`, `20`, `12` appear with no explanation of scale or meaning.

**Fix:** Add `title="Deficiency Priority Score: condition × criticality. Range 1–25. Higher = more urgent."` to the column header.

---

## 🧪 TEST COVERAGE GAPS

### T1. Zero tests for `arcFlashSanity.ts` — the gate that prevents bad labels from printing
**Files:** No test in `server/tests/` references `arcFlashSanity`, `checkBusContradictions`, or `checkSystemContradictions`.

This engine blocks physically-impossible arc flash values (PPE category doesn't cover IE, arcing > bolted, clearing time < 0) from reaching printed labels. It has zero automated coverage.

**Fix:** Add `arcFlashSanity.test.js` covering all boundary conditions: arcing > bolted, PPE Cat doesn't cover IE, IE > 40 with category assigned, clearing time = 0 and = 2001, arc rating < IE.

---

### T2. Zero tests for `maintenanceInterval.ts` — the core NFPA 70B compliance calculation
**Files:** No test imports `maintenanceInterval`, `intervalMonthsFor`, `recomputeScheduleDates`, or `worstCondition`.

Every `nextDueDate` and overdue/breach alert depends on this. Bugs here directly affect regulatory compliance claims. The C3 interval derivation has untested rounding edge cases.

**Fix:** Add `maintenanceInterval.test.js` covering C1/C2/C3 columns, C1 ceiling at 60, C3 floor at 1, C3 ceiling at 12, `worstCondition` null handling.

---

### T3. No test for work order COMPLETE transition → schedule roll-forward
**Impact:** A work order completed with a future `completedDate` pushes `nextDueDate` into the future, silently masking overdue items on the dashboard.

**Fix:** Route-level test: create SCHEDULED WO, PATCH to COMPLETE with specific `completedDate`, assert linked schedule's `nextDueDate = completedDate + intervalMonths`.

---

### T4. No test for alert engine dedup key — could double-fire customer alerts
**File:** `server/scripts/seed-demo.js:1620-1645` — 17 seeded alerts rely on a comment that the engine skips them, with no test validating the dedup logic.

**Fix:** Unit test for `alertCadence.ts` dedup path: seeded `sent` row with exact `(scheduleId, alertType, leadDays)` triple must be skipped on next sweep.

---

## 🥊 COMPETITIVE / PRODUCT GAPS

### P1. No labor cost tracking or time-on-wrench
**Competitor attack:** *"Can you tell me what your electricians actually cost per work order?"*

The WorkOrder schema has `startedAt` / `completedDate` but no `laborHours`, `laborCostCents`, or tech rate card. The CFO report can't answer cost-per-PM. This is the first question a reliability engineer asks.

**Fix:** Add `laborHours` and `techRateOverride` to WorkOrder. Add time-started/time-finished in the field view.

---

### P2. No work order approval workflow
**Competitor attack:** *"Who authorized this $40,000 switchgear rebuild?"*

The 4-state WO lifecycle (SCHEDULED → IN_PROGRESS → COMPLETE → CANCELLED) has no approval gate. Any manager can complete any work order. The LOTO module has an approval flow — the WO module doesn't.

**Fix:** `requires_approval` flag on TaskDefinition + AWAITING_APPROVAL state + `POST /work-orders/:id/approve` endpoint.

---

### P3. Webhook catalog only covers 5 event types — all maintenance/scheduling
**Competitor attack:** *"Deficiency created? Nothing fires. Arc flash study expired? Nothing. You'd be polling the API constantly."*

`webhook.js` `EVENT_NAMES` has exactly 5 types: `maintenance.due`, `maintenance.overdue`, `maintenance.escalation`, `maintenance.regulatory_breach`, `workorder.completed`. The 5 configurable alert types (condition degradation, deficiency, arc flash expiry, asset decommission) fire through alertEngine for email/Slack but not through the webhook pipeline.

**Fix:** Wire each `AlertType` enum value through `deliverWebhook` in the engine. The infrastructure is fully built.

---

### P4. No work order type distinction — PM/corrective/emergency indistinguishable
**Competitor attack:** *"What percentage of your maintenance spend is reactive?"*

No `workOrderType` field on the WorkOrder model. The only distinction is whether `scheduleId` is set (PM-linked) or null (ad-hoc). PM ratio is the first question every reliability engineer asks.

**Fix:** Add `WorkOrderType` enum (PREVENTIVE / CORRECTIVE / EMERGENCY / INSPECTION), defaulting to PREVENTIVE when scheduleId is set.

---

### P5. No parts reservation or WO-linked parts consumption
**Competitor attack:** *"ServiceCycle has parts and spare inventory — but there's no link between a work order and the parts it consumes. The inventory is decorative."*

The `Part`, `SpareInventory`, and `AssetPartRequirement` models are well-structured. The WorkOrder model has no relation to SpareInventory. No reservation concept, no consumption event on WO completion.

**Fix:** `WorkOrderPartUsage` join table (workOrderId, partId, quantityUsed) + post-completion hook decrementing `SpareInventory.quantityOnHand`.

---

### P6. Two visible "Planned" report cards — first thing a buyer sees in the Reports hub
**Evidence:** `reportsRegistry.js` — `planned: true` entries visible to all users in the reports hub.

Enterprise customers expect at minimum: MTBF, MTTR, PM completion rate by tech, work order aging. None exist as live reports.

**Fix (near-term):** Hide planned entries behind a feature flag or replace with actual data queries. Ship WO aging first — it's achievable with existing data.

---

### P7. SSO dark / not self-service — IT teams can't configure it without contacting support
**Evidence:** `client/src/pages/SsoSettings.jsx` exists; the feature is feature-flagged or requires manual provisioning.

MaintainX lets an IT admin configure SAML in 15 minutes. SSO self-service is table stakes for enterprise security reviews.

**Fix:** Activate the self-service SSO configuration UI. The backend code is fully built.

---

## 📋 QUICK FIXES (< 30 minutes each)

| # | File | Fix |
|---|------|-----|
| Q1 | `server/index.ts:2469` + `docker-compose.yml` | Add `stop_grace_period: 30s` to server service |
| Q2 | `.github/workflows/ci.yml` | Remove `branches-ignore: [main]` |
| Q3 | `client/src/pages/UsersPage.jsx:67` | `placeholder={\`At least \${minLen} characters\`}` |
| Q4 | `server/scripts/seed-demo.js:1185` | "138 kV class" → "15 kV class" |
| Q5 | `server/scripts/seed-demo.js:1978` | "1500kW" → "750 kW" |
| Q6 | `server/scripts/seed-demo.js:1401` | `method: 'IEEE 1584-2002'` |
| Q7 | `client/src/pages/AcceptInvite.jsx:81` | "Software Renewal Management" → "Electrical Asset Management" |
| Q8 | `client/src/index.css:399-400` | Hamburger: 40px → 44px |
| Q9 | `server/index.ts:1533` | Remove `> 5_000` from cron duration log |
| Q10 | `server/lib/arcFlashLabelDoc.ts:92-97` | Fix §130.2(B) → §130.5 citation |

---

## 💪 WHAT'S ALREADY SOLID (don't touch)

These came up clean across all 8 agents:

- **No SQL injection** — zero `$queryRaw`/`$executeRaw`/`queryUnsafe` calls. All DB access through Prisma's typed ORM.
- **Tenant isolation** — `accountId` never accepted from request body; always sourced from JWT. IDOR test suite covers cross-account reads/writes.
- **JWT security** — algorithm pinned to `['HS256']`. Token epoch revocation wired to password change. Refresh tokens are opaque random strings stored hashed.
- **Arc flash data model** — IEEE 1584-2018 inputs (electrode config, conductor gap, working distance, voltage class, arcing current, clearing time, VarCf dual-scenario schema) are correctly modeled. No CMMS competitor comes close.
- **NFPA 70B interval math** — `maintenanceInterval.ts` genuinely implements three-axis condition assessment with C1/C2/C3 multipliers and automatic `autoConditionC3` flag. Most CMMS platforms call fixed-interval PM "condition-based" without implementing it.
- **NETA test measurement schema** — as-found/as-left value pairs, calibrated instrument provenance, ambient conditions, IEEE gas analysis, NETA priority 1-4 severity. Professionally modeled.
- **Offline mutation queue** — IndexedDB-backed FIFO outbox with photo support and FIFO replay is real, not marketing.
- **LOTO is structured data** — energy sources, isolation points, verification methods, ordered steps as queryable records. Not just PDF-upload-only.
- **SOC2 / audit posture** — TOTP MFA, SSO/SCIM (dark), SHA-256 tamper-evident audit log, immutable soft-delete on test measurements, SSRF-defended webhooks with DNS pinning, prepared SOC2 documentation.
- **Modal accessibility** — ConfirmDialog has `role="dialog"`, `aria-modal`, `aria-labelledby`, and focus trap. Skip-link is implemented. Error divs consistently use `role="alert"`. `prefers-reduced-motion` respected globally.

---

## PRIORITIZED FIX ORDER

**Ship before any demo or acquisition conversation:**
S1, D1, D2, D3, UX1, UX2, UX5, Q4, Q5, Q7

**Ship before due diligence:**
S2, S3, S4, S6, SEC1, R1, R2, A3, A4, A5, T1, T2, Q2, Q10

**Ship before first enterprise customer:**
SEC2, SEC3, SEC4, R3, R4, R5, A1, A2, UX3, UX4, UX6, P1, P2, P3, P4, P5, T3, T4

**Backlog (important but not urgent):**
S5, D4, D5, SEC5, SEC6, R6, R7, R8, R9, R10, A6, A7, UX7–UX12, P6, P7, Q1, Q3, Q6, Q8, Q9

---

*Generated 2026-06-26 by 8-agent adversarial scan. Previous scan: docs/DEMO_LANDMINES.md (all 19 items resolved as of commit 46e3ada).*

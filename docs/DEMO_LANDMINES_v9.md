# DEMO_LANDMINES_v9 - ServiceCycle v9 Smoke-Test Scan

Generated: 2026-06-27
Round: v9 (post-v8 regression + demo-readiness smoke test, 5 focused agents)
Personas: REGRESS-9 (server), REGRESS-9C (client), DEMO-9 (demo coherence), UX-9 (polish), SEC-9 (security/safety)

Actionable issues fixed in the v9 fix pass:
  CRITICAL: DEMO-9-1 dashboard double-counts hero bus; DEMO-9-2 incident register empty (wrong table)
  HIGH:     REGRESS-9-1 assetsImport case-insensitive regression; REGRESS-9C-1 Parts.jsx native confirm;
            REGRESS-9C-2 EquipmentTemplates/AssetDocumentsCard Toast props; UX-9-2 AlertsPage no pager
Key confirmations:
  SEC-9: ALL v8 security/safety fixes VERIFIED CORRECT.
  DEMO-9-3..6: degradation story, hero-bus DANGER, GEN-1, SWGR-2M all VERIFIED CONSISTENT.
Deferred to backlog (non-breaking polish): UX-9-1 pager visual consistency; remaining MEDIUM/LOW.

---

# REGRESS-9 — v8 server-side regression audit

Agent: REGRESS-9 (v9 smoke-test). Scope: regressions/bugs INTRODUCED by the v8 fix
cycle (commit f0368fb, 135+ fixes) on the SERVER side — code that compiles (tsc clean)
but is logically wrong, breaks an API contract, or fails at runtime/demo. Every finding
below was verified against the actual code at HEAD f0368fb with file+line cites. Where a
risky v8 fix was checked and found sound, it is recorded as VERIFIED OK rather than
padded into a finding.

Counts: CRITICAL 1 · HIGH 3 · MEDIUM 5

---

**[REGRESS-9-1] HIGH: assetsImport case-insensitive site + serial matching is broken by the COMP-8-12 file-scoping — duplicate sites/assets created on real imports**
The COMP-8-12 optimization replaced a full-table site/serial lookup (keyed by `lc(name)` /
`lc(serial)`, a TRUE case-insensitive match) with a file-scoped `name: { in: [...variants] }`
where `variants` is only `{ trimmed, trimmed.toLowerCase(), trimmed.toUpperCase() }`. Postgres
`in` is case-sensitive, so a site stored in MIXED case that is neither all-lower nor all-upper
(e.g. file `"Riverside Plant"` vs stored `"Riverside plant"`) is NOT in the variant set →
`siteByLc.has()` misses it → it lands in `unknownSites` → a DUPLICATE site is created on commit.
The identical flaw hits the serial-number dedupe (`fileSerialVariants`): an existing asset whose
serial is stored as `"aB123"` won't match file variant `"Ab123"`, so the dedupe is bypassed and a
duplicate asset is inserted. The old code matched both via `lc()` regardless of stored casing. The
comment explicitly claims "a case-sensitive `in` still matches a site stored in a different case" —
it does not, for any casing other than the three generated variants. Demo seed data uses consistent
casing so it likely won't fire in the walkthrough, but it is a real data-integrity regression for
customer imports (the product's "frictionless data-in" moat). Fix: keep the file-scoping for the
bound (good), but match case-insensitively — either `mode: 'insensitive'` per-name OR fetch the
candidate rows and re-key the result map by `lc()` (don't rely on `in` to do case folding).
File: server/routes/assetsImport.ts lines 616-664

**[REGRESS-9-2] MEDIUM: complianceReport CFO-8-4 "clear every action → 100%" guarantee only holds when totalActions ≤ limit (default 50); the displayed subset under-sums pointsToFull**
The cumulative-residual rounding walks ALL `actions` and forces the FINAL action's cumulative onto
`pointsToFull`, so the full list sums to exactly pointsToFull. But only `actions.slice(0, limit)`
(default limit 50) is returned as `trimmed`. When an account has >50 gap actions, the displayed
actions are the first 50 of N, whose per-action `pointsRecovered` sum to roughly
`pointsToFull × (cumUnits_at_50 / totalUnits)`, NOT pointsToFull — and the forced-final action is
trimmed out entirely. The fix comment asserts the displayed per-action values "sum to EXACTLY
pointsToFull," which is only true for short lists. This is a softer issue than the pre-v8 bug it
replaced (constant-rounding drift), and the UI already frames it as "top N actions," but the stated
invariant is still wrong for large gap lists. Fix: compute the residual rounding over the trimmed
(displayed) set, or document that per-action points are exact only across the full list, not the
shown subset.
File: server/lib/complianceReport.ts lines 808-833, 837-838

**[REGRESS-9-3] MEDIUM: export.ts truncation-sentinel row will throw in non-first column getters at the hard ceiling (250k rows)**
`appendTruncationRow` pushes a sentinel object `{ __truncationNotice: true }` into the `rows` array
that is then handed to the XLSX/CSV builder. Only the FIRST column's getter is wrapped to handle the
sentinel; every OTHER column getter runs against the bare sentinel object. Any getter that does
unguarded nested access (e.g. `r.site.name`, `r.asset.equipmentType`) will throw a TypeError mid-render
and 500 the export AFTER headers may already be streaming. This only triggers when a single model
exceeds EXPORT_HARD_CEILING (250,000 rows), so it is effectively unreachable in the demo or any
realistic single-contractor / 120-site book — but it is a latent crash on the exact "huge tenant" path
the fix was written to protect. Fix: make the sentinel render an all-blank row except column 0 (have
every getter early-return '' when `r.__truncationNotice`), or append the notice as a separate trailing
string rather than a fake data row.
File: server/routes/export.ts lines 58-79, 188-194, 278-281

**[REGRESS-9-4] MEDIUM: contractors GET default limit dropped from unbounded to 200 — large rosters silently truncate the dropdown source the comment says it preserves**
Pre-v8, `GET /api/contractors` returned the FULL roster (`data: { contractors }`, no take). The CUST-8-10
change adds `take: 200` by DEFAULT (applied even when no `?page`/`?limit` is sent). The fix comment
states the high default keeps "the many callers that use this purely as a dropdown source (work-order
pickers, asset filters) … getting the full roster for typical accounts without change." That is true only
for accounts with ≤200 contractors; an account with >200 now silently shows the first 200 (alphabetical)
in every picker, with no pagination UI on the dropdown consumers. The response shape did NOT regress
(`data.contractors` still present), so this is a truncation/contract-narrowing risk, not a crash. Lower
demo risk (the demo account has a handful of contractors) but a real behavior change for large books. Fix:
leave the default unbounded for this endpoint (only page when `?page`/`?limit` is explicitly sent, as
parts.ts does), or raise the dropdown callers to paginate.
File: server/routes/contractors.ts lines 70-99

**[REGRESS-9-5] MEDIUM: arc_flash_ingest_confirmed audit emits `peSignedOff: true` whenever a PE name is present, directly contradicting its own comment that a confirmed study is NOT PE-signed-off**
In the ingest-confirm audit (LEGAL-8-10), the provenance block sets `peSignedOff: !!peOnStudy` — i.e.
TRUE the moment a PE name string is carried onto the produced study. The comment two lines above states
the exact opposite intent: "A produced study is NOT PE-signed-off just because it was confirmed — it
carries AI-extracted numbers unless a qualified person re-verifies." So the audited attestation claims the
study WAS PE-signed-off purely because a name field was populated (which can happen via AI extraction or a
non-engineer typing a name), undermining the very "unverified AI provenance" the audit is meant to record.
The field is in the tamper-evident chain, so the wrong value is now durably attested. Fix: set
`peSignedOff: false` here (confirmation is never sign-off), and instead record `peName` separately as a
claimed-but-unverified attribution; sign-off should require an explicit qualified-person action, not the
mere presence of a name.
File: server/routes/arcFlashIngest.ts lines 685-695

**[REGRESS-9-6] MEDIUM: monthlyDigest CFO-8-1 pipeline now reads $0 when no INSPECTION rate is seeded (silent), vs the old forEquip path that always returned a floor**
The CFO-8-1 fix correctly stops pricing routine schedules at REPLACEMENT rates by switching to
`resolver.get('INSPECTION')`. But `get()` returns `null` when no INSPECTION rate exists at any tier
(account/group/partner/platform), whereas the old `forEquip()` path's resolver fell back to a
`minCents: 0` floor object. So if an account has no INSPECTION rate configured, `serviceRate` is null →
`svcMin`/`svcMax` are null → the entire "Service pipeline" line silently reports $0 for every account in
the digest, with no warning. This is arguably more correct than a 10–100× overstatement, but it is a new
silent-zero failure mode for any deployment that didn't seed an INSPECTION platform default. Fix: confirm a
platform-default INSPECTION rate is always seeded, or fall back to a labeled "rate not configured" rather
than summing $0 into a headline figure.
File: server/lib/monthlyDigest.ts lines 182-194

**[REGRESS-9-7] CRITICAL: VERIFIED OK — no qualifying CRITICAL regression found; the riskiest v8 fixes are sound (see below)**
After tracing every server-side area the v8 fixes touched, none rose to a CRITICAL runtime/contract break.
This slot records that conclusion explicitly so the count is unambiguous: the audit-trail rewrites, the
auth/SSO fail-closed flips, the finance "round-once" refactors, the raw-SQL dashboard, and the pagination
shape changes were all verified to be wired correctly (details in VERIFIED OK below). The most impactful
real issue is REGRESS-9-1 (HIGH).
File: (summary) — see VERIFIED OK section

---

## VERIFIED OK — riskiest v8 fixes checked and found sound

- **Audit-trail hash-chain coverage (the central LEGAL-8-6 claim).** The hash chain is computed by a
  BACKGROUND SETTLER cron that picks up rows where `rowHash IS NULL` every ~30s
  (activityLogChain.ts:139-196), NOT inside `writeLog`/`activityLog.create`. Therefore EVERY row written
  to ActivityLog gets chained later, regardless of whether a route used the object-signature
  `writeLog({...})` (activityLog.ts:49) or a file-local positional `logActivity(userId, accountId, action,
  details)` wrapper (sites.ts:32, arcFlashIngest.ts:67) that writes `prisma.activityLog.create` directly.
  The repeated "routed through ActivityLog so the hash chain commits to the values" comments are accurate.

- **Arc-flash audit writes — signatures and field names all valid.** `writeLog` is exported as `writeLog`
  and imported as `writeActivityLog` in arcFlashIncidents.ts, deficiencies.ts (line 26), v1/arcFlash.ts;
  the positional `logActivity` wrappers exist in sites.ts/arcFlashIngest.ts. `req.apiKey` (id+name) IS set
  by apiKeyAuth middleware (apiKeyAuth.ts:103) for the v1 device audit; `accountId = req.apiKeyAccountId`
  is in scope (v1/arcFlash.ts:161). `incident.studyStateSnapshot` IS a real Json column on ArcFlashIncident
  (schema.prisma:3253). The POST/PATCH/import audit writes are fire-and-forget but writeLog/logActivity
  swallow their own errors, so a logging failure cannot break or roll back the mutation. The arc-flash
  studyStateSnapshot query was correctly migrated off the non-existent `arcFlashLabel` model to
  `systemStudyAsset` with a logged (not swallowed) failure path.

- **Auth SSO fail-closed (auth.ts:677-712).** The fail-OPEN→fail-CLOSED flip on the `sso.required` read is
  correctly gated: the ONLY identity allowed through an indeterminate (throwing) read is the local-admin
  break-glass (`user.role === 'admin' && !user.ssoManaged`). The demo's auto-provisioned admin is a local
  admin (ssoManaged defaults false, schema.prisma:516), so it is never locked out. Normal login when the
  read SUCCEEDS and sso.required is absent/false is unchanged.

- **SSO id_token fail-closed (sso.ts:161-171).** Rejects the callback when `id_token` is absent unless
  `SSO_ALLOW_MISSING_ID_TOKEN=true`. Only affects a misconfigured Polis (no OIDC signing keys); does not
  touch the demo's password-login admin path. The INFOSEC-8-1 admin-MFA-on-SSO addition is fail-OPEN +
  audited (never blocks).

- **passwordPolicy HIBP (passwordPolicy.ts).** Default `HIBP_FAIL_MODE='open'` and the check runs only in
  `validateStrength` (password set/change/signup), never on the LOGIN path — so it cannot block a
  legitimate login, and an HIBP outage does not brick signup by default. A confirmed breach hit still
  rejects regardless of mode.

- **alertEngine band-ownership (CUST-8-2, alertEngine.ts:174-184, 594-613).** `tierCrosses` fires exactly
  ONE positive lead tier per run (the smallest threshold still ≥ daysUntil), and the dedup `fired` set is
  SEEDED FROM PERSISTED ALERTS (status in sent/acknowledged, cycle-aware via lastCompletedDate,
  lines 567-578), so it is durable across runs. Each tier fires once as daysUntil descends through its
  band; no double-fire and no never-fire. Overdue/escalation tiers still fire on any crossing.

- **maintenanceDebt CFO-8-5/8-6 (round-once).** Now accumulates RAW dollar sub-totals and rounds the
  account totals/plan ONCE (lines 112-192). Per-site object retains `modernization.year1/year3/year5` shape
  so the CSV builder (lines 243-254) still works. (Minor: the documented "Year5 = Deferred + Repair +
  ModTotal" identity holds on raw values but each is independently rounded on the TOTAL row, so it can be
  off by ±1-2 dollars — cosmetic, not a regression.)

- **cfoReport CFO-8-13 (realized WO spend).** The new query selects the `partsUsed` relation
  (schema.prisma:1103) with `unitCostCents`+`quantityUsed` (3356-3357) and `laborCostCents` (1083) — all
  relation/field names valid, so the report does not throw. Cents are summed then converted to dollars
  ONCE. CFO-8-12 trajectory reads snapshot stats with nullish-safe `st.complianceRate ?? st.rate`.

- **dashboard COMP-8-3 (raw SQL).** All five table names in the two `$queryRaw` blocks
  (`maintenance_schedules`, `assets`, `sites`, `spare_inventory`, `parts`) match their `@@map` values
  exactly. The new GROUP BY filter (`isActive=true AND nextDueDate IS NOT NULL AND archivedAt IS NULL`) is
  IDENTICAL to the old `scheduleBase` (dashboard.ts:41-46), so `scheduleCount` and `complianceBySite` are
  computed over the same population. BigInt is handled via `::int` casts + `Number()`.

- **deficiencies bulk-resolve routing (deficiencies.ts:271).** `POST /bulk-resolve` cannot be captured by a
  param route: there is a `PUT /:id` but NO `POST /:id`. The IMMEDIATE-severity ≥20-char note gate is
  enforced for the whole batch, cross-tenant/resolved ids are skipped, and each resolve writes an audit row.

- **parts GET (parts.ts) + v1/telemetry GET /channels.** Both preserve backward-compatible response shapes:
  parts returns the bare `data: Part[]` array UNLESS pagination is explicitly requested; telemetry keeps
  `data` as the channel array and adds `pagination` as a sibling. No array→object break for existing callers.

- **proposalBuilder CFO-8-7.** Recommended option is now `[...yr1, ...yr3]`, so its total === byYear.year1 +
  byYear.year3 (lines 151-175) — reconciles with the year breakdown.

- **revenueAttribution CFO-8-14, fleetDashboard CFO-8-2, rateCards CFO-8-9, ai.ts COMP-8-10/11,
  news.ts COMP-8-14.** All verified: priced/unpriced split is additive and complete; account-forecast now
  applies the same `installDate: { not: null }` filter as the OEM forecast; rateCards PUT still
  `Math.round(minDollars*100)` (rateCards.ts:70) so the no-rounding GET round-trips safely; ai.ts text-block
  guards and the cloudflare-vision missing-key error are correct handled throws; news.ts cooldown releases
  the in-flight latch in `finally` and only starts the cooldown on success.

---

# REGRESS-9C — v8 client-side regression audit

Agent: REGRESS-9C (v9 smoke-test). Scope: client (React/Vite) regressions/bugs
INTRODUCED or LEFT-BEHIND by the v8 fix cycle (commit `f0368fb`). The client
already builds clean, so this hunts logical/runtime/contract bugs a build won't
catch — verified against server route shapes and the actual hook/component APIs.
Every finding is verified in code with file+line cites. Where a v8 fix verified
OK, it is recorded at the bottom rather than invented into a defect.

Counts: CRITICAL 1 · HIGH 4 · MEDIUM 6

---

**[REGRESS-9C-1] HIGH: v8 "branded confirm" conversion MISSED Parts.jsx itself — delete-part and remove-inventory still fire the native browser dialog**
The v8 round (UX-8-2 / CUST-8-11) converted six surfaces to the branded
`useConfirm()` dialog — StudyAssetBinding, EquipmentTemplates, RequiredPartsPanel,
SpareInventoryPanel, AssetDocumentsCard — but the top-level **Parts catalog page
itself was never converted**, even though the v8 landmine doc named "delete part"
explicitly. `deletePart()` still calls `window.confirm(\`Delete part ${part.partNumber}? …\`)`
and `deleteInventory()` still calls `window.confirm('Remove this inventory entry?')`.
The v8 diff touched Parts.jsx only to add pagination/URL-persistence; it did not
import `useConfirm` or replace these two calls. Result: the exact demo-day
inconsistency the fix claimed to eliminate persists on the Parts page — deleting
an asset shows the branded modal, deleting a part shows the gray OS box. (RequiredPartsPanel
/ SpareInventoryPanel, which are AssetDetail-embedded, ARE converted; only the
standalone Parts page was skipped.) Fix: `import { useConfirm } from '../context/ConfirmContext'`,
`const confirm = useConfirm()` in the `PartDetail` component, and replace both
`window.confirm(...)` calls with `await confirm({ title, message, confirmLabel, danger:true })`.
File: client/src/pages/Parts.jsx lines 171-177, 189-193

**[REGRESS-9C-2] HIGH (verified pre-existing, NOT a v8 regression, but the v8 Toast rewrite was the moment to fix it and didn't): EquipmentTemplates + AssetDocumentsCard call `<Toast message=… type=…>` — neither prop exists on the Toast component**
The Toast component's contract is `<Toast toast={obj} onClose={fn} />` where `obj`
carries `{ message, variant, duration }`. EquipmentTemplates renders
`<Toast message={toast.message} type={toast.type} onClose={…} />` (line 326) and
sets `setToast({ message, type: 'success' })`; AssetDocumentsCard does the same
(line 285, `setToast({ ..., type: 'success' })`). Because the component reads
`toast.message`/`toast.variant` and gets neither (`toast` prop is undefined),
**every toast on these two surfaces renders nothing** — the "Deleted template",
"Template saved", "Document added/removed" confirmations are silently swallowed.
Verified against `f0368fb~1` that this predates v8 (the broken JSX is unchanged
by the commit), so it is a latent bug, not a v8 regression — BUT the v8 Toast
stacking rewrite (UX-8-14) was the natural place to catch it and the round left
it. Fix: `setToast({ message, variant: 'success' })` and `<Toast toast={toast} onClose={…} />`
on both files. (Other callers — DeficienciesPage, WorkOrderDetail, AssetsList,
NewAsset — already use the correct `toast=`/`variant` shape and are unaffected.)
File: client/src/pages/EquipmentTemplates.jsx lines 310, 313, 326, 332; client/src/components/AssetDocumentsCard.jsx lines 274, 285, 298

**[REGRESS-9C-3] MEDIUM: AssetsList truncation banner is suppressed at an exact 500-row boundary — the new CUST-8-4 paged loop can silently drop assets without warning**
The new paged-loop fetch (CUST-8-4) breaks when `allAssets.length >= FETCH_CAP`
(5000) at the TOP of each iteration, then computes `wasTruncated = allAssets.length > FETCH_CAP`.
Because `FETCH_PAGE` (500) divides `FETCH_CAP` (5000) evenly, an account with >5000
matching assets fills to **exactly 5000** after 10 pages, the loop breaks before
fetching page 11, and `5000 > 5000` is `false` — so the "showing the first 5,000 —
narrow your filters" banner does NOT render even though data WAS truncated. The
honest-count promise in the code comment ("even then the count is honest") fails
at that boundary. Impact is small (only at >5000 assets, well past the demo's ~67),
but it reintroduces a silent-truncation hole the fix was meant to close. Fix:
track truncation from `totalPages` (`wasTruncated = first.pagination?.pages > pagesFetched`
or `allAssets.length >= FETCH_CAP && morePagesRemained`), not from a strict `>`
on the capped length.
File: client/src/pages/AssetsList.jsx lines ~321-338 (the `for` loop + `wasTruncated` computation in the v8 diff)

**[REGRESS-9C-4] MEDIUM: ComplianceCalendar overdue look-back always fires 4 sequential requests — the documented "stop when a window returns no schedules" early-exit was never implemented**
The CUST-8-6 overdue rewrite comments promise it "walk[s] backward in 36-month
windows until a window returns no schedules (or we hit a 10-year safety bound)."
The actual loop is `for (let w = 0; w < MAX_WINDOWS; w++)` with no `break` on an
empty window — it unconditionally issues all 4 `/api/dashboard/calendar` calls
every time overdue mode is opened, even for a brand-new account with zero overdue
items (4 round-trips for nothing). The date math itself is correct and contiguous
(`[now-143mo, now+1mo)`, deduped by `s.id`, client-filtered `t < nowT`), so this
is a performance/contract-drift issue, not wrong data. Fix: `if (rows.length === 0) break;`
inside the loop after each window, matching the comment.
File: client/src/pages/ComplianceCalendar.jsx lines ~178-200 (overdue windowed loop)

**[REGRESS-9C-5] MEDIUM: FailedSyncBanner `expand()` reads a stale `open` from the closure — benign today, fragile under change**
`expand()` calls `setOpen(o => !o)` (functional update, correct) but then gates the
lazy fetch on `if (!open && items === null)` — `open` here is the pre-toggle value
captured in the render closure, not the value just set. It happens to work (first
expand: `open===false` → fetch once; later toggles: `items` already set), so there
is no live bug, but the logic is self-inconsistent (one line uses the updater form,
the next trusts the stale value) and will misbehave the moment someone adds a refetch
or a second trigger. Fix: derive intent from a single source — e.g.
`const next = !open; setOpen(next); if (next && items === null) { … }`.
File: client/src/components/field/FailedSyncBanner.jsx lines 38-43

**[REGRESS-9C-6] MEDIUM: FailedSyncBanner success/clear confirmation can never appear — the `note` short-circuit is unreachable once `failed` hits 0**
The retry/dismiss flow sets a green confirmation via `setNote(...)`, and the
component renders that note only inside the `if (!failed || failed <= 0)` block.
But `useOutboxStatus()` is a live subscription: the instant `retryFailed`/`clearFailed`
call `_notify()`, `failed` drops to 0 and the component re-renders into the
`!failed` branch — which is fine for showing `note` — EXCEPT `onRetry` sets
`note` to a *success* string only when `res.sent > 0` with a `setTimeout(... 5000)`
to clear it, while `onDismiss` sets no note at all. The net effect is inconsistent:
a successful **dismiss** shows nothing (acceptable), but a partial retry
(`res.failed > 0`) sets a "still rejected — review and fix" note that is then
immediately hidden because `failed > 0` keeps the component in the RED branch
(which does not render `note`). So the "N still rejected" guidance after a partial
retry is written to state but never shown. Fix: render `note` in BOTH branches
(or hoist the note line above the `if (!failed)` early-return).
File: client/src/components/field/FailedSyncBanner.jsx lines 22-30, 49-58

**[REGRESS-9C-7] MEDIUM: Deficiencies bulk-resolve toast shows "X resolved" even when the server resolved fewer than selected and skipped the rest — count can mislead at page boundaries**
`handleBulkResolve` posts `ids: [...selectedIds]` and renders the toast from
`{ resolved, skipped }`. The selection is page-scoped and cleared on reload, and
the server only resolves in-account OPEN rows (resolved/cross-tenant ids fall into
`skipped`). That is handled — but the client's `selectedHasImmediate` (which drives
the mandatory-note requirement) is computed from `deficiencies.some(d => selectedIds.has(d.id) && d.severity === 'IMMEDIATE')`, i.e. only rows on the CURRENT page.
Because selection is page-scoped this is consistent today. The latent risk: if a
future change lets selection span pages (or pre-selects off-page ids), the client
would not require the note for an off-page IMMEDIATE, and the server would then
400 with "minimum 20 characters" — a confusing rejection after the user already
confirmed. Not a live bug (selection is strictly page-local and cleared on reload),
logged as a contract-coupling note. The resolved/skipped toast wording itself is
correct. No fix required now; keep selection page-scoped or recompute
`selectedHasImmediate` from a fetched-by-id severity map if cross-page select ships.
File: client/src/pages/DeficienciesPage.jsx lines ~321-370 (handleBulkResolve + selectedHasImmediate)

**[REGRESS-9C-8] MEDIUM: outbox `retryFailed` moves rejected entries to the QUEUE tail and re-flushes immediately — a permanently-bad mutation (archived asset, validation rule) re-fails and silently lands back in the failed store, looking like the retry "did nothing"**
`retryFailed(api)` strips failure metadata, re-`add`s each entry to the QUEUE, then
calls `flush(api)`. For a TRANSIENT cause this is right. But the common case the
banner exists for (COMP-8-5: "asset was archived" / a 409/422 validation reject) is
NOT transient — on re-flush the server rejects it again, `flush` moves it straight
back to the failed store, and the user sees the banner reappear with the same count.
`onRetry` handles `res.failed > 0` by setting a note (see 9C-6, which is itself not
shown), but the UX reads as "Retry now did nothing." This is behaviorally acceptable
(the data genuinely can't be saved as-is) but undiscoverable — there is no signal
distinguishing "still offline" from "server still rejects." Fix: when
`retryFailed`'s resulting flush reports `failed > 0`, surface the per-entry
`serverError` (it's already stored) so the tech learns WHY, instead of a bare
re-appearing banner.
File: client/src/lib/outbox.js lines 156-178 (retryFailed) + client/src/components/field/FailedSyncBanner.jsx onRetry

**[REGRESS-9C-9] MEDIUM: ReportsHub intro copy now asserts "Every card in the registry is live" / "Revenue Attribution … round out the set" — a runtime-unverifiable claim that will read as false if any registry entry still carries `planned: true`**
The v8 ReportsHub rewrite changed the header text from "Activity summaries and
test-value trending are planned" to "The arc-flash suite, EMP document, and full
account export round out the set" and the doc-comment to "Every card in the registry
is live … no registry entry currently sets [planned]." This is a content assertion
about `client/src/tables/reportsRegistry.js` that the JSX does not enforce — if the
registry still defines a `planned:true` card (the component still renders a disabled
"Planned" card for one), the prose and the grid contradict each other in front of a
buyer. The render path is unchanged and correct; this is a copy-vs-data drift risk
introduced by the v8 wording change. Fix: assert in a test that no
`reportsRegistry` entry has `planned:true`, OR soften the copy to not claim
completeness. (Verify the registry; if a planned card remains this is a HIGH demo
credibility hit.)
File: client/src/pages/ReportsHub.jsx lines 2-15, 219-224; client/src/tables/reportsRegistry.js

**[REGRESS-9C-10] CRITICAL-adjacent → recorded as MEDIUM (verified the data path, no live break): AlertsPage `capped` banner + bell reconciliation depends on the server returning a numeric `count`; if the route omits `count`, the header silently falls back to the loaded length and the "of N" reconciliation the fix promised is lost**
The CUST-8-1 fix reads `setServerTotal(typeof d.count === 'number' ? d.count : list.length)`
and computes `capped = totalCount > loadedCount`. This is correct IF and ONLY IF
`GET /api/alerts` returns `data.count` as the true open-alert total (not the page
length). If the route returns only `data.alerts` (no `count`), `serverTotal`
collapses to `list.length`, `capped` is always false, and the banner/bell-reconcile
promise silently no-ops — the very undercount UX-8 flagged. The client code is
defensive (no crash), so this is a contract dependency to verify, not a confirmed
break. Fix: confirm `routes/alerts.ts` GET returns `data.count` = total open alerts
(independent of the 500 page cap); add a test pinning the field name.
File: client/src/pages/AlertsPage.jsx lines 146-156, 198-208; depends on server/routes/alerts.ts GET / response `count`

**[REGRESS-9C-11] MEDIUM: AssetsList multi-page fetch holds the whole set in memory and re-fetches ALL pages on every filter/sort keystroke change — the CUST-8-4 loop has no abort of in-flight pages mid-loop beyond the `cancelled` flag check between awaits**
The paged loop checks `if (cancelled) return;` after each `await`, which prevents
stale state writes, but a rapid filter change while page 7-of-12 is in flight does
NOT abort the underlying axios request — it lets the current page resolve, sees
`cancelled`, and bails. For the demo population this is invisible; at the 5000-cap
target it means up to 10 sequential round-trips can be in flight-and-discarded per
keystroke burst (the effect re-runs on 11 dependencies including `debouncedSearch`).
Search is debounced (good) but sort/filter chips are not. Not a correctness bug
(state is guarded), a load/latency concern at scale. Fix: pass an `AbortController`
signal into `api.get` and abort on cleanup, or cap concurrency.
File: client/src/pages/AssetsList.jsx lines ~300-345 (async paged loop + dependency array)

---

## Riskiest v8 fixes VERIFIED OK (did not break)

- **Toast stacking rewrite (UX-8-14)** — preserves the `{ toast, onClose }` prop
  contract exactly. `onClose` still fires when the newest toast dismisses; the
  `seenRef`/identity guard prevents double-push on unrelated re-renders. All
  correct callers (`<Toast toast={…} onClose={…}>` with `variant`) keep working.
  client/src/components/Toast.jsx.
- **WorkOrderDetail complete-gate (CUST-8-14)** — `blockingImmediate` is computed
  from `wo.deficiencies` (the WO-scoped relation), which exactly matches the
  server's completion block `where:{ workOrderId, severity:'IMMEDIATE', resolvedAt:null }`
  (server/routes/workOrders.ts:592-599). No false block, no false allow. Verified.
- **WorkOrderDetail Clear-assignment (CUST-8-12)** — `clearFieldUser()` PUTs
  `{ userId: null }` to `/assignment` and refetches; replaces the old no-op that
  only reset the dropdown. Correct. client/src/pages/WorkOrderDetail.jsx:354-366, 1372-1376.
- **ConfirmDialog conversions (StudyAssetBinding, EquipmentTemplates,
  RequiredPartsPanel, SpareInventoryPanel, AssetDocumentsCard)** — each uses
  `await confirm({ title, message, confirmLabel, danger:true })` and the
  `useConfirm()` contract (ConfirmContext.jsx) returns a `Promise<boolean>` with
  exactly those option keys. All five are correct. (Parts.jsx is the one miss — 9C-1.)
- **AuditsPage shape realignment (CUST-8-9)** — now reads `data.visits` (was
  `data.audits`), `rec.auditVisit` (was `rec.audit`), `a.recommendationCounts`
  (was `a.recCounts`); all three match the actual route response
  (server/routes/audits.ts:206, 196, 272). The recommendations pagination
  (page/total/pages) matches the route envelope. Verified correct — this would
  have been a blank-list regression if mis-aligned, and it is aligned.
- **DeficienciesPage pagination + bulk-resolve (CUST-8-3/7)** — list reads
  `data.deficiencies` + `data.pagination{total,pages}` (matches deficiencies.ts:81-87);
  bulk-resolve reads `data.resolved`/`data.skipped` (matches deficiencies.ts:322-324);
  the IMMEDIATE-requires-note rule matches the server's `hasImmediate && note.length<20`
  (deficiencies.ts:291). Page-1 reset on filter change correctly skips first mount
  via `firstFilterRun` ref. Verified.
- **Parts pagination (CUST-8-11)** — always sends `page`+`limit`, so the route
  returns the `{ parts, pagination }` envelope (parts.ts:405-407); client reads
  `d?.parts` / `d?.pagination` with an array fallback. URL persistence + 300ms
  search debounce + page-reset-on-filter all correct. (The confirm-dialog gap is
  separate — 9C-1.)
- **AssetsList bootstrap paged loop (CUST-8-4)** — consumes `r.data.data.assets`
  and `pagination.pages` correctly (bootstrap.ts:208-222); terminates (bounded by
  `totalPages` and `FETCH_CAP`); pages are server-disjoint so no dedupe needed.
  Only the exact-boundary banner suppression (9C-3) and abort/concurrency (9C-11)
  are flagged.
- **FailedSyncBanner wiring (COMP-8-5/6)** — `FailedSyncBanner` is imported and
  rendered in FieldAsset.jsx:31/659, FieldBatchNameplate.jsx:22/103,
  FieldNewAsset.jsx:20/161. `failedCount`/`failedEntries`/`retryFailed`/`clearFailed`
  all exist in outbox.js and are re-exported through fieldApi.js as
  `getFailedMutations`/`retryFailedMutations`/`clearFailedMutations`; `useOutboxStatus`
  now carries `failed`. No undefined import. (The two UX subtleties are 9C-5/6.)
- **fieldMutate online/offline return contract (COMP-8-6)** — returns the raw axios
  response when online (so `res.data?.data?.asset` works) and `{queued:true}` when
  offline/network-failed (so `res?.queued` works); rethrows 4xx/5xx while online.
  FieldAsset OCR, FieldNewAsset, FieldBatchNameplate all branch on this correctly.
  Verified. client/src/lib/fieldApi.js:27-44.
- **CSS/token changes (index.css, tokens.css, ErrorBoundary, DemoModeBanner,
  Nameplate*)** — purely additive aliases (`--space-N`, `--radius-*`,
  `--font-*`, `--color-ink`, etc.) added to index.css's loaded `:root`; tokens.css
  re-documented as non-imported reference. ErrorBoundary/DemoModeBanner fallbacks
  changed to theme-aware tokens with neutral system-color fallbacks (`Canvas`,
  `GrayText`). No reference to a still-undefined variable; no broken import.
  Verified.
- **FleetDashboard serviceRep + error copy (DEMO-8-5)** — gate changed from
  `data.account.serviceRep` (never set) to `data.account.serviceRepName ? … : (No rep assigned)`,
  so the rep bar now renders (or shows a placeholder). Error fallback no longer
  leaks raw axios strings. Correct. client/src/pages/FleetDashboard.jsx:174-195, 750.
- **NewAsset draft persistence (CUST-8-13)** — sessionStorage write gated behind
  `draftRestored.current` so the empty initial state never clobbers a saved draft;
  restore skipped when `?templateId=` present; cleared on successful create.
  Correct. client/src/pages/NewAsset.jsx:131-163, 441.

---

# DEMO-9 — demo-data coherence re-check

Round: v9 smoke-test of the SEEDED demo after v8 (commit f0368fb) fixed the DEMO-8
demo-data contradictions. Scope: re-trace the hero arc-flash bus, conditionScore
persistence, and the other seed edits the v8 pass touched; confirm the demo tells
ONE coherent story; surface any NEW contradiction the seed edits introduced.

Method: read the two seed scripts (`server/scripts/seed-demo.js`,
`seed-arcflash-trend-demo.js`) against the routes/components that RENDER the values
(`server/routes/arcFlashIngest.ts`, `routes/v1/arcFlash.ts`, `Dashboard.jsx`,
`ArcFlashReport.jsx`, `ArcFlashDashboardCard.jsx`, `ArcFlashAssetTab.jsx`,
`WorkOrdersList.jsx`). Every finding cites file + line. Items explicitly marked
VERIFIED CONSISTENT (v8 fix held) vs STILL-BROKEN / NEW.

Counts: CRITICAL 2 · HIGH 4 · MEDIUM 6

---

**[DEMO-9-1] CRITICAL (NEW): The hero bus is counted TWICE as DANGER on the dashboard — the card shows "2 DANGER buses" and lists "SWGR-1A Main Bus" twice, while every other surface shows 1**
The v8 fix made `labelSeverity:'danger'` consistent, but introduced a count split.
`GET /api/arc-flash/dashboard` queries `systemStudyAsset.findMany({ where: { accountId } })`
with **NO `study.supersededById:null` filter** (arcFlashIngest.ts:893), so it returns
BOTH bindings the seed creates on SWGR-1A-1: the prior study bind (14.2 cal/cm², 13.8kV,
seed-demo.js:1430-1436) AND the current bind (19.6 cal/cm², seed-demo.js:1437-1445).
Both are 13.8 kV (volts>600) so the DANGER filter (arcFlashIngest.ts:900) counts BOTH →
`dangerBuses:2`, and `topDanger` (line 901-904) lists the SAME bus name "SWGR-1A Main Bus"
twice (once at 14.2, once at 19.6). The dashboard card renders `dangerBuses` verbatim
(ArcFlashDashboardCard.jsx:40) and maps `topDanger` into the "Hottest equipment" list
(lines 48-53). But the Fleet rollup (arcFlashIngest.ts:940, `supersededById:null`), the
Label Report, and the v1 labels API (v1/arcFlash.ts:57) all filter superseded studies →
they show **1** DANGER bus. A buyer who reads "2 DANGER buses / SWGR-1A Main Bus listed
twice" on the home dashboard, then opens the Arc Flash report and sees "1 DANGER", catches
a self-contradiction on the flagship feature — the same DEMO-8-1 failure mode, inverted from
a severity split into a count split. This is the single biggest remaining demo-coherence risk.
Fix: add `study: { supersededById: null }` to the dashboard `systemStudyAsset.findMany` where
clause (arcFlashIngest.ts:893) so the dashboard counts only current bindings like every other
surface.
File: server/routes/arcFlashIngest.ts lines 892-904; server/scripts/seed-demo.js lines 1430-1445; client/src/components/ArcFlashDashboardCard.jsx lines 40, 45-53

**[DEMO-9-2] CRITICAL (STILL-BROKEN): The arc-flash incident register is empty in the demo — all 6 seeded incidents (incl. the 18-mo ARC_FLASH_EVENT on the hero bus) are written to the WRONG table**
The seed writes its 6 incidents (1 open + 5 resolved, incl. an ARC_FLASH_EVENT on
SWGR-1A-1 and the GEN-1 overspeed trip) to `prisma.incidentLog` (seed-demo.js:1868). But the
arc-flash incident register and the per-asset Arc Flash tab's "Incidents & near-misses" card
read a DIFFERENT table, `prisma.arcFlashIncident`: the per-asset tab loads it at
arcFlashIngest.ts:1235 and renders `data.incidents` (ArcFlashAssetTab.jsx:365, 462-472); the
account register loads it at arcFlashIngest.ts:1600; the fleet rollup reads it at line 949 for
the `recentIncidents`/`incidentInjuries` columns; the risk score reads it at line 1738. A
repo-wide grep confirms `arcFlashIncident.create`/`createMany` exists ONLY in route files,
NEVER in any seed script. Net effect on the demo: SWGR-1A-1's Arc Flash tab shows the empty
"Incidents & near-misses" state even though `incidentLog` has the perfect 18-months-ago
ARC_FLASH_EVENT on that exact asset (seed-demo.js:1869-1879); the Fleet rollup's incident
columns are all 0, so the "a recent real-world incident outranks DANGER%" sort
(arcFlashIngest.ts:1001) never fires; and the SWGR-2M open-incident → risk-score-upgrade story
(seed comment, seed-demo.js:1866, 1924-1932) never reaches the arc-flash risk score. The
incidents DO surface, but only on the general IncidentLogCard (AssetDetail), not the arc-flash
register a buyer opens from the hero feature. Fix: add an `arcFlashIncident.createMany` block in
seed-demo.js mirroring the arc-flash-relevant incidents (ARC_FLASH_EVENT on SWGR-1A-1; the open
SWGR-2M thermal alarm) with `incidentType`/`busName`/`occurredAt` fields, OR have the seed write
those rows to `arcFlashIncident` in addition to `incidentLog`.
File: server/scripts/seed-demo.js lines 1868-1933; server/routes/arcFlashIngest.ts lines 1235, 1600, 949, 1738; client/src/components/ArcFlashAssetTab.jsx lines 365, 462-472

**[DEMO-9-3] HIGH (VERIFIED CONSISTENT): conditionScore + priorityScore now persist — the degradation story is no longer "—"**
DEMO-8-3 fix held. `_createAsset` now writes `conditionScore: spec.conditionScore ?? null` and
computes `priorityScore = conditionScore × criticalityScore` (seed-demo.js:417-420). The 8
degradation-story assets carry their scores (e.g. SWGR-1A-1 conditionScore:4 criticality:4 →
DPS 16, line 643; T-1 conditionScore:3 criticality:5 → DPS 15, line 624). The consumers read
them: WorkOrdersList renders `a.conditionScore ?? '—'` and the DPS column reads `a.priorityScore`
(WorkOrdersList.jsx:460, 470). The "Top scored assets (DPS = condition × criticality)" panel
(WorkOrdersList.jsx:438, 451) now sorts on real values instead of all-null. No remaining "—" on the
degradation assets.
File: server/scripts/seed-demo.js lines 417-420, 624, 643; client/src/pages/WorkOrdersList.jsx lines 438, 451, 460, 470

**[DEMO-9-4] HIGH (VERIFIED CONSISTENT): Hero-bus severity is now DANGER on all four CURRENT-study surfaces**
DEMO-8-1/2 fix held for the current (non-superseded) binding. SWGR-1A-1's current bind stamps
`labelSeverity:'danger'` (seed-demo.js:1441), the printed snapshot also `'danger'`
(seed-demo.js:1481), and `seed-arcflash-trend-demo.js` derives the same: `labelSeverity = mv ? 'danger'
: 'warning'` with `mv` true for 13.8 kV (lines 110-116, 171). All four render paths agree on DANGER for
the current bus: dashboard counts volts>600 (arcFlashIngest.ts:900); Fleet counts volts>600
(line 968); v1 labels API prefers stored `labelSeverity` else volts>600 (v1/arcFlash.ts:78);
Label Report reads stored `labelSeverity` (ArcFlashReport.jsx:44, 108). Matches the ingest
classification rule `deriveLabelSeverity` (volts>600 ⇒ DANGER, arcFlashIngest.ts:159-164). No
WARNING-vs-DANGER split remains on the current bus. (The residual double-count is a COUNT bug, not a
severity bug — see DEMO-9-1.)
File: server/scripts/seed-demo.js lines 1441, 1481; server/scripts/seed-arcflash-trend-demo.js lines 110-116, 171; server/routes/arcFlashIngest.ts lines 159-164, 900, 968

**[DEMO-9-5] HIGH (VERIFIED CONSISTENT): GEN-1 overspeed trip now chronologically bridges to the clean monthly exercise**
DEMO-8-6 fix held. The overspeed-trip incident is at -91 days (seed-demo.js:1918, "Overspeed relay
tripped GEN-1 … governor drifted out of calibration … Governor adjusted by Caterpillar-certified
technician"), and WO #17 (the clean GREEN exercise) is at -20 days (seed-demo.js:1140) with notes that
now explicitly reference it: "Governor calibration (re-adjusted after the prior overspeed-trip finding)
confirmed stable — no faults this cycle" (line 1143). The trip pre-dates and is closed out by the clean
exercise, with a narrative bridge. No remaining contradiction. (Caveat: the trip lives in `incidentLog`,
so it surfaces on the general incident card, not the arc-flash register — see DEMO-9-2.)
File: server/scripts/seed-demo.js lines 1140-1143, 1918-1922

**[DEMO-9-6] HIGH (VERIFIED CONSISTENT): SWGR-2M duplicate-deficiency contradiction resolved (older RECOMMENDED now superseded/closed)**
DEMO-8-7 fix held. The 350-day-old RECOMMENDED "early-stage 12°C" deficiency on SWGR-2M's B-phase joint
now carries `resolvedAt: addDays(now, -12)` and a corrective-action note "Superseded by the current
IMMEDIATE deficiency (38 deg C) on this same B-phase joint" (seed-demo.js:1271-1278). The open IMMEDIATE
deficiency (ΔT 38°C, -12 days, seed-demo.js:1232-1238) is now the sole OPEN item on that joint. A buyer no
longer sees the same connection simultaneously flagged "repair at earliest convenience" and "de-energize at
first opportunity." Consistent.
File: server/scripts/seed-demo.js lines 1232-1238, 1271-1278

**[DEMO-9-7] MEDIUM (VERIFIED CONSISTENT): Quote-dossier ages now match install dates**
DEMO-8-8 fix held. `dossierSnapshotT1.ageYears` is now 29 (was 16) and `dossierSnapshotGen1.ageYears` is
now 21 (was 8) (seed-demo.js:1690, 1697), matching install dates 1997-06-12 (≈29 yr) and 2005-08-23 (≈21 yr)
at the 2026 demo date (seed-demo.js:621, 677). A buyer cross-checking a quote dossier against the asset no
longer sees a 13-year age discrepancy. NOTE: these are still hard-coded literals, not computed from
installDate at seed time — they are correct for the 2026 demo year but will drift in a future year. Low
residual; relative-compute is the durable fix.
File: server/scripts/seed-demo.js lines 1690, 1697, 621, 677

**[DEMO-9-8] MEDIUM (VERIFIED CONSISTENT): Disaster-Response events now geographically match the Iowa/Illinois sites**
DEMO-8-10 fix held. Both seeded DisasterEvents are now Quad Cities / IA-IL, not Wisconsin: event 1 "Severe
Thunderstorm Watch — Scott County, IA / Rock Island County, IL", `affectedStates:['IA','IL']`
(seed-demo.js:1364-1366); event 2 "Winter Storm Warning … Eastern Iowa / Northwestern Illinois — Quad Cities
metro", `affectedStates:['IA','IL']` (seed-demo.js:1380-1382). Both wire to the real site IDs
`[riverside.id, eastgate.id]` (Davenport IA / Moline IL). Geography is now coherent with the Sites page.
File: server/scripts/seed-demo.js lines 1364-1372, 1380-1388

**[DEMO-9-9] MEDIUM (VERIFIED CONSISTENT): Audit-note study-era drift fixed — literal "2022" removed, relative phrasing used**
DEMO-8-13 fix held. The insurer rec and internal finding no longer hard-code "2022"; they use relative
phrasing — "labels in place reference superseded study values" (seed-demo.js:1527) and "two kits contain
cal/cm2 ratings from the superseded (prior) study" (seed-demo.js:1555), with response "re-labelled with current
incident-energy study values" (line 1558). Tracks the relative-dated studies (current arc_flash ~4.2 yr,
IEEE 1584-2018; prior ~9 yr, IEEE 1584-2002 — seed-demo.js:1393-1421) on any reset day. No fixed-year drift.
File: server/scripts/seed-demo.js lines 1527, 1555, 1558, 1393-1421

**[DEMO-9-10] MEDIUM (VERIFIED CONSISTENT): AFX per-tool template overclaim demoted from "EXACT (verified)" to "DRAFT / FORMAT-MATCHED"**
DEMO-8-11 fix held. ArcFlashFleet.jsx no longer renders a green "EXACT — column names verified from vendor
templates" badge. The badge text is now "DRAFT" (line 187) and the legend reads "FORMAT-MATCHED = mapped to the
tool's published format · DRAFT = check with your tool. Confirm columns against your tool version before
importing" (line 407). Matches the deferred status of the per-tool templates; no diligence overclaim remains on
that panel.
File: client/src/pages/ArcFlashFleet.jsx lines 187, 407

**[DEMO-9-11] MEDIUM (NEW, low-severity): Prior-study bus binding has no labelSeverity, so its row in the per-asset study HISTORY shows blank severity next to the DANGER current row**
The current SWGR-1A-1 bind stamps `labelSeverity:'danger'` (seed-demo.js:1441), but the prior-study bind
(seed-demo.js:1430-1436) sets none — it relies on derive-fallback. The per-asset Arc Flash tab loads ALL bindings
for the asset including superseded ones (arcFlashIngest.ts:1226-1230, no superseded filter) and renders a study
history table (ArcFlashAssetTab.jsx:286, study-revision rows). Where the report/v1 paths derive severity from
volts>600 for a null `labelSeverity`, a history table that reads the stored field verbatim would show the prior
14.2 row with a blank/`—` severity beside the current DANGER row — a minor inconsistency on the trend tab a
careful buyer could notice (both are the same 13.8 kV bus, so both are DANGER by rule). Low impact because IE
trend (14.2→19.6) is the story, not the per-row severity badge. Fix: add `labelSeverity:'danger'` to the prior
bind too (seed-demo.js:1430-1436), or have the history renderer derive severity from voltage when the field is
null. (Confirm the exact history-row severity rendering in ArcFlashAssetTab.jsx:560-585 before changing.)
File: server/scripts/seed-demo.js lines 1430-1436; server/routes/arcFlashIngest.ts lines 1226-1230; client/src/components/ArcFlashAssetTab.jsx lines 286, 560-585

**[DEMO-9-12] MEDIUM (STILL-BROKEN, pre-existing): "Clears DANGER (>40)?" what-if is permanently "No" for the only seeded incident-energy bus**
DEMO-8-9 not addressed by the v8 pass. The mitigation what-if labels success as removing DANGER only when
`ie>40 && ieAfter<=40` (ArcFlashAssetTab.jsx ~648-654; the tab even notes "is DANGER because of incident energy
itself (IE > 40)" at line 653). The only seeded bus with incident energy is SWGR-1A-1 at 19.6 cal/cm² (already
<40 — seed-demo.js:1440), which the platform labels DANGER purely on the 13.8 kV>600 V rule, not on IE. So driving
the flagship incident-energy-reduction tool on the demo's hero bus always returns "Clears DANGER: No," which reads
as the feature not working. Fix: seed a >40 cal/cm² bus (or a bus whose DANGER is IE-driven) so the what-if can
demonstrate a real "Yes," OR adjust the what-if copy to acknowledge a voltage-driven DANGER bus.
File: server/scripts/seed-demo.js lines 1437-1445; client/src/components/ArcFlashAssetTab.jsx lines 648-654

---

## Summary

The v8 pass landed its core fixes cleanly: hero-bus severity (DEMO-8-1/2), conditionScore persistence
(DEMO-8-3), GEN-1 chronology (DEMO-8-6), SWGR-2M dedup (DEMO-8-7), dossier ages (DEMO-8-8), disaster
geography (DEMO-8-10), audit-era drift (DEMO-8-13), and the AFX overclaim (DEMO-8-11) are ALL verified
consistent in code. Two CRITICAL coherence risks remain for a buyer clicking through:

1. (NEW) The dashboard double-counts the hero bus (2 DANGER vs 1 everywhere else, bus listed twice) because
   the `/dashboard` query lacks the `supersededById:null` filter every other arc-flash surface has — the v8
   severity fix exposed it. One-line fix.
2. (STILL-BROKEN) The arc-flash incident register is empty in the demo: all 6 seeded incidents go to
   `incidentLog`, but the register + per-asset Arc Flash incidents card + fleet incident columns + risk score
   all read `arcFlashIncident`, which no seed script ever populates.

DEMO-8-9 (what-if permanently "No" on the hero bus) and the prior-bind blank-severity row are lower-severity
residuals.

---

# SEC-9 — v9 security/safety re-check

Persona: SEC-9, v9 security/safety re-verification agent.
Scope: confirm the v8 (commit `f0368fb`) auth/SSO/CSP hardening and arc-flash safety
audit trail are CORRECT — did not open a new hole, did not break a legitimate flow —
and flag any residual deal-/liability-risk. READ-ONLY. Verified against source at
HEAD `f0368fb`. HIGH-confidence findings only; each marked VERIFIED CORRECT or PROBLEM.

Counts: CRITICAL 0 / HIGH 0 / MEDIUM 3 (all residual/hardening, not regressions).
Bottom line: **v8 security/safety fixes verified correct** — fail-closed logic, signed-token
enforcement, HIBP fail-mode, audit writes, and Table 130.4 boundaries are all sound and
did not break normal login or the demo. The MEDIUMs below are residual-risk notes, not
defects introduced by v8.

---

**[SEC-9-1] VERIFIED CORRECT: auth.ts SSO-required enforcement now fails CLOSED without bricking normal login (INFOSEC-8-2)**
The break-glass identity is computed once (`_isBreakGlassAdmin = user.role === 'admin' && !user.ssoManaged`) and reused in BOTH the success and the catch path, so the two branches can never disagree. On a successful `sso.required` read that is absent/false, control falls straight through unchanged — normal password login (including the demo's auto-provisioned local admin) is untouched. On a *read throw*, only the local-admin break-glass proceeds (logged `sso_break_glass_login` w/ `reason: policy_read_failed_break_glass`); every other identity gets a 403 `SSO_REQUIRED` (logged `login_blocked_sso_required` w/ `reason: policy_read_failed_fail_closed`). This denies only when it genuinely cannot confirm SSO-is-not-required, and cannot be bypassed by inducing a DB error. No path bricks legitimate login.
File: server/routes/auth.ts lines 688-713

**[SEC-9-2] VERIFIED CORRECT: sso.ts id_token signature is validated and the fail-closed only triggers when no signed token is present (INFOSEC-8-3)**
When `token.id_token` is present, the code calls `validateIdToken({ idToken, jwksUri, expectedIss, expectedNonce })` (JWKS signature + iss/exp/nonce) and any failure → `failRedirect('id_token_invalid:…')` — a forged/invalid token is rejected, never accepted. When the IdP returns NO id_token, the default branch now `return failRedirect(res, 'id_token_missing')` (fail closed); the legacy "proceed on PKCE/state/userinfo alone" path exists ONLY behind the explicit `SSO_ALLOW_MISSING_ID_TOKEN=true` opt-in. There is no path that accepts an unsigned/forged token by default, and valid signed logins still succeed. (PKCE + single-use state + tenant cross-check remain in force on every path.)
File: server/routes/sso.ts lines 152-172

**[SEC-9-3] VERIFIED CORRECT: passwordPolicy HIBP — a confirmed breach is ALWAYS rejected; fail-open governs outages only, default mode safe (INFOSEC-8-7)**
A confirmed hit (`breach.breached === true`, i.e. the API answered and the suffix matched) returns `valid:false` and is rejected before the fail-mode branch is ever consulted — it is impossible for a known-compromised password to be accepted, even mid-outage. The `failedOpen` branch (HTTP non-200 / network error / timeout) is the ONLY thing `HIBP_FAIL_MODE` governs: `closed` → reject with a retry message, `open` (default) → accept so an HIBP outage cannot brick signup/reset. Every fail-open event is logged (`console.warn`) so a silent control gap is visible. Default `open` is the correct availability posture for the demo; `closed` is available for strict operators.
File: server/lib/passwordPolicy.ts lines 56-63, 136-160, 207-227

**[SEC-9-4] VERIFIED CORRECT: activityLog ipAddress merge is non-clobbering and backward-compatible (INFOSEC-8-4)**
`writeLog` folds an optional `ipAddress` into `details.ip` ONLY when (a) `ipAddress` is truthy AND (b) `details.ip == null` — an existing `details.ip` is never overwritten, and a blank ipAddress is a no-op. Callers that omit the param write exactly as before (`details ?? undefined`). The Json-only `details` column is used because no dedicated `ipAddress` column exists, which is the correct shape. twoFactor `/setup` exercises the new param correctly (`ipAddress: req.ip`). No clobber, fully backward-compatible.
File: server/lib/activityLog.ts lines 47-71

**[SEC-9-5] VERIFIED CORRECT: CSP/CORS changes do not break the app and introduce no over-permissive value (INFOSEC-8-11/12)**
`scriptSrc`/`styleSrc` stay `'self'` (the app's own bundles still load); the new `workerSrc`/`manifestSrc`/`mediaSrc` are all `'self'`, so the PWA service worker + manifest still register. `upgradeInsecureRequests` is emitted only under `NODE_ENV=production` (harmless on http localhost). `reportUri`/`reportTo` + the `Reporting-Endpoints` header are emitted only when `CSP_REPORT_URI` is set (off by default → self-hosted instances unaffected); `reportTo` is correctly an array per Helmet's API. CORS still requires a bearer token on every protected route — the allowed no-Origin path carries no ambient-cookie risk because auth is bearer-token, not cookie. No directive blocks the app's own scripts/styles/workers; no wildcard or over-permissive value added.
File: server/index.ts lines 471-505, 573-631

**[SEC-9-6] VERIFIED CORRECT: arc-flash incident snapshot now reads a REAL model and failures are logged, not swallowed (LEGAL-8-1)**
The POST `/arc-flash-incidents` handler no longer queries the non-existent `arcFlashLabel` model. It queries `prisma.systemStudyAsset` (the real durable model — fields verified at schema.prisma 1275-1370), picks the current binding (non-superseded study wins, then newest `performedDate`), and normalizes `superseded: !!study.supersededById` before calling `buildStudyStateSnapshot` (which reads `study.superseded` — verified at arcFlashIncident.ts:50). A snapshot failure is `console.error`-logged (was a silent `catch (_)`), so a broken evidentiary path surfaces. studyStateSnapshot is now populated from a real model.
File: server/routes/arcFlashIncidents.ts lines 108-145; server/lib/arcFlashIncident.ts lines 33-55

**[SEC-9-7] VERIFIED CORRECT: incident-energy / PPE / PE-attribution / incident mutations write before/after audit records to real fields (LEGAL-8-2/3/4/7/8)**
All flagged mutations now write before/after audit rows routed through `writeLog`/`logActivity` (so the ActivityLog hash chain commits to the values), referencing real schema fields:
- Incident logged (`arc_flash_incident_logged`) + amended (`arc_flash_incident_amended`, per-field old→new over `AUDITED_INCIDENT_FIELDS` incl. injury/oshaRecordable/occurredAt) — arcFlashIncidents.ts 174-195, 252-271.
- Study PE attribution / date (`system_study_pe_attribution_changed` vs `system_study_updated`, distinct alertable action when peName/peLicense change) — sites.ts 852-877.
- Study-asset bind/unbind capture `labelBefore`/`labelAfter` and `removedLabel` (incident energy, AFB, PPE, working distance) — sites.ts 1014-1062, 1085-1106.
- Results import (`arc_flash_results_imported`, per-bus changes, non-preview path only) — arcFlashIngest.ts 2461-2474.
- AFX overwrite + reviewer-edit before/after — arcFlashIngest.ts overwrite/draft blocks.
- v1 public API protective-device write now audits (`api_v1_protective_device_created`, hashes payload + API-key id) — v1/arcFlash.ts. All field names verified against schema.

**[SEC-9-8] VERIFIED CORRECT: NETA-8-8 shock-approach boundaries match NFPA 70E Table 130.4 and never fabricate out-of-table values (NETA-8-8)**
Spot-checked `TABLE_130_4` against NFPA 70E Table 130.4(E)(a), AC, exposed fixed parts (values stable across 2018/2021/2024):
- 151–750 V → Limited 42 in (3'6"), Restricted 12 in (1'0") ✓
- 751 V–15 kV → Limited 60 in (5'0"), Restricted 26 in (2'2") ✓ (13.8 kV resolves here)
- 15.001–36 kV → 72 in / 31 in ✓ · 36.001–46 kV → 96 in / 33 in ✓ · 46.001–72.5 kV → 96 in / 39 in ✓
- 50–150 V → Limited 42 in, Restricted = "avoid contact" (null) ✓ · <50 V → no boundary (null) ✓
Above 72.5 kV returns all-null with the comment "outside the table's scope — do not fabricate a value." `v <= 0`/unparseable → null. Stored PE value overrides the table when present; provenance flagged via `*Source: 'study'|'table130_4'`. Tests assert these exact values (arcFlashLabel.test.ts 27-31). Public portal (`labelSnapshot`, arcFlashLabelPublic.ts:46) and printed PDF (`buildLabelModel`, arcFlashLabelDoc.ts) both derive from the SAME `shockApproachBoundaries()` — no portal-vs-PDF contradiction introduced.
File: server/lib/arcFlashLabel.ts lines 36-90; server/lib/arcFlashLabelDoc.ts lines 68-183

**[SEC-9-9] VERIFIED CORRECT: storage signed-URL TTL, twoFactor audit, setup.ts key encryption (INFOSEC-8-15/8-8, DD-8-14)**
- storage.ts: S3 pre-signed URL default dropped 3600s→900s (`PRESIGN_TTL_DEFAULT`), tunable via `STORAGE_S3_URL_TTL_SECONDS` / per-call override, hard-clamped to [60s, 3600s] so a typo cannot mint a multi-day capability. Correct. (storage.ts 44-60, 251-261)
- twoFactor.ts: `/setup` now writes `2fa_setup_initiated` with `ipAddress: req.ip` (exercises the INFOSEC-8-4 merge); `/disable` + `/backup-codes/regenerate` retain their TOTP/backup-code proof-of-possession gate, so a stolen access token alone can't disable 2FA. Correct. (twoFactor.ts 240-253)
- setup.ts: POST `/api/setup/ai` encrypts the key at rest via `encryptIfNeeded()` on the wizard path (no plaintext-until-re-save window); the header comment and `encryptionNote` response are reconciled to match the code. Correct. (setup.ts 300-358)

---

## Residual risks (MEDIUM — not v8 regressions, carried forward)

**[SEC-9-10] MEDIUM: Audit trail / safety records remain rewritable by anyone with app-server + DB access (no external anchoring)**
The new arc-flash before/after records all route through ActivityLog so the hash chain commits to them — a genuine improvement — but `activityLogChain.ts` still concedes the chain "Does NOT defeat: insider with both DB access AND app-server access … who rewrites the chain and recomputes all subsequent hashes." For a CMMS whose value proposition is defensible arc-flash/OSHA evidence, the honest answer to "can the safety audit log be silently rewritten?" is still "yes, by anyone who roots the one app server." v8 widened *coverage* (good) but did not add external anchoring (WORM/notarization/HSM-held signing key). Recommend periodic external head-hash anchoring before a safety/SOC2 buyer's diligence. (Pre-existing DD-8-2/LEGAL-8-6; restating because v8's audit writes inherit exactly this limitation.)
File: server/lib/activityLogChain.ts lines 30-95

**[SEC-9-11] MEDIUM: In-memory login-lockout and per-user TOTP fail counters reset on every deploy/restart and are per-replica**
`auth.ts` `loginFailMap` and `twoFactor.ts` `_totpUserFailMap` are process-local; a PM2 restart (i.e. every deploy) clears lockout state mid-attack, and a future multi-replica deploy makes the budget per-replica (N×). v8 honestly documents this as deferred (needs a TOTP-scoped table) and the 5-min pending-2FA TTL + IP limiter bound the exposure, so this is accepted, not a regression — but it remains a real brute-force-resistance gap a security reviewer will flag against the enterprise-SSO positioning. The `FailedLoginAttempt` model exists in schema but the lockout logic is not wired to it. Recommend wiring login lockout to the existing table and adding a TOTP-scoped store before claiming enterprise-grade brute-force protection.
File: server/routes/auth.ts lines 240-260; server/routes/twoFactor.ts lines 43-60

**[SEC-9-12] MEDIUM: `SSO_ALLOW_MISSING_ID_TOKEN=true` is a single env var that disables signed-identity proof on the SSO path**
The INFOSEC-8-3 fix is correct and fails closed by default, but the escape hatch is a plain boolean env flag: an operator who sets `SSO_ALLOW_MISSING_ID_TOKEN=true` (e.g. to make a misconfigured Polis "just work") silently downgrades every SSO login on that instance to PKCE/state/userinfo with no cryptographic subject proof. It is logged on each use (`console.warn`), and PKCE + single-use state + tenant cross-check still apply, so impact is bounded — but it is a footgun that turns off a cryptographic identity control for the whole instance. Recommend gating it to non-production only, or surfacing a loud persistent startup banner (not just a per-request warn) when it is enabled in production. Analogous to DD-8-5's `SCIM_WEBHOOK_TOLERANCE_MS=0` footgun.
File: server/routes/sso.ts lines 164-167

---

# UX-9 — v9 polish sweep

Persona: UX-9, final product-designer polish pass before demo day. Read-only.
Scope: the NEW/CHANGED UI shipped in v8 (commit f0368fb) — pagination controls,
FailedSyncBanner, WorkOrdersList skeletons, ConfirmDialog conversions, Toast
stack, token/theme changes, and the public arc-flash label — plus anything
adjacent that still reads as unpolished. All findings verified against code at
HEAD f0368fb. Where a v8 fix landed cleanly it is NOT reported (ErrorBoundary,
DemoModeBanner, NameplateReview alt-text + borders all verified fixed).

Counts: HIGH 2 · MEDIUM 8 · LOW 4 (14 total)

---

**[UX-9-1] HIGH: The six new list pagers are three different components — sloppy side-by-side**
v8 added pagination to six pages but each was hand-built, so they don't match. AssetsList uses the shared `.pagination`/`.page-btn` CSS classes with chevron glyphs (`‹`/`›`) and `aria-label`s on the buttons. DeficienciesPage, Parts, WorkOrdersList, and AuditsPage instead use inline-styled `<div>`s with `.btn.btn-secondary.btn-sm` buttons and arrow glyphs (`←`/`→`). AlertsPage has no pager at all (see UX-9-2). A buyer who clicks Assets → Deficiencies → Work orders sees the page control visibly change shape, button style, and arrow glyph on each hop. There is already a canonical pager (`.pagination` in index.css) — the others should adopt it. Fix: extract a single `<Pagination page total pages onPage>` component and use it on all six pages.
File: client/src/pages/AssetsList.jsx lines 1023-1048; client/src/pages/DeficienciesPage.jsx lines 617-638; client/src/pages/WorkOrdersList.jsx lines 566-578; client/src/pages/AuditsPage.jsx lines 768-780; client/src/pages/Parts.jsx lines 634-657; client/src/index.css (.pagination / .page-btn)

**[UX-9-2] HIGH: AlertsPage never got a real pager — it's the one high-volume list still capped with no way forward**
The v8 CUST-8-1 fix for the 100-row alert cap added only a "Showing N of M open alerts — use a filter chip" info banner (lines 404-410); it did NOT add Prev/Next. Every sibling list (Deficiencies, Assets, Audits, Work orders, Parts) gained a working pager, so Alerts is conspicuously the outlier — a plant manager with >100 open alerts still cannot page to rows 101+, only filter them down. On demo day, if Alerts is shown next to any other list the missing pager is an obvious gap and contradicts the "we paginated everything" story. Fix: add the same shared pager wired to the alerts endpoint's page param (or, if the endpoint still hard-caps server-side, that's a CUST-tier bug, but the UI inconsistency stands regardless).
File: client/src/pages/AlertsPage.jsx lines 404-410, 502-506 (no pager block anywhere in the render)

**[UX-9-3] MEDIUM: AuditsPage's two pagers don't even match each other**
AuditsPage renders two separate pagers — one for the AuditRecommendations sub-list (line 768) and one for AllRecommendations (line 996). The first uses `String.fromCharCode(8592)` arrows and shows "N total · page X of Y"; the second uses literal `← / →` arrows and shows only "Page X of Y" with no total count. Two pagers in the same file, same visual family, rendered differently. A diligence engineer reading the file sees the divergence immediately. Fix: same shared component as UX-9-1; both should show the total and use one arrow convention.
File: client/src/pages/AuditsPage.jsx lines 768-779 vs 996-1007

**[UX-9-4] MEDIUM: Pager labels are inconsistent — count shown on some, hidden on others; alignment varies**
Even ignoring the component split, the label text and layout differ: Deficiencies = "N total · page X of Y" (left-aligned, space-between); Parts = "N parts · page X of Y" (left, space-between); WorkOrdersList = "Page X of Y" with NO total, right-aligned (flex-end); AuditsPage second pager = "Page X of Y" no total, right-aligned; AssetsList = "Page X of Y · N assets". So three different orderings of the same two facts, two alignments, and two pages that drop the total entirely. The total-count is the most useful number to a user paging a long list; dropping it on Work orders/Audits is a real regression vs the others. Fix: standardize on one label ("Page X of Y · N items") and one alignment in the shared component.
File: client/src/pages/WorkOrdersList.jsx lines 571-573; client/src/pages/AuditsPage.jsx lines 1001-1003; client/src/pages/DeficienciesPage.jsx lines 619-621; client/src/pages/AssetsList.jsx line 1026

**[UX-9-5] MEDIUM: Skeleton loaders were added to exactly ONE page — WorkOrdersList now looks different from every other list while loading**
v8 swapped WorkOrdersList's loading text for `<SkeletonRows />` (line 492), but a grep shows every other list/detail page still renders the bare `<div className="loading">Loading…</div>` string: DeficienciesPage:482, AssetsList:724, AuditsPage:710/905, AlertsPage:375, ComplianceCalendar:394, Parts, Dashboard:830, and ~30 more. So the v8 "skeleton" polish made WorkOrdersList the lone page that shimmers while its siblings flash a gray text node — that's a NEW inconsistency, the inverse of polish. Fix: either roll `<SkeletonRows>`/`<SkeletonCard>` out to the other high-traffic list pages, or revert WorkOrdersList to the shared `.loading` treatment so the app is at least uniform.
File: client/src/pages/WorkOrdersList.jsx line 492; client/src/pages/DeficienciesPage.jsx line 482; client/src/pages/AssetsList.jsx line 724; client/src/pages/AuditsPage.jsx lines 710, 905

**[UX-9-6] MEDIUM: ConfirmDialog migration left Parts.jsx still firing the native OS dialog — twice**
The v8 UX-8-1 fix converted most destructive call sites to the branded `useConfirm()` hook (verified across ~25 files), but Parts.jsx was missed entirely: it doesn't import `useConfirm` and still calls `window.confirm()` for "Delete part" (line 172) and "Remove this inventory entry" (line 190). On demo day, deleting an asset shows the polished modal but deleting a part on the Parts page pops the gray foreign browser box — exactly the jarring inconsistency UX-8-1 set out to kill, still live on a page a buyer will visit. Fix: import `useConfirm` in Parts.jsx and route both deletes through it (with `danger: true`), matching the rest of the app.
File: client/src/pages/Parts.jsx lines 172, 190 (no useConfirm import in the file)

**[UX-9-7] MEDIUM: FailedSyncBanner is built from 100% hardcoded hex — it breaks in dark mode**
The new FailedSyncBanner (the field-tech "your offline change was rejected" surface) styles everything with literal hex and zero tokens: wrap `#fca5a5`/`#fef2f2`/`#991b1b`, the OK state `#86efac`/`#f0fdf4`/`#166534`, buttons `#b91c1c`/`#fff`, item borders `#fecaca`, and body copy `#7f1d1d` (lines 85, 107, 115, 123-141). The app supports a dark theme (`[data-theme="dark"]` in index.css), and a tech on a phone with dark mode set will see a bright `#fef2f2` near-white banner with `#7f1d1d` dark-red text fighting a dark page — visibly off vs every tokenized surface around it. Equivalent danger tokens exist (`--color-danger`, `--color-danger-bg`, `--color-danger-soft`, `--color-danger-strong`). Fix: replace the hex with the danger/success token pairs so the banner inverts correctly in dark mode.
File: client/src/components/field/FailedSyncBanner.jsx lines 85, 107, 115, 123-141

**[UX-9-8] MEDIUM: Toast stack can grow without bound — no cap on how many pile up**
v8 rebuilt Toast from single-slot to an internal stack (good — fixes UX-8-14's "second toast destroys the first"). But the stack has no maximum: every fresh `toast` prop is pushed (`setStack(s => [...s, …])`, line 150) and entries only leave when their own timer fires or the user dismisses. The default duration is 8000ms, so a burst of background events (export ready, draft saved, sync complete, etc.) within 8s stacks 4-5+ toasts up the bottom-right corner, and a sticky `duration: 0` toast never auto-leaves. On a busy demo this can wall off the corner of the screen. Fix: cap the stack (e.g. keep the newest 3, drop the oldest) so it can't tower.
File: client/src/components/Toast.jsx lines 142-151

**[UX-9-9] MEDIUM: AiDisclaimer still hardcodes its border hex — the UX-8-9 fix was only half-done**
v8 correctly removed the phantom `renewalBrief` variant from the doc and tokenized the backgrounds (`--color-warning-bg`, `--color-bg`), but the borders are STILL literal: amber tone `border: '1px solid #fde68a'` (line 41) and slate tone `border: '1px solid #dde2eb'` (line 48). In dark mode `#fde68a` is a bright pale-yellow hairline and `#dde2eb` a light-gray hairline, both wrong against the dark cards this disclaimer sits on (it appears under every AI extract/brief/ask surface). Fix: use `--color-warning-bg-strong`/`--color-warning` for the amber border and `--color-border` for the slate border.
File: client/src/components/AiDisclaimer.jsx lines 41, 48

**[UX-9-10] MEDIUM: New inline pagers don't wrap — Prev/Next can overflow on a narrow viewport**
The DeficienciesPage and Parts pagers include `flexWrap: 'wrap'` (good), but the WorkOrdersList pager (line 567) and BOTH AuditsPage pagers (lines 769, 997) do not. On a ~375px phone the row "← Prev | Page X of Y | Next →" right-aligned with no wrap can push the Next button to the clipped edge of the card, since the changed pages are the ones a mobile field user lands on. Fix: add `flexWrap: 'wrap'` (or fold into the shared pager from UX-9-1, which should wrap by default).
File: client/src/pages/WorkOrdersList.jsx line 567; client/src/pages/AuditsPage.jsx lines 769, 997

**[UX-9-11] LOW: Disabled-during-load state is applied to some pagers and not others**
Deficiencies (lines 625, 632) and Parts (lines 643, 650) disable Prev/Next while `loading` is true, so a fast double-click can't fire a second page fetch mid-flight. WorkOrdersList (lines 568, 574) and both AuditsPage pagers (773, 776, 998, 1004) gate only on `page <= 1 / page >= totalPages`, not on `loading` — so a user can spam Next and queue overlapping requests, momentarily showing stale rows. Minor, but it's a behavioral inconsistency between pagers that should match. Fix: include the `loading` guard in the shared pager's disabled logic.
File: client/src/pages/WorkOrdersList.jsx lines 568, 574; client/src/pages/AuditsPage.jsx lines 773, 776

**[UX-9-12] LOW: Public arc-flash label loading state is still the bare string "Loading label…"**
PublicArcFlashLabel was nicely tokenized in v8 (petrol/ink palette, Inter, shock-approach boundaries now rendered, dark-mode aware) — the page itself is clean and printable. But the loading state is still `<div style={wrap}>Loading label…</div>` (line 71), a lone left-aligned text string with no spinner or brand mark, on the one surface a prospect physically scans in the field. The not-found/error states are similarly text-only. Fix: center the loading text and add the BrandMark (or a small spinner) so the first paint of a scanned sticker reads as the product, not a blank string.
File: client/src/pages/PublicArcFlashLabel.jsx lines 71-73

**[UX-9-13] LOW: AlertsPage hand-rolls its empty state instead of using the shared `<EmptyState>` component**
While WorkOrdersList's v8 update correctly adopted the shared `<EmptyState icon title sub cta>` component (line 496), AlertsPage's "All clear" empty state is a bespoke inline-styled block with a raw `✓` glyph at `fontSize: 36` and hand-set spacing (lines 413-426). It reads fine in isolation but doesn't match the iconned, soft-bg `.empty-state-icon` treatment EmptyState gives every other list. Fix: render the alerts empty state through `<EmptyState>` (icon = CheckCircle) for visual parity.
File: client/src/pages/AlertsPage.jsx lines 413-426; client/src/components/EmptyState.jsx

**[UX-9-14] LOW: Residual native window.confirm() lingers on two more destructive actions**
Beyond Parts (UX-9-6), two more `window.confirm()` calls survive on genuinely destructive flows: UsersPage.jsx:272 "Permanently erase all data for {name}?" (the GDPR hard-erase) and LotoProcForm.jsx:345 "Replace the current energy sources and steps…". The erase one is the most consequential confirm in the app and still uses the OS box, while the adjacent invite/disable confirms in the same file already use the branded hook (UsersPage:216, 266, 288). Fix: convert both to `useConfirm({ danger: true })`.
File: client/src/pages/UsersPage.jsx line 272; client/src/components/LotoProcForm.jsx line 345

---

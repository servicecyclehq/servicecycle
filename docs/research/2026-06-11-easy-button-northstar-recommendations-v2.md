# The Easy Button v2 — Post-Wave Re-Diagnosis & Fresh Gems
**Date:** 2026-06-11 (post-ship) · **Author:** product strategy review (Fable)
**Supersedes/extends:** `docs/research/2026-06-11-easy-button-northstar-recommendations.md` (v1). This wave shipped v1 gems N1, N2, N4, N5, R1-stage-1, R3-partial, R5 — all verified in code and live at servicecycle.app. This doc re-scores the four easy buttons, audits what the wave itself introduced, and lays out the next prioritized set.

---

## 1. Scoreboard — the four easy buttons, NOW

### Button 1 — "What day is your outage?" → here's your list: ~60% → **~85%**
Shipped and genuinely strong. `server/routes/outagePlanner.ts` is now date-first (`GET /plan?date=&scope=`), with the three-rule union (dueByDate / carryOver / opportunistic, all default ON), reason tags on every task, Location→Panel/Equipment→Device grouping via `fedFromAssetId`, carry-over detection against the last real `BlackoutWindow`, pull-forward tallying, PDF/XLSX field check-off exports, and one-click `POST /commit`. `OutagePlannerPage.jsx` renders the date + scope inputs first, advanced filters collapsed — the design law applied correctly.

**Remaining gap (the big one): the loop doesn't close.** `POST /commit` creates one WorkOrder per asset linked to `scheduleIds[0] || null` (outagePlanner.ts:493–507); the other selected schedules on that device are only mentioned in a notes string ("N task(s)"). When the WO completes, only ONE schedule rolls forward — the user does five tasks on a breaker during the outage and four of them stay overdue in the compliance math. The easy button currently ends at "work created," not "compliance cleared," which is the entire point of the button.

### Button 2 — Upload report → fix list: ~25% → **~55%. Biggest jump, biggest remaining prize.**
Shipped: the staged PDF ingest (`server/lib/testReportParse.ts` + `server/routes/testReportImport.ts` + `TestReportImport.jsx`) — upload → deterministic extract → human-verified preview → TestMeasurements + auto-deficiencies → "View fix-it list." `assetsImport.ts` now auto-applies a baselined NFPA 70B program by default (`autoApplySchedules` defaults true, line 706) and returns `assetsWithProgram`/`assetsWithoutProgram` so `ImportAssets.jsx` step 3 leads with "Here's what we found" + a "View your fix-it list →" CTA (line 441). The hero loop exists.

**Remaining gaps:**
1. **One PDF = one asset.** `POST /preview` matches a single serial; `POST /commit` takes a single `assetId`. The document customers actually hold — the 200-page NETA contractor report — covers *dozens* of assets in sections. Today they'd have to split the PDF themselves and upload N times. That's data-entry friction reborn at the document level.
2. **The parser is demo-grade** (see §2.1 below).
3. **No OCR** — scanned reports get "Is it a text-based test report (not a scan)?" (testReportImport.ts:64) and a dead end.
4. **Still three import doors** in `Sidebar.jsx` (`/import` line 732, `/test-reports/import` line 743, plus `CmmsImport.jsx`) — the user still picks the parser. No email-in: the only "webhook" is *outbound* (`fireImportWebhook`, assetsImport.ts:950).
5. **NewAsset.jsx is still an 852-line form** with the photo panel "collapsed by default so the manual flow stays primary" (NewAsset.jsx:102–104), and `field/FieldHome.jsx` is still QR-scan-only (line 5: "Big SCAN button — the primary field action") — no photo→asset in the field. v1 gem N6 untouched.

### Button 3 — OSHA shows up → here's my program: **~80%, UNCHANGED — the only button this wave skipped.**
The EMP one-click PDF still lives solely as a card inside `ReportsHub.jsx` (`report.empDownload`, lines 108–152). v1 gem N3 (persistent "Inspector's here" affordance + audit-readiness line + viewer-role access) did not ship. With Path-to-100 now built, the readiness line is nearly free: `buildComplianceGap().summary` already knows whether the program would look good when opened.

### Button 4 — NFPA 70B always-on + path to 100%: ~50% → **~85%, with two new integrity holes.**
Shipped: `buildComplianceGap` in `server/lib/complianceReport.ts` (523–694) — the honest obligation model `D = current + overdue + unbaselined + uncoveredAssets`, per-action `pointsRecovered = 100/D`, ranked one-click fixes. `PathTo100.jsx` mounts on Dashboard (compact) + ComplianceStandardsReport. `dashboard.ts` exposes coverage fields and Dashboard.jsx shows "Coverage X% · true rate Y%". The denominator credibility hole from v1 is *fixed in the math*. But:
1. **The headline still flatters.** Dashboard.jsx 862–880: the big `stat-tile-value` is `overallComplianceRate` (the 89%), with the honest rate (54%) relegated to a small-print suffix line. Two numbers that disagree on the same card is worse for trust than one honest number.
2. **One-click compliance can now be *fabricated*** — see §2.2/2.3.

---

## 2. What this wave introduced that works AGAINST the north star

### 2.1 The test-report parser will not survive a real PowerDB PDF
`testReportParse.ts` is honest about being deterministic, but the specifics are brittle in ways a customer's first real upload will expose:
- `parseTestReport` collapses ALL whitespace (`text.replace(/\s+/g, ' ')`, line 76) — destroying the table structure pdfjs text-items preserve. Column association (which value belongs to which phase/row) is then guessed by "first number within 90 chars after the label" (lines 105–111), which will happily grab a test voltage, a date fragment, or the next row's value.
- `testDate` only matches ISO `\d{4}-\d{2}-\d{2}` (line 82). PowerDB forms print US dates (MM/DD/YYYY). On real reports the date silently comes back null.
- `evaluate()` handles only single `<`/`>` thresholds (lines 55–69); real expected-ranges ("100–1000 MΩ", "±10% of avg", temp-corrected minimums) return null → no verdict → row may be skipped entirely (line 122).
- `meta.serialNumber` takes the FIRST "Serial" occurrence in the whole document — in a multi-asset report that's whichever asset appears first, silently mis-attributing every measurement.
- The only in-repo fixture generator is `server/scripts/seed-powerdb-demo.js` — i.e., the parser is tuned to a PDF we wrote ourselves. There is no golden corpus of third-party PDFs and no unit tests pinning `parseTestReport` to known-good extractions.

The HITL preview contains the blast radius (the right call — HITL lifts document-extraction accuracy from ~80% to 95%+ in industry practice: [Iteration Layer](https://iterationlayer.com/blog/ai-data-extraction-confidence-scores), [Parseur](https://parseur.com/blog/ai-data-extraction)), but a preview full of garbage rows *is* the Gimba failure mode wearing a new shirt: the user does the data entry anyway, now with extra steps. **The moat is only a moat if extraction quality holds on documents we didn't write.**

### 2.2 Auto-baselining to now + interval = "compliance by import"
`assetsImport.ts:889–925` and `schedules.ts /bulk-apply` (291–306) set `nextDueDate = now + intervalC2Months` with `lastCompletedDate = null`. Modeling consequence: import 50 transformers that haven't been touched in a decade → every one lands **green for a full interval** (36+ months for some tasks) with zero evidence any maintenance ever occurred. Three knock-on effects:
- Path-to-100 reads ~100% immediately post-import — the gap engine, our flagship honesty feature, is silenced by our own default.
- v1's N5 spec said: anchor on `lastServiceDate` if the import has one, **else "due now" so it lands on the action list**. The import schema doesn't even map a last-service column; the shipped choice was the flattering one.
- An acquirer's diligence engineer (or an insurer post-incident) asks: "this asset shows compliant — show me the completion record." There isn't one. For a product whose differentiator is hash-chained tamper-evident audit snapshots (`snapshotPipeline.ts`), green-without-evidence is a self-inflicted contradiction.

### 2.3 "Mark baselined" is a self-certification button
`PathTo100.jsx:64–66` — the unbaselined fix action calls `POST /api/schedules/:id/complete`, which (schedules.ts:390–438) writes `lastCompletedDate = now`. One click manufactures a completion record dated today for work nobody claims happened. Combined with 2.2, the "path to 100%" can be walked entirely by clicking, no maintenance performed. Honest framing demands the baseline action ask one question: *"When was this last actually done?"* (date picker, "never" allowed → schedule goes due-now instead).

### 2.4 Two compliance numbers that disagree, displayed together
Dashboard.jsx:867–879. The demo shows 89% big, 54% small. Either number alone is defensible; the pair invites "which one is real?" — from a customer, or worse, from a buyer's diligence team reading the screenshot deck.

### 2.5 Outage commit drops schedule linkage (the Button-1 loop break) — detailed in §1.
### 2.6 Smaller frictions, new and carried
- Test-report ingest is `requireManager` on *preview* too (testReportImport.ts:36) — a viewer/contractor tech can't even see what a PDF contains. Each ingest also creates a `status: COMPLETE` WorkOrder that pollutes Dashboard "Recent work orders" with synthetic entries.
- Dashboard `MaintenanceHorizon` legend renders the "overdue" swatch twice (Dashboard.jsx:358–366) — cosmetic, but it's on the most-viewed screen.
- Carried from v1, still true: EMP buried in Reports hub (N3); KPI count-tiles lead the dashboard with PathTo100 third (N7); Equipment Templates still a top-level nav destination (Sidebar.jsx:630); 20+ sidebar destinations; AI consent + manager gates in hot paths; NewAsset form-first; FieldScan QR-only.

---

## 3. The gems, v2

### NOW

#### Gem V1 — Close the outage loop: commit → complete → compliant ⭐
- **Principle:** Button 1; "the easy button ends in green, not in paperwork."
- **Gap:** `outagePlanner.ts POST /commit` links only `scheduleIds[0]` per asset; completing the WO leaves sibling tasks overdue (§1, §2.5).
- **Change:** Persist all selected scheduleIds per WO (junction table or one WO per schedule under a parent outage group), and make the WO COMPLETE transition roll *every* linked schedule via the existing `recomputeScheduleDates`. Then the demo arc becomes: type date → commit plan → mark done → watch Path-to-100 jump. **Effort: S–M. Now.**
- **Acquisition angle:** No CMMS ties outage execution to standards compliance at all; PowerDB has no scheduling layer. This makes the flagship demo end on the money shot.

#### Gem V2 — One honest number (kill the 89%/54% split)
- **Principle:** Button 4; trust is the product.
- **Gap:** Dashboard.jsx:862–880 leads with the flattering rate; honest rate in small print (§2.4).
- **Change:** `overallRate` (the gap-engine number) becomes THE headline everywhere; the schedule-only rate moves into the explainer tooltip ("of schedules with a due date, X% current"). One number, one story, prescription attached. **Effort: S. Now.**
- **Acquisition angle:** "Audit-ready means current, complete, accurate evidence at any time" is the bar compliance buyers now apply ([GRC Pros](https://grcprosblog.substack.com/p/what-audit-ready-really-looks-like-23b)); a dashboard that argues with itself fails the screenshot test in a diligence deck.

#### Gem V3 — Evidence-grade baselining (fix 2.2 + 2.3 together)
- **Principle:** Button 4 + the data-in moat (smart defaults must be honest defaults).
- **Gap:** Import auto-baseline manufactures a green interval with no evidence; "Mark baselined" fabricates completions (§2.2–2.3).
- **Change:** (a) Map an optional `lastServiceDate` column in `assetsImport.ts`; when present, anchor `nextDueDate` from it (the existing `computeNextDueDate` path). (b) When absent, create the schedule with a distinct visible state — "scheduled, unverified" — due within a short grace window (e.g. 90 days) so it lands ON the action list instead of silently green. (c) The PathTo100 baseline action opens a one-field prompt: "When was this last done?" (date | never). lastCompletedDate only ever holds asserted dates, never button-clicks. **Effort: M. Now.**
- **Acquisition angle:** Converts the auto-apply default from a diligence liability into the headline ("a complete program in ten minutes — and it tells the truth about what's verified"). Insurers/AHJs enforcing 70B want documentation that survives audits ([IRISS compliance guide](https://iriss.com/discover/whitepaper/the-nfpa-70b-2023-compliance-guide/), [Trola](https://trolaindustries.com/nfpa-70b-2023-compliance-digital-documentation-challenges-and-electrical-maintenance-programs-for-control-panels/)).

#### Gem V4 — Multi-asset PDF segmentation + a golden corpus ⭐ the single biggest remaining data-in friction reducer
- **Principle:** Button 2, verbatim; the moat.
- **Gap:** One PDF = one asset (testReportImport.ts preview/commit shape); parser tuned to our own seeded PDF, no third-party fixtures, no parse tests; whitespace-collapse + first-number heuristics + ISO-only dates (§2.1).
- **Change, staged:** (1) **Corpus first** — collect 10–20 real PowerDB/Megger/NETA PDFs (the brother's contractor contacts are the source), pin `parseTestReport` with unit tests per fixture; fix the cheap wins (US date formats, range expressions, per-line parsing using pdfjs item coordinates instead of flattened text). (2) **Section segmentation** — split the document on PowerDB per-equipment form headers/serials; preview becomes a per-asset accordion, serial-matching each section to the register, flagging unmatched sections as "create asset?" rows. One upload onboards a facility. (3) Add per-field confidence flags so the preview highlights what to check instead of asking the human to re-read everything (the documented HITL pattern: [Iteration Layer](https://iterationlayer.com/blog/ai-data-extraction-confidence-scores)). **Effort: M (stage 1) → L (stage 2–3). Now (stage 1) / Roadmap (2–3).**
- **Acquisition angle:** PowerDB ships 370+ test forms and *produces* these PDFs with one-step report packages ([Megger PowerDB](https://www.megger.com/en-us/products/powerdb-pro), [PowerDB](https://www2.powerdb.us/)) — and has no compliance/action layer. Reading its output at facility scale, reliably, is the structural moat; reading it flakily is a churn machine. Note the field is no longer empty: Gimba still markets "the only platform purpose-built around NFPA 70B" ([gimba.io](https://gimba.io/)) and MaintenancePulse has appeared ([maintenancepulse.com](https://www.maintenancepulse.com/)) — neither ingests test reports. Speed here decides who owns the claim.

#### Gem V5 — "Inspector's here" button (carried from v1; now nearly free)
- **Principle:** Button 3 — the only button this wave didn't touch.
- **Gap:** EMP export still one card among many in `ReportsHub.jsx` (108–152), manager-gated at the API.
- **Change:** Persistent sidebar affordance → one click: EMP PDF + immutable snapshot (both pipelines exist), readable by all roles; readiness line fed by `buildComplianceGap().summary` ("Audit-ready ✓" / "3 items would look bad — fix first"). **Effort: S. Now.**
- **Acquisition angle:** The panic-moment feature converts the 70B insurance-enforcement tailwind ([Eaton](https://www.eaton.com/us/en-us/company/news-insights/nfpa-70b.html), [Qmerit](https://qmerit.com/blog/nfpa-70b-compliance-for-commercial-buildings/)) into a sentence a CFO repeats.

#### Gem V6 — Fix-it list first on the Dashboard (v1 N7, half-done)
- **Principle:** the design law — lead with verbs.
- **Gap:** Dashboard.jsx still opens with KPI count tiles (810–841); `<PathTo100 compact />` sits third (885). Counts are still a report.
- **Change:** Merge PathTo100 rows + open IMMEDIATE deficiencies into one ranked five-row to-do list above the KPI grid; tiles drop below. Also fix the duplicated horizon legend entry while in the file. **Effort: S. Now.**
- **Acquisition angle:** This is the screenshot that sells the company; post-wave it's a re-ordering, not a build.

#### Gem V7 — Open the ingest gates
- **Principle:** Button 2; friction out of the hot path.
- **Gap:** `requireManager` on test-report *preview* (testReportImport.ts:36); ingest WOs polluting Recent Work Orders; per-use AI consent elsewhere.
- **Change:** Preview = any authenticated role (read-only); commit stays manager+. Tag ingest WOs (e.g. `source: 'test_report'`) and filter them from the recency feed. **Effort: S. Now.**

### ROADMAP

#### Gem W1 — AI-fallback extraction + OCR behind the deterministic parser
When the regex pass yields low coverage (few labels, no values), offer the existing AI pipeline (consent-gated, like `photoInspect.ts`) as a fallback, and an OCR stage for scans — deterministic-first keeps costs and trust, AI catches the long tail; GenAI layout-aware extraction is exactly the documented cure for template drift ([Box](https://blog.box.com/ai-document-extraction), [Unstract](https://unstract.com/blog/ai-document-processing-with-unstract/)). **Effort: M–L.**

#### Gem W2 — One "Add data" door + email-in
Three import pages remain a parser taxonomy quiz; the only webhook is outbound. Single drop-anything surface that sniffs the file → routes to the right preview pipeline; phase 2 the per-account `reports-{acct}@servicecycle.app` forwarding address. Mobile-friction and extra-clicks are the documented adoption killers ([MaintainNow](https://www.maintainnow.app/blog/why-your-cmms-adoption-rate-is-low-and-how-to-fix-it-1761774397375), [Maintainly](https://maintainly.com/articles/why-cmms-adoption-fails-and-how-to-ensure-a-smooth-roll-out)). **Effort: M.**

#### Gem W3 — Field photo→asset (v1 N6, still untouched)
`FieldHome.jsx` remains QR-only; nameplate AI remains a collapsed desktop panel. Walk-the-facility onboarding stays the answer to the weeks-long CMMS data-load norm — and per the flywheel narrative, the walker is the *contractor's* tech. **Effort: S–M.**

#### Gem W4 — Trend-based deficiencies (ingest stage 2)
`testReportImport.ts` flags only single-reading RED/YELLOW. The YoY wrong-direction logic already rendered in `TestingTrendsTab.jsx` should *generate* deficiencies on commit ("C-phase IR down 40% YoY — still in spec, won't be next year"). That's the predictive sentence no competitor can say. **Effort: M.**

#### Gem W5 — Contractor-side bulk ingest (flywheel × moat)
Once V4 stage 2 lands: a Fleet-Dashboard contractor uploads one report covering a customer facility → the facility account is seeded/updated → onboarding becomes a side-effect of work the contractor already billed (see `docs/CONTRACTOR_FLYWHEEL_NARRATIVE.md`, loop step 1). The CAC-collapse story made literal. **Effort: M after V4.**

---

## 4. If we only did three things

1. **V4 — Multi-asset segmentation + golden-corpus hardening of the PDF parser.** The moat claim is now *live on the demo*; the first real-world PDF that previews as garbage converts the moat into an anti-demo. Stage 1 (corpus + tests + date/range fixes) is a week of work that protects the company's single most valuable sentence.
2. **V3 + V2 (one bundle) — evidence-grade baselining + one honest number.** Together they close every integrity hole this wave opened (compliance-by-import, self-certified baselines, dueling percentages) before a customer incident or an acquirer's diligence engineer finds them. Honesty is the only durable differentiator in a compliance product.
3. **V1 — close the outage loop.** Small lift, and it completes the best demo in the product: date → plan → commit → done → compliance visibly rises. Every easy button must end in green.

(V5, the inspector button, is the stealth fourth — smallest effort-to-story ratio in the backlog, and Button 3 is now the only button without a wave behind it.)

## 5. The single biggest remaining data-in friction reducer

**One upload = one facility (V4 stage 2).** Everything else this wave built — auto-applied programs, action-list imports, Path-to-100 — multiplies whatever enters the funnel. The funnel's mouth is still per-asset. The customer's real artifact is a multi-asset contractor report; until that document lands whole, "frictionless data-in" is true for spreadsheets and demos, not for the thing actually sitting in their inbox. (Email-in, W2, is the same bet's second half: remove even the upload.)

## 6. Most underrated, post-wave

The **condition→interval loop** (assets.ts PUT recompute + `interval-preview` + `ConditionIntervalCard.jsx`). It shipped quietly as item 4, but it's the only feature in the market where a field observation *re-plans the program* ("what if C3? intervals tighten 67%" + one-tap apply) — NFPA 70B's condition-of-maintenance model actually closed-loop. Neither Gimba nor MaintenancePulse nor any CMMS does hint→condition→recompute end-to-end. It deserves a sentence in every demo and the narrative doc; today it's a card on AssetDetail that nobody is told about.

## 7. Sources
- [Maintainly — Why CMMS adoption fails](https://maintainly.com/articles/why-cmms-adoption-fails-and-how-to-ensure-a-smooth-roll-out) · [MaintainNow — Why your CMMS adoption rate is low](https://www.maintainnow.app/blog/why-your-cmms-adoption-rate-is-low-and-how-to-fix-it-1761774397375) · [SAMEX — CMMS implementation failure causes](https://www.samexsys.com/kc-en/cmms-implementation-failure-causes-en/) (50–80% failure; friction + dirty data + reversion within 60 days)
- [Megger PowerDB Pro](https://www.megger.com/en-us/products/powerdb-pro) · [PowerDB](https://www2.powerdb.us/) (370+ forms, one-step report packages — the document supply we ingest)
- [Gimba](https://gimba.io/) · [MaintenancePulse](https://www.maintenancepulse.com/) (the 70B software field is no longer empty)
- [Eaton — NFPA 70B](https://www.eaton.com/us/en-us/company/news-insights/nfpa-70b.html) · [IRISS — 70B-2023 compliance guide](https://iriss.com/discover/whitepaper/the-nfpa-70b-2023-compliance-guide/) · [Qmerit — 70B for commercial buildings](https://qmerit.com/blog/nfpa-70b-compliance-for-commercial-buildings/) · [Trola — digital documentation challenges](https://trolaindustries.com/nfpa-70b-2023-compliance-digital-documentation-challenges-and-electrical-maintenance-programs-for-control-panels/) (should→shall; insurer/AHJ enforcement; audit-grade documentation)
- [Iteration Layer — HITL confidence scores](https://iterationlayer.com/blog/ai-data-extraction-confidence-scores) · [Parseur — AI data extraction](https://parseur.com/blog/ai-data-extraction) · [Unstract — accurate AI document processing](https://unstract.com/blog/ai-document-processing-with-unstract/) · [Box — AI document extraction](https://blog.box.com/ai-document-extraction) (HITL ~80%→95%+; confidence-threshold review routing; layout-aware fallback)
- [GRC Pros — what audit-ready really looks like](https://grcprosblog.substack.com/p/what-audit-ready-really-looks-like-23b) (continuous, evidence-backed readiness as the buyer bar)
- Internal: v1 doc, `docs/CONTRACTOR_FLYWHEEL_NARRATIVE.md`, `server/scripts/seed-powerdb-demo.js` (parser fixture provenance), all code paths cited inline.

# The Easy Button — North-Star Gap Analysis & Gems
**Date:** 2026-06-11 · **Author:** product strategy review (Fable)
**Thesis under test:** "Nobody wants to think about this stuff. Lead with the short action list; demote the report. The moat is frictionless data-in — Gimba died because data entry wasn't worth the user's time."

Everything below is grounded in the actual code on `ui-modernize-fable` / `main` (paths cited inline) and assumes the punch list in `docs/MASTER_PUNCH_LIST_2026-06-11.md` ships as planned. This doc deliberately does NOT repeat punch-list items; it builds on top of them.

---

## 1. Where we are vs. the four easy buttons

### Button 1 — "What day is your outage?" → here's your list
**Closeness: ~60%.** The hard part is built; the framing is backwards.
`server/routes/outagePlanner.ts` already finds every outage-requiring schedule due within ±90 days, groups by site, computes "N shutdowns avoided," and creates a consolidated multi-asset WO in one POST. `OutagePlannerPage.jsx` renders it well.
**The gap:** the page answers *"what outage work exists somewhere in the next 90 days?"* — a planner's browse view. The brother's question is the inverse: *"my outage is July 18, what should we do that day?"* There is no date input. The ±90-day window is hardcoded (`WINDOW_DAYS = 90`), so there's also no "pull-forward" logic — the single biggest economic win of an outage window is doing the task due in month 11 *now*, while the gear is already de-energized, instead of buying another shutdown later.

### Button 2 — Upload report → here's your list of stuff to fix
**Closeness: ~25%. This is the biggest gap and the biggest prize.**
What exists: CSV/Excel asset import with mapping preview (`server/routes/assetsImport.ts`, `ImportAssets.jsx` — a clean 3-step flow), schedules import, work-orders import, a genuinely impressive deficiency import that already speaks Maximo/SAP/Oracle severity dialects (`server/routes/deficienciesImport.ts`), a CMMS import page, and — crucially — the full test-data substrate: `TestEvent`/`TestMeasurement` in `schema.prisma`, the YoY pivot with wrong-direction trend flags in `TestingTrendsTab.jsx`, and **15 per-equipment-type PowerDB report templates already researched** in `docs/research/powerdb-templates/`.
**The gap:** every import path requires a *structured file the customer doesn't have*. What customers actually have is the 200-page PDF their NETA contractor emailed them — the very EMP-style report "nobody reads." There is no PDF ingest anywhere (`grep -ri "pdf import"` → only PDF *export* paths). And import success screens report **counts** ("42 rows created"), not **actions** ("we found 6 things to fix").

### Button 3 — OSHA shows up → here's my program (one click)
**Closeness: ~80%. Built, but buried.**
`POST /api/compliance/emp-document` generates the full NFPA 70B §4.2 EMP PDF; `reportsRegistry.js` exposes it as a one-click download with a nice toast; audit snapshots are immutable with SHA-256 hashes chained into the tamper-evident activity log (`snapshotPipeline.ts`, `activityLogChain.ts`) — that integrity story is a genuine differentiator no incumbent has.
**The gap:** it lives as the first card *inside the Reports hub*, one destination among ~8 reports. The panic moment ("the inspector is in the lobby") has no dedicated affordance, it's manager-gated (`requireManager` — a viewer-level facilities person can't pull the program), and nothing tells you *in advance* whether the program would look good or embarrassing when opened.

### Button 4 — NFPA 70B total compliance monitoring + exactly what's needed to hit 100%
**Closeness: ~50%, with a credibility hole.**
`server/lib/complianceReport.ts` computes per-standard compliance, the dashboard leads with the overall rate, drill-downs are being wired (punch-list B5), and the overdue report is explicitly framed in code comments as "the punch list an operator works from."
**Two gaps:**
1. **The denominator flatters.** `complianceRate = current / (current + overdue)`; unbaselined schedules are excluded, and **assets with no schedules at all don't exist in the math**. A facility with one current schedule on one breaker shows 100% while 40 transformers sit untracked. For a product whose pitch is "total compliance monitoring at all times," that's the first thing a sophisticated buyer (or acquirer's diligence engineer) will poke.
2. **No prescription.** The app says *89%*; it never says *"complete these 4 tasks and baseline these 2 schedules → 100%."* The number is a report. The brother asked for a list.

---

## 2. The gems

### NOW — make the current app *feel* like the easy button

#### Gem N1 — Invert the Outage Planner: date-first ("What day is your outage?")
- **Easy button:** #1. **Effort: S–M.**
- **Gap:** browse-the-window view, no date input, no pull-forward.
- **Change:** Put a single date (or date-range) picker at the top of `OutagePlannerPage.jsx`. Parameterize `outagePlanner.ts` (`?date=&windowDays=`) — the query already does the heavy lifting. Return two buckets per site: **"Due in this window"** and **"Pull forward — already de-energized, do it now"** (outage-requiring tasks due within the next 12 months; doing them in-window shows *future* shutdowns avoided, extending the existing SavingsBanner math). Output = a printable one-page work scope + the existing one-click consolidated WO.
- **Moat/acquisition angle:** This is the demo moment for facilities buyers — type a date, get a scoped work plan with a dollar-flavored "3 shutdowns avoided" banner. No CMMS or PowerDB does outage-window consolidation at all (confirmed gap in `docs/ServiceCycle_vs_Gimba_Competitive_Analysis.md`). Cheapest possible upgrade to a flagship feature.

#### Gem N2 — "Path to 100%" panel (compliance as a to-do list, not a score)
- **Easy button:** #4. **Effort: M.**
- **Gap:** the % has no prescription, and coverage gaps are invisible.
- **Change:** New endpoint composing what `complianceReport.ts` already classifies: overdue schedules, unbaselined schedules (need a first completion date), **uncovered assets** (in-service assets with zero active schedules — one new query), and missing one-time program records (arc-flash study date, etc.). Each row carries *points recovered* ("Complete IR scan on SWGR-2 → +4.2%") and a one-click action (create WO / request quote / apply template). Render on the Dashboard and atop `ComplianceStandardsReport.jsx`. Fix the honesty problem at the same time: show "Compliance 89% · Coverage 61%" as a pair, or blend coverage into the headline number behind an explainer.
- **Moat/acquisition angle:** Gimba's whole pitch was "the only software built around NFPA 70B" — and even Gimba only showed status. A gap-engine that *prescribes the exact path to 100%* is the literal sentence the brother used, and it converts the 2023 70B "should→shall" regulatory tailwind ([Eaton](https://www.eaton.com/us/en-us/company/news-insights/nfpa-70b.html), [ESFI](https://www.esfi.org/nfpa-70b-what-the-change-means/)) into recurring product value. Also fixes the diligence hole before a buyer finds it.

#### Gem N3 — "Inspector's here" button (audit mode, one click, everywhere)
- **Easy button:** #3. **Effort: S.**
- **Gap:** EMP export is buried in the Reports hub and manager-gated.
- **Change:** A persistent sidebar/dashboard affordance — "Audit? Get my program" — that in one click generates the EMP PDF *and* an immutable snapshot (both pipelines exist; just chain them). Open it to all authenticated roles (read-only export ≠ a write). Add a quiet "audit-ready ✓ / 3 items would look bad" readiness line, fed by Gem N2's gap list.
- **Moat/acquisition angle:** Insurers now routinely ask for the EMP at renewal ([Facilities Management Insights](https://www.facilitiesnet.com/maintenanceoperations/article/Electrical-Safety-Compliance-Under-NFPA-70B--20949)). "One button, hash-chained evidence, any user, any time" is a sales line PowerDB (a test-data tool, not a program-of-record) structurally cannot match.

#### Gem N4 — Every import ends in an action list, not a row count
- **Easy button:** #2 (and the design law). **Effort: S.**
- **Gap:** `ImportAssets.jsx` step 3 and siblings report created/skipped counts. Ingestion's payoff is invisible.
- **Change:** Standardize one post-import screen across all five import flows: **"Here's what we found"** — new IMMEDIATE/RECOMMENDED deficiencies, schedules auto-created, assets that landed with *no* program coverage ("12 assets imported, 9 have no maintenance schedule — apply templates?" → one click, see N5), and a single "View your fix-it list" CTA. Same component everywhere.
- **Moat/acquisition angle:** This is the anti-Gimba moment made visible: data-in → value-out in the same breath. It also reframes import as the product's hero loop for demos: upload spreadsheet, *immediately* get told what to fix. Static reporting vs. actionable diagnosis is exactly the gap the dashboard-UX literature keeps flagging ([UXPin](https://www.uxpin.com/studio/blog/dashboard-vs-data-report-design/), [JTBD dashboards](https://nastengraph.substack.com/p/jobs-to-be-done-a-user-centered-approach)).

#### Gem N5 — Auto-apply equipment templates everywhere data enters
- **Easy button:** #2 and #4 (the data-in moat AND the path to 100%). **Effort: M.**
- **Gap:** Equipment Templates (`assetTemplates.ts`) pre-fill the form and auto-schedule a curated NETA/70B task list — but only via `?templateId=` from the templates page. CSV import and photo-inspect create *bare* assets: no schedules, so they're invisible to compliance.
- **Change:** Whenever an asset is created with a recognized `equipmentType` — via CSV import, CMMS import, nameplate photo, or the New Asset form — default-apply the matching template's task set (NETA intervals; the condition-based C1/C2/C3 math in `maintenanceInterval.ts` is already pure and tested). One-click "skip/adjust" behind "advanced," per the design law. Baseline `nextDueDate` from `lastServiceDate` if the import had one, else "due now" so it lands on the action list instead of unbaselined limbo.
- **Moat/acquisition angle:** This single default makes the sentence "upload your spreadsheet, get a complete NFPA 70B program in ten minutes" *true*. Low adoption from data burden is the #1 documented CMMS killer (~70–80% implementation failure, led by data issues — [Limble](https://limblecmms.com/blog/why-cmms-implementations-fail/), [UpKeep](https://upkeep.com/learning/most-common-failures-in-cmms-implementation/)); smart defaults are the cure incumbents don't ship because their consultants bill for setup.

#### Gem N6 — Field Mode: nameplate → asset in one tap (walk-the-facility onboarding)
- **Easy button:** #2 (data-in). **Effort: S–M.**
- **Gap:** The vision pipeline is genuinely strong — `photoInspect.ts` extracts nameplate fields, condition hints, *and* "FED FROM MCC-1" power-path clues — but it's a card on the desktop NewAsset form behind an AI-consent modal. `FieldScan.jsx` is QR-only; a tech standing in the electrical room can't create an asset from a photo.
- **Change:** Make "📷 Add equipment" a primary Field Mode action: snap nameplate → AI fills type/mfr/model/serial → template auto-applies (N5) → power-path suggestion accepted with one tap. Consent prompt once per account, not per use. This turns initial onboarding into "walk the facility for an hour" — done by the *contractor's* tech, not the customer.
- **Moat/acquisition angle:** Gimba had nameplate AI too; the difference is the chain *photo → asset → schedules → compliance → action list* with zero forms. Onboarding-by-walking is the answer to the 3–6-month field-service implementation norm ([Flatfile on data onboarding](https://flatfile.com/blog/what-is-a-data-onboarding-everything-you-need-to-know/)).

#### Gem N7 — Dashboard's first module = "Your fix-it list" (verbs, not counts)
- **Easy button:** the design law ("every screen answers: what do I need to do?"). **Effort: S.**
- **Gap:** Post-punch-list, the dashboard leads with KPI *counts* (Overdue 4, Immediate 2…). Counts are still a report; the user must click through and synthesize.
- **Change:** Above the KPI row, a five-row ranked to-do list merging IMMEDIATE deficiencies, most-overdue schedules, and N2 gap items — each row: severity dot, plain-language sentence ("Replace breaker contact kit on MCC-1 — IMMEDIATE, 12 days old"), and one inline action (Create WO / Request quote / Schedule). "See all" → Deficiencies/Calendar pre-filtered. KPI tiles drop below it.
- **Moat/acquisition angle:** This is the screenshot that sells the company. It is the brother's first sentence rendered as UI, and it's the JTBD pattern — design for the decision, not the data ([User Interviews JTBD guide](https://www.userinterviews.com/ux-research-field-guide-chapter/jobs-to-be-done-jtbd-framework), [Pencil & Paper dashboard patterns](https://www.pencilandpaper.io/articles/ux-pattern-analysis-data-dashboards)).

### ROADMAP — the bigger bets (mostly: kill data-in friction)

#### Gem R1 — Test-report PDF ingest: PowerDB/Megger/NETA report → fix list ⭐ the moat bet
- **Easy button:** #2, verbatim. **Effort: L** (but de-risked in stages).
- **Gap:** The single document every customer already possesses — the contractor's PDF test report — cannot enter the system. Meanwhile the entire landing zone is built: `TestEvent`/`TestMeasurement` schema, YoY trend flags with per-measurement bad-direction logic (`TestingTrendsTab.jsx`), and 15 per-equipment-type PowerDB form templates already mapped in `docs/research/powerdb-templates/`.
- **Change (staged):** (1) PDF upload → AI extraction against the known templates → preview table (reuse the import preview/commit pattern that already exists in all five importers) → TestMeasurement rows. (2) Auto-create deficiencies from failed/trending readings ("C-phase insulation resistance down 40% YoY") and from the report's own recommendations section. (3) The import lands on Gem N4's "here's the crap to fix" screen. Human-in-the-loop preview keeps extraction-accuracy risk contained.
- **Moat/acquisition angle:** This is the moat. PowerDB *produces* these PDFs; it has no compliance/action layer and no incentive to build one. Gimba never touched test data. A buyer sees: every NETA contractor's deliverable becomes ServiceCycle's input — the installed base of *unread EMP reports* becomes the onboarding funnel. "We read the report nobody reads, and hand back the to-do list."

#### Gem R2 — One "Add data" door + email-in ingestion
- **Easy button:** #2. **Effort: M.**
- **Gap:** Five separate import pages (assets, schedules, deficiencies, work orders, CMMS) — the user must know which parser their file belongs to. That's config-first thinking.
- **Change:** A single "Add data — drop anything" surface that sniffs the file (asset CSV vs. Maximo FAILURELIST vs. SAP IW28 vs. — later — test PDF) and routes to the right preview/commit pipeline; the existing pages become the "advanced" tier. Phase 2: a per-account address (`reports-{acct}@servicecycle.app`) so customers *forward the contractor's email* and the attachment shows up as a pending import (`webhookImport.ts` is groundwork). Zero-UI data-in.
- **Moat/acquisition angle:** Data migration is the #1 stated barrier to switching tools (45% in CRM-adjacent surveys; weeks-to-months norms — [Flatfile](https://flatfile.com/blog/what-is-a-data-onboarding-everything-you-need-to-know/), [Ingestro](https://ingestro.com/blog/overcome-data-migration-challenges)). "Forward an email" is the lowest-friction ingestion primitive that exists.

#### Gem R3 — Close the condition loop: observations auto-tighten the program
- **Easy button:** #4 + "smart defaults." **Effort: M.**
- **Gap:** The NETA condition-based interval engine exists (`maintenanceInterval.ts`: C1 ×2.5 stretch, C3 ×0.25 compress) and field photo-inspect emits C1/C2/C3 *hints* — but the hint→condition→recompute chain requires manual edits. The Gimba analysis marked "risk-based scheduling" as their differentiator; ours is 80% built and unmarketed.
- **Change:** When a field observation or test-trend flag implies a condition change, propose it as a one-tap accept ("3 Monitor observations on TX-4 → set condition C3? Intervals tighten 75%"), recompute schedules, and show the delta on the action list.
- **Moat/acquisition angle:** "The program maintains itself" — living-program automation per NFPA 70B's condition-of-maintenance model, which neither a CMMS nor PowerDB does end-to-end.

#### Gem R4 — SKM/ETAP one-line import (power path + inventory from the arc-flash study)
- **Easy button:** #2. **Effort: L.** Flagged ➕ in the Gimba analysis; every mid-size facility has a recent arc-flash study containing a complete equipment list *and* topology. Parsing even the tabular exports seeds assets + `fedFromAssetId` power path in one shot. Park behind R1 — same ingest muscle, smaller audience, but a beautiful diligence-deck line ("we ingest the studies engineers already paid for").

#### Gem R5 — The contractor flywheel as the distribution story (not a feature)
- **Effort: S (positioning) / ongoing.** The pieces exist: per-account service rep + 5-question quote request with EMERGENCY mode (`quoteRequests.ts`), leave-behind PDF, Fleet Dashboard, partner events/digests. Frame them in the acquisition narrative as a *two-sided motion*: NETA contractors onboard their customers (they hold the data: their own reports — see R1), facilities send quote requests back, contractors see the fleet-wide modernization forecast as their sales pipeline. Gimba tried white-label; we ship the loop. This is the "who acquires us and why" slide: an OEM/service-network buyer is purchasing the *channel*, not just the software.

---

## 3. If we only did three things (the sell-the-company narrative)

1. **R1 — PDF test-report ingest → fix list.** The moat, the brother's exact sentence, and the onboarding funnel disguised as a feature. Stage 1 (extract → preview → trends) is demoable in weeks because the schema, trend engine, and templates research are done.
2. **N2 — Path to 100%.** Converts the regulatory tailwind into the product's headline loop, fixes the coverage-denominator credibility hole before diligence finds it, and is the purest expression of easy-button #4.
3. **N1 — Date-first Outage Planner.** Smallest lift of the three, uniquely ours in the market, and the most concrete "they removed the work" demo: type a date, get the day's plan, avoid two shutdowns.

(N5 — template auto-apply — is the stealth fourth: without it, every ingestion win produces assets that are invisible to compliance. If three becomes four, it's N5.)

## 4. Where the app currently works AGAINST the north star

- **The Reports hub is a destination.** Eight report cards, EMP first among equals. Reports are *exports for someone else*, per the thesis — the hub should shrink toward "Export center," with EMP promoted to the global "Inspector's here" button (N3) and the Overdue report absorbed by the dashboard fix-it list (N7).
- **Counts masquerading as answers.** KPI tiles, severity tiles, compliance % — all post-punch-list improved, all still nouns. Until a ranked verb-list sits on top (N7), the dashboard reports rather than directs.
- **Import success = bookkeeping.** "42 created, 3 skipped" is the system congratulating itself. The user's question is "so what do I fix?" (N4).
- **NewAsset is an 852-line form.** The template and photo paths exist but are opt-in side doors; the default path is 20+ fields. Invert: photo/template first, full form behind "advanced" — the design law applied to the single most data-in-critical screen.
- **Five import pages force the user to know our parser taxonomy** (R2). Config-first by accident.
- **Compliance math quietly flatters** (uncovered assets and unbaselined schedules outside the headline number). Flattery reads as dishonesty the day an audit goes badly — fix via N2 before a customer or acquirer fixes it for us.
- **AI consent + manager gating sit in front of easy buttons.** Photo-inspect consent per-session and `requireManager` on EMP generation both make the one-click path two-click-plus-permission. Keep the guardrails; move them out of the hot path (account-level consent, viewer-readable exports).
- **Equipment Templates as a top-level nav destination** (punch list C3 already demotes it) — templates should be an invisible default (N5), not a page the user must discover.

## 5. Sources

- Limble — [Why CMMS Implementations Fail](https://limblecmms.com/blog/why-cmms-implementations-fail/) (~80% failure; data issues + adoption)
- UpKeep — [Most common failures in CMMS implementation](https://upkeep.com/learning/most-common-failures-in-cmms-implementation/)
- Flatfile — [Data onboarding guide](https://flatfile.com/blog/what-is-a-data-onboarding-everything-you-need-to-know/); Ingestro — [Overcoming data-migration challenges](https://ingestro.com/blog/overcome-data-migration-challenges) (migration = top switching barrier; weeks-to-months norms)
- Eaton — [NFPA 70B becomes a standard](https://www.eaton.com/us/en-us/company/news-insights/nfpa-70b.html); ESFI — [What the change means](https://www.esfi.org/nfpa-70b-what-the-change-means/); FacilitiesNet — [Compliance under NFPA 70B](https://www.facilitiesnet.com/maintenanceoperations/article/Electrical-Safety-Compliance-Under-NFPA-70B--20949) (insurer documentation demands)
- User Interviews — [JTBD framework](https://www.userinterviews.com/ux-research-field-guide-chapter/jobs-to-be-done-jtbd-framework); Pencil & Paper — [Dashboard UX patterns](https://www.pencilandpaper.io/articles/ux-pattern-analysis-data-dashboards); UXPin — [Dashboards vs. data reports](https://www.uxpin.com/studio/blog/dashboard-vs-data-report-design/) (action-first vs. report-first design)
- Internal: `docs/ServiceCycle_vs_Gimba_Competitive_Analysis.md`, `docs/MASTER_PUNCH_LIST_2026-06-11.md`, `docs/research/powerdb-templates/`, `docs/research/2026-06-11-ia-card-column-priority-review.md`

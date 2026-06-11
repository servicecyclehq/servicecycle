# IA Review — Card & Column Priority Ordering
**Date:** 2026-06-11 · **Scope:** order of cards/sections per page + left-to-right column order per table
**Method:** read directly from the current working tree (`ui-mo` branch) — every "Current" below reflects actual JSX render order, not guesses.
**No code was changed.** Recommendations only.

## Personas

| | **Service Manager (SM)** | **Field Tech (FT)** |
|---|---|---|
| Decision mode | "Where's the risk and the money?" | "What do I do next on this asset?" |
| First glance needs | Overdue/IMMEDIATE counts, financial exposure (CapEx, repair cost), quote opportunities, audit posture, site rollups | Today's work, the asset in front of them, safety (LOTO, energized, downstream), fastest logging path |

**Guiding principle used throughout:** the app already has a de facto role split — **Field Mode (`/field`) is the tech surface; the desktop pages should default to Service-Manager ordering.** Where a desktop page must serve both, that's flagged explicitly.

---

## Top 10 highest-impact moves

1. **AssetDetail: promote Open Deficiencies from ~10th card to 1st card** — the single worst burial in the app; open findings are the #1 thing both personas need on an asset. *(both)*
2. **Dashboard: put the Overdue KPI tile first (leftmost), not last** — reading order should match severity order. *(both)*
3. **Dashboard: promote the CapEx Forecast panel from slot 7 (below Recent Work Orders) to slot 4–5** — it's the renewal/upsell conversation starter and currently lives below the fold under low-value recency feeds. *(SM)*
4. **Assets list: make the first four columns Equipment · Condition · Next Due · Open Def.** — today Next Due and Open Def. are columns 10–11, after Serial #, Address, and Owner. *(both)*
5. **Fleet Dashboard totals bar: reorder to IMMEDIATE · Overdue · Service Opportunities · Accounts w/ Issues · Open WOs · Total Assets** — lead with risk and money, demote the inventory count. *(SM)*
6. **AssetDetail: promote Risk & Criticality + Service Quote Request into the top third for managers** — repair cost, lead time, redundancy and the quote CTA are slots 12 and 6 today; this is the upsell engine. *(SM)*
7. **Work Orders table: move Status and Scheduled to columns 2–3** (currently 5–6) — status + date is the at-a-glance triage pair. *(both)*
8. **Deficiencies table: move Age next to Severity and default-sort Severity→Age desc** — an IMMEDIATE finding open 45 days is both a liability and a ready-to-quote opportunity; today Age is column 5. *(SM, FT benefits)*
9. **SiteDetail: move "Assets at this site" above the Structure tree** — structure is a setup-time artifact; the asset/risk list is the everyday read. *(both)*
10. **FieldAsset: show Open Deficiencies before the Report Deficiency form, and demote AI Photo Inspect below the core log actions** — know what's already wrong before logging; AI is an accelerant, not the primary path. *(FT)*

---

# Pages

## 1. Dashboard (`pages/Dashboard.jsx`)

**Current order**
1. KPI tiles: Due 30 → Due 60 → Due 90 → **Overdue (last)**
2. Open deficiencies by severity (IMMEDIATE/RECOMMENDED/ADVISORY) + Overall compliance rate
3. Compliance by site (bars)
4. Priority assets (tabs: Critical Infrastructure / High Value / By Volume)
5. Next maintenance due (table)
6. Recent work orders
7. CapEx Forecast ("Estimated Electrical CapEx Exposure")
8. Maintenance horizon — 36 months

**Proposed order**
1. KPI tiles, reordered: **Overdue → Due 30 → Due 60 → Due 90** — severity reads left-to-right; "Overdue" is the only tile that demands action today. *(both)*
   - Consider adding an **Open IMMEDIATE** tile to this row (it's one click further down today). *(both)*
2. Open deficiencies by severity + compliance rate — keep at 2; it's the risk/compliance pulse. *(SM)*
3. Priority assets — promote above Compliance by site; "where to spend the next maintenance dollar" (its own subtitle!) outranks a rollup chart. Default the tab to **High Value** for managers — repair cost × predictive signal is the money view. *(SM)*
4. **CapEx Forecast** — promote from 7. The 3-year exposure range is the budget/renewal conversation; it should never sit below "Recent work orders." *(SM)*
5. Compliance by site — fleet rollup, drill-in. *(SM)*
6. Next maintenance due — useful, but it duplicates the calendar; mid-page is right. *(both)*
7. Maintenance horizon (36-month strip) — planning texture, fine low. *(SM)*
8. Recent work orders — **demote to last.** Pure recency feed, no decision content; everything in it is reachable from Work Orders. *(low-value demote)*

**FT note:** a tech landing here mostly wants #1 and #6 — both stay in the top half. The real FT answer is the Field Mode home, which already exists.

---

## 2. Assets list (`pages/AssetsList.jsx`)

**Current columns (default visibility):**
Equipment · Manufacturer/Model · Serial # · Location · Address · Owner · Condition · Criticality · ~~Repair Cost~~ (hidden) · ~~Priority Score~~ (hidden) · Next Due · Open Def. · Service

**Proposed default:**
**Equipment · Condition · Next Due · Open Def. · Criticality · Location · Manufacturer/Model · Service** · (hidden by default: Serial #, Address, Owner, Repair Cost, Priority Score)

| Move | Rationale | Persona |
|---|---|---|
| Next Due, Open Def. → cols 3–4 | The two "does this need attention?" signals are currently cols 10–11, off-screen on most laptops | both |
| Condition → col 2 | Worst-of-three governing condition is the asset's health headline | both |
| Serial # → hidden default | Identification detail; needed when standing at the gear (that's Field Mode / detail page), not when scanning the register | demote |
| Address → hidden default | It's a data-hygiene flag ("does the site have an address"), not an operational signal; keep available in ColumnPicker | demote |
| Owner → hidden default | Org metadata, rarely the scan target | demote |
| Repair Cost, Priority Score → default ON in a saved **"Manager"** view | DPS and repair cost already exist server-sorted; the SM money view is one ColumnPicker preset away | SM |

The page already has ColumnPicker + SavedViews — ship the reorder as the new default plus a "Risk & $" saved view rather than role-based code.

---

## 3. Asset detail (`pages/AssetDetail.jsx`, Overview tab)

**Current order** (after header chips / Edit form):
1. Power Path
2. Outage Consolidation (self-gating)
3. Maintenance Schedules (grouped by standard)
4. AI Maintenance Brief
5. AI Photo Inspection
6. Service Quote Request
7. LOTO Procedures
8. Documents & Procedures (AssetDocumentsCard)
9. Work Orders
10. **Open Deficiencies**
11. Lab Samples
12. Risk & Criticality
13. Nameplate & Details
14. Custom Fields
15. Documents (compact, legacy)
16. Activity

**Proposed order (desktop default = SM):**
1. **Open Deficiencies** — open findings with a red title buried below two AI cards and a documents card is the page's biggest IA miss. First card, always. *(both)*
2. **Maintenance Schedules** — overdue rows are the second question. Within the card, consider sorting overdue groups/rows to the top rather than purely alphabetical-by-standard. *(both)*
3. **Risk & Criticality** — criticality score, repair cost, spare lead time, redundancy: the "should I care / what's the exposure" block, currently slot 12. *(SM)*
4. **Service Quote Request** — directly under the exposure data it justifies; deficiency + risk + quote button is the natural upsell funnel. *(SM)*
5. Outage Consolidation (self-gating; fine here) *(SM)*
6. Work Orders *(both)*
7. AI Maintenance Brief *(SM)*
8. Power Path — context, not a daily decision on desktop. *(demote for SM; FT gets it in Field Mode header already — `FieldAsset` shows fed-from/downstream in the header, which is the right treatment)*
9. Lab Samples
10. Nameplate & Details *(reference)*
11. LOTO Procedures — on desktop this is reference/authoring; in the field it's safety-critical, and Field Mode should carry that load (see gap note below). *(FT-relevant; demote on desktop)*
12. Documents & Procedures
13. AI Photo Inspection *(accelerant, not headline)*
14. Custom Fields
15. Activity
16. **Remove/merge the compact "Documents" card (slot 15)** — it duplicates AssetDocumentsCard (slot 8); two document cards on one page is confusing. *(cleanup)*

**Persona conflict & resolution:** FT wants LOTO + power path + tasks first; SM wants deficiencies + risk + quote first. Resolution: keep one desktop ordering (SM) because **FieldAsset.jsx is the tech ordering** — but note Field Mode currently has **no LOTO section** (see gaps).

---

## 4. Work orders list (`pages/WorkOrdersList.jsx`)

**Current sections:** Filters → **Priority Queue** card (DPS-scored assets with no open WO) → Work-order table. Section order is good — keep it. The Priority Queue is exactly the right "what should exist but doesn't" prompt for an SM.

**Current table columns:** Asset · Site · Task · Contractor/tech · Status · Scheduled · Completed · Decal

**Proposed:** **Asset · Status · Scheduled · Task · Contractor/tech · Site · Completed · Decal**
- Status+Scheduled at cols 2–3: a scheduled-for-yesterday OPEN row should jump out without horizontal scanning. *(both)*
- Site demoted (filterable above). Decal stays last (post-completion artifact). Completed is only meaningful for terminal rows. *(demote)*

**Priority Queue table** (Asset · Site · DPS · Condition · Criticality): fine; consider DPS to col 2 since it's the ranking key. *(SM, minor)*

---

## 5. Work order detail (`pages/WorkOrderDetail.jsx`)

**Current order:** Details → Test conditions & instruments → Test measurements → Deficiencies found → Lab samples → Documents.

**Proposed:** keep the **execution order for active WOs** (it mirrors NETA report flow a tech actually follows: conditions → measurements → findings), but **for COMPLETE/CANCELLED WOs reorder to: Details → Deficiencies found → Test measurements → Test conditions → Lab samples → Documents.** A manager reviewing a finished job reads findings first; instrument serial numbers are audit fine print. Status-conditional order is one ternary, no role plumbing. *(SM on terminal WOs; FT keeps execution order on active ones)*

Asset-detail WO sub-table (Status · Scheduled · Contractor · Completed) — fine as is.

---

## 6. Deficiencies (`pages/DeficienciesPage.jsx`)

**Current:** severity chips → status chips → site select → table: Severity · Description · Asset · Site · **Age (col 5)** · Work order · Actions.

**Proposed columns:** **Severity · Age · Asset · Description · Work order · Site · Actions**
- Age beside Severity: severity×age is the triage matrix; an aging IMMEDIATE is both audit liability and the warmest quote lead in the system. Default sort: severity rank, then age desc. *(SM primary, both)*
- Description after Asset: you orient on *which gear* before reading prose. *(both)*
- Work order before Site: "is anyone on it?" beats location. *(both)*

---

## 7. Compliance calendar (`pages/ComplianceCalendar.jsx`)

**Current:** site filter → month cards chronologically; rows: asset → task (+OUTAGE badge) → standard ref → site/date; overdue days flagged inline within the current month.

**Proposed:** chronology is correct for a calendar — don't fight it. One promotion: render a slim **"Overdue (N)" rollup strip above the first month card** linking to the overdue report, so past-due items aren't only discoverable by scrolling into the current-month card. Row order within days is fine. *(both, minor)*

---

## 8. Reports hub (`pages/ReportsHub.jsx` + `tables/reportsRegistry.js`)

**Current card order:** EMP Document → Compliance by Standard → Overdue by Severity → Standards Library → Audit Evidence Snapshots → Export Asset Register → *(planned)* Activity Summary → Trend Analysis.

**Proposed:** **Overdue Maintenance by Severity → Compliance by Standard → EMP Document → Audit Evidence Snapshots → Export Asset Register → Standards Library → planned items last.**
- Overdue-by-severity is the only *actionable* report — first. *(SM)*
- EMP stays top-3 (insurance renewal artifact = money), but it's an episodic export, not a daily read. *(SM)*
- Standards Library is education, not reporting — demote (long-term it belongs in the planned Help Center). *(demote)*

---

## 9. Sites list & Site detail

**SitesList columns (current):** Name · Location · Assets · Open deficiencies → **Proposed:** **Name · Open deficiencies · Assets · Location.** Risk count beats address. *(SM)*

**SiteDetail (current):** header → Edit site → **Structure tree** → Assets at this site → Blackout windows → System Studies.

**Proposed:** header → **Assets at this site** → **System Studies** → Blackout windows → Structure tree.
- Assets-with-condition/deficiency is the everyday read; the building/area/position tree is mostly touched during setup. *(both)*
- System Studies (arc-flash/coordination study dates) is a compliance-posture item an SM checks before audits — above blackout windows. *(SM)*

**"Assets at this site" columns (current):** Asset · Type · Condition · Open deficiencies → **Proposed:** **Asset · Condition · Open def. · Next due · Type** — note **Next Due is missing entirely** from this table; adding it would make the site page a self-sufficient triage view. *(both — gap, not just reorder)*

---

## 10. Fleet Dashboard (`pages/FleetDashboard.jsx`) — the OEM/partner SM home

**Totals bar (current):** Total Assets · Overdue Schedules · IMMEDIATE Open · Service Opportunities · Open Work Orders · Accounts w/ Issues
**Proposed:** **IMMEDIATE Open · Overdue Schedules · Service Opportunities · Accounts w/ Issues · Open Work Orders · Total Assets.** Risk → money → coverage; the fleet headcount is wallpaper. *(SM)*

**Account card metric pills (current):** Assets · Overdue · IMMEDIATE · Svc Opps · Open WOs · Last Service → **Proposed:** **IMMEDIATE · Overdue · Svc Opps · Last Service · Open WOs · Assets.** Last Service is the relationship-health/renewal signal — promote it. *(SM)*

**Expanded account panel (current grid):** Overdue Schedules → IMMEDIATE Deficiencies → Service Opportunities → Recent WOs.
**Proposed:** **IMMEDIATE → Service Opportunities → Overdue → Recent WOs** — safety first, then the "ready for quote" list (the panel's own copy says *"IMMEDIATE open Nd — ready for quote"*); overdue schedules are the slower burn. *(SM)*

**Fleet Modernization Forecast (CapEx table):** currently dead last, below all account cards — for a fleet view whose buyers are pitched on CapEx forecasting, promote it to **directly below the totals bar** (or add an anchor/summary chip in the totals bar: "3-yr exposure $X–$Y"). Highest-ROI single move on this page. *(SM)*

---

## 11. Alerts (`pages/AlertsPage.jsx` + `tables/alertsColumns.jsx`)

**Current columns:** Type · Asset · Site · Task · Due Date · **Tier** · Actions (default sort: tier asc).
**Proposed:** **Tier · Due Date · Asset · Type · Task · Site · Actions.** The table is sorted by Tier yet Tier renders 6th — the sort key should be the first thing the eye lands on, with Due Date as the second triage axis. *(both)*

---

## 12. Audits (`pages/AuditsPage.jsx`)

**Tabs:** Visits / All recommendations — fine.

**Visits table (current):** [expander] · Type · Scope · Auditor · Scheduled · Performed · Outcome · Open RECs · Snapshots.
**Proposed:** **[expander] · Type · Outcome · Open RECs · Scheduled · Performed · Scope · Auditor · Snapshots.** Outcome + open recommendation count = "did we pass and what's still hanging" — that's the audit-readiness glance. *(SM)*

**All recommendations (current):** Recommendation · Audit · Source · Severity · Status · Due · Assignee.
**Proposed:** **Severity · Status · Due · Recommendation · Assignee · Audit · Source.** Same severity-first logic as Deficiencies; prose text never belongs in column 1 of a triage table. *(SM)*

---

## 13. Outage Planner (`pages/OutagePlannerPage.jsx`)

**Current:** header → savings banner ("Consolidating saves N shutdowns") → per-site sections (task count + consolidation into one window, schedule form).
**Verdict:** ordering is already correct — the savings banner is the ROI headline and leads. Only suggestion: inside each site section, surface the **earliest hard due date** in the section header so the SM can see how much slack each consolidation window has before drilling in. *(SM, minor)*

---

## 14. Disaster Response (`pages/DisasterResponsePage.jsx`)

**Current:** header → Queue position card (once declared) → Service rep contact → Active events list (+ Declare modal).
**Verdict:** correct priority — queue status, then "call this human," then history. In EMERGENCY contexts the phone number is the product. One tweak: when **no** event is declared, the Declare CTA + rep phone should be the first visual block (verify the pre-declaration state renders rep contact above the fold). *(FT/both)*

---

## 15. Field Mode (`pages/field/`)

**FieldHome (current):** Scan equipment button → Outbox sync chip → **Overdue** → **Due soon** → Open work orders → Open deficiencies.
**Proposed:** Scan → Outbox → **Open work orders** → **Overdue** → Due soon → Open deficiencies. Assigned, scheduled work is "what do I do next"; overdue-but-unscheduled is the dispatcher's problem first. Defensible either way — if techs self-dispatch in your demo accounts, current order is fine. *(FT)*

**FieldAsset (current):** Header (label, condition/energized chips, fed-from/downstream) → Tasks → 📷 Photo inspect → Report deficiency → Open deficiencies → Open work orders → Record measurement → Scan nameplate.
**Proposed:** Header → **Open deficiencies** → Tasks → **Record measurement** → Report deficiency → Open work orders → Photo inspect → Scan nameplate.
- Known hazards before anything else — a tech must see the existing IMMEDIATE before touching the gear. *(FT, safety)*
- Record measurement promoted next to Tasks: it's the core logging loop during a PM. *(FT)*
- Photo inspect demoted: AI assist below the manual primitives it accelerates. *(FT)*
- **Gap:** no LOTO section in Field Mode — the place LOTO matters most. Worth a future card between header and tasks. *(FT)*

---

## 16. Contractors

**ContractorsList (current):** Company · Accreditation · Techs · Open work orders → **Proposed:** **Company · Open work orders · Accreditation · Techs.** Active workload first; accreditation is a vetting-time check. *(SM)*

**ContractorDetail (current):** header → Edit → Tech roster → Recent work orders → **Proposed:** header → **Recent/Open work orders** → Tech roster. Work tells you about the relationship; the roster is reference. *(SM)*

---

# Tables — "first 3–4 columns" cheat sheet

The stakeholder question: *what are the first 3–4 columns that tell you at a glance whether something needs attention?*

| Table | Service Manager | Field Tech (where different) |
|---|---|---|
| **Assets** | Equipment · Condition · Next Due · Open Def. | same (add Location 5th for routing) |
| **Work Orders** | Asset · Status · Scheduled · Task | Scheduled · Asset · Task · Status |
| **Deficiencies** | Severity · Age · Asset · Work order | Severity · Asset · Description |
| **Alerts** | Tier · Due Date · Asset · Type | same |
| **Audit recs** | Severity · Status · Due · Recommendation | n/a (manager surface) |
| **Audit visits** | Type · Outcome · Open RECs · Scheduled | n/a |
| **Sites** | Name · Open def. · Assets | n/a |
| **Contractors** | Company · Open WOs · Accreditation | n/a |
| **Fleet forecast** | Account · Year-1 range · Assets | n/a |
| **Testing YoY pivot** | Test/Phase · **Latest Δ · Trend** · latest value | same |

**Testing & Trends pivot note** (`components/TestingTrendsTab.jsx`): the pivot renders Test/Phase, then *every* historical event column oldest→newest, with Latest Δ and Trend **last**. With 5+ years of events the verdict columns scroll off-screen. Recommend moving **Latest Δ + Trend to columns 2–3** (or sticky-pinning them right) so the wrong-direction flag is always visible. Card order on the tab (hero trend chart + gauges → YoY pivot → per-event cards) is already right.

---

# Persona conflicts & resolution summary

| Screen | Conflict | Resolution |
|---|---|---|
| Asset detail | SM wants deficiencies/risk/quote first; FT wants LOTO/power-path/tasks first | Desktop page defaults to SM order; **Field Mode is the FT ordering** (add LOTO card there). No role-based reordering code needed. |
| Dashboard | SM wants money panels high; FT wants today's work | Keep SM default; FT home is `/field`. |
| Work order detail | FT wants execution order; SM wants findings-first review | **Status-conditional order**: active = execution flow, terminal = findings first. |
| Work orders table | SM scans status; FT scans dates | Shared compromise (Asset · Status · Scheduled) — both signals within first 3 columns. |
| FieldHome | Dispatch model ambiguity (assigned WOs vs overdue first) | Pick based on whether techs self-dispatch; suggested WOs-first. |

# What I couldn't determine from code alone
- Actual rendered widths/fold lines (no browser run) — column-count-vs-viewport claims assume ~1280–1440 px laptops.
- Whether per-user saved views already persist column *order* (SavedViewsMenu persists visibility/filters; order appeared fixed in JSX).
- Real usage telemetry — all "low-value" calls are domain judgment, not analytics.
- Pre-declaration layout of Disaster Response (rep-contact position before an event is declared) was inferred, worth a visual check.

# ServiceCycle — Master Punch List (2026-06-11)

Consolidated from the 6/10 list (minus confirmed-fixed), today's findings, and Fable's
IA/persona review. Work happens on branch `ui-modernize-fable`, verify, push tonight.
Persona tags: **SM** = service manager, **FT** = field tech/consultant.

---

## ✅ Already fixed this session (6/10 items — REMOVED from active work)
- Equipment Templates "route not found" → client called `/api/standards/tasks`; fixed to `/api/standards/task-definitions`.
- Import Data → source-system options unreadable in dark mode → global `select option` color rule added.
- Help drawer persisted across navigation → now closes on route change.
- Industry news scanner "not pulling anything" → scanner was disabled + had no UA; enabled, added browser UA, fires on login (throttled). Real EC&M/CSE/Plant-Engineering articles flowing; fake seeds removed.
- Chrome-tab favicon → replaced with bold petrol tile + cyan→lime pulse (legible at 16px).
- Seed a few audits → 2 audit visits + 5 recommendations already seeded (NOTE: more/archived requested below).
- Global pill/chip color tokens added (dark-mode contrast) — BUT specific pills still flagged below.
- `.com → .app` swept in `client/src` — full-codebase sweep still pending below.

---

## A. Quick UI / CSS wins
- **A1. Sticky page top-bar / title** — anchor each page's header so the title doesn't scroll away on long pages. (both)
- **A2. Pill/badge contrast — targeted.** Specific pills still light-grey-on-white / unreadable in dark (and maybe light): the **Industry News "matched: NFPA 70B"** pill, **Equipment Templates** white/grey pills, **Dashboard › Priority Assets** light-red/pink pills. Darken text across all colored pills. (both)
- **A3. Dashboard › "Open deficiencies by severity"** — reformat the tile text (drop/replace the bullet), AND condense the whole section (eats too much vertical space). (SM)
- **A4. Dashboard › "Overall compliance rate"** — shrink the big 89% to match the "Due in XX days" card text sizing. (both)
- **A5. Dashboard › "Maintenance horizon — next 36 months"** — equalize spacing between monthly squares across all years (2029's first squares are off). (both)
- **A6. Equipment Templates** — lay the 6 cards out as a 2×3 grid (currently one row). (both)  [open Q: do we want more than 6 templates?]
- **A7. Normalize data-display spacing site-wide** — start with **Contractors › Recent Work Orders** chart (status→decal columns have random spacing); apply the same normalization anywhere data columns/inputs are unevenly spaced. (both)

## B. Dashboard layout / IA (Fable review + your notes)
- **B1. KPI row: lead with Overdue (+ add an IMMEDIATE-count tile); severity reads left→right.** (both)
- **B2. Promote "Maintenance horizon" higher** on the dashboard (valuable, currently buried at the bottom). (both)
- **B3. Promote CapEx / Modernization forecast** up (slot ~4–5), demote "Recent Work Orders." (SM)
- **B4. "Recent work orders / most recently updated"** — keep but **resize smaller**; reclaim the space for a higher-priority module. (SM)
- **B5. Drill-downs must carry the filter.** "Due in 30 days = 6" → Compliance Calendar filtered to exactly those 6; "Open deficiencies by severity" links → Deficiencies filtered to that severity. Generalize to every count/tile. (both)

## C. Navigation
- **C1. Systemic "← back" = return to where you came from** (router history / `from` location), platform-wide. Known breaks: Outage Planner → View Asset → "← Assets" goes to Assets list not back to Outage Planner; Deficiencies page (reached from a dashboard tile) has **no** back link. Audit every detail page. (both)
- **C2. Field Mode sidebar link placement** — move to top or bottom (awkward mid-list); confirm installed PWA opens into Field Mode by default (`start_url=/field`). (FT)
- **C3. Equipment Templates** — nest under **Assets** in the sidebar (doesn't need its own top-level entry). (both)

## D. Tables / columns
- **D1. Assets — Excel-style per-column header filters.** A dedicated **filter row directly beneath the column headers** (ref: LapseIQ contract page screenshot). Each column gets its own "Filter" control: **categorical → dropdown with checkboxes (single OR multi-select)**, **date columns → date-picker (range)**, **numeric (e.g. Value) → min/max**. Matches the provided screenshot exactly. (both) [Dustin approved a one-time look at LapseIQ's filter code to adapt; building fresh to match the screenshot.]
- **D2. Assets list column order** — first four = **Equipment · Condition · Next Due · Open Deficiencies**; hide Serial #, Address, Owner by default. (both)
- **D3. Fleet Dashboard** — totals reorder to IMMEDIATE · Overdue · Service Opportunities · Accounts w/ issues · Open WOs · Total Assets; lift Modernization Forecast table to directly under the totals. (SM)
- **D4. Testing & Trends pivot** — move "Latest Δ" + trend-flag columns to position 2–3 so the verdict doesn't scroll off. (both)
- **D5. Site detail asset table** — add the missing **Next Due** column. (both)  [gap Fable found]
- **D6. Column picker** — on all Excel-like data pages (Assets, etc.), a control to add/remove/show/hide columns; persist the choice (there appears to be partial SavedViews visibility support — extend it into a real column picker that pairs with D1 filters + D2 ordering). (both)

## E. Asset Detail (Fable review)
- **E1. Open Deficiencies → top of the page** (currently ~10th, under AI/LOTO/docs). (both)
- **E2. Sequence deficiency → Risk/Criticality → Quote Request** in the top third (problem → exposure → upsell). (SM)
- **E3. Work-order detail** — order by status (active = execution flow; completed = findings-first for manager review). (both)

## F. Features / pages
- **F1. Outage Planner** — beef up the explanation/descriptions (what it does, what an outage window looks like, how to read output). (both)
- **F2. Field Mode** — (a) easy filters (Site filter exists; add equipment-type / due-status quick filters?); (b) **Scan Nameplate should open the camera on mobile** for immediate capture (on PC it opened a file picker — confirm mobile = camera); (c) **add a LOTO section** (Field Mode has none — the place a tech needs lockout/tagout most). (FT)
- **F3. Welcome / first-run tour** — ensure it fires on a fresh demo login (reset onboardingStep; test with a fresh user, not the already-advanced admin@demo). (both)
- **F4. Weather alerts** — confirm/where they surface (sidebar indicator vs. DisasterBanner only); decide if a sidebar indicator is wanted. (both)
- **F5. Alerts page is empty** while the dashboard shows due/deficiency counts — reconcile: should the Alerts page be populated (seed alerts) and/or feed the dashboard? (both)

## G. Data / seeding
- **G1. Ensure every report is seeded with non-empty data** — compliance snapshots still empty (need real generated files w/ sha256+filePath, or a safe stub), plus walk each report. (SM)
- **G2. Seed archived equipment, more audits, and alerts** (so Archive, Audits, Alerts pages aren't bare). (both)

## H. Branding (finish the sweep)
- **H1. Remove every `servicecycle.com` mention + email across the WHOLE codebase** (server/docs/scripts ~120 files; client/src already done). We own `servicecycle.app`. (n/a)
- **H2. Logo on the legal docs** (favicon already done). (n/a)

## I. Decisions needed (not blocking other work)
- **I1. Help → "Ask ServiceCycle AI" chatbot** (like LapseIQ) — seed the help corpus; customers supply their own API key? Confirm before building.
- **I2. Contractor grading/scoring** in the tool — value vs. risk (contractors could see it). Keep internal-only or skip?
- **I3. Equipment Templates** — do we want more than 6?

---

## Suggested execution order (minimize rebuilds, branch `ui-modernize-fable`)
1. **Batch 1 (client CSS/IA, one build):** A1–A7, B1–B4, C2–C3, D2, D4, E1–E3. (pure restyle/reorder — highest visual ROI, low risk)
2. **Batch 2 (client + light server):** B5 + C1 (filtered drill-downs + systemic back-nav), D1 (Excel column filters), D6 (column picker), D3, D5.
3. **Batch 3 (server/seed):** G1, G2, F3, F5; F2c (Field Mode LOTO).
4. **Batch 4:** F1 copy, F2a/F2b (field filters + camera), F4, H1 sweep, H2 legal logo.
5. **Decisions:** I1–I3 with Dustin.

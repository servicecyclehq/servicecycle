# ServiceCycle — Demo Script (PE/OEM Buyer)

**Format:** 20–25 minute live demo, screenshare  
**Audience:** PE deal team, OEM product/strategy, industrial facility VP  
**Login:** servicecycle.app (contact for credentials)  
**Goal:** Leave the buyer thinking "this is the data layer I didn't know I needed"

---

## Opening line (30 seconds, before logging in)

> "Electrical contractors do a job, hand over a report, and the relationship goes cold.
> The customer files the PDF. No one knows when the next test is due.
> ServiceCycle converts that report into a living equipment record — 
> and surfaces the next job automatically. Transaction becomes program."

Then log in.

---

## 1. The dashboard (3 min) — *"the whole story at a glance"*

Land on the main dashboard. Let it speak first — don't rush to explain.

**Points to hit:**
- Top KPIs: compliance rate, overdue items, open deficiencies, active arc-flash labels
- "Path to 100%" progress bar — what it would take to hit full compliance. This is the pipeline engine: every gap is a scheduled job.
- Compliance horizon — the calendar of what's coming due. "This is your book of work for the next quarter, automatically generated from the reports you already uploaded."
- Weather tile (if visible) — "We pull in local weather because NEC and NFPA have ambient-condition requirements for some test types."

**Punchline:** "You're looking at a contractor's entire customer portfolio health — built from PDFs they already produce."

---

## 2. Asset detail (3 min) — *"the record that never existed before"*

Click into any asset (e.g., a switchgear or panelboard with C2 condition).

**Points to hit:**
- Condition badge (C1/C2/C3) with NFPA 70B reference — "condition-based, not calendar-based"
- Maintenance schedule panel: next due date calculated from the last work order, automatically
- Active deficiencies panel — open findings from the last inspection, each with severity and resolution status
- Arc Flash tab — show the current label (PPE category, incident energy, flash boundary); "this is what the technician needs before touching live equipment; it's gated on a current study"
- Test history tab — trend line of measurements across visits; "this is the YoY comparison that tells you if a transformer is degrading"

**Punchline:** "Every one of these tabs was populated from a PDF that already existed in a filing cabinet."

---

## 3. Arc flash management (3 min) — *"the life-safety layer"*

Navigate to Reports → Arc Flash or the Arc Flash section.

**Points to hit:**
- Label status by site: current / expiring / superseded / missing — at a glance
- Click into a label: the full NFPA 70E 130.5(H) output — PPE category, incident energy, flash boundary, working distance, equipment ID
- "5-year review clock" — the system tracks study expiry and flags assets where the study is stale
- "Before we issue an energized-work permit, the system checks: does this asset have a current study? If not, it blocks the permit. That's an OSHA-cited requirement under NFPA 70E."
- AFX export — "we can export the full arc-flash data set in the industry-standard AFX format, which any EAM or safety software can ingest"

**Punchline:** "Every arc-flash fatality triggers OSHA review of every related facility. This is the system that proves you're current."

---

## 4. Report ingest (2 min) — *"the moat"*

Navigate to the document ingest / upload area.

**Points to hit:**
- "This is where the data comes in — not from manual entry, from the reports the contractor already produces"
- Show the PDF parser: upload (or show a previously uploaded) test report; it parses the measurements and populates the asset record
- AI gap-fill: "where the PDF is thin or scanned, the AI drafts the missing fields — the technician reviews, not enters from scratch"
- "The competitors in this space — horizontal CMMS tools like MaintainX or UpKeep — require manual data entry for every asset. That's why they don't get adopted. We start from what already exists."

**Punchline:** "Zero-entry onboarding. The contractor uploads the reports they already have, and we do the rest."

---

## 5. Quote Request / customer demand (2 min) — *"the second revenue engine"*

Navigate to the Quote Requests inbox (or explain it verbally if not populated).

**Points to hit:**
- "When the contractor pushes this platform to their customer — a facility manager — that customer can now see their own equipment health"
- From that view, the facility manager can submit a quote request with one click — pre-loaded with the asset record, the open deficiency, the test history
- "The contractor's rep gets an email: 'Generator B14, overdue for load bank test, last tested 2021, three open deficiencies.' Not a cold call — a warm, pre-loaded lead."
- Quote requests feed into the same compliance loop: accept → create work order → mark complete → schedule advances

**Punchline:** "The platform converts the facility manager from a passive recipient of PDFs into an active demand source for the contractor."

---

## 6. Multi-site / enterprise rollup (1 min) — *"the scale story"*

If showing to PE or a large industrial buyer, navigate to the Sites overview or EnterpriseGroup view.

**Points to hit:**
- Multi-site rollup: compliance rate, overdue count, deficiency count per site — in one view
- "For a PE firm rolling up contractors, this is the portfolio view: every acquired contractor's customer base, consolidated"
- "For a large industrial operator with 12 facilities, this is the fleet view: who's compliant, who's at risk, what's the total cost exposure"

---

## 7. Export and data portability (1 min) — *"no lock-in"*

Navigate to Reports → Export or Settings.

**Points to hit:**
- One-click account export: all assets, work orders, arc-flash data, parts — JSON + XLSX
- "We believe in zero lock-in. A customer can take their data out in full at any time. That's a trust signal, not a risk."
- v1 REST API: "any existing CMMS — MaintainX, Maximo, SAP PM — can pull from or push to this platform. It's composable, not a replacement."

---

## 8. The handoff (2 min) — *"built to be owned by someone else"*

This is specifically for a buyer conversation. You can say it or navigate to the docs section.

> "The whole product is documented to run without me. There's a deploy runbook, an architecture doc, a security trust pack, a SOC 2 controls mapping, and a full engineering handoff guide written for whoever takes over. I built this to be handed off — that was the design constraint from day one."

Points to hit if showing docs:
- `docs/ARCHITECTURE.md` — stack + security architecture
- `docs/SOC2_CONTROLS.md` — 14+ Trust Service Criteria mapped
- `docs/ENGINEERING_HANDOFF.md` — day-1 guide for a new CTO
- Test suite: ~500 integration tests; CI via GitHub Actions

---

## Closing (30 seconds)

> "What you're looking at is the data layer between field work and compliance — 
> the layer that didn't exist. The contractor market is fragmented, 
> under-digitized, and increasingly on the hook for NFPA 70B and OSHA compliance.
> This is the tool that makes them sticky to their customers and their customers 
> sticky to them. The question is: who owns that data layer?"

Then stop. Let them ask questions.

---

## Common objections and responses

**"Why would contractors adopt this?"**
> "Because it generates their next work order automatically. It doesn't add work — it converts work they already do (writing reports) into a pipeline. The first job is the hook; the platform surfaces the next one."

**"Isn't this just a CMMS?"**
> "Horizontal CMMS tools (MaintainX, UpKeep) require manual data entry. They don't understand NFPA 70B intervals, arc-flash label currency, or IEEE 1584 study requirements. We're the compliance layer, not the ticketing system."

**"What's the competition?"**
> "There's no direct incumbent. Contractors use Excel and email. The gap itself is the opportunity."

**"You have no customers — how do we value this?"**
> "This is a pre-revenue asset play, not a multiple-of-ARR deal. The value is the completed, documented, production-deployed software with a defensible domain moat and a clear deployment path into an existing contractor book of business. The first acquirer has a head start that can't be replicated."

**"What would it take to integrate this with our existing tools?"**
> "The v1 REST API is documented at `/api/docs`. It's OpenAPI 3.1. A basic MaintainX or Salesforce integration takes a backend developer 1–2 weeks. We have an integration guide at `docs/api/INTEGRATIONS.md` that walks through both."

**"Can it handle our scale?"**
> "The current architecture is single-VPS + Postgres. The natural scale path is managed Postgres + horizontal compute — the app is stateless and the schema is built for it. The OEM atlas design doc (`docs/research/2026-06-20-oem-atlas-cross-tenant-design.md`) describes the multi-tenant fleet analytics path that your scale enables."

---

## After the demo

Send the buyer:
1. Link to the live demo (servicecycle.app — request credentials)
2. `docs/ACQUISITION_BRIEF.md` — the written acquisition narrative
3. `docs/SECURITY_TRUST_PACK.md` — if they have a security team asking questions
4. `docs/ARCHITECTURE.md` — for technical due diligence
5. Offer NDA + source code access for serious buyers

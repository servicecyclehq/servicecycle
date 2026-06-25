# ServiceCycle — Competitive Analysis

**Classification:** Confidential / Diligence  
**Updated:** 2026-06-25

---

## Market position in one sentence

ServiceCycle is the only platform that converts an electrical contractor's
existing field reports into a living NFPA 70B compliance record, arc-flash
management system, and customer demand-capture engine — without requiring
any manual data entry from the contractor or the facility.

---

## The real "competition": Excel and paper

The most common current solution is a spreadsheet, a shared drive of PDFs,
and a phone call when the customer notices something is wrong. This is the
operative competitive baseline:

- No compliance calendar
- No cross-site visibility
- No arc-flash currency tracking
- No demand generation from existing work
- No customer-facing interface

ServiceCycle doesn't replace a tool the contractor is currently using —
it fills a gap that doesn't exist in their current workflow. Position as
"revenue you're leaving on the table" rather than "replacement for X."

---

## Named competitive tools

### Horizontal CMMS — MaintainX, UpKeep, Limble

**What they do:** Work-order management, preventive maintenance scheduling,
asset tracking. General-purpose, multi-industry.

**Why contractors don't adopt them for electrical compliance:**
- Require manual data entry for every asset — the contractor would need to
  re-key everything from every PDF report before getting value. This is
  the friction that killed Gimba ("way too much work for the user").
- No understanding of NFPA 70B intervals, condition ratings (C1/C2/C3),
  arc-flash label requirements, or IEEE 1584 study currency.
- No arc-flash compliance layer — cannot block an energized-work permit
  based on study status.
- Sold to facility managers / internal maintenance teams, not contractors.
  A contractor using UpKeep for their customers would be paying for a tool
  their customer owns and can take away.
- No report ingestion — no path from "hand over a PDF" to "data is live."

**ServiceCycle's edge:** Zero-entry onboarding from existing PDFs + full
NFPA 70B domain logic + arc-flash management built in + contractor-aligned
distribution model (the contractor is the user, not the facility manager).

---

### OEM software — ABB ESAP, Schneider Electric EcoStruxure

**What they do:** Manufacturer-specific asset management for large
industrial installations. Typically bundled with the OEM's own equipment.

**Why they don't compete for the electrical contractor market:**
- Proprietary to one manufacturer's equipment — a contractor who tests
  across 30 brands can't use a Schneider tool for Square D and ABB gear.
- Expensive enterprise software — per-seat licensing, long implementation
  cycles, IT-heavy deployment.
- Not designed for contractors — designed for facilities teams with
  dedicated maintenance staff.
- No customer demand-capture features (Quote Request, QEMW, field mode).

**ServiceCycle's edge:** Multi-vendor asset support, lightweight deployment
(web app / PWA, no IT team required), contractor-first distribution model,
and the customer demand-capture layer that OEM software doesn't have.

**OEM acquisition angle (inverse):** Rather than competing with OEM
software, ServiceCycle is the complement — an OEM acquires ServiceCycle
to add the compliance and demand-capture layer to their instrument
ecosystem without building it from scratch.

---

### Vertical NETA/maintenance tools — AVO TRAX, PowerDB (standalone)

**What they do:** Test data management for NETA-accredited testing firms.
PowerDB is the de facto standard for entering and storing electrical test
results in a structured format. AVO TRAX provides basic asset tracking.

**Why they're not direct competitors:**
- PowerDB is a test-data *recording* tool, not a compliance *monitoring*
  platform. It produces the PDF reports that ServiceCycle ingests. It has
  no compliance calendar, no arc-flash currency management, and no
  customer-facing surface.
- AVO TRAX is similarly focused on the testing workflow, not the ongoing
  monitoring and demand-generation functions.
- Neither has a customer-facing demand-capture surface.
- Neither is built for the contractor-to-customer-to-contractor flywheel.

**ServiceCycle's edge:** ServiceCycle is downstream of PowerDB — it
consumes the reports PowerDB produces and adds the monitoring and
compliance management layer that PowerDB doesn't have. They are
complementary, not competing.

**Partnership angle:** PowerDB is the de facto standard that field
technicians already use. An integration that automatically ingests
PowerDB exports (rather than the parsed PDF) would be a significant
distribution wedge. The design supports it: the ingestion parser already
handles PowerDB-format PDFs.

---

### EAM / CMMS for utilities — IBM Maximo, SAP PM

**What they do:** Enterprise asset management at scale — utilities,
refineries, heavy industrial. Tens of thousands of assets, complex
workflow management, SAP/Oracle integration.

**Why they don't compete:**
- Implementation costs in the hundreds of thousands; 12+ month rollouts.
  A 10-person electrical testing contractor cannot adopt Maximo.
- No contractor-specific features; no arc-flash label management;
  no customer demand-capture.
- The ServiceCycle v1 REST API is designed to integrate with Maximo/SAP PM
  (see `docs/api/INTEGRATIONS.md`), not compete with them. At an enterprise
  account that already has Maximo, ServiceCycle sits above it as the
  arc-flash and NFPA 70B compliance layer.

**Integration angle (large industrial / utility):** For the utility or
large industrial direct sale, ServiceCycle is sold as a compliance overlay
for what's already in Maximo/SAP — not a replacement. The bidirectional
API makes this composable. The arc-flash management, label generation, and
NFPA 70B monitoring have no equivalent in Maximo.

---

## Barriers to replication

**Domain specificity:** NFPA 70B condition-based interval calculations,
IEEE 1584 arc-flash study ingestion, NFPA 70E 130.5(H) label requirements,
AFX export format, and study-expiry tracking are all domain-specific. A
general-purpose CMMS vendor would need to hire domain experts and spend
12–18 months building this knowledge into their platform.

**Report ingestion:** The deterministic PDF parser that recognizes
PowerDB, Megger M-Power, and NETA-standard report formats is not
straightforward to replicate. It encodes the structural quirks of each
report format. This is the primary data-in moat.

**History network effects:** Once a contractor's report archive is loaded,
the switching cost is high — the equipment history, condition trends,
arc-flash labels, and compliance calendar are all tied to the ingested
data. A competitor would need to re-ingest the same archive, and the
facility manager would lose their history in the transition.

---

## Win/loss summary

| Scenario | ServiceCycle wins because... |
|---|---|
| Small-to-mid NETA contractor (primary target) | Only tool that starts from their existing reports; no data entry; contractor-first |
| Mid-size industrial facility with in-house testing | Arc-flash management + NFPA 70B monitoring layer; REST API composes with existing CMMS |
| PE roll-up of electrical contractors | The platform is the differentiated portfolio asset; each acquired contractor arrives data-ready |
| OEM test-equipment manufacturer | Acquires the compliance + demand-capture layer without building it; deepens instrument lock-in |
| Utility / large industrial (long-term) | Compliance overlay above Maximo/SAP; arc-flash management fills a gap in EAM tools |

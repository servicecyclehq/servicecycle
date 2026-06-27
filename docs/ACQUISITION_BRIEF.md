# ServiceCycle — Acquisition Brief

**Classification:** Confidential / Diligence  
**Prepared:** 2026-06-25  
**Contact:** servicecycle.app (demo access available on request)

---

## The one-paragraph pitch

ServiceCycle is the missing data layer between an electrical contractor's field reports and the recurring service revenue those reports should generate. It converts one-off inspection PDFs into a living equipment-health record that surfaces what's due, what's trending bad, and what's non-compliant — transforming a transaction relationship into a permanent maintenance program. The platform manages arc-flash compliance (a federally-recognized life-safety obligation under NFPA 70E), NFPA 70B condition-based maintenance scheduling, and real-time telemetry monitoring. It is built to be embedded in a PE contractor roll-up, licensed to OEM test-equipment manufacturers, or sold to utilities and industrial facilities teams as a standalone compliance SaaS.

---

## The market gap it fills

Electrical contractors test and inspect equipment, hand over thick PDF reports, and then the relationship goes cold. The customer files the PDF. No one knows when the next test is due. No one monitors whether anything changed. The contractor has no visibility into the customer's equipment health between jobs — so the next job is a cold call, not a data-driven signal.

**ServiceCycle converts the reports contractors already produce into an ongoing revenue engine.** The contractor uploads the report (or it flows in automatically from compatible instruments); ServiceCycle parses it, populates the asset record, calculates NFPA 70B maintenance intervals, flags arc-flash study currency, and from that point forward surfaces "this panel is due for infrared thermography in 47 days" — generating the next work order automatically.

Transaction → recurring program. For the contractor: predictable revenue, stickier customers, a reason to call before the customer calls a competitor.

---

## Why this market, why now

**NFPA 70B (2023 revision)** — the standard that governs electrical equipment maintenance — shifted from recommended to condition-based, giving AHJs (Authorities Having Jurisdiction) clearer grounds to enforce maintenance intervals. Facilities that haven't digitized their maintenance records are increasingly exposed during inspections. This creates an immediate compliance pull.

**NFPA 70E (arc flash)** — every energized electrical work permit requires a current arc-flash study (PPE category, incident energy, flash boundary). Studies must be updated when equipment changes or on a 5-year cycle (OSHA-cited). Most facilities carry stale studies on paper or in a spreadsheet. Every arc-flash fatality triggers OSHA scrutiny of every related facility in the contractor's book — the liability is shared. ServiceCycle tracks study currency, flags expiry, and gates energized-work permits when the data is missing or stale.

**The incumbent**: there is no incumbent. The gap itself is the opportunity. Contractors hand over PDFs and move on. Facilities track compliance in Excel or not at all. The closest competitors (MaintainX, UpKeep) are horizontal CMMS tools that require manual data entry — they do not ingest existing field reports, they do not understand NFPA 70B intervals or arc-flash label requirements, and they are not built for contractors (they target the facility end-user).

---

## Two revenue engines

**Engine 1 — Proactive monitoring (contractor-side).** The contractor uses ServiceCycle to monitor every customer's equipment health. Compliance calendar surfaces what's coming due. Deficiency register shows unresolved open items. Condition scoring (C1/C2/C3) tracks degradation between visits. The platform turns the contractor's existing report archive into a live dashboard of revenue opportunities.

**Engine 2 — Customer demand capture (facility-side).** When the contractor pushes the platform to their customer (a facility manager), that customer can view their own asset register, open deficiencies, and arc-flash label status. From that surface:
- **Quote Request** — one-click request for a service call, pre-loaded with the asset dossier. Arrives at the contractor's rep with full context: what equipment, what deficiency, what history.
- **Declare Emergency** — one-tap escalation for a live fault, routed to the on-call rep.
- **QEMW wallet** — digital energized-work permit, stamped with arc-flash data, accessible from a QR code on the equipment.

These surfaces make the facility manager sticky to *the contractor*, not the platform. The contractor is the distribution channel. ServiceCycle is the tool that makes the contractor irreplaceable.

---

## The data moat

Frictionless data-in is the structural barrier to replication. ServiceCycle ingests:
- **Existing PDF test reports** (PowerDB, Megger M-Power, NETA-standard forms) via a deterministic parser with AI-assisted gap-fill — zero manual entry for the contractor
- **Nameplate photos** (OCR → auto-populate asset record)
- **Arc-flash study spreadsheets** (IEEE 1584 inputs, NFPA 70E label outputs)
- **Real-time telemetry** from OT edge gateways (voltage, current, temperature, power factor) via the v1 REST API

Once a contractor's report archive is loaded, switching costs are high: the equipment history, compliance calendar, arc-flash labels, and deficiency register are all there. No competitor can offer that history without another import.

---

## Revenue Intelligence — SC detects, the CRM manages

ServiceCycle ships a super_admin-only **Revenue Intelligence** surface: a read-only, cross-tenant field-intelligence feed that surfaces condition-driven pull-through opportunities the platform can see and a CRM cannot. It is deliberately *not* a pipeline tool.

**SC is the detector; the CRM is the manager.** The module has no stages, owners, forecasts, or close dates — it never duplicates pipeline management. It detects, scores, and hands off. The rationale is structural: a strategic acquirer already owns a CRM (Salesforce, Dynamics, HubSpot), and re-implementing one inside SC would create a competing system of record and a perpetual data-sync liability. SC's defensible contribution is the **signal** — the cross-tenant, condition-derived opportunity no CRM can compute, because the CRM does not hold equipment-health data. The single editable field on the surface, "CRM Value," is rep-owned and never pre-populated from SC's estimate, so the number that lands in the CRM is always owned by a human.

**Pull-through revenue for OEM channel programs.** For an OEM acquirer this is the channel-enablement layer. Every panel an OEM instrument tests becomes a monitored asset; when an arc-flash study expires, a safety-critical breaker or transformer is modified after the study, or a protective device drifts out of its study assumptions, SC surfaces it as a *scored* lead with an estimated dollar range and a resolved customer contact — ready to route to the channel partner's or service org's CRM. The instrument sale seeds recurring service pull-through, and the platform makes the next service call a data-driven signal instead of a cold call. The planning-horizon framing (arc-flash studies require 2–4 months of lead time) converts "compliance is due" into "act now, you may already be inside the window."

**The opportunity lifecycle is condition-driven, not time-driven.** Legacy renewal engines fire on a calendar — a study turns five years old, send a reminder. SC fires on **condition**: equipment changed after the last study, devices drifted from their study settings, IMMEDIATE deficiencies went unresolved, nameplate data is incomplete, no one-line diagram is on file. Each is a real, defensible reason the field data has materially changed — not an arbitrary date. The composite score (0–100) blends six condition signals — expiry horizon, post-study system changes, drift-flagged devices, protective-device PM currency, nameplate completeness, and one-line presence — so the highest-liability accounts rank first and the feed reads as risk triage, not a mail-merge.

**Rate-sheet confirmation as an audit trail — defensible pricing integrity.** Dollar estimates appear only when the platform rate sheet is *fresh*: configured and confirmed within a validity window (default 180 days). A dedicated "Confirm Rates Are Current" action — separate from editing the rates — re-affirms them and writes a hash-chained ActivityLog entry snapshotting the values, the actor, and the timestamp. Once the sheet goes stale, estimates auto-hide from the UI and from CSV exports. The effect is that every exported dollar figure is traceable to a dated, attributed pricing basis — defensible under diligence and in front of a customer.

**CRM integration roadmap (funded upside).** The shipped module resolves contacts, scores opportunities, and exports them to CSV with a hardcoded `Lead Source = "ServiceCycle Field Intelligence"`. The handoff path to native integration is scoped and intentionally deferred:
- **`OpportunityReview` table** — persist review state (accepted / rejected + reason, rep-entered CRM value, exported-at) so triage survives sessions and de-dupes against what is already in the acquirer's CRM.
- **Native connectors** — Salesforce, Dynamics 365, and HubSpot lead/opportunity creation with field mapping.
- **Zapier / Make templates** — no-code routing for smaller channel partners.
- **`/api/v1/opportunities`** — a versioned, API-key-scoped public endpoint mirroring the feed for scheduled CRM polling. The v1 REST API, scoped keys, webhooks (HMAC-signed), and Idempotency-Key support already exist; this endpoint is an additive surface, not new infrastructure.

This keeps ServiceCycle firmly in the detector role: it emits signal; the acquirer's system of record decides what to do with it.

---

## Acquisition angles

### PE contractor roll-up
ServiceCycle is a platform play that gets more valuable the more contractors adopt it. A PE firm rolling up electrical contractors acquires a differentiated tool alongside each business — and each acquired contractor's customer base is immediately loaded into the platform's monitoring engine. The roll-up is also the distribution: the PE firm mandates the platform, the contractors adopt it, the facility managers get sticky, the next acquisition has a head start.

**Specific fit:** roll-ups targeting NETA-accredited electrical testing and maintenance firms (ETM), where compliance rigor is already embedded in the sales motion.

### OEM test-equipment manufacturer
Manufacturers of insulation testers, power analyzers, infrared cameras, and power quality analyzers (Fluke, Megger, Hubbell, Amprobe) sell equipment that produces exactly the data ServiceCycle ingests. Bundling ServiceCycle with a service contract or instrument purchase:
- Gives the OEM a recurring SaaS revenue stream post-sale
- Deepens instrument lock-in (the test results live in ServiceCycle, tied to that instrument's model)
- Provides a data-feedback loop (fleet-level condition trending across all customers of that instrument type)

The arc-flash surface is particularly compelling for safety-equipment OEMs (arc-flash PPE, switching gear manufacturers) who want to be positioned as compliance partners, not just PPE vendors.

### Industrial facility / utility direct
For a utility or large industrial operator (chemical plant, data center, manufacturing campus), ServiceCycle is a compliance layer over their existing CMMS. The v1 REST API and CMMS integration guide (MaintainX, Salesforce) make it composable with incumbent tooling without replacement. The multi-tenant (HoldCo/OpCo) architecture supports enterprise groups with multiple sites under one rollup view.

---

## What's built (as of Q2 2026)

The platform is production-deployed with a live demo at servicecycle.app:

- **Compliance calendar** — NFPA 70B C1/C2/C3 condition-based intervals; auto-advances on work-order completion
- **Arc-flash management** — IEEE 1584 study ingestion (AI gap-fill), NFPA 70E 130.5(H) label generation, AFX v1 export, per-asset energized-work permits, 5-year review tracking
- **Document ingest** — PDF/report parser (deterministic + AI draft-fill for thin or scanned reports); nameplate OCR
- **Condition monitoring** — real-time telemetry from OT edge gateways; CRIT breach auto-escalates asset to NFPA 70B C2
- **Parts & spare inventory** — parts catalog, low-stock procurement-risk flags, required-parts panel per asset
- **Customer demand surfaces** — Quote Request inbox, Declare Emergency, QEMW QR permit wallet
- **Field labor role** — invite a technician, assign work orders, field-scoped view of own assignments
- **Public REST API** — versioned v1, scoped API keys, OpenAPI 3.1 spec, webhooks with HMAC signing, Idempotency-Key support
- **Multi-tenant** — HoldCo/OpCo rollup (EnterpriseGroup) + OEM fleet view (PartnerOrganization)
- **SSO** — Ory Polis OIDC/SAML/SCIM; ships dark (SSO_ENABLED env flag)
- **Full data portability** — one-click account export (JSON + XLSX) covering all assets, work orders, arc-flash data, and parts; no lock-in

Security posture: SOC 2 Type I controls mapped and documented; 13 of the actionable TSC gaps closed; hash-chain audit log; AES-256-GCM encryption at rest; multi-layer rate limiting; tenant isolation tested.

---

## What's deferred (acquisition upside)

These items are intentionally not built — they represent funded upside for an acquirer:

**OEM data atlas** — cross-tenant, privacy-preserving fleet analytics: "all panelboards of model X installed before 2015 show a C3 thermal pattern by year 8." Requires data from multiple operator accounts (which the acquirer's scale provides). Design doc: `docs/research/2026-06-20-oem-atlas-cross-tenant-design.md`.

**Predictive RUL modeling** — Remaining Useful Life scoring from telemetry + condition history. The data schema and telemetry ingestion are live; the ML layer is the next build.

**Automated PDF report generation** — NETA-standard output from the asset record (turn ingestion around: upload a report → fix deficiencies → export the updated report back). High-value for contractors who bill for the report.

**Marketplace / contractor finder** — a facility manager uses ServiceCycle, has a deficiency, wants to hire a contractor. If the acquirer is a PE roll-up, the marketplace IS the roll-up's book of business, pre-warmed with facility demand.

**Better Stack uptime SLA dashboard** — customer-visible uptime page. One configuration task (~30 minutes), deferred for now.

---

## The clean-break thesis

The product is self-contained and documented to operate without the founding engineer:

- `docs/ARCHITECTURE.md` — stack, data model, security architecture, scaling path
- `docs/DEPLOY_RUNBOOK.md` — full operator install + deploy runbook
- `docs/SELF_HOST.md` — air-gapped / no-egress install guide
- `docs/ENGINEERING_HANDOFF.md` — day-1 guide for a new engineering lead
- `docs/KEY_ROTATION.md` — secret rotation procedures
- `docs/INCIDENT_RESPONSE.md` — incident playbooks
- Test suite: ~500 integration tests; CI via GitHub Actions

A new engineering team can deploy, maintain, and extend the platform without the original author. That is intentional — it is the prerequisite for the clean break.

---

## Asking price considerations

ServiceCycle is pre-revenue and pre-customer at the time of this brief. The valuation basis is the asset:
- Completed, production-deployed software with a live demo
- Complete diligence documentation package (SOC 2 controls, risk register, security trust pack, architecture, API spec)
- Defensible moat (report ingestion, arc-flash data layer, NFPA 70B domain logic)
- Funded roadmap (deferred OEM atlas, predictive RUL, marketplace)
- Clean IP (no outside investors, no prior employees with equity claims, no open-source copyleft)
- Built to be handed off (handoff docs, test suite, CI/CD pipeline)

Comparable transactions: B2B vertical SaaS compliance tools (pre-revenue with working product) have transacted in the $500K–$3M range depending on acquirer strategic fit. At a strategic buyer (OEM, PE roll-up) where the tool is a force-multiplier for their existing book of business, the multiple on strategic value — not revenue — is the relevant benchmark.

---

*For demo access and technical diligence materials, contact via servicecycle.app. All source code available for review under NDA.*

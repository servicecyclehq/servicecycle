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
- **SSO** — Ory Polis OIDC/SAML with SCIM-brokered directory sync (Polis implements SCIM against the IdP and pushes provisioning/deprovisioning events to SC's inbound webhook consumer; SC does not itself expose a standard SCIM v2 resource-server API); ships dark (SSO_ENABLED env flag)
- **Full data portability** — one-click account export (JSON + XLSX) covering all assets, work orders, arc-flash data, and parts; no lock-in
- **Revenue Intelligence** — super_admin-only, cross-tenant field-intelligence feed: arc-flash study pipeline with a 0–100 composite score, system-change alerts, plus dormant / greenfield / no-study leads; a platform rate sheet (researched US-average rates) drives dollar estimates; CSV export to the acquirer's CRM. SC detects; the CRM manages.
- **Document layer** — customer-uploaded documents (one-lines, manuals, test reports, LOTO) surfaced on the asset, in field mode / via QR scan, on the site, and in an account-wide searchable library; accuracy acknowledgment at upload and download (storage-platform posture — SC stores and extracts, it does not author, verify, or generate documents)

Security posture: SOC 2 Type I controls mapped and documented; 13 of the actionable TSC gaps closed; hash-chain audit log; AES-256-GCM encryption at rest; multi-layer rate limiting; tenant isolation tested.

---

## What's deferred (acquisition upside)

These items are intentionally not built — they represent funded upside for an acquirer:

**OEM data atlas** — cross-tenant, privacy-preserving fleet analytics: "all panelboards of model X installed before 2015 show a C3 thermal pattern by year 8." Requires data from multiple operator accounts (which the acquirer's scale provides). Design doc: `docs/research/2026-06-20-oem-atlas-cross-tenant-design.md`.

**Predictive RUL modeling** — Remaining Useful Life scoring from telemetry + condition history. The data schema and telemetry ingestion are live; the ML layer is the next build.

**Automated PDF report generation** — NETA-standard output from the asset record (turn ingestion around: upload a report → fix deficiencies → export the updated report back). High-value for contractors who bill for the report.

**One-line / single-line diagram auto-generation** — generate an as-built electrical one-line from the structured asset graph the customer already maintains (equipment, voltages, `fedFromAssetId` connectivity, ratings) and keep it current as equipment changes. The platform already auto-builds a power-path one-line *view* (`GET /api/arc-flash/site/:siteId/one-line`) and stores/serves customer-uploaded engineered drawings; this turns that into an exportable, branded, continuously-updated drawing — closing a gap the Revenue Intelligence feed already scores ("no one-line on file" adds 25–35% to a study's cost). **The deferral is deliberate and is the point:** a data-generated one-line that a technician relies on for switching, de-energization, or LOTO carries professional-engineering liability that a PE's seal normally absorbs. ServiceCycle (pre-revenue, no PE on staff) should not assume that exposure pre-acquisition. An acquirer with engineering resources can productize it safely behind a PE-in-the-loop review/seal workflow, with the insurance and licensing posture to back it. Until then ServiceCycle deliberately **stores and surfaces only customer-authored, customer-uploaded drawings** — with an explicit accuracy disclaimer acknowledged at upload and download — and never generates them. The document layer that makes uploaded one-lines findable from the asset, the site, and a QR scan (incl. field mode) is built; the generator is the funded next step.

**Authoritative arc-flash PPE determination** — ServiceCycle deliberately does **not** own the authoritative PPE call. It stores and displays the PPE category, incident energy, and arc-flash boundary exactly as they appear on the customer's PE-sealed IEEE 1584 study (system-of-record display, with the accuracy disclaimer acknowledged at upload/download), and where it surfaces a computed incident-energy figure it expresses the protection requirement as a required minimum arc rating (cal/cm²) per NFPA 70E §130.5(F) — never as a ServiceCycle-asserted PPE category. **The deferral is deliberate and is the point:** an authoritative PPE determination that a worker relies on to dress for energized work is a life-safety call that a licensed PE's seal absorbs; a tool that computed and asserted it would inherit that liability directly, with no PE on staff and no professional-liability insurance behind it — and if the determination is wrong, the exposure is catastrophic and personal. A safety- or PPE-equipment OEM acquirer — already identified above as a natural strategic buyer — has the PE staff, the standards licensing (NFPA/IEEE/NETA), the liability insurance, and the PPE catalog to productize an authoritative PPE-selection layer safely, behind a PE-in-the-loop review/seal workflow. Until then ServiceCycle stays in the storage-and-surfacing role: it shows what the sealed study says and flags when that study is stale, and it leaves the determination to the engineer who sealed it.

**Marketplace / contractor finder** — a facility manager uses ServiceCycle, has a deficiency, wants to hire a contractor. If the acquirer is a PE roll-up, the marketplace IS the roll-up's book of business, pre-warmed with facility demand.

**Better Stack uptime SLA dashboard** — customer-visible uptime page. One configuration task (~30 minutes), deferred for now.

**The electrical one-line EDMS module (PDF-first policy, DWG/DXF conversion, and full-fidelity DWG + DGN rendering via an ODA Drawings SDK license)** — the module is scoped and locked (`docs/scoping/EDMS_MODULE_SCOPE_2026-07-04.md`, "Ready for Phase 1 kickoff"). The Phase-1 data model has landed (`DrawingRevision`, `DrawingAnnotation`, `DrawingSymbolLink`, `DrawingShareLink`, `DrawingPageText`, `DrawingRevisionSeal` in `schema.prisma`), but no route or UI is wired to it yet: today's general document-upload endpoint only accepts PDF, Word, and common image MIME types (`server/routes/documents.ts`) — there is no live upload path for DWG/DXF, or for the EDMS revision workflow at all. The one piece of EDMS *conversion* code that exists, `server/lib/drawingConverter.ts`, is an explicit Phase-1 scaffold that is **not wired into any route** — its `DwgConverter` always throws an actionable "not yet implemented, please export to PDF" error by design, and the LibreOffice/LibreDWG pipeline it would eventually call isn't in the Dockerfile. The plan itself is architecturally sound for the pilot NETA-contractor ICP (PDF-first, since they receive PDFs 95%+ of the time; the `DrawingConverter` adapter interface is deliberately settled now so a future upload flow can drop in a real implementation without callers changing) — but beyond the data model, none of the upload, conversion, or workflow surface is live product today. Once the upload flow, PDF-first policy, and open-source DWG/DXF conversion are built, the productized enterprise upgrade path is a $7,500 year-1 / $4,500/yr recurring Open Design Alliance Drawings SDK Sustaining tier license for full-fidelity DWG + DGN + IFC + STEP + 3D-PDF, swapped in behind the same adapter interface on a feature flag. **The deferral is deliberate:** we chose to defer the EDMS build-out itself, and separately the ODA licensing spend, until a paying customer required each. Autodesk Platform Services was evaluated and explicitly excluded from the architecture (ToS §7.1 restricts "automated translation service" use, plus a ~3.3x price increase and mandatory hub migration in December 2025, plus multi-region data residency on Autodesk's cloud — all wrong shape for SC's SOC-2 posture). See `docs/scoping/EDMS_MODULE_SCOPE_2026-07-04.md` §16–19 for full analysis.

**Hosted device library / marketplace** — Reddit-verified user behavior: engineers actively trade >1GB SKM/EasyPower/ETAP protective-device libraries in Dropbox threads because vendors won't add breakers/relays fast enough (a 4-year-old thread on r/ElectricalEngineering is still active). ServiceCycle already ingests device libraries via the AFX importer per-tenant. The productized upgrade is to aggregate ingested libraries across tenants (opt-in, privacy-preserving) into a curated marketplace with community-contributed vs OEM-verified provenance tags — a network-effect play no single incumbent (ETAP 100K+ models, OMICRON 400+ PTL templates, PowerDB 370+ NETA forms) can replicate because each is single-vendor. **The deferral is deliberate:** the moat only exists at multi-tenant aggregate scale, which requires the acquirer's install base. Directional evidence: OMICRON's PTL is free-with-hardware and creates decades of lock-in; Doble's 60M-record benchmark database is the most-cited "won't switch" moat in the entire test-data space.

**Symbol-detection ML on one-lines** — Auto-link breakers, relays, transformers, and MCC symbols on ingested drawings to asset records via a vision model. The one-line EDMS module ships manual tap-to-link (fine for hundreds of assets); auto-link at fleet scale is the acquirer productization. Research-grade only today — no off-the-shelf model for electrical schematics; the closest published work (ESC-YOLOv8 for P&IDs, SynthPID synthetic-data pipeline) required 2,000–75,000 labeled diagrams. Requires labeled training data, custom model, and ongoing maintenance — acquirer scale + engineering resources make it feasible.

**Real-time co-markup on drawings (Bluebeam Studio Sessions-style)** — Async NETA workflows don't need it; enterprise design-review workflows do. Explicitly declined for SC v1 to keep the module lean and focused on maintenance use cases. Acquirer with an enterprise CAD customer base would productize this on top of the annotation layer already shipped.

**Configurable workflow engines for enterprise tenants** — SC's EDMS module ships **one fixed workflow** (draft → review → published → superseded) because every EDMS review in the market universally cited configurable workflows as the most-painful feature of Meridian and ProjectWise. But large regulated tenants (pharma, utility fleet operations) do need custom states — the enterprise workflow engine on top of SC's state machine is a paid acquirer upside.

**BIM / GIS integration for drawings** — Bentley MicroStation, Autodesk Docs, ArcGIS. Enterprise-tier surface that a facility-management acquirer or utility-adjacent acquirer would extend. Not required for the NETA-contractor ICP.

**Air-gap / classified-site SKU** — On-prem/appliance variant of ServiceCycle that operates without external services (LibreDWG works offline, pyHanko works offline, Postgres works offline, PDF.js works offline — the architecture is already air-gap-friendly). Target: defense subs, Middle East power plants where USBs are banned (ETAP hardlock dongles fail there, per Capterra), classified nuclear facilities. Extends the existing SELF_HOST.md story into a productized appliance. Not required pre-acquisition; well-suited to defense-adjacent acquirer.

**FSM lane (Client Hub / dispatch board / on-site invoicing / on-my-way SMS / route optimization)** — ServiceCycle deliberately declined this segment. The 2026-07-04 competitive intelligence sweep identified an entire adjacent lane of electrical service companies (5-50 tech shops) actively churning off ServiceTitan and Housecall Pro because those tools *"squeeze electrical workflows into a mold that doesn't quite fit."* SC's asset-registry + electrical-domain + maintenance-first data model is uniquely positioned to serve this segment if productized by an FSM-adjacent acquirer. The pitch: *"SC's electrical-domain data spine is what these FSM tools would have to build to move upmarket into electrical-specific verticals."* Zero engineering work required from SC pre-acquisition — the market opportunity is documented, sized, and named.

**State-specific PE seal cloud-signing service** — SC's default posture (verify + display externally-sealed PDFs, never mint) is legally correct and remains permanent. However, an acquirer with life-sciences or heavy-regulated exposure may want to offer in-app sealing via a cloud signing service where each engineer holds their own AATL credential (GlobalSign DSS-style, per-user keys on the provider's HSM). This is a paid-service integration on top of SC's existing pyHanko verification layer. Never SC-owned seal certs.

**AI PM procedure generation for NETA MTS test procedures** — MaintainX ships an emerging AI-assisted procedure generator (loved in reviews). SC has deeper electrical domain knowledge (NFPA 70B intervals, arc-flash context, asset condition history) than a generic CMMS AI could ever infer — enough to auto-scaffold NETA MTS test procedures per asset type + last-test recency. Requires paid AI model access at scale + Groq/Gemini quota expansion. Directional upside; not urgent.

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

# External-AI Prompt — ServiceCycle Competitive Teardown + Creative Ideation + Reporting Deep-Dive
_Paste the section below into other AI agents. Self-contained (no codebase access needed). Bring results back for review._

---

You are acting as a **product strategist, competitive analyst, and wildly creative inventor** for a B2B SaaS company called **ServiceCycle (SC)**. I want three things, in depth: (1) a rigorous competitor teardown that exposes what SC is missing, (2) bold, net-new, even ridiculous "wow" feature ideas, and (3) a focused deep-dive on **reporting**. Use live web research for the competitor work and cite sources. Be specific and implementable-creative, not vague. I would rather see 25 sharp ideas (including a few absurd moonshots) than 8 safe ones.

## What ServiceCycle is
ServiceCycle is a software platform for **NFPA 70B electrical preventive maintenance (EPM) and electrical testing compliance**. It serves electrical testing/maintenance **contractors** and the **facility customers** whose electrical assets (switchgear, transformers, breakers, motors, panels, etc.) must be tested and kept compliant. SC turns inspection/test data into a living asset record, a compliance score, and an action plan — and connects the contractor and customer around that data.

**North star (do not violate):** treat the asset record not as a static compliance log but as a **revenue-bearing digital twin** — "compliance gets you in the door; revenue intelligence is what an acquirer pays for." The product leads with **action lists, not reports**; the real moat is **frictionless data-in** (getting messy field/test data into the system with near-zero effort); everything favors **one-click + smart defaults**. Two revenue engines: (a) the contractor's service pipeline (findings → quotes → work), and (b) intelligence that makes the company itself more acquirable.

**Three audiences (target every idea at one or more):**
- **Customer side** — facility owners/managers/viewers who own the electrical assets and must stay compliant and budget for it.
- **Contractor/partner side** — the electrical testing/maintenance firm that services many customer accounts through a multi-account "Fleet" view (white-labeled / co-branded).
- **Acquirer side** — **Private Equity** firms and **OEM manufacturers** (e.g. switchgear/breaker makers) evaluating buying the company or the data asset.

## SC's CURRENT features and functionality (treat as already-built; do NOT propose these as new)
**Compliance & scoring (NFPA 70B):** path-to-100 compliance scoring; maturity score vs NFPA 70B (1–5 levels across coverage / timeliness / baselining / program-docs §4.2); evidence-to-requirement trace map + evidence-gap detector; repeat-failure / compliance-drift detector; "what changed since last cycle" audit/change brief; an "what will fail an audit" likely-findings view; arc-flash study binding (per-account).

**Asset intelligence:** asset condition + criticality → derived priority score; remaining-useful-life (RUL) scoring and replacement/modernization forecast with ranges; maintenance debt ledger + 1/3/5-year capital plan; "forgotten/untracked assets" lens (no history / not inspected in years).

**Frictionless data-in / ingestion:** PDF test-report parsing; email-in (forward a report → auto-creates asset cards); nameplate photo → asset (OCR/vision with confidence review); bulk import; backfill; confidence-gated review queue (auto-commit high-confidence, park the rest); tunable identity matching (strict/balanced/lenient); BYO-AI model cascade; PWA field add-equipment.

**Contractor / Fleet (multi-account):** Fleet dashboard across many customer accounts; contractor portfolio rank + per-account talking points; consent-gated partner-event flywheel (inbox + webhook); co-branding (partner logo/colors); per-account service rep.

**Sales / revenue loop:** multi-year proposal builder (repair/replace/defer, 3 tiers, PDF) — cost-redacted for customers with a "request quote/call/meeting" CTA, priced for the contractor; closed-loop quote→work-order attribution; quote requests with dossier email + EMERGENCY call-now mode + draft/send lifecycle; rate cards; outage-consolidation planner.

**Trust / governance:** immutable SHA-256 snapshots + auditor "break-glass" share links; role-based access (viewer/consultant/manager/admin + contractor admin + super-admin) with strict multi-tenant isolation; activity/audit log; disaster-response events; help center. _(Enterprise SSO/SCIM is in active development — exclude it from gap analysis.)_

## SC's CURRENT reports (high level)
- **NFPA 70B Compliance Standards Report** — stacked cards: maturity score, evidence gaps, maintenance debt ledger, change brief, drift detector, proposal, access-blocker log, "what will fail an audit."
- **Monthly digest** (two versions: contractor/manager roll-up with rate-card $ + Excel; and a value-framed customer digest with compliance % by site, no $).
- **CFO / executive financial-exposure report.**
- **Proposal PDF** (priced for contractor, cost-redacted for customer).
- **Maintenance debt ledger / capital plan** (CSV).
- **Contractor portfolio rank** (Fleet).
- **Path-to-100** breakdown.
- **Immutable snapshot / auditor share package.**

## YOUR TASKS

**A. Competitor teardown.** Identify and validate (via web research) the **top 5 DIRECT competitors** in NFPA 70B / electrical testing & maintenance compliance + electrical asset management software. Stay in this niche — only include a generic CMMS (e.g. MaintainX/Fiix/Limble/eMaint/Brightly) or a test-data platform (e.g. PowerDB/Megger, Doble, Cascade by Group CBS, AVO, EMA) or a reliability/asset suite (ABB Ability, Schneider EcoStruxure) **if it genuinely competes for this buyer.** (Note: a product called Gimba reportedly struggled here — if it still exists, analyze why.) For each competitor: positioning, 1-line on who buys it, standout features, and **most important — what they offer that SC lacks.** Then a consolidated, **prioritized "gaps SC is missing" list**, ranked by impact on (i) customer value and (ii) acquisition appeal. Cite sources.

**B. Net-new / wow ideas.** Be extremely creative — I want **20–30 ideas**, deliberately spanning three buckets: *make the customer's life dramatically easier*, *make a PE/OEM acquisition more attractive*, and *pure left-field moonshots (including ideas that probably shouldn't be built — include them anyway).* For each idea give: a one-line pitch, **which audience it wows**, why it's novel (not table-stakes), rough build size (S/M/L), and **how it reinforces the north star** (compliance-in / revenue-intelligence-out / frictionless data-in / digital twin). Reward originality over safety.

**C. Reporting deep-dive (focus area).** Given SC's current reports above, propose **high-strategic-value, push-button reports** for three audiences separately: **PE acquirers**, **OEM acquirers**, and **Customers**. For each proposed report: name; audience; **the single decision it drives**; the inputs it needs (and whether SC plausibly already has them given the feature list); why it's strategically valuable or genuinely "wow"; and build size. Prioritize within each audience. Think about what data SC uniquely holds (closed-loop quote→work data, fleet-wide benchmarking, RUL/forecast, immutable evidence) that competitors can't easily report on.

**D. Constraints & filters.**
- Anchor everything to SC's current standard: **NFPA 70B electrical preventive maintenance & testing.** You may explore *other* compliance standards (e.g. NETA, NFPA 70E, IEEE, insurance/FM Global, OSHA) **only if** the idea **directly, meaningfully, and positively** advances the north star — and you must say exactly how. Otherwise leave them out.
- Do **not** re-suggest features SC already has (listed above).
- Favor specific and implementable-creative over generic.

## OUTPUT FORMAT
Return four labeled sections (A, B, C, D-notes). End with **"Top 5 diamonds in the rough"** — your highest-conviction picks across all sections, each with a 2-sentence rationale and why it would wow this market. Use live sources for Section A and list them.

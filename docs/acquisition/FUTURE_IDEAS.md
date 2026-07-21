# ServiceCycle — Future Ideas (consolidated & status-verified)

**What this is:** The single forward-looking ideas backlog for ServiceCycle. Merged 2026-07-21 from three working docs — `PRODUCT_BETS` (2026-07-03), `feature-ideas-vetted-shortlist` (the 5-AI competitor/ideation pass), and `strategy-review-v3` (2026-06-12) — de-duplicated, with **every item's build status checked against `main` as of 2026-07-21**. The important finding: the large majority of all three docs has since shipped, so this document keeps only what is genuinely open or strategic, and lists the shipped items separately (so nothing already built gets re-proposed).

**Related docs:** locked GTM / pricing / role decisions live in `DECISIONS.md`; the formal diligence data room lives in `docs/` (see `docs/DATA_ROOM_INDEX.md`); the near-term active build candidates are scoped in the current Build Scoping prompt.

**Supersedes (archived under `_source/`):** `PRODUCT_BETS_2026-07-03.md`, `feature-ideas-vetted-shortlist.md`, `2026-06-12-strategy-review-v3.md`.

---

## The thesis (unchanged)

ServiceCycle wins on a flywheel: **frictionless data-in → daily field/office usage → a longitudinal, brand-neutral test-result dataset → OEM fear and greed.** The differentiated raw material is not the UI — it's structured NETA test results, condition trends, and deficiency→dollars linkage across *every manufacturer's* installed base. An OEM's services org pays for that signal; an OEM's strategy team fears a neutral third party owning it. The job between here and a deal: (1) prove one real contractor runs their business on it, (2) make the demo un-fumble-able, (3) make the data-asset story visible *in the product*, not just in a brief.

## Market context (as of mid-2026, from the July 2026 research pass)

- **Test-data incumbents consolidated.** Doble Engineering + Megger merged under ESCO Technologies (April 2026) — PowerDB and Doble's test/analytics stack are now one house. Implication: every *other* OEM and PE services platform now lacks a neutral test-data layer; and ESCO itself is a natural acquirer of a workflow layer that already imports PowerDB and speaks NETA drift.
- **PE is rolling up NETA contractors at premium multiples** (Shermco / Gryphon acquiring Power Test is the pattern; data centers, electrification, and infrastructure spend are driving it). A roll-up needs one operating system to standardize N acquired firms — a distinct, urgent buyer class.
- **NFPA 70B is enforcement-shaped.** The 2023 edition moved "should" → "shall"; insurers weight documented maintenance programs; the **next 70B edition is expected in 2026**, and an edition-aware standards library (ours is seeded/versioned) turns update day into a marketing moment.
- **OEM digital land-grab is live** (Eaton Brightlayer Energy, March 2026). The OEM suites are monitoring-heavy and maintenance-workflow-light — the gap SC occupies.

---

## Open ideas (verified still-open), by theme

### A. The acquisition moat — highest narrative payoff

1. **Full cross-tenant benchmarking network / OEM Installed-Base Atlas.** *Parked, deliberate.* The basic pieces already shipped — an anonymized, k-anon-gated benchmark + insurer risk score (`44717fd`) and the Installed-Base Intelligence import lattice + modernization pipeline (`c3d4e20`). What remains is the **cross-network reliability pool** — anonymized cross-account curves by make/model/vintage/environment ("1980s Ferranti-Packard transformers outdoors: median IR degradation X%/yr"; "this breaker tests worse than 78% of its cohort"). This is the asset a PE roll-up *cannot build* without the install base. **Gate:** the cross-tenant consent + anonymization framework (opt-in ToS, k-anonymity thresholds) must land before the first real customer signs — retrofitting benchmark rights into existing contracts is between hard and impossible. Needs many tenants, so it's meaningless at 0 customers; keep *designing* it as acquisition upside (design doc: `docs/research/2026-06-20-oem-atlas-cross-tenant-design.md`). This is the "idea #4 / fleet benchmarking" item flagged for this doc. **Effort: L.**

2. **The correction dataset as a sellable asset + self-improving extraction.** Extraction telemetry already captures field-level before/after human corrections per account/document (`extractionTelemetry.ts`) — a proprietary labeled-correction corpus no acquirer can recreate. *Nothing consumes it yet.* Open build: an **active-learning loop** — per-account few-shot injection at extract time, promote-recurring-corrections-to-rules, all eval-gated so learning never regresses accuracy. Doubles as the diligence line: "N reports parsed, X% field accuracy, improving monthly, with a labeled correction corpus." **Effort: M (phased).**

3. **Authoritative-PPE "acquirer switch" spec.** Keep the liability posture exactly as is (system of record, never compute PPE). But write the one-page technical spec of *where the seam is in code* (`requiredArcRatingCalCm2` tiers vs. sealed-study display), what flips when a buyer with licensed PEs owns it, and what the engineering-review workflow becomes. Acquirers pay for optionality they can see. **Effort: S.**

4. **Acquirer dossiers.** One page per likely acquirer (ESCO/Doble+Megger, Eaton/Schneider/ABB/Vertiv services, PE roll-ups like Shermco/Blackstone, IPS, EMCOR, Quanta, RESA; dark-horse insurers): what they'd do with SC, the integration thesis, the metrics they'd ask for, and the wedge (Megger owns PowerDB, so a roll-up buying the layer that *consumes* PowerDB output hedges that lock-in). Founder work, not code. **Effort: S.**

### B. Compliance & safety depth

5. **AI safety copilot** — "can I safely rack this breaker?" answered from real study data + boundaries + procedures. The last unbuilt arc-flash roadmap slice (Slice 7) and the "ask-AI help chat" from strategy-review, held for the same reason both docs gave: build it *after* the data layer matures and with hard guardrails, BYO-AI-gated and grounded strictly in the account's own data + help corpus. Gimmick/liability risk is real; the fix-it list already answers most questions a chatbot would get. **Effort: M.**

6. **NETA trip-time → arc-flash drift correlation.** When a NETA ATS breaker test record (measured trip time) and an arc-flash study both exist for the same protective device, auto-flag if the tested trip time deviates >10% from the TCC-assumed time the study used, and surface the recalculated effective incident energy. **No existing tool (ETAP, SKM, EasyPower, AFX) does this.** Primary audience: NETA contractors who produce both documents — a liability shield for them and a real safety insight for the owner. Easy-button design: upload either doc on any schedule; SC correlates only when both are present, never requires both. **Gate:** the base arc-flash per-tool template import shipped, so this is unblocked. **Effort: M.** *(Acquisition upside for OEM/NETA-adjacent buyers, e.g. Eaton who makes AFX.)*

7. **Customer-staff 70B training tracker.** QEMW tracks the *contractor's* techs (shipped); this tracks the *facility's own* staff against their 70B program responsibilities. Niche but cheap audit-readiness stickiness. **Effort: S.**

### C. Data-in frontier

8. **Direct test-instrument sync (Fluke / Megger / Doble).** Pull readings straight from test sets — the next frontier of the data-in moat beyond PDF parsing. *Deferred by standing decision* (SC ingests the test *report* the instrument produces — brand-agnostic, same data, AI-gap-filled; instruments are contractor-owned, marginal gain on PowerDB's home turf). Revisit only if a buyer/partner funds it, or post-merger positioning makes reading both PowerDB and Doble natively strategic. **Effort: L.**

9. **Vendor-lead-time-aware replacement flag.** Flag assets whose replacement lead time (switchgear/transformer/breaker) exceeds remaining life; pairs directly with RUL scoring. A procurement-risk badge already exists on Parts, so this may be partially covered — *verify current state before building.* **Effort: S-M.**

### D. Channel / ops

10. **Multi-site capacity / route planner for 70B cycles.** Map all customers' required cycles to crew availability / skills / travel. Operationally valuable but a large scheduling-optimization build — explicitly low priority. **Effort: L.**

### E. Trust / exit packaging

11. **SOC 2 Type II.** Readiness is done (controls matrix, CI security scanning, "score 78 green"). The Type II *observation window* is calendar time you can't compress — keep it running. Pair with a named-firm pen test. **Effort: calendar + S-M.**

12. **Self-host / air-gap full productization.** The `planType=licensed` seam and a self-host prep/runbook exist. Productize: offline license keys, an update channel, a "no data leaves your network" architecture doc (deterministic parser runs fully local, BYO-AI optional). "Runs air-gapped" is a differentiator no VC-SaaS competitor matches — utilities and federal will demand it. **Effort: L.**

13. **Publish the AFX format publicly.** The Arc Flash Data Exchange spec, validator, and per-tool crosswalks all shipped internally. Publish the schema + sample files as a neutral public interchange standard (docs page + JSON schema). Standards plays are cheap when you're the reference implementation, and it directly counters ESCO's post-merger data-format gravity. **Effort: S.**

14. **Platform / architecture debt that gates a buyer's review.** TypeScript `strict` on the server (staged); split the truncation-hazard files (`AssetDetail.jsx`, `arcFlashIngest.ts`, `assets.ts`, `Sidebar`) into modules — maintaining splice scripts *because* files are dangerous is a smell a reviewer reads correctly; a provisioning script / IaC so the deploy story is "docker compose anywhere," not one pet server. **Effort: M-L, amortizable.**

### F. Moonshots / watch (park — fun, deferred)

From the arc-flash could-add backlog and the roadmap park list, none committed: SCADA live-state synthesis · ghost-bus discovery (smart-meter vs. model) · predictive breaker-wear decay (IoT) · LiDAR cable-length · AR/3D room explorer · acoustic/phone-mic diagnostics · drone nameplate capture · electrical-asset "Zillow" valuation · "ask my switchgear" Q&A. **Do not build** (safety/trust): self-healing microgrid API control · OSHA/insurer "whistleblower" automation · contractor quality scoring (relationship/legal risk — killed).

---

## Who buys, and the one-line pitch to each

| Buyer | Why they must own it | The pitch |
|---|---|---|
| **ESCO (Doble+Megger)** | SC is the owner-facing workflow + compliance layer their instrument/test-data stack lacks; already imports PowerDB. Neutral SC erodes their data lock-in if it spreads. | "The workflow layer your merger is missing — already fluent in your data." |
| **Eaton / Schneider / ABB / Vertiv services** | Brightlayer-class suites monitor; they don't run maintenance programs. SC = installed-base intelligence on *all* brands + a 70B compliance funnel into field services. | "A continuous demand signal for your services org — on your competitors' installed base too." |
| **PE NETA roll-up platforms (Shermco-class)** | Roll-ups need one operating system across acquired firms; the data asset compounds with each add-on; they won't standardize on a rival's software. | "The operating system for the roll-up — every acquisition lands on day one." |
| **Dark horse: insurance / risk** | 70B documentation as underwriting data; tamper-evident maintenance records. | "Loss-control telemetry for electrical risk." |

The "so it doesn't get out into the marketplace" fear is real *because* SC is neutral: if a thousand NETA contractors run their business on an independent SaaS, the OEMs' service arms lose visibility into — and the ability to intermediate — the maintenance relationship on their own installed base.

## Deliberate non-goals (don't build — see DECISIONS.md)

Full field-service management (dispatch/scheduling/invoicing) — integrate with ServiceTrade/simPRO/QuickBooks instead. An IEEE 1584 calculation engine — the liability posture is a *feature*, and every plausible acquirer already owns an engine. Native mobile apps — harden the PWA until a buyer funds the rest. A parts marketplace — premature; the quote-request loop is sufficient. RSMeans/NECA deep cost indexing; 70E/NETA module expansion (stay NFPA 70B); generic-CMMS breadth.

---

## Already shipped since these docs were written — do NOT re-propose (reference)

Verified against `main`, 2026-07-21. The three source docs were largely a build queue that has since been worked off:

- **The entire feature-shortlist "build order" + Tier 1–2:** B1 maturity score (`4310586`), B2 portfolio rank, Maintenance Debt Ledger + 1/3/5-yr capital plan (`ff17f7a`), "what changed since last cycle" brief (`3eff8a6`), missing-access/open-items blocker log (`54dc69b`), evidence-to-requirement trace map + gap detector (`15eb5ef`), repeat-failure/compliance-drift detector (`b4918ab`), multi-year scope/proposal builder (`5c66950`).
- **strategy-review-v3 core (#1–#37, most):** one-upload=one-facility split, async parser + page budgets, asset identity resolution, extraction telemetry, report fingerprinting/dedupe, email-in ingest (`599...`), condition-of-maintenance labels (`5eed84b`), auto-Condition-3, EMP audit clock, 23 equipment templates, batch nameplate, contractor bulk ingest, co-branding, auto-send leave-behind, Fleet Path-to-100, quote→work→green loop, auditor/insurer share link, incident log (`0ea0002`), arc-flash first-class records, NFPA 110 genset + IEEE 450/1188 battery (`6320375`), oil/DGA ingest (`9da0b47`), thermography ingest (`c7c4d22`), customer digest + CFO PDF (`3330065`), parser-as-funnel (`fbbd1e2`), switching-cost backfill (`59b5b0e`), QEMW wallet (`4a6b968`), self-host guide (`653...`).
- **PRODUCT_BETS Tier 0–3 (most):** auth/role findings, deficiency→work-order button, nightly reseed + PWA cache fix, field-tech seed, import lattice, Installed-Base Intelligence, attach-rate rollup, AFX opened (internally), tamper-evident audit chain, SOC 2 readiness.
- **Arc-flash roadmap:** all foundation + drift engine + Slices 3–6, 9, 10, 11, 12 (fleet dashboard, heat-map, NL search, LOTO/permit validator, what-if ROI, auto one-line, TCC library, CMMS/EAM primitives, benchmark+risk score, timeline playback, regulatory-change matching). Only Slice 7 (AI copilot, item 5 above) remains.
- **SSO** (OIDC+SAML+SCIM on Ory Polis, ships dark), the bi-directional v1 public API, revenue-attribution dashboard, HoldCo multi-OpCo roll-up.

## Sources (market context)

[Doble+Megger / ESCO merger](https://www.doble.com/news/doble-engineering-and-megger-unite-to-shape-the-future-of-electrical-asset-management/) · [Shermco acquires Power Test (Gryphon)](https://www.gryphon-inv.com/news/shermco-industries-acquires-power-test-a-leading-neta-testing-company/) · [NETA market overview (Industria)](https://industria-partners.com/industry-updates/neta-market-overview/) · [NFPA 70B 2023 shift + 2026 (Miller Electric)](https://mecojax.com/news/nfpa-70b-2023-shift-suggested-standardized-electrical-maintenance-and-what-2026-may-bring) · [NFPA 70B standard development](https://www.nfpa.org/codes-and-standards/nfpa-70b-standard-development/70b) · [Eaton Brightlayer Energy](https://www.eaton.com/us/en-us/company/news-insights/news-releases/2026/eaton-unveils-brightlayer-energy-an-ai-powered-energy-management.html)

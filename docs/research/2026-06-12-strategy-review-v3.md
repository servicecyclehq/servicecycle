# Strategy Review v3 — The Exhaustive List
**Date:** 2026-06-12 · **Author:** product + GTM strategy review (Fable)
**Supersedes/extends:** `2026-06-11-easy-button-northstar-recommendations-v2.md` (v2). Since v2 shipped: hardened pdfplumber geometry parser (key-value grids, OCR, multi-asset *detection*), the 311-entry / 23-equipment-type field library, NFPA 70B Table 9.2.2 fixed intervals + 3-axis condition model, the nameplate vision system with per-field confidence review, field "+ Add equipment," BYO-AI across 5 providers + free-tier cascade + demo metering, evidence-grade baselining, one honest number, closed outage loop, trend advisories, "Inspector's here," fix-it-first dashboard, the single Add-data door. None of those are re-recommended below — every idea here builds ON them.

**Framing.** The product has crossed a line: the easy buttons mostly exist and mostly end in green. What's left falls into four families: (1) **scale the funnel mouth** — the parser reads one asset per upload while the customer's real artifact is a 40-page, multi-asset job report; (2) **make the compliance story undeniable** — 70B contains several cheap, literal requirements (labels, auto-C3, EMP audit clock) nobody else implements; (3) **arm the channel** — the contractor flywheel narrative is written but the contractor-side tooling is thin; (4) **instrument the exit** — the proprietary data assets (correction logs, reliability curves, AUM metrics) have to start accumulating *now* to be worth anything at diligence. The list below is one ranking, top to bottom, grouped into tiers.

---

## TIER 1 — DO NEXT (close the loops that are already live)

### 1. One upload = one facility: multi-asset split & commit UI ⭐
**What:** Section detection shipped (`asset_sections` count + a warning). Build the rest: preview renders a per-section accordion (one per `SUBSTATION … POSITION …` block), each section serial/position-matched to the register, unmatched sections become "create asset?" rows, one commit writes every asset's measurements + deficiencies + a grouped summary ("38 readings across 12 assets, 4 new deficiencies, 2 assets created").
**Why now:** This is the single most valuable sentence the company can say — "drop your contractor's annual report, your whole facility updates" — and it is the v2 #1 that is now half-built. SAMPLE JOB (3 sections) is enough to build the UI; the brother's reports tune it, they don't gate it.
**Effort:** L · **Lever:** data-in (the moat itself)

### 2. Kill the parser page budgets before they kill #1
**What:** `pyextract` page budgets (text 18 / cells 4 / tables 4, 45s bridge timeout) mean a 41-page PowerDB job silently drops later assets. Move ingest to an async job (queue + progress UI + "we'll notify you"), parse all pages, stream sections as they complete.
**Why now:** Facility-scale ingest on a 1-vCPU droplet cannot live inside an HTTP request. #1 is structurally impossible without this; it also unlocks email-in (#6), which is async by nature.
**Effort:** M · **Lever:** data-in / technical debt

### 3. Asset identity resolution — "is this the same breaker?"
**What:** A matching layer used by BOTH ingest and nameplate scan: normalized fuzzy serial match (B36S01 ≈ B36SO1, O/0, I/1), secondary match on site+position+type, and a one-tap confirm step ("Looks like SWGR-2 Main, last tested 2025-03-04 — same device?"). Nameplate scan of an existing serial warns instead of duplicating.
**Why now:** Year-over-year trending — the predictive feature no competitor has — is only as good as entity resolution. Brother Q14 says IDs are messy in the wild; build the confirm-step version now, tighten the auto-match with his data.
**Effort:** M · **Lever:** data-in / compliance (trend integrity)

### 4. Extraction telemetry + correction capture — the learning flywheel
**What:** Log every preview: source engine, coverage, per-field confidence, AND every human edit (field, extracted value, corrected value, report family). A small admin view: accuracy by field by form type, trending.
**Why now:** Today it's the QA harness that tells you what to tune after the brother's PDFs arrive. At diligence it's the proprietary dataset: "12,000 reports parsed, 94% field-level accuracy, improving monthly, with a labeled correction corpus no acquirer can recreate." Cheapest exit asset on this list — but only if it starts accumulating now.
**Effort:** S–M · **Lever:** data-in / exit

### 5. Report fingerprinting — never ingest the same PDF twice
**What:** SHA-256 the upload; on match, "This report was imported 2026-03-03 against SWGR-2 (38 readings) — re-import anyway?"
**Why now:** Duplicate measurements silently poison trend math and the deficiency engine. One-day fix, protects the most defensible feature.
**Effort:** S · **Lever:** data-in / trust

### 6. Email-in ingest (`reports-{account}@servicecycle.app`)
**What:** Inbound mail (Postmark/SES) → attachment into the async ingest queue (#2) → notification "Your report is ready to review." The AddData page already shows the card as "coming soon."
**Why now:** Removes even the upload. The contractor already emails the report to the customer — make the product the CC line. This is the Gimba-killer thesis at its logical end: data-in with zero new behavior.
**Effort:** M (after #2) · **Lever:** data-in

### 7. Printable condition-of-maintenance labels (70B §4.2, literally)
**What:** Extend the existing QR label sheets: add the asset's condition designation (Serviceable / Limited Service / Nonserviceable — `netaDecal` already exists), governing condition (C1/2/3), and **the date the condition of maintenance was established** — which NFPA 70B's EMP element list literally requires on the equipment. Offer per-asset reprint after each completed WO.
**Why now:** "The software prints the labels the standard requires" is an undeniable demo line, a physical ServiceCycle artifact stuck to every switchboard in the facility (a switching cost you can touch), and ~2 days of work on an existing PDF generator.
**Effort:** S · **Lever:** compliance / retention

### 8. Auto-Condition-3 on two missed cycles (§9.3.1, verbatim)
**What:** 70B's C3 criteria include "missed the last two successive maintenance cycles per the EMP." Implement as computed state: a schedule lapsed 2× consecutively flags the asset's physical condition C3 → worstCondition tightens every interval → Path-to-100 explains why ("Condition 3 per §9.3.1 — two missed cycles. Complete maintenance to re-assess.").
**Why now:** Makes the compliance math self-enforcing and standard-cited — the model gets *more honest* under neglect instead of stale. Also commercially sharp: lapsed customers correctly see their obligation grow. Pure logic in an existing model.
**Effort:** S · **Lever:** compliance

### 9. EMP audit clock + coordinator nag in Path-to-100
**What:** `EMP_LAST_REVIEWED_AT` and `EMP_COORDINATOR_USER_ID` already exist for the EMP PDF. Surface both as gap items: "EMP review due in 4 months (5-year max, §4.2)" and "No EMP coordinator named — required by §4.2."
**Why now:** Nearly free; completes the §4.2 story the EMP document already tells; two more one-click fixes on the list that sells the product.
**Effort:** S · **Lever:** compliance

### 10. Give the PDF preview the nameplate treatment (per-field red/yellow/green)
**What:** The parser already emits per-measurement confidence; render the same ServiceCycle-style triage the nameplate flow uses — flagged rows up top, all-green collapsible, "review 6 of 38."
**Why now:** One review pattern across nameplate AND documents trains the user once; reviewing 6 rows instead of re-reading 38 is the difference between HITL and homework. Mostly client work.
**Effort:** S–M · **Lever:** data-in / action-list

### 11. Equipment templates: 6 → 23 (close decision I3 with data you already have)
**What:** The field library enumerates 23 equipment types with 70B linkage and Table 9.2.2 intervals; the powerdb-templates research folder has per-type task matrices. Ship a 70B template for every type — it's seed-data work.
**Why now:** "My equipment type isn't here" is a first-5-minutes objection, and the field add flow + multi-asset commit (#1) both auto-apply templates — coverage gaps multiply.
**Effort:** S–M · **Lever:** data-in / compliance

### 12. AI type-guess pre-fills the field add flow
**What:** FieldNewAsset makes the tech pick the equipment type *before* the scan. Reverse it: snap first; photoInspect already returns a type guess; pre-select it (confidence-flagged), auto-apply the matching template, tech confirms.
**Why now:** One fewer decision per asset × 200 assets per walkthrough. The pieces all exist; this is wiring.
**Effort:** S · **Lever:** data-in

### 13. Batch nameplate capture
**What:** Tech shoots 30 nameplates walking the floor (or uploads a camera roll); the app queues them into sequential confidence reviews with one-tap accept for all-green reads, site/type carried forward.
**Why now:** The single-photo flow is built and good; the batch wrapper is what makes "walk the facility, leave with a complete register" true. Watch the demo metering interplay (batch on free tier will hit the 5-scan cap instantly — fine, it's the BYO-AI conversion moment).
**Effort:** M · **Lever:** data-in

---

## TIER 2 — HIGH VALUE (the channel, more document streams, trust)

### 14. Contractor bulk ingest on the Fleet Dashboard
**What:** After #1: an oem_admin uploads a job report from the fleet view, picks (or creates) the customer account, and the facility is seeded/updated — onboarding as a side-effect of work already billed.
**Why now:** The CONTRACTOR_FLYWHEEL_NARRATIVE made literal, and the demo that makes a PE-backed contractor say "we'd turn this on for every service customer." It's the acquisition demo.
**Effort:** M (after #1) · **Lever:** channel / exit

### 15. Co-branded customer artifacts
**What:** `partnerOrg` already carries logoUrl/primaryColor. Put the contractor's brand on the leave-behind, EMP, compliance PDFs, and label sheets: "Prepared by {Contractor} · powered by ServiceCycle."
**Why now:** Contractors distribute artifacts that carry their name; you get a logo in every binder in every facility. Cheapest channel feature available.
**Effort:** S · **Lever:** channel

### 16. Auto-send the leave-behind on WO completion
**What:** When a WO completes (especially outage batches), generate the leave-behind PDF and email it to the account contacts automatically (account-level toggle).
**Why now:** The leave-behind exists but depends on someone remembering it. Found/fixed/budget-for arriving unprompted after every visit is the retention heartbeat and the contractor's renewal weapon.
**Effort:** S · **Lever:** channel / retention

### 17. "Send one report, get your fix list" — the parser as top-of-funnel
**What:** A public, rate-limited, email-gated page: prospect drops a test report → sees the extraction + a teaser fix list ("14 findings, 3 critical — create a free account to keep it"). Deterministic engine only; no AI cost.
**Why now:** The hardest GTM asset to fake is a demo on the prospect's own data. This converts the moat into lead-gen with zero sales motion — exactly right for a quietly-groomed company.
**Effort:** M · **Lever:** channel / data-in

### 18. Structured-export side doors: PowerDB native / Doble / OMICRON — DECISION GATED
**What:** If brother Q2 says CSV/XML/.mdb actually leaves the building, build a structured importer (10× more reliable than PDF parsing); keep the PDF path for the long tail. If only PDFs leave, skip and double down on #1.
**Why now:** Don't build until Q2 is answered — but pre-write the decision: any structured format gets a side door within a sprint of confirmation.
**Effort:** M–L · **Lever:** data-in

### 19. Offline-first field mode
**What:** Electrical rooms, basements, and substations are RF-dead. PWA offline queue (IndexedDB): scans, photos, checklist ticks, notes captured offline; sync with conflict-tolerant upsert when signal returns.
**Why now:** Field capture that fails without bars trains techs to photograph things "for later" — which is data entry deferred, the Gimba disease. This is the gap between "demo of field mode" and "techs actually use field mode."
**Effort:** M–L · **Lever:** data-in

### 20. Photo-of-paper-report capture
**What:** The OCR path exists for scanned PDFs; let a phone photo of a paper field sheet enter the same ingest pipeline from field mode (multi-page capture → stitched into one queued document).
**Why now:** A meaningful share of the industry still hand-writes field sheets (brother Q11 will size it). Cheap because OCR + ingest + confidence review all exist; this is a camera entry point.
**Effort:** S–M · **Lever:** data-in

### 21. Auditor / insurer share link
**What:** Time-boxed, read-only, watermarked link to the compliance package: EMP PDF + honest number + Path-to-100 + the latest hash-chained snapshot. "Share with your underwriter" button next to "Inspector's here."
**Why now:** Insurance enforcement is THE 70B tailwind; the renewal conversation becomes ServiceCycle's distribution moment, and an underwriter who's seen the package starts asking other insureds for it.
**Effort:** M · **Lever:** trust / compliance / channel

### 22. Close the quote→work→green loop
**What:** The QuoteRequest lifecycle exists; when a quote is accepted, auto-create the WO bound to the originating deficiency/schedules so completion clears compliance — the same loop-closing discipline the outage planner got.
**Why now:** Every easy button must end in green; today the quote path ends in email. Also gives contractors closed-loop attribution ("quotes via ServiceCycle → completed work"), a number that matters at exit.
**Effort:** S–M · **Lever:** action-list / channel

### 23. Fleet Path-to-100
**What:** Aggregate `buildComplianceGap` per customer on the Fleet Dashboard: "Acme Foods — 73%, 12 actions to 100, est. $14k" ranked across the book.
**Why now:** For the contractor this is a ranked sales pipeline that is *also genuinely the customer's compliance need* — the rare upsell that respects the customer-vs-channel wall. The gap engine exists; this is aggregation.
**Effort:** S · **Lever:** channel

### 24. Protective-device-operation / incident log (EMP element 9)
**What:** Quick-log in field mode + asset detail: "breaker tripped / relay operated / alarm" with date + note. Feeds the condition assessment (unaddressed notification = C2/C3 criteria per §9.3.1), the EMP's incident-feedback section (currently thin), and trend context.
**Why now:** 70B requires the program to *use* incident feedback; logging it makes the EMP document honest and gives condition ratings ground truth between test cycles.
**Effort:** M · **Lever:** compliance

### 25. Arc flash as first-class records (NFPA 70E)
**What:** Replace the account-level `ARC_FLASH_STUDY_DATE` setting with per-study records: scope (sites/buses), date, engineer of record, document attachment, affected assets via the power-path graph; 5-year clock per study; invalidation triggers (already built) bind to the study; incident-energy label data export.
**Why now:** 70E is the adjacent must-have every facility asks about in the same breath as 70B; the existing engine is right but modeled too coarsely to survive a real multi-site customer.
**Effort:** M · **Lever:** compliance

### 26. NFPA 110 genset + IEEE 450/1188 battery modules
**What:** Templates + intervals for emergency power (monthly run tests, annual load bank — NFPA 110) and battery systems (quarterly/annual per IEEE 450 VLA / 1188 VRLA); the field library already carries the test vocabulary for both.
**Why now:** Healthcare and data-center buyers — the highest-compliance-anxiety segments — care about these as much as 70B. Two modules, one pattern, mostly seed data + a couple of report tweaks.
**Effort:** M each · **Lever:** compliance

### 27. Acceptance test = year-0 baseline
**What:** On asset creation/import, accept an acceptance-test report as the baseline record (70B requires retaining commissioning baselines; trend math gets a true anchor instead of "first maintenance test wins").
**Why now:** Answers brother Q23, strengthens trend integrity, and creates a reason to be in the workflow on day one of an asset's life, not year three.
**Effort:** S–M · **Lever:** compliance / data-in

### 28. Oil / DGA lab-report ingest
**What:** The transformer-oil lab report (SDMyers, Doble labs — PDF and often CSV) is a *third* recurring document stream the facility already receives. DGA fields (ppm gasses, IEEE C57.104 limits) are in the field library; the trend engine is built.
**Why now:** Transformers are the highest-value assets in the register; DGA trending is the canonical predictive story ("acetylene doubled — investigate now"). Another data-in pipe into existing plumbing.
**Effort:** M · **Lever:** data-in / compliance

### 29. Thermography report ingest
**What:** IR survey reports (FLIR/contractor PDFs) — thermography is a 70B 12-month *required* task, so every compliant facility generates these annually. Parse hot-spot tables (location, ΔT, severity) → deficiencies at the matched asset.
**Why now:** Same logic as #28: each recurring document stream you can drink from multiplies the moat. ΔT severity bands (NETA Table 100.18) are well-defined.
**Effort:** M · **Lever:** data-in / compliance

### 30. Customer weekly digest + quarterly CFO PDF
**What:** Customer-side equivalent of the existing partnerDigest: "This week: 2 items went overdue, 1 fixed, compliance 87→89%, next outage in 41 days." Quarterly: a board-grade PDF (trend, spend forecast, compliance trajectory) timed for budget season.
**Why now:** A compliance product's engagement is naturally episodic; the digest is the heartbeat that keeps the tab open between test seasons — and the CFO PDF is what gets the renewal signed without a meeting.
**Effort:** S–M · **Lever:** retention

---

## TIER 3 — STRATEGIC BETS (the exit narrative)

### 31. The reliability benchmark asset ⭐ (start accumulating NOW)
**What:** Anonymized, consented cross-account curves: test-result trends and failure/deficiency rates by make / model / vintage / environment ("1980s Ferranti Packard transformers in outdoor environments: median IR degradation X%/yr"). Product features later (percentile badges: "this breaker tests worse than 78% of its cohort"); data accumulation and the consent/terms framing NOW.
**Why now:** This is the asset a PE roll-up *cannot build* without the install base — the difference between "nice product, we could clone it" and "we need to own this." Every month of delay is cohort data lost forever. Requires careful ToS language before the first real customer signs.
**Effort:** L (S to start logging) · **Lever:** exit

### 32. Founder KPI instrumentation — the data-room dashboard
**What:** Instrument and chart the metrics an acquirer will ask for: assets under management, readings ingested, PDFs parsed + field-accuracy (from #4), WAU by role, time-to-first-fix-list, contractor→facility attach rate, compliance-lift per account over time.
**Why now:** You can't sell what you didn't measure, and the brother demo is about to generate the first real numbers. Retro-instrumenting is always worse than instrumenting from day one.
**Effort:** S–M · **Lever:** exit

### 33. Contractor-sponsored pricing architecture
**What:** Commit to the channel-true model: the contractor pays per facility-under-management (bundled into their service contract — "you get the maintenance and the software"), the facility pays $0; direct facility plans exist alongside for facilities without a contractor. Per-asset tier bands, not seats. Stripe stays dormant until the first paying signal (the seam doc is right). NO AI resale anywhere — BYO-AI is the permanent answer, and it's a *selling point* for security reviews (your key, your data policy).
**Why now:** Pricing IS positioning for the acquirer: contractor-pays makes the roll-up integration story trivial ("flip it on for every service customer") and makes facility-side adoption frictionless, which is the whole thesis.
**Effort:** Strategy + S plumbing · **Lever:** monetization / channel / exit

### 34. Switching-cost backfill: "bring us your decade"
**What:** A bulk historical import job — zip of old test reports → async parse (#2) → a decade of measurements on the asset timeline. Position as a white-glove onboarding service initially (you run it; charge for it or comp it strategically).
**Why now:** Once ten years of an asset's medical record lives in ServiceCycle, leaving means abandoning the patient history. Deepest retention mechanic available, and it feeds #31 with historical cohorts.
**Effort:** M (after #1/#2) · **Lever:** exit / retention

### 35. Enterprise trust pack
**What:** SSO/SAML, SCIM-lite user provisioning, SIEM-exportable audit log (the hash-chained activity log already exists — package it), a security one-pager (encryption at rest via docCrypto, 2FA, backup crypto, BYO-AI data flow diagram), pen-test receipt.
**Why now:** NERC-CIP-adjacent customers (utilities, big industrials) gate on the security review before they look at features. Most of the substance exists; this is packaging + SAML.
**Effort:** M–L · **Lever:** trust

### 36. Self-host / air-gap productization
**What:** The licensed-instance seam exists (`planType=licensed`, Stripe bypass). Productize: install runbook, offline license keys, update channel, "no data leaves your network" architecture doc; deterministic parser runs fully local, BYO-AI optional.
**Why now:** Utilities and federal sites will demand it, and "runs air-gapped" is a differentiator no VC-built SaaS competitor will match. Sequenced after #35.
**Effort:** L · **Lever:** trust / exit

### 37. QEMW credential wallet for contractors
**What:** qemwAlerts + ContractorTech exist server-side; give contractors the roster UI — techs, certs, expiry dates, assignment-vs-requirement gaps ("3 jobs next month require QEMW; 2 qualified techs available").
**Why now:** The code comments themselves note the 12–18-month first-mover window on ANSI/NETA EMW-2026 before PowerDB or Accruent builds it. Brother Q36 sizes the urgency.
**Effort:** M · **Lever:** channel / compliance

### 38. Acquirer dossiers (founder work, not code)
**What:** A one-pager per likely acquirer — Shermco/Blackstone, IPS, EMCOR, Quanta, RESA: what they'd do with ServiceCycle, the integration thesis (attach to every service contract), the metrics they'd ask for (#32), and the wedge (note: Megger owns PowerDB — a contractor roll-up buying the layer that *consumes* PowerDB output is a hedge against Megger's lock-in).
**Why now:** The brother conversation's Tier-3 strategic questions (Q38–40) land better with a thesis already drafted; and it forces clarity on which metrics to instrument first.
**Effort:** S · **Lever:** exit

---

## TIER 4 — LATER / EXPLICIT DECISIONS

### 39. Ask-AI help chat (open decision I1) — HOLD
Hold for brother validation (Q16). If built: BYO-AI-gated, grounded strictly in the help corpus + the account's own data, never metered demo AI. Gimmick risk is real; the fix-it list IS the answer to most questions a chatbot would get.
**Effort:** M · **Lever:** retention

### 40. Contractor grading (open decision I2) — RECOMMEND: internal-only or skip
The political downside (a contractor sees his grade the week you're courting contractors as the channel) exceeds the facility-side upside. If anything: private, facility-only response-time stats, never a published score. Brother Q17 confirms.
**Effort:** — · **Lever:** channel (negative risk)

### 41. Voice / dictation field notes
"Breaker 4B, contact resistance high, recommend service" spoken at the panel → structured note. Real value, but sequenced after offline mode (#19) — voice without offline is a demo, not a tool.
**Effort:** M · **Lever:** data-in

### 42. Help Center / FAQ
Already planned post-stabilization (per project memory). Write the RUL-scoring, condition-rating, forecast-range, and arc-flash explainers first — they generate the most "why does it say this?" questions, and they double as the audit-defense citations.
**Effort:** S–M · **Lever:** trust / retention

### 43. Stripe completion — explicitly deferred
The seam doc has it right: finish checkout/portal/webhooks when the first paying signal arrives, not before. Decision #33 (pricing architecture) matters now; the billing plumbing doesn't.
**Effort:** M (later) · **Lever:** monetization

### 44. Production-grade infra batch (the honest debt list)
Roll into the planned deploy chunk: repo/droplet compose drift (DEMO_FIXES 0.1), express-rate-limit IPv6 keyGenerator (0.2), aiBudgetGuard FK violation (0.3), uploads-dir permission fix reproducible in the repo, droplet sizing for parser CPU (the 16–22s parses on 1 vCPU won't survive concurrent users), golden-corpus fixture tests pinned in CI (corpus findings doc notes "no golden corpus fixtures pinned yet"), free-tier AI cascade rate-limit fragility under real load, and the demo-vs-production env divergence (AI_ENABLED=false on the droplet means the AI gap-fill and nameplate flows demo differently than they'll run for customers).
**Effort:** M · **Lever:** trust / technical debt

---

## Risk flags (not ideas — things to keep naming out loud)

- **Brother-gated items are gating quality, not existence.** #1's UI, #3's confirm step, and #11's templates can all be built on data in hand (SAMPLE JOB, the 2nd-batch corpus, the field library). Don't let the golden-corpus ask become a build blocker.
- **The page-budget truncation (#2) is the silent contradiction** of the multi-asset warning: the product now *tells* the user "this report covers 3 assets" while only parsing the first ~18 pages of a 41-page job. Fix before anyone notices.
- **Demo metering vs. batch capture (#13):** batch nameplate on the free tier burns the 5-scan cap in one hallway. That's the BYO-AI conversion moment by design — make the wall say so.
- **The customer-vs-channel wall** (DESIGN_PRINCIPLE doc) gets stress-tested by #23 and #14. Keep every channel surface behind oem_admin; the moment a facility user smells a sales pipeline, the Gimba trust failure repeats.
- **#31's consent framing must precede the first real customer contract.** Retro-fitting benchmark rights into existing ToS is somewhere between hard and impossible.

## If we only did five things
1. **#1 + #2** — one upload = one facility, parsed async and whole. The moat at document scale.
2. **#4** — telemetry + correction capture. The cheapest exit asset, compounding from day one.
3. **#7 + #8 + #9** (one compliance bundle) — labels, auto-C3, EMP clock: three literal 70B requirements, each small, that together make the compliance story undeniable.
4. **#14 + #15** — contractor bulk ingest + co-branding. The flywheel stops being a narrative doc.
5. **#31 + #32** — start the data assets an acquirer pays for. Logging is cheap; hindsight isn't.

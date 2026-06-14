# ServiceCycle Build Roadmap (v3)
**Date:** 2026-06-12
**Sequences:** the 44-item strategy review in `docs/research/2026-06-12-strategy-review-v3.md` (read that for the full rationale of each item).
**Purpose:** the build plan a fresh session can start from. Item numbers (#) refer to the v3 review.

---

## The principle behind the order

Two truths shape the sequence:

1. **Some value compounds and cannot be backfilled.** Labeled extraction corrections, cross-account benchmark curves, and the KPI history a PE/contractor acquirer underwrites only exist if they begin accumulating *before* the first real customer. They are cheap to start and impossible to catch up on — so they go **first**, even though their payoff is latest.
2. **The moat is the exit thesis.** Frictionless data-in + contractor channel + compliance-required stickiness are simultaneously the product and the acquisition asset. So we finish the half-open core capture loop early, then stack channel and compliance on top.

We run three workstreams in parallel:
- **Track A — Compounding data & metrics** (start now, never stops; small, irreversible-if-skipped).
- **Track B — Build waves** (the feature loops, ordered by dependency and leverage).
- **Founder workstream** (decisions only Dustin can make — they unblock the above).

Effort key: **S** = hours–1 day · **M** = days · **L** = 1–2+ weeks.

---

## Track A — Start immediately, run continuously (compounding, un-backfillable)

These are the acquisition crown jewels in seed form. Wire them in alongside Wave 1; every day skipped is data you can never recover.

- **#4 Extraction telemetry + correction capture** [S–M] — log engine / coverage / confidence on every preview and every human edit (field, before, after, form family). QA harness now; a proprietary labeled dataset at diligence ("12k reports, 94% field accuracy, improving monthly"). **Thread through every ingest + scan path from day one.**
- **#32 KPI instrumentation (the data-room dashboard)** [S–M] — assets under management, readings ingested, PDFs parsed + field accuracy, WAU by role, time-to-first-fix-list, contractor→facility attach rate. The brother demo is about to produce the first real numbers — capture them before they're gone.
- **#5 Report fingerprinting (SHA-256 dedupe)** [S] — "imported 2026-03-03 against SWGR-2 — re-import anyway?" Protects the integrity of every metric in Track A and every trend in the product.
- **#31 Benchmark data — *start the consented logging only*** [S to start] — the full cohort product is Wave 6, but the consented capture pipeline must begin now (blocked on the Founder ToS item below).

---

## Track B — Build waves

### Wave 1 — Finish the core loop (the moat made real)
The "one upload = one facility" headline, in dependency order:

1. **#2 Async parser + page-budget fix** [M] — the 18/4/4 page caps now *contradict* the multi-asset warning already shipped (it claims 3 assets, then drops later ones). Move ingest to an async job with progress + notify. **Prereq for #1 at facility scale, #6, #34.** Absorbs the parser slice of the #44 infra debt.
2. **#3 Asset identity resolution** [M] — fuzzy serial normalization (B36S01≈B36SO1) + site/position/type fallback + one-tap confirm; scanning an existing serial warns instead of duplicating. Underpins trustworthy year-over-year trending **and** #1's section matching.
3. **#1 One-upload = one-facility split & commit UI** [L] — the per-section accordion: match each `SUBSTATION…POSITION` block to the register, unmatched → "create asset?" rows, one commit writes everything. The single most valuable sentence the company can say, finished.
4. **#10 PDF preview confidence triage** [S–M] — render the same red/yellow/green review the nameplate flow uses ("review 6 of 38"). One review pattern everywhere; trains users once.

### Wave 2 — Compliance lock + cheap quick wins (makes it *required*, not nice-to-have)
Largely independent of Wave 1 — parallelize:

- **#7 Condition-of-maintenance labels** [S] — extend QR sheets with Serviceable/Limited/Nonserviceable + governing condition + date (70B literally requires this on the equipment).
- **#8 Auto-Condition-3 on two missed cycles** [S] — §9.3.1 verbatim; neglect tightens intervals automatically, citation shown.
- **#9 EMP audit clock + coordinator nag in Path-to-100** [S] — surface "EMP review due (5-yr)" and "no coordinator named" as one-click gap items.
- **#11 Templates 6→23** [S–M] — field library already enumerates all 23; ship a template each (kills "my type isn't here").
- **#12 AI type-guess pre-fills the field add flow** [S] — snap first, type guess pre-selects the template, tech confirms.
- **#27 Acceptance test = year-0 baseline** [S–M] — accept commissioning reports as the trend anchor; enter the asset's life on day one.
- **#24 Protective-device-operation / incident log** [M] — quick-log trips/relay ops from field mode; feeds C2/C3 criteria + the EMP's thin incident section.

### Wave 3 — Channel proof (the integration thesis the acquirer underwrites)
Builds on Wave 1 (#1):

- **#14 Contractor bulk ingest on the Fleet Dashboard** [M] — contractor uploads a customer's job report from the fleet view → the facility account seeds itself. Onboarding as a side-effect of billed work; the acquisition demo.
- **#15 Co-branded customer artifacts** [S] — `partnerOrg` logo/color on leave-behind, EMP, labels ("powered by ServiceCycle").
- **#16 Auto-send the leave-behind on WO completion** [S] — found/fixed/budget-for, unprompted; the retention heartbeat.
- **#23 Fleet Path-to-100** [S] — "Acme — 73%, 12 actions to 100, ~$14k," ranked across the book. An upsell that *is* the customer's need (respects the customer-vs-channel wall; keep behind oem_admin).
- **#22 Close the quote→work→green loop** [S–M] — accepted quote auto-creates the WO bound to its deficiency so completion clears compliance + gives contractors closed-loop attribution.
- **#21 Auditor/insurer share link** [M] — time-boxed, watermarked, read-only EMP + honest number + Path-to-100 + snapshot. The *demand wedge* — insurance enforcement is the 70B tailwind. **Pull earlier than Wave 3 if a live customer/insurer conversation appears.**

### Wave 4 — More data streams + capture completeness (data gravity + TAM)
- **#6 Email-in ingest** [M, needs #2] — `reports-{account}@servicecycle.app` → async queue. Zero-new-behavior data-in.
- **#13 Batch nameplate capture** [M] — queue of confidence reviews, one-tap accept on all-green; the deliberate BYO-AI conversion moment.
- **#28 Oil/DGA lab-report ingest** [M] — third recurring document stream; transformers are the highest-value assets.
- **#29 Thermography report ingest** [M] — IR is a *required* annual 70B task, so every compliant facility generates them.
- **#19 Offline-first field mode** [M–L] — electrical rooms are RF-dead; PWA IndexedDB queue, sync on signal.
- **#20 Photo-of-paper-report capture** [S–M] — handwritten field sheet into the existing OCR→ingest→confidence pipe.
- **#17 Parser-as-funnel (public, email-gated, deterministic-only)** [M] — prospect drops a report, sees a teaser fix list, signs up to keep it. Hardest GTM asset to fake.

### Wave 5 — Compliance breadth (bigger mandate → bigger buyers)
- **#25 Arc flash as first-class records (NFPA 70E)** [M] — per-study records with their own 5-year clocks; the account-level date won't survive a multi-site customer.
- **#26 NFPA 110 genset + IEEE 450/1188 battery modules** [M each] — healthcare + data centers ask for these with 70B.
- **#30 Customer weekly digest + quarterly CFO PDF** [S–M] — the heartbeat between test seasons + a board-grade budget artifact.
- **#37 QEMW credential wallet for contractors** [M] — 12–18-month first-mover window on ANSI/NETA EMW-2026; server seam exists, build the roster UI.

### Wave 6 — Exit packaging + trust (de-risk the buyer, open regulated customers)
- **#31 Benchmark product** (the cohort badges) [L] — the payoff of Track A's logging: "worse than 78% of its peers." The asset a roll-up can't build.
- **#34 Switching-cost backfill ("bring us your decade")** [M, needs #1/#2] — bulk historical import; the asset's medical record lives here, so leaving means abandoning the patient history. Also feeds #31.
- **#35 Enterprise trust pack** [M–L] — SSO/SAML, SIEM-exportable audit log (the hash chain exists — package it), security one-pager with the BYO-AI data-flow diagram.
- **#36 Self-host / air-gap productization** [L] — `planType=licensed` seam exists; "no data leaves your network" for utilities/federal — no VC-SaaS competitor matches it.

---

## Continuous — Infra hygiene (interleave, never a single batch)
**#44** — parser CPU/concurrency (largely absorbed by #2), compose drift, rate-limit IPv6, golden-corpus fixtures pinned in CI, free-tier cascade fragility, `AI_ENABLED` demo-vs-prod divergence, droplet sizing. Fold in as you touch each area. Removes diligence risk; doesn't add value.

---

## Founder workstream (decisions only Dustin can make — they unblock Track B)
- **ToS / consent language for benchmark data (#31)** — settle BEFORE the first real customer signs. Gates Track A's highest-value asset; the single most time-sensitive non-code item.
- **#33 Pricing architecture** [decision + S] — per-facility-under-management, contractor pays / facility $0, per-asset bands not seats, BYO-AI permanent (and a security-review selling point). Pricing *is* positioning for the acquirer.
- **#38 Acquirer dossiers** [S] — one pager per target (Shermco/Blackstone, IPS, EMCOR, Quanta, RESA); the wedge: Megger owns PowerDB, so a roll-up buying the layer that *consumes* PowerDB output hedges that lock-in.
- **The brother conversation** — unblocks multi-asset *tuning* (#1 quality, not existence), structured side-doors (#18), and several validation gates. **Brother gates quality, not existence — build the build-decidable parts now.**

## Explicit holds / later (with reasons)
- **#18 Structured side-doors (PowerDB native / Doble / OMICRON)** — build within a sprint of brother confirming structured data leaves the building; nothing before.
- **#39 Ask-AI help chat** — hold for validation; the fix-it list already answers most of it. If built: BYO-AI-gated, corpus-grounded.
- **#40 Contractor grading** — internal-only or skip; channel risk while courting contractors.
- **#41 Voice/dictation field notes** — after offline mode (#19), or it's just a demo.
- **#42 Help Center / FAQ** — write the RUL / condition / arc-flash explainers first; they double as audit-defense citations.
- **#43 Stripe completion** — deferred until first paying signal; the seam is enough.

---

## Where the fresh session starts
**Open with Track A (#4 + #32 + #5) wired in alongside the Wave 1 opener (#2 async parser + page-budget fix).**
- Track A is small and makes everything after it measurable and un-lose-able.
- #2 unblocks the entire core loop (#1/#6/#34) and fixes a live contradiction (the multi-asset warning vs. the page-budget truncation).

That is the first concrete build block. From there: #3 → #1 → #10 completes the moat loop, and Waves 2/3 can run in parallel once #1 lands.

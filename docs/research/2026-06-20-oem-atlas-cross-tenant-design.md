# Cross-Tenant Aggregation: OEM Installed-Base Atlas & Fleet Benchmarking — Design Spike

**Status:** DESIGN SPIKE — no feature code. Research + design doc.
**Date:** 2026-06-20
**Author:** Product + Privacy architecture pass
**Scope:** Two acquisition-centerpiece features that REQUIRE cross-tenant aggregation, plus the consent + anonymization layer they sit on.

---

## 0. Why this is hard (and why it is the moat)

ServiceCycle's north star: the asset record is a **revenue-bearing digital twin**. Compliance (NFPA 70B condition-based intervals, C1/C2/C3 governing condition, EMP evidence) gets us in the door. The thing an acquirer (an Eaton/Schneider/ABB/Siemens, or a PE roll-up) actually pays a premium for is the **aggregate**: a census of who has what gear, how old, how degraded, how close to replacement, and where — across the entire customer base.

That aggregate is in **direct tension with the per-tenant isolation that was just hardened** (the recent audit that closed cross-tenant read holes). Every production query is scoped by `accountId`. The two features below deliberately read across `accountId` boundaries. If we are sloppy, we re-open exactly the holes the audit closed, except now intentionally and at the data-product layer where the blast radius is "competitor sees your installed base" or "OEM re-identifies a single-site customer."

**The architectural commitment that resolves the tension (non-negotiable):**

> Cross-tenant data is **never** read in the live application request path. It is materialized by a **separate, offline, read-only aggregation pipeline** into a **physically separate analytics schema/database** that holds only k-anonymized, threshold-suppressed aggregates — never tenant-identifiable rows. The app's `accountId`-scoped isolation is untouched. The Atlas and Benchmarking surfaces read **only** from the aggregate store, which by construction cannot answer "show me account X."

This is the data-clean-room pattern adapted to a single-vendor multi-tenant DB: the "clean room" is our own offline aggregation boundary, and the privacy guarantees are enforced at materialization time, not query time.

---

## A. RESEARCH — 2026 best practices for privacy-safe cross-tenant analytics

### A.1 The anonymization toolkit and where each fits

| Technique | What it gives | Where it fails | SC fit |
|---|---|---|---|
| **k-anonymity** | Each released record indistinguishable from ≥ k−1 others on quasi-identifiers (make/model/region/equipment-type). Simple, explainable, auditable. | Vulnerable to **homogeneity** (all k share the sensitive value) and **linking/background-knowledge** attacks; high-dimensional data degrades fast. Re-identification of "k-anonymized" EdX students by cross-referencing LinkedIn is the canonical failure. | **Primary gate** for the Atlas (suppress any map cell / model bucket backed by < k tenants AND < k assets). |
| **l-diversity** | On top of k: each equivalence class must have ≥ l *distinct* values of the sensitive attribute (e.g., not all C3). Defeats homogeneity. | Still beatable by skew/similarity attacks; can be over-conservative. | Apply to **condition/RUL** cells so we never publish "every Eaton transformer in cohort = C3" (which fingerprints one operator). |
| **t-closeness** | Distribution of the sensitive attribute in each class is within t of the global distribution. | Hard to tune; heavy utility cost. | Optional hardening on benchmarking percentiles; likely overkill for v1. |
| **Differential privacy (DP)** | Mathematically provable bound (ε) on what any single tenant's inclusion can reveal; add calibrated Laplace/Gaussian noise to query *outputs*. 2025 work: ε≈1.0 hit < 0.1% re-id risk with low utility loss; robust to linking/background-knowledge because the guarantee is output-side, not data-side. | Noise hurts small-N utility; needs a **privacy budget** managed over time (repeated queries leak). | **Counts and benchmark statistics** (per-OEM/model counts, percentile bands, "X% more degraded than peers"). DP noise on published counts + a query budget per OEM partner. |
| **Pseudonymization** | Replace tenant IDs with tokens. Cheap, preserves utility. | **Not anonymization** under GDPR — re-linkable; legally still personal/confidential data. | Only an *internal* pipeline mechanic, never a release control. |
| **Data clean rooms / TEEs / MPC / homomorphic** | Neutral environment; parties compute on combined data without seeing raw rows; TEEs are now the 2026 standard, MPC/threshold-homomorphic for confidential benchmarking. | Operational complexity; overkill when one vendor already holds all the data. | **Conceptual model** we adopt (offline aggregation boundary = our clean room). Real MPC/TEE only matters if OEMs ever contribute their *own* warranty/sales data back to join — a v2+ consideration. |

**Consensus the research points to:** no single technique is sufficient in 2026. The defensible posture is **layered**: minimum-aggregation suppression (k-anonymity + l-diversity) as the hard gate, **plus** DP noise on the numbers that survive the gate, **plus** contractual + consent controls, **plus** re-identification red-teaming before any new dimension is exposed.

### A.2 How comparable platforms expose "vs peers" without leaking

- **Minimum cohort thresholds are universal.** Google Analytics Benchmarking, app-store peer benchmarking, security-rating peer comparison (BitSight), and 401(k)/HR benchmarking all require a property/entity to clear a minimum population before it appears in any peer group, and suppress cohorts under a floor because "small cohorts produce misleading percentages" and leak. Some supply **synthetic baseline distributions** when a real cohort is too small rather than show a thin one.
- **Output is always a distribution or a relative position, never a row.** "You are in the 60th percentile" / "12% above peer median" — never "Acme Plant has X."
- **Apple's app-store peer benchmarking ships DP** (patented) over peer groups — the direction of travel for consumer-scale analytics.
- **Installed-base intelligence is an established OEM category** (Entytle, Industrility, IIR PECWeb) — OEMs already buy "where is my fleet, what's its lifecycle stage, where's competitive-displacement risk." SC's differentiator is **condition-based truth** (real NFPA 70B C1/C3 + measured RUL from inspections) vs. their modeled guesses. That is exactly the asset that commands an acquisition premium — and exactly why the privacy gate must be airtight, because the underlying data is real customers' confidential plant data.

### A.3 Contractual / consent norms (2026 B2B SaaS)

- Customer **owns** their data; provider gets **only a license** to use **aggregated/de-identified** data, and that right must be **explicitly granted** in the MSA/DPA — increasingly with a **customer opt-out / right to be excluded from the aggregate** (lawinsider "Aggregate/Anonymous Data" clauses, contractnerds "De-Identified Data in SaaS Agreements").
- 2026 GDPR/CPRA practice: **separate, purpose-specific opt-in** ("every purpose needs a separate opt-in checkbox"); de-identified ≠ exempt if re-linkable; provider must contractually commit **not to attempt re-identification** and bind downstream recipients (OEMs) to the same.
- Provider-favoring agreements reserve aggregate rights by default, **but** the modern, trust-building (and acquisition-friendly — clean consent provenance is a diligence asset) posture is **opt-in for selling/sharing the aggregate to third parties (OEMs)**, even if "internal product improvement" stays opt-out.

**Sources**
- [Privacy-Preserving Mechanisms in Cloud Big-Data Analytics (Preprints, 2026)](https://www.preprints.org/manuscript/202601.1025)
- [Comparative Evaluation of K-Anonymity, Differential Privacy, Pseudonymization for Rare Disease Registries (2025)](https://www.researchgate.net/publication/395921557_Comparative_Evaluation_of_K-Anonymity_Differential_Privacy_and_Pseudonymization_for_Data_Protection_in_Rare_Disease_Registries)
- [What is Differential Privacy? (Privacy Guides, 2025)](https://www.privacyguides.org/articles/2025/09/30/differential-privacy/)
- [Practical methodology to assess re-identification risk in anonymized datasets (arXiv 2501.10841)](https://arxiv.org/pdf/2501.10841)
- [K-Anonymity privacy protection against skewness/similarity attacks (PMC9919945)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9919945/)
- [What is a data clean room — complete guide (Decentriq)](https://www.decentriq.com/article/what-is-a-data-clean-room)
- [Best Data Clean Rooms 2026 (Gartner Peer Insights)](https://www.gartner.com/reviews/market/data-clean-rooms)
- [Google Analytics Benchmarking (minimum-volume peer groups)](https://support.google.com/analytics/answer/16388466?hl=en)
- [App-store peer-group benchmarking with differential privacy (USPTO 12430660)](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12430660)
- [Performance benchmarking with cascaded decryption (USPTO 12401493)](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12401493)
- [Installed Base Analytics: The OEM's Most Underused Growth Lever (Entytle)](https://entytle.com/installed-base-analytics-oems/)
- [Installed Base Intelligence For Growth (Industrility)](https://www.industrility.com/installed-base-intelligence/)
- [Aggregate/Anonymous Data sample clauses (Law Insider)](https://www.lawinsider.com/clause/aggregate-anonymous-data)
- [De-Identified Data in SaaS Agreements (Contract Nerds)](https://contractnerds.com/de-identified-data-in-saas-agreements/)
- [GDPR Compliance Checklist for B2B SaaS 2025 (Complydog)](https://complydog.com/blog/gdpr-compliance-checklist-complete-guide-b2b-saas-companies)

---

## B. DESIGN — the consent + anonymization framework

### B.1 Who consents — and the two-party problem

SC's hierarchy is `PartnerOrganization → Account → Site → Asset`, but **two different parties' confidential interests** are embedded in every asset record, and they consent to different things:

1. **The customer Account (asset owner / facility operator).** Owns the plant data: nameplate, condition, RUL, geo, measurements. Consents to **their assets being included in cross-tenant aggregates** (Atlas + benchmarking). This is the GDPR/MSA "right to be in/out of the aggregate."
2. **The contractor PartnerOrganization (the NETA firm / service vendor whose techs produced the inspections).** Their confidential interest is the **contractor quality score** in the benchmarking feature — that ranks *them*. A contractor must consent to **being scored and compared**, separately from the customer consenting to data inclusion.

These are **independent toggles**. A customer can opt their assets into the Atlas while a contractor declines quality-scoring; in that case the assets still feed installed-base counts but are excluded from any contractor-attributed benchmark.

**Default posture (recommended):**
- **Internal product improvement / SC's own roll-ups:** opt-**out** (covered by standard MSA aggregate-data license).
- **Atlas sold/shared to OEM third parties:** opt-**in** at the Account level (explicit, separate checkbox, logged with version + actor + timestamp).
- **Contractor quality scoring exposed to anyone outside the contractor:** opt-**in** at the PartnerOrganization level.

### B.2 Minimum-aggregation thresholds (the hard gate)

No aggregate cell is ever published unless it clears **all** of:

| Parameter | v1 value | Rationale |
|---|---|---|
| **k_tenants** — distinct consenting Accounts behind a cell | **≥ 5** | Industry-standard floor; one tenant can't be ≥ 80% of a 5-cell. |
| **k_assets** — distinct assets behind a cell | **≥ 20** | Prevents a 5-tenant cell where one tenant supplies 90% of assets. |
| **max_tenant_dominance** — no single tenant > **40%** of a cell's assets | enforced | Defeats the "5 tenants but it's really one" homogeneity case. |
| **l_diversity** on condition/RUL cells | **l ≥ 3 distinct values** | Never publish a cell where the sensitive value is uniform (fingerprints one operator). |
| **geo granularity floor** | **3-digit ZIP / metro / state**, never site point | Single-site OEM gear + a precise pin = trivial re-id. Atlas maps render at metro/region; drill-down only deepens if the deeper cell *independently* clears k. |
| **DP noise** on published counts | Laplace, **ε per release window budgeted** | Counts that survive suppression still get calibrated noise so exact small-N counts don't leak; per-OEM query budget caps repeated-query reconstruction. |

Cells failing any check are **suppressed** (shown as "insufficient peer data," not zero — zero is itself a signal). **Complementary suppression** applies: if suppressing one cell lets it be reconstructed by subtracting visible cells from a visible total, suppress neighbors too.

### B.3 Field exposure matrix

| Field (from `Asset`/`Site`/`Account`) | In aggregate? | Form when exposed |
|---|---|---|
| `manufacturer`, `model` | YES | The point of the Atlas — but only as **counts/shares within a cohort**, never tied to a tenant. |
| `equipmentType` | YES | Cohort dimension. |
| `conditionPhysical/Criticality/Environment`, `governingCondition` | YES | **Distribution only** (% C1/C2/C3 in cohort), l-diversity gated. |
| `modernizationRiskScore` (RUL), `endOfSupport`, `obsolescenceStatus` | YES | **Banded** (e.g., < 2yr / 2–5yr / 5yr+ to replacement); banding is itself a suppression aid. |
| Geo (`Site.city/state/postalCode`) | YES, **coarsened** | Metro/3-digit-ZIP/state per B.2 floor. Never lat/long, never full address. |
| `serialNumber` | **NEVER** | Direct identifier; unique per unit. Strip at pipeline ingest. |
| `companyName`, `Site.name`, contacts, `ownerId` | **NEVER** | Tenant/PII identifiers. |
| `repairCostEstimate`, `replacementCostCents`, quote→WO revenue attribution | **NEVER raw**; banded ranges only if opted-in | Pricing is the most competitively sensitive field; default OUT of OEM-facing Atlas. Internal benchmarking may use banded ranges. |
| `nameplateData` (JSONB: kVA, voltage, AIC…) | Selected technical fields only | Useful for failure-mode signatures (e.g., dry vs liquid transformer); but free-text notes and anything rare is dropped. |
| `notes`, free-text | **NEVER** | Unbounded re-identification surface. |
| Contractor identity (`Contractor`, `ContractorTech`) | Only to the contractor itself / opt-in scoring | Quality score is contractor-consented. |

### B.4 Re-identification defenses (the rare-equipment / single-site problem)

This is the sharpest risk. NFPA 70B electrical gear has long tails: a 50 MVA substation transformer or a fire-pump controller in a small metro may be **the only one** in any plausible cohort. Defenses, in order:

1. **Outlier / rare-combination suppression at materialization.** Any (make, model, equipmentType, geo) tuple whose population < k is folded into an "Other/rare" bucket before publish — it never appears as its own cell.
2. **Generalization hierarchies.** Geo (site → 3-ZIP → metro → state) and RUL/cost (raw → band) auto-coarsen until the cell clears k; if it never clears even at the coarsest level, suppress.
3. **Tenant-dominance cap** (B.2) so a single big operator can't *be* the cohort.
4. **DP noise + per-recipient query budget** so an OEM can't difference-attack across many narrow queries to isolate a tenant.
5. **No "your own data in the aggregate" mirror.** An OEM partner viewing the Atlas must not be able to subtract their own known sales records to back out the rest. Mitigated by suppression + DP + not exposing exact counts.
6. **Manual re-id review gate for new dimensions.** Any new field added to the Atlas requires a documented re-identification risk pass (per arXiv 2501.10841 methodology) before it ships — recorded in this docs/research folder.

### B.5 Consent & audit logging

- New `AggregationConsent` records (see C.1) are **append-only / versioned**: each change writes a new row with `consentVersion`, `scope`, `grantedByUserId`, `ip`, `policyTextHash`, `effectiveAt`, `revokedAt`. Never mutate; revocation = new row.
- Reuse the existing `ActivityLog` model for human-readable trail ("admin@acme enabled OEM Atlas inclusion").
- **Materialization provenance:** every aggregate-store build records which consent snapshot it was built from (a `consentSnapshotId`), so we can always answer "on what date did tenant X consent, and which Atlas builds included them." Critical for diligence and for honoring revocation (next build drops them).
- **Recipient-side access logging:** every OEM/super_admin query against the aggregate store is logged (who, what cohort, when) for the DP budget accounting and abuse detection.

### B.6 How this coexists with `accountId` isolation

- **The app path does not change.** All existing routes stay `accountId`-scoped. The audit's guarantees hold verbatim.
- The aggregation pipeline runs as a **separate offline job** (own DB role, **read-only** on the prod tables it sources, **write** only to the analytics schema). It is the *only* code allowed to read across `accountId` — and it never returns rows, only writes pre-aggregated, suppressed cells.
- The Atlas/Benchmarking API surfaces query **only** the analytics schema. They have **no** code path to the live tenant tables. Even a bug in those surfaces cannot leak a tenant row, because the aggregate store contains none.
- Physically: separate schema (`analytics.*`) or separate DB; the pipeline's prod-read role has `SELECT` only on a defined column allowlist (serial/notes/PII columns not granted). Belt-and-suspenders against accidental ingestion of forbidden fields.

---

## C. FEATURE SPECS

### C.0 Shared aggregation layer (build this first — both features depend on it)

**Data model additions (new migration; analytics schema separate from app schema):**

- `AggregationConsent` (app schema, alongside `Account`):
  - `id`, `accountId` (FK), `scope` enum (`INTERNAL_IMPROVEMENT` | `OEM_ATLAS` | `BENCHMARKING`), `granted` Boolean, `consentVersion` String, `policyTextHash`, `grantedByUserId`, `ip`, `effectiveAt`, `revokedAt?`, `createdAt`. Append-only.
- `PartnerAggregationConsent` (for contractor quality scoring): same shape keyed on `partnerOrgId` (or the `Contractor` model) with scope `CONTRACTOR_SCORING`.
- `analytics.AggCell` (the published-cell store): `cohortKey` (hash of dimensions), dimension columns (`manufacturer`, `model`, `equipmentType`, `geoBucket`, `conditionBucket`, `rulBand`), `tenantCount`, `assetCount`, `noisyAssetCount`, `conditionDistribution` JSON, `rulDistribution` JSON, `buildId`, `consentSnapshotId`, `suppressed` Boolean + `suppressReason`. **Contains no `accountId`, no serials, no names.**
- `analytics.AggBuild`: `id`, `startedAt`, `finishedAt`, `consentSnapshotId`, `kTenants`, `kAssets`, `epsilon`, `rowCounts`, `status`. One row per pipeline run = full reproducibility.
- `analytics.BenchmarkStat`: cohort key → percentile bands, peer-median condition mix, failure-mode signature aggregates, contractor-score aggregates (opt-in only).

**Pipeline (batch — NOT on-demand):**
- Nightly/weekly job (cron alongside existing modernization/missed-cycle crons). On-demand would mean live cross-tenant reads — explicitly forbidden.
- Steps: (1) snapshot current consents → `consentSnapshotId`; (2) read **only consenting** accounts' allowlisted columns; (3) strip identifiers, coarsen geo, band RUL/cost; (4) group into cohorts; (5) apply k_tenants/k_assets/dominance/l-diversity suppression + complementary suppression; (6) apply DP noise to surviving counts; (7) write `AggCell`/`BenchmarkStat` for a new `buildId`; (8) atomically swap the "current" build pointer; (9) log build. Revoked-since-last-build tenants are simply absent from the new build.

**Access:** pipeline runs under a dedicated DB service account; no human reads it directly.

**Estimate: L.** The privacy gate (suppression + DP + generalization hierarchies + the separate-schema/role split + consent model + provenance) is most of the work and is genuinely hard to get right. Both features are thin once this exists.

---

### C.1 Feature 1 — OEM Installed-Base Atlas

**What it is:** an OEM partner (Eaton/Schneider/ABB/Siemens) sees, across the consenting fleet, where their and competitors' gear is installed (metro/region), its age/condition/RUL distribution, and **replacement-opportunity** + **competitive-encroachment** maps — all from real NFPA 70B condition truth, never modeled. Anchored to the north star: this is the digital twin's aggregate value, monetized.

**Data source:** `AggCell` only. Dimensions: `manufacturer` × `model` × `equipmentType` × `geoBucket` × `conditionBucket` × `rulBand`.

**API endpoints (read aggregate store only):**
- `GET /api/atlas/installed-base?equipmentType=&geoBucket=` → cohort counts + condition/RUL distributions (suppressed cells omitted).
- `GET /api/atlas/replacement-opportunities?manufacturer=&geoBucket=` → cohorts with high share of C3 / RUL < 2yr / past `endOfSupport` (banded). The "modernization revenue" map.
- `GET /api/atlas/competitive-encroachment?manufacturer=` → for cohorts where the OEM has known presence, the **share mix vs competitors** by metro (relative, DP-noised).
- All gated on **DP query budget**; every call logged.

**Access control:** **`oem_admin` role, scoped to its `PartnerOrganization`** — but with a crucial change: an oem_admin's Atlas view spans the **whole consenting fleet's aggregate**, NOT just `partnerOrgId`-linked accounts. So the existing `oem_admin` (today: read-only over linked accounts) is the right *persona* but needs a **new capability flag** (`atlasEnabled` on `PartnerOrganization`, contract-gated) that grants aggregate-store access. `super_admin` can view all + manage the flag. **No new role needed** — extend `oem_admin`'s reach into the aggregate layer via a per-partner entitlement. Recommend a paid/contract-gated entitlement, since this is the monetized surface.

**Views:** map (choropleth by metro, never pins), opportunity table (cohort, asset band, % C3, % past EOL, est. replacement window), competitive share chart per metro, "insufficient peer data" placeholders for suppressed cells.

**Estimate: M.** Mostly views + read endpoints + entitlement gating on top of the shared layer.

---

### C.2 Feature 2 — Fleet-wide anonymized benchmarking / failure-mode atlas

**What it is:** "Your fleet is X% more degraded than peers"; per-OEM/model **failure signatures** (which models trend to C3 fastest, common deficiency patterns by make/model); **contractor quality scores**. Two audiences: (a) **customers** see themselves vs peers (retention/value); (b) OEMs see model-level failure signatures (product intelligence).

**Data source:** `BenchmarkStat` (cohort percentile bands, peer-median condition mix, failure-mode aggregates, contractor scores) — all opt-in, all suppression+DP gated.

**Key computations (in pipeline, not live):**
- Peer cohort = same equipmentType × geoBucket × rough fleet-size band; must clear k_tenants ≥ 5.
- "X% more degraded" = the requesting account's own governingCondition mix (computed in the **app path** from its own data — no cross-tenant read) compared against the **published peer-median band** from `BenchmarkStat`. The cross-tenant part is only the peer band; the "you" part stays tenant-local.
- Failure-mode signature = distribution of deficiency severity / time-to-C3 per make/model cohort, l-diversity gated.
- Contractor quality score = aggregate result-rating / deficiency-recurrence stats attributed to a contractor, **only if that PartnerOrganization opted into `CONTRACTOR_SCORING`**, and only ever shown as the contractor's own position vs an anonymized peer band (never "Contractor B scored 3.2").

**API endpoints:**
- `GET /api/benchmark/my-fleet` (customer, `manager`+) → your condition/RUL position vs peer bands. Combines tenant-local self-stats with `BenchmarkStat` peer bands. **This is the one endpoint that touches both worlds — and it does so by joining the tenant's OWN scoped data with anonymized aggregate bands, never another tenant's rows.**
- `GET /api/benchmark/failure-modes?manufacturer=&model=` (oem_admin entitlement) → model failure signatures.
- `GET /api/benchmark/contractor-score` (the contractor's own PartnerOrg admin) → own score vs peer band; opt-in gated.

**Access control:** customer benchmarking → `manager`/`admin` on the account (their own vs peers — low risk, big retention win). Failure-mode atlas → `oem_admin` with `benchmarkEnabled` entitlement. Contractor scores → that PartnerOrg's own admin only (+ super_admin). No new role.

**Views:** customer "you vs peers" gauge/bars on a dashboard tab; OEM failure-signature tables/curves per model; contractor self-scorecard.

**Estimate: M** for customer-facing "you vs peers" + OEM failure modes; **the contractor-scoring sub-feature adds risk/effort** (separate consent party, defamation/competitive-harm exposure) — could ship benchmarking v1 WITHOUT contractor scoring and add it later. Treat contractor scoring as a separable M.

---

## D. RISKS, LEGAL/CONSENT GAPS, OPEN QUESTIONS FOR DUSTIN

### D.1 Top risks

1. **Re-opening the cross-tenant boundary the audit just closed.** Mitigation is the separate-schema/read-only-role/offline-pipeline split (B.6). The single highest-leverage control: the Atlas/Benchmarking API code must have **no DB grant** to the live tenant tables. Enforce in code review + DB permissions, not just convention.
2. **Rare-equipment re-identification.** Long-tail NFPA 70B gear (big substation transformers, fire-pump controllers, single MV switchgear lineups in a small metro) is the realistic leak path. The suppression + generalization + dominance-cap stack (B.4) is designed for exactly this, but it MUST be red-teamed before launch.
3. **Difference/linkage attacks by OEMs who know their own sales.** An OEM partner has strong background knowledge. DP + query budget + suppression are the defense; without DP, suppression alone is beatable.
4. **Contractor quality scores = competitive/defamation exposure.** Scoring a named contractor poorly, even anonymized, invites disputes. Opt-in + peer-band-only presentation + legal review.
5. **Consent provenance gaps becoming a diligence liability.** An acquirer will audit *exactly* this. Clean, versioned, per-purpose consent with build-provenance is itself an asset; a messy retrofit is a discount.
6. **Pricing/revenue data leaking via the Atlas.** Defaulted OUT; keep it out of OEM-facing surfaces unless a deliberate, separately-consented decision is made.

### D.2 Legal / consent gaps to close (pre-build)

- **MSA/DPA language** for the aggregate-data license, per-purpose opt-in for OEM sharing, customer right-to-exclude, and a no-re-identification covenant binding OEM recipients. Today's terms almost certainly don't cover selling aggregates to OEMs.
- **OEM data-recipient agreement**: contractual no-re-id, no-resale, audit rights.
- **Contractor scoring consent** is a net-new consent relationship SC doesn't have today.
- **Jurisdiction**: GDPR/CPRA if any EU/CA customers — de-identified-but-relinkable is still regulated; the DP + suppression stack is what lets us argue true anonymization.

### D.3 Open questions for Dustin

1. **Opt-in vs opt-out for the OEM Atlas?** Recommendation: opt-in for OEM sharing (trust + diligence), opt-out for internal use. Your call on the commercial trade-off (opt-in shrinks the dataset; that directly weakens k-anonymity early when tenant count is low).
2. **At current customer count, can we even clear k_tenants ≥ 5 in meaningful cohorts?** If the fleet is small today, the Atlas may be mostly "insufficient peer data" at launch. Do we (a) ship it gated until density arrives, (b) raise thresholds even higher to be safe, or (c) seed with broader cohorts (state-level only)? This is the most important practical question — privacy thresholds and product utility are in direct tension at low N.
3. **Is contractor quality scoring in v1, or deferred?** It carries the most legal/relationship risk. Recommend deferring.
4. **Is pricing/revenue ever allowed into OEM-facing surfaces?** Recommend never; confirm.
5. **New per-partner entitlement = paid tier?** This is the monetized, acquisition-centerpiece surface — should Atlas/benchmarking be a contract-gated paid add-on (and does that gating itself become part of the consent story customers see)?
6. **Build order:** shared layer (L) is the gate for both. Confirm we build the anonymization layer + consent model first, validate with a re-id red-team, THEN layer the two read-only feature surfaces.
7. **DP epsilon / budget policy** — needs a deliberate choice (start ε≈1.0 per research; define the per-OEM query budget window). Want a follow-up spike to pin exact parameters?

---

## E. Summary recommendation

- **Approach:** layered, defense-in-depth — **minimum-aggregation suppression (k_tenants ≥ 5, k_assets ≥ 20, ≤ 40% tenant dominance, l-diversity ≥ 3) + generalization hierarchies for geo/RUL + differential-privacy noise with a per-recipient query budget**, materialized by an **offline, read-only, separate-schema aggregation pipeline** that the live app never queries — so existing `accountId` isolation is wholly preserved. Wrapped in **two-party, per-purpose, versioned opt-in consent** (Account for data inclusion; PartnerOrganization for contractor scoring) with full build-provenance for diligence and revocation.
- **Build effort:** Shared anonymization layer = **L** (the real work). OEM Installed-Base Atlas = **M**. Fleet benchmarking = **M** (customer "vs peers" + OEM failure modes), with contractor scoring as a separable, deferrable **M**.
- **Build order:** shared layer first + re-identification red-team, then Atlas, then benchmarking; contractor scoring last (or never in v1).

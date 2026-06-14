# ServiceCycle Standards & Compliance-Math Accuracy Review

**Date:** 2026-06-14
**Analyst:** Fable (compliance-standards / product research)
**Scope:** RESEARCH ONLY — no source code changed. Reviews (A) the standards/editions and interval matrix we encode in `server/scripts/seed-standards.js`, the derivation in `server/lib/maintenanceInterval.ts`, the DGA method in `server/lib/dgaEvaluate.ts`, and the thermography bands in `server/lib/thermographyEvaluate.ts`; and (B) the compliance-% math in `server/lib/complianceReport.ts`.
**Hard guardrail honored:** most of these standards are paywalled/copyrighted. Exact verbatim interval tables are NOT publicly reproducible. Every claim below is tied to a citation; items I could not confirm against a primary or high-quality secondary source are flagged **NEEDS PRIMARY-SOURCE / NETA-CERTIFIED REVIEW**.

---

## 1. Executive summary

**How close are we?** Structurally, very close and noticeably better than most home-grown compliance trackers. The 3-axis condition model (physical / criticality / environment, worst-governs) is an accurate rendering of NFPA 70B:2023 §9.3, and the dominant Table 9.2.2 interval row (C1=60 / C2=36 / C3=12) and the all-equipment IR-thermography row (12/12/6) are correct (verified in the 2026-06-12 field-library research against the HVM/Vertiv chart reproduced with NFPA permission). The compliance-% math is mostly sound and unusually honest (it already separates "unbaselined" and exposes a coverage rate). The biggest accuracy risks are concentrated in three places: the **DGA condition table (deprecated methodology)**, the **NFPA 110 load-bank test profile (wrong edition / wrong numbers in the description)**, and **two interval rows that contradict the standard's own exceptions**.

**Things we likely have WRONG (not merely unverifiable):**

1. **DGA — `dgaEvaluate.ts` implements the RETIRED methodology.** Our 4-condition individual-gas + TDCG ppm table is the IEEE C57.104-1991/2008 method. C57.104-**2019** (the edition we *claim* in our STANDARDS list) deleted the four-condition scheme, deleted TDCG as a primary parameter, and replaced it with a **three-status (DGA Status 1/2/3)** model built on 90th/95th-percentile gas concentrations stratified by the **O2/N2 ratio (split at 0.2)** and transformer age, plus delta/rate-of-change tables. We claim 2019 but encode pre-2019. (LIKELY-WRONG vs. the cited edition.)

2. **NFPA 110 load-bank description is the WRONG profile for the edition we claim.** `GEN_LOAD_BANK` description reads "50% kW × 30min + 75% kW × 60min (continuous 90 min total)." That is the **NFPA 110-2025** profile. We claim edition **2022**, whose annual supplemental load-bank profile is the three-step **25% / 50% / 75%** sequence (25% × 30min, 50% × 30min, 75% × 60min = 2 hours). (LIKELY-WRONG vs. claimed edition.)

3. **Grounding electrical-testing C3 over-requires.** `GND_FALL_OF_POTENTIAL` is seeded 36/36/12, but NFPA 70B Table 9.2.2 grounding-&-bonding electrical-testing row is **60 / 36 / 36** — C3 is **36 months, not compressed to 12**. We make a poor-condition ground system due 3× more often than the standard requires. The seed code comment even acknowledges this should be 60/36/36, but the actual seeded value plus the C3 12-month ceiling forces 12. (NEEDS-REVIEW — over-conservative, not unsafe, but mislabeled as "the 70B interval.")

**Things that are CORRECT or defensibly conservative:** thermography similar-component bands; arc-flash 5-year ceiling; NFPA 25 monthly electric / annual flow cadence; emergency-lighting monthly+annual; IEEE 43 PI ≥2.0; the dominant 60/36/12 row; the "should→shall" 2023 narrative.

**Multiplier mislabeling (already documented 2026-06-12, restating for completeness):** the ×2.5 / ×0.25 constants in `maintenanceInterval.ts` are **NETA MTS Appendix B** matrix corners, NOT NFPA 70B. The code comment and the seed header still partly attribute them to "NFPA 70B / NETA App. B." They are used only as a fallback for custom tasks (explicit columns win), so this is a documentation/labeling defect, not a math error for seeded tasks.

**What a NETA-certified engineer MUST verify before any production customer relies on this:** every `[ENCODED FROM PRACTICE — VERIFY]` row (there are ~30); the exact NETA MTS Appendix B *base* intervals per equipment/test (we don't have the paywalled table); the DGA rebuild against C57.104-2019; the NFPA 110 edition decision (2022 vs 2025 profile); and the grounding C3 value.

---

## 2. Per-standard findings table

Severity legend: **OK** = matches / defensibly conservative · **MINOR** = labeling/wording only · **NEEDS-REVIEW** = plausible but unverified or over/under-conservative · **LIKELY-WRONG** = contradicts the standard or the edition we claim.

| Standard / edition (as we claim it) | What we encode | What the standard actually says (citation) | Discrepancy + severity | Recommended fix |
|---|---|---|---|---|
| **NFPA 70B 2023** | EMP mandatory; condition-based intervals; dominant row 60/36/12; IR 12/12/6; UPS 12/6/3; §4.2 5-yr program audit; named coordinator | 2023 converted 70B from Recommended Practice ("should") to Standard ("shall"). §9.2.2 fixed interval table per product × task category (NOT multipliers). §9.3 3-axis ECA, worst governs. EMP audit ≤5 yr; coordinator; corrective-action loop. [NFPA product page; ESW-2023-18; HVM/Vertiv chart] | Core model **OK**. Multiplier attribution **MINOR** (App. B, not 70B). | Correct the code/seed comments to say "NETA App. B" for the multipliers. |
| **NFPA 70B 2023 — grounding electrical test** | `GND_FALL_OF_POTENTIAL` seeded → effectively 36/36/12 | Table 9.2.2 grounding & bonding *electrical testing* = **60 / 36 / 36** (C3 NOT compressed). [HVM/Vertiv chart, 2026-06-12 research] | C1 (36 vs 60) and C3 (12 vs 36) both off. **NEEDS-REVIEW** (over-requires; mislabeled). | Seed explicit 60/36/36 and exempt this row from the C3 12-mo ceiling. |
| **NETA MTS 2023** | Per-equipment test intervals "Appendix B"; many rows tagged [ENCODED FROM PRACTICE] | App. B = base intervals (months) × a 3×3 multiplier matrix (condition good/avg/poor × reliability low/med/high), corners 0.25 → 2.5. The matrix is real and our corners are right; the *base* per-test intervals are paywalled. [ANSI/NETA App. B 2011 PDF; Scribd 2019 App. B] | Matrix corners **OK**; specific seeded NETA intervals **NEEDS-REVIEW** (unverified base values). | NETA-certified review of each `§7.x` base interval against the actual App. B table. |
| **NETA MTS 2023 — Table 100.18 (thermography)** | similar: 1–3 ADVISORY, 4–15 RECOMMENDED, >15 IMMEDIATE; ambient: ≥1 ADVISORY, >20 RECOMMENDED, >40 IMMEDIATE | Similar-component: 1–3 investigate, 4–15 repair-as-time-permits, >15 major/immediate — **matches us**. Over-ambient: 1–10 possible, 11–20 probable, **21–40 monitor**, >40 major. [NETA ATS-2003/2013 Table 100.18; Quizlet flashcard set; eng.com doc] | Similar bands **OK**. Ambient bands **NEEDS-REVIEW**: we collapse the standard's 4 ambient tiers into 3 and put the RECOMMENDED break at >20 (std splits 11–20 "probable" vs 21–40 "monitor"). | Add the 21–40 "monitor" tier; set 11–20 → RECOMMENDED to match. Confirm exact MTS-2023 numbers (table is historically stable across editions). |
| **NETA ATS 2025** | Acceptance testing on new installs (reference only; no schedules) | Acceptance specs for new gear. Not interval-driven. | **OK** (reference only). | None. |
| **IEEE C57.104 2019** | 4-condition ppm + TDCG table (`dgaEvaluate.ts`); coarse key-gas hint | 2019 = three-status percentile model (90th/95th), O2/N2 split at 0.2, age bins, delta & rate tables; TDCG removed as primary; Duval Triangle/Pentagon formally adopted; Key Gas & Doernenburg moved out of main text. [powerprognosis 2019-vs-2008; researchgate; CIGRE] | **LIKELY-WRONG vs. the 2019 edition we claim.** Our table is the 1991/2008 method. | See §3 deep-dive. Either relabel to the legacy edition + disclaim, or rebuild to 2019. |
| **IEEE 43 2013** | Motor/gen IR + PI; ≥2.0 acceptable, <1.0 do-not-energize | PI = R10min/R1min; PI > 2.0 good (Class A 1.5); min IR (1 min) = kV+1 MΩ. [IEEE Xplore 43-2013; PMW; Electrom] | **OK**. (Optional: add the kV+1 minimum-IR floor.) | None required; consider kV+1 floor in evaluator. |
| **OSHA 1910 Subpart S current** | Fines $16,550 serious / $165,514 willful | Penalty figures are inflation-adjusted annually (Jan). Order of magnitude correct for 2024–2026; exact $ drifts. [DOL OSHA penalty tables] | **MINOR** (figures age out). | Add "as of <year>" and review annually, or pull from a dated constant. |
| **NFPA 101 2012** | EM lighting monthly 30-sec + annual 90-min (§7.9.3); 2012 edition deliberately (CMS) | CMS enforces 2012 LSC for healthcare; §7.9.3 monthly 30-sec functional + annual 90-min discharge. [verified 2026-06-07 healthcare research; widely corroborated] | **OK**. Note non-healthcare AHJs may enforce a newer edition. | Multi-edition binding (already planned). |
| **NFPA 25 2023** | Electric pump monthly no-flow (≥10 min); diesel weekly; annual flow at churn/100/150% | Electric: monthly ≥10-min churn. Diesel: weekly ≥30-min. Annual flow at 0/100/150%, ≥65% rated head at 150%. [QRFS; firesafetyfirst; usmadesupply] | **OK** (diesel weekly correctly noted out-of-scope until day-granular work). | None. |
| **NFPA 110 2022** | `GEN_LOAD_BANK` desc "50%×30 + 75%×60 = 90 min"; monthly 30%/30min; 3-yr 4-hr | 2022 annual supplemental load bank = **25%×30 + 50%×30 + 75%×60 = 2 hr**. The 50/75 two-step is the **2025** edition. Monthly 30% / 30 min ✓. Triennial 4-hr Class run ✓ (may combine: 3 hr ≥30% + 1 hr ≥75%). [Depco NFPA-110 guide; csdiesel; foster fuels] | Load-bank profile **LIKELY-WRONG** for the 2022 edition we claim. Monthly & triennial **OK**. | Either change the description to the 2022 three-step profile, or bump the claimed edition to 2025 and keep the two-step. Pick one and be consistent. |
| **IEEE 450 2010** | Stationary VLA: quarterly per-cell float V/ohmic; annual capacity ≥80% | 3-tier: **monthly** (string float V, charger, ambient), **quarterly** (per-cell V, SG, ohmic), **annual** (connection resistance, capacity). Capacity ≥80% rated; perform within first 2 yr then ≤25% of expected life. [IEEE Xplore 450-2010; Megger summary; Eagle Eye] | **MINOR**: we fold the monthly string check into the quarterly per-cell task (coarser than the standard's monthly tier). Capacity cadence **OK**. | Optionally add a monthly string-level float/charger check distinct from the quarterly per-cell task. |
| **IEEE 1188 2005** | VRLA quarterly ohmic; annual capacity ≥80% | Quarterly ohmic/impedance trending; annual capacity. Aligns with our encoding. [IEEE 1188; Megger summary] | **OK**. | None. |
| **IEEE 81 2012** | Fall-of-potential ground-resistance method | Measurement method for ground impedance/soil resistivity (method, not interval). | **OK** (method ref). Interval is the 70B grounding row issue above. | See grounding row. |
| **NFPA 70 2023** | GFP performance test §230.95(C) on install; cable tray §392 fill/bonding | NEC 230.95(C) requires GFP performance test at installation; §392 governs tray fill/bonding. Periodic retest is NETA/practice, not NEC-mandated. | **OK** (we already mark periodic interval as practice-based). | None. |
| **NFPA 70E 2024** | Arc-flash study review ≤5 yr (§130.5(G)); label legible/current (§130.5(H)) | §130.5 requires arc-flash risk assessment reviewed ≤5 yr (or on major change); label must carry nominal voltage, AF boundary, and incident energy+working distance OR PPE category, plus study date. [Schneider; Brady; Tyndale; Brainfiller] | **OK**. (2024 renumbered some sub-items; (G)/(H) split is correct in spirit — confirm exact letters in the 2024 text.) | Spot-confirm 2024 subsection letters; otherwise fine. |

---

## 3. DGA (IEEE C57.104) deep-dive

**What we do today (`server/lib/dgaEvaluate.ts`):**
- Per-gas [C1max, C2max, C3max] ppm bands for H2, CH4, C2H2, C2H4, C2H6, CO, CO2, plus a TDCG band [720, 1920, 4630].
- Condition 1–4 per gas; overall = worst gas (incl. TDCG); GREEN/YELLOW/RED at cond 1 / 2 / ≥3.
- Coarse key-gas fault hint (PD/T1/T2/T3/D1/D2) by acetylene + ethylene thresholds.

**What IEEE C57.104-2019 actually specifies (the edition our STANDARDS row claims):**
- **Three DGA Status levels, not four conditions.** Status 1 (unexceptional), Status 2 (possibly suspicious), Status 3 (probably suspicious / active gassing). [powerprognosis; CIGRE; researchgate]
- **Percentile-based limits, not fixed "good number" cutoffs.** Status boundaries come from the 90th-percentile table (Table 1) and 95th-percentile table (Table 2) of a large transformer population study.
- **Limits are a function of O2/N2 ratio (split at 0.2) and transformer age** — sealed/low-O2 units get *lower* limits than free-breathing/high-O2 units for the same gas. Our single fixed band per gas cannot express this.
- **TDCG removed as a primary diagnostic parameter.** Our reliance on a TDCG band is specifically the thing 2019 walked away from (it produced false positives on aged units).
- **Trend matters:** Table 3 (95th-percentile absolute change between successive samples) and Table 4 (rate of change ppm/yr) are now first-class. We have no trend logic.
- **Duval Triangle/Pentagon formally adopted; Key Gas & Doernenburg moved to annex.** Our key-gas hint is the de-emphasized legacy method.

**Verdict:** Our values are internally consistent with the **1991/2008** four-condition method (e.g., H2 ≤100 cond-1, C2H2 ≤1 cond-1, TDCG ≤720 cond-1 match the legacy tables printed on PowerDB forms — see field-library §1.3). They are **NOT** the 2019 method. This is the single biggest factual mismatch between what we *claim* (C57.104-2019) and what we *do*.

**Concrete recommendation (ranked):**
1. **Cheapest honest fix (S):** relabel — change the seed/DGA provenance to state we implement the *legacy C57.104 four-condition screen* and either change the STANDARDS edition to "1991/2008 method (legacy screen)" or add an explicit disclaimer that the 2019 percentile method is not yet implemented. This removes the "claims 2019, does 1991" contradiction immediately.
2. **Correct fix (L, needs engineer):** rebuild to 2019 — capture O2 and N2 (the parser already has `dga_oxygen`/`dga_nitrogen` fields), compute O2/N2, branch on the 0.2 split and age, and apply the 90th/95th-percentile Status tables. Add delta/rate trending across an asset's sample history. Add a real Duval Triangle classifier to replace the coarse key-gas hint. The percentile tables are paywalled (IEEE Std C57.104-2019) — a licensed copy + NETA/engineer review is required to transcribe them.
3. **Interim (M):** keep the legacy screen as a fast first-pass but stop reporting an `ieeeStatus` that implies 2019 conformance; flag any measurable C2H2 and any high rate-of-change as a hard YELLOW regardless of absolute band (the 2019 spirit).

---

## 4. Thermography (NETA Table 100.18) check

**Our bands (`thermographyEvaluate.ts`):**
- Similar-component ΔT: 1–3 → ADVISORY (priority 4); 4–15 → RECOMMENDED (priority 2); >15 → IMMEDIATE (priority 1).
- Over-ambient ΔT: ≥1 → ADVISORY (priority 3); >20 → RECOMMENDED (priority 2); >40 → IMMEDIATE (priority 1).

**Table 100.18 as published (NETA ATS-2003/2013; historically stable):**
- **Similar components under similar loading:** 1–3 °C → possible deficiency, investigate; 4–15 °C → probable deficiency, repair as time permits; >15 °C → major discrepancy, repair immediately.
- **Component vs. ambient air:** 1–10 °C → possible deficiency, investigate; 11–20 °C → probable deficiency, repair as time permits; **21–40 °C → monitor until corrective measures can be accomplished**; >40 °C → major discrepancy, repair immediately.

**Verdict:**
- **Similar-component bands: CORRECT** — exact match. [Quizlet Table 100.18 set; eng.com Table_100.18 doc]
- **Over-ambient bands: NEEDS-REVIEW.** We compressed the standard's four ambient tiers into three. Two issues: (a) we have no 21–40 "monitor" tier; (b) our RECOMMENDED threshold is ">20", but the standard's "probable deficiency / repair as time permits" tier is **11–20** (and 21–40 is a *separate, lower-urgency* "monitor" action). The net effect: a 12–20 °C over-ambient reading is currently scored ADVISORY by us but should be RECOMMENDED, and a 21–40 °C reading has no dedicated tier.
- **Caveat:** Table 100.18 is published in the *ATS* (Acceptance) standard; the equivalent table in MTS-2023 should be the same numbers but confirm against the licensed MTS-2023 copy. Our code references "NETA Table 100.18" generically, which is fine.

**Recommended fix (S):** add the 21–40 ambient "monitor" tier (could map to RECOMMENDED or a new MONITOR severity) and move the 11–20 break to RECOMMENDED. Safe code fix once the exact MTS-2023 numbers are confirmed.

---

## 5. Compliance-% math assessment (`server/lib/complianceReport.ts`)

### 5.1 Per-standard rate — `summarizeSchedules`
`complianceRate = current / (current + overdue)`, null when no rated schedules; unbaselined excluded.

- **Sound and explainable.** Excluding unbaselined (no first completion / mid-onboarding) is the right call so onboarding doesn't read as non-compliant.
- **Deliberately ignores coverage** (assets with no schedule under that standard are invisible). **This is the correct definition for a per-standard rate** — "of the obligations I've accepted under this standard, what fraction is current" — *provided the UI labels it that way.* The risk is purely presentational: a facility tracking one transformer under NFPA 70B reads 100% even with 40 untracked transformers. The code comment in `buildComplianceGap` already calls this out honestly ("flatters"). Keep per-standard rate coverage-blind, but always show it next to the coverage rate.
- **Rounding:** `Math.round(x*1000)/10` → one decimal. Consistent across the file. OK.

### 5.2 Overall rate — `buildComplianceGap`
`D = current + overdue + unbaselined + uncoveredAssets + empGaps`; `overallRate = current / D`.

- **As an *estimate*, defensible and unusually honest** — it folds the three ways an obligation can be unmet (overdue, never-baselined, no-program-at-all) plus program-level EMP gaps into one denominator, and the "each item = 100/D points, clear the list → 100%" framing is mathematically clean and good UX.
- **Edge cases / where it can mislead:**
  1. **Unit heterogeneity (the main soft spot).** One uncovered *asset* counts as one obligation unit, exactly like one overdue *schedule*. But covering an asset typically creates *several* schedules (an IR scan + IR test + contact-resistance, etc.). So an uncovered asset is under-weighted relative to the schedule load it implies — applying a template can *drop* the overall rate momentarily (1 covered asset becomes, say, 4 new unbaselined schedules = net +3 obligations). The "points recovered" promised by the uncovered action won't actually be realized on click. **NEEDS-REVIEW** — consider estimating expected-schedule-count per uncovered asset, or clearly framing uncovered as "asset coverage" in a separate sub-score rather than mixing unit types.
  2. **EMP gaps in the same denominator (your explicit question).** Folding §4.2 account-level program gaps (coordinator, 5-yr review) into the *per-asset* denominator is **defensible for a single headline "are we 70B-compliant" number**, because 70B compliance genuinely requires both the program *and* the schedules. But it mixes scales: with 2 EMP gaps and 4 schedules, the coordinator field is worth as much as a transformer's overdue test (1/6 of the score). On a 500-schedule account the same EMP gaps are nearly invisible (2/502). **Recommendation: keep them in the obligation list (they're real, one-click, and belong on the "path to 100%"), but report them as a separate "Program (EMP §4.2)" sub-score AND in the blended overall — don't let two checkboxes swing a small account's headline number, and don't let them vanish on a large one.** Surfacing them only on the whole-account view (not per-site) is already correct.
  3. **No criticality weighting in the rate.** A 480V lighting panel's overdue IR scan counts the same as a main-switchgear relay calibration. Criticality is used for *sort order* but not for the *score*. Defensible for a simple % but a weighted "risk-adjusted compliance" would be more honest. (Optional enhancement, not a bug.)
  4. **`inService` / `archivedAt` scoping differs subtly between functions.** `buildComplianceGap` uses `{archivedAt:null, inService:true}`; `buildStandardsSummary`/`buildStandardReport` use `{archivedAt:null}` only (no inService filter). So an out-of-service-but-not-archived asset is counted by the per-standard summary but excluded from the overall gap. **MINOR inconsistency** — pick one asset-population definition and use it everywhere, or document why they differ.

### 5.3 Recommended clearest definitions (wording for the UI / docs)
- **Schedule compliance (per standard):** "Of active, baselined maintenance schedules under {standard}, the share that are current." (coverage-blind, by design)
- **Asset coverage:** "Share of in-service assets that carry at least one active maintenance schedule."
- **Overall readiness / Path-to-100:** "A blended estimate combining current schedules, overdue/unbaselined work, uncovered assets, and account-level EMP program gaps. Each open item is one step to 100%." Add a one-line note that uncovered assets and EMP gaps are program-level and may each imply more than one downstream task.

---

## 6. Prioritized correction backlog

Ranked by (accuracy risk × audit exposure). Effort S/M/L. "Engineer" = needs NETA-certified / primary-source review; "Safe fix" = code/labeling change we can make from verified public sources.

| # | Item | Why it matters | Effort | Type |
|---|---|---|---|---|
| 1 | **Resolve the C57.104 edition contradiction (DGA).** Short term: relabel to legacy 4-condition screen + disclaim 2019. Long term: rebuild to 2019 (O2/N2 split, percentile tables, Duval, trending). | We claim 2019 and run 1991/2008. Most defensible single-line accuracy hit; transformers are the highest-value asset. | S (relabel) / L (rebuild) | Engineer for rebuild; relabel is a safe fix |
| 2 | **Fix the NFPA 110 load-bank profile/edition mismatch.** Make the description match the claimed edition (2022 → 25/50/75 three-step) OR move claimed edition to 2025 (keep 50/75). | A surveyor reading "NFPA 110:2022" next to a 2025 profile is an immediate credibility ding. | S | Safe fix (verified) |
| 3 | **Correct the grounding electrical-test interval to 60/36/36** and exempt it from the C3 12-mo ceiling. | Contradicts Table 9.2.2's named exception; we over-require 3×, and the seed comment already knows the right value. | S | Engineer to confirm; then safe fix |
| 4 | **Add the Table 100.18 over-ambient 21–40 "monitor" tier and move 11–20 → RECOMMENDED.** | Mis-tiers 12–20 °C ambient findings and drops the monitor band. | S | Safe fix (confirm MTS-2023 numbers) |
| 5 | **Correct the multiplier attribution** in `maintenanceInterval.ts` + seed header: ×2.5/×0.25 are NETA App. B, not NFPA 70B. | Documentation accuracy; cited in the 2026-06-12 doc but code comments still partly wrong. | S | Safe fix (verified) |
| 6 | **Separate EMP §4.2 program score from per-asset rate** (keep in path-to-100, report as its own sub-score). | Prevents 2 checkboxes from swinging a small account or vanishing on a large one. | M | Safe fix (design) |
| 7 | **Reconcile asset-population scoping** (`inService` filter) across the three report builders. | Same account can report two different denominators. | S | Safe fix |
| 8 | **Weight uncovered assets by expected schedule count** (or split into a coverage sub-score) so "points recovered" is truthful. | Applying a template can paradoxically drop the overall rate. | M | Safe fix (design) |
| 9 | **NETA-certified review of every `[ENCODED FROM PRACTICE — VERIFY]` row** (~30 rows) against the real NETA MTS-2023 Appendix B base intervals. | These are our largest body of unverified numbers. | L | Engineer (requires licensed MTS-2023) |
| 10 | **Add IEEE 450 monthly string-level check** distinct from quarterly per-cell; **add OSHA penalty "as-of-year"**; **spot-confirm 70E 2024 subsection letters**; **add IEEE 43 kV+1 MΩ IR floor**. | Small accuracy polish items, individually MINOR. | S each | Mostly safe fixes |

---

## 7. Sources (every URL used)

**NFPA 70B / condition model / multipliers (primary work in the 2026-06-12 field-library doc, re-cited):**
- NFPA 70B:2023 product page — https://www.nfpa.org/product/access-nfpa-70b-electrical-equipment-maintenance-practices/p0070bcode
- Valdes & Cunningham, IEEE ESW-2023-18 — https://electricalsafetyworkshop.org/wp-content/uploads/sites/255/ESW-2023-18.pdf
- HVM/Vertiv, *NFPA 70B Equipment Condition Assessment* (Table 9.2.2 + §9.3.1 reproduced w/ NFPA permission) — https://www.hvmcorp.com/4a8bf8/globalassets/documents/hvm-website-documents/hvm-nfpa-maintenance-chart-en-na-gr-00027-web.pdf
- ANSI/NETA Appendix B *Frequency of Maintenance Tests* (multiplier matrix) — https://www.meuw.org/Files/JT%26S%20Schedules%20and%20Sites/ANSI-NETA_Frequency_of_Maintenance_Tests_2011.pdf
- ANSI/NETA MTS-2019 Appendix B — https://www.scribd.com/document/467467104/ANSI-NETA-MTS-2019-Appendix-B
- ANSI/NETA MTS-2019 preview — https://webstore.ansi.org/preview-pages/NETA/preview_ANSI_NETA+MTS-2019.pdf

**IEEE C57.104-2019 DGA:**
- Power Prognosis, *C57.104-2019 vs 2008* — https://powerprognosis.com/ieee-c57-104-2019-vs-2008-what-changed-why-it-matters-for-transformer-dga/
- ResearchGate, *How to Improve IEEE C57.104-2019 DGA Fault Severity Interpretation* — https://www.researchgate.net/publication/362102025_How_to_Improve_IEEE_C57104-2019_DGA_Fault_Severity_Interpretation
- Power Systems Technology, *The Data Behind the Numbers: C57.104-2019* — https://www.powersystems.technology/community-hub/technical-articles/the-data-behind-the-numbers-ieee-c57-104tm-2019-dga-interpretation-guide.html
- HV Assets, *DGA Procedure Based on C57.104-2019* — https://www.hvassets.com/en/post/dissolved-gas-analysis-procedure-based-on-ieee-c57-104-2019
- IEEE Xplore C57.104-2019 standard page — https://standards.ieee.org/ieee/C57.104/5444/

**NETA Table 100.18 thermography:**
- NETA ATS Table 100.18 (eng.com hosted doc) — http://files.engineering.com/files/cb00de4f-ab57-4a63-a734-f514a1106884/Table_100.18.doc
- Quizlet, NETA ATS Table 100.18 flashcards — https://quizlet.com/615540872/neta-ats-table-10018-thermographic-survey-suggested-actions-based-on-temperature-rise-flash-cards/
- ANSI/NETA ATS-2013 (Danville VA hosted) — https://www.danville-va.gov/DocumentCenter/View/26223
- Fluke, *Electrical inspections using thermal imaging* — https://media.fluke.com/e5fe5900-3285-4e45-8896-b10600678538_original%20file.pdf

**NFPA 110 generator / load bank:**
- Depco, *Generator Load Bank Testing* (edition-by-edition profiles) — https://www.depco.com/blog/generator-load-bank-testing-planning-for-success/
- CS Diesel, *NFPA 110 Generator Maintenance Simplified* — https://csdieselgenerators.com/nfpa-110-generator-maintenance-requirements-simplified-for-2025/
- Foster Fuels, *Emergency Generator Testing Requirements* — https://fosterfuels.com/blog/emergency-generator-testing-requirements/
- Clifford Power, *NFPA 110 Levels 1 & 2* — https://cliffordpower.com/wp-content/uploads/2024/02/IS_25_NFPA110_Level1_2-REV-11-1-19.pdf

**NFPA 25 fire pump:**
- QRFS, *Fire Pump Flow Test, NFPA 25* — https://blog.qrfs.com/245-the-fire-pump-flow-test-nfpa-25-requirements-for-fire-pump-tests-part-1/
- Fire Safety First, *Fire Pump Testing* — https://firesafetyfirst.com/fire-pump-testing-inspection/
- US Made Supply, *NFPA 25* — https://usmadesupply.com/resources/building-codes-standards/fire-suppression-standards/nfpa-25

**IEEE batteries 450 / 1188:**
- IEEE Xplore 450-2010 — https://ieeexplore.ieee.org/document/5724325
- Megger, *Standard Battery Testing Requirements Summary* — https://media.megger.com/mediacontainer/medialibraries/meggerus/images/std_bat_test_reqsum_dal_v1.pdf
- Eagle Eye, *IEEE 450 vs PRC-005-6* — https://eepowersolutions.com/resources/white-papers/differing-maintenance-requirements-of-ieee-450-and-prc-005-6-for-vented-lead-acid-vla-batteries/

**IEEE 43 motor/gen IR-PI:**
- IEEE Xplore 43-2013 — https://ieeexplore.ieee.org/document/6754111
- Pump & Motor Works, *Understanding IEEE 43* — https://www.pmwus.com/understanding-ieee-43-and-motor-insulation-resistance-testing-2/
- Electrom Instruments, *Insulation Resistance* — https://electrominst.com/test-technology/insulation-resistance/

**NFPA 70E arc flash:**
- Schneider Electric, *Arc flash labeling requirements* — https://blog.se.com/energy-management-energy-efficiency/electrical-safety/2024/06/14/arc-flash-equipment-marking-requirements-is-your-installation-compliant/
- Brady, *Arc Flash Labeling Requirements (2024 70E)* — https://www.bradyid.com/applications/arc-flash-labeling-requirements
- Tyndale, *130.5(F) Incident Energy Analysis* — https://tyndaleusa.com/nfpa-70e/130-5-f-incident-energy-analysis-methods/
- Brainfiller, *2024 NFPA 70E Major Changes* — https://brainfiller.com/technical-articles/2024-nfpa-70e-major-changes/

---

**Bottom line:** the skeleton is right and the math is honest; the flesh has three real errors (DGA edition, NFPA 110 load-bank profile, grounding C3) plus a set of labeling/wording and unit-heterogeneity issues. None require a licensed standard to *identify*, but the DGA rebuild and the ~30 practice-encoded interval rows require a NETA-certified engineer with paywalled copies of NETA MTS-2023 and IEEE C57.104-2019 to *fully resolve*.

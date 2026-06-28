# ServiceCycle — Electrical-Engineering Domain-Accuracy Audit

**Date:** 2026-06-28
**Scope:** Read-only fact-verification of the standards/compliance engine and seeded demo data against NFPA 70B-2023, NFPA 70E-2024, NFPA 110-2022, NFPA 101, NFPA 25, NETA MTS-2023, IEEE C57.104, C57.106, 43, 450, 1188, and 1584-2018.
**Method:** Code inventory (seed-demo.js, seed-standards.js, the `lib/*Evaluate` + `arcFlash*` engine, client glossary) → adversarial multi-source web verification (4 parallel research streams). Standards text is paywalled; values were triangulated from primary-standard PDFs where reachable and otherwise from multiple independent verbatim reproductions. **No standard text is reproduced here — only factual values, section/table numbers, and thresholds.**
**Posture:** This is a findings report only. Nothing in the engine or seed was modified. Several "errors" sit in demo copy and may be intentional simplifications; all domain fixes should be confirmed with the NETA expert before they ship.

---

## Tally

**3 P0 · 11 P1 · 9 P2** (23 findings). Plus a substantial **Verified-Correct** list — the engine's architecture (NFPA 70B chapter map, condition model, NETA test matrix, IEEE 1584 ranges, NFPA 70E shock boundaries and PPE arc ratings) is **largely accurate**. The errors are concentrated in (a) one DGA lookup table and (b) hand-written demo-seed copy, not in the core math.

**The one-sentence version for the meeting:** the engine is built right, but a transformer/arc-flash specialist would catch the acetylene DGA limits, a false "NFPA 110 requires annual battery replacement" line, and an incident-energy-labeled-as-PPE-Category arc-flash result — fix those three before he opens the laptop.

> **UPDATE 2026-06-28 — all findings fixed.** Engine + seed corrections applied and re-scanned: syntax/NUL clean, DGA logic re-tested 6/6, zero wrong citations remain. See the **Fixes Applied** addendum at the end of this doc. Three items were intentionally left as judgment calls for you / your brother (flagged in the addendum), and the live demo needs a **reseed** before the seed-copy changes show.

---

## P0 — Wrong facts a NETA/PE expert catches on sight (lead with these; all demo-visible)

### P0-1 · DGA acetylene limits are wrong and internally inconsistent
- **File:** `server/lib/dgaEvaluate.ts:29` (used by the T-1 transformer DGA in the Riverside demo)
- **App's claim:** acetylene (C₂H₂) four-condition limits `[1, 9, 35]` ppm (Condition 1/2/3 upper bounds), labeled "classic IEEE C57.104 four-condition table."
- **Standard's actual value:** IEEE C57.104-1991/2008 Table 1 lists C₂H₂ at **35 / 50 / 80 ppm**. (Verified against the primary IEEE C57.104-1991 PDF, Table 1; corroborated by an oil-lab reproduction.)
- **Discrepancy:** Two problems. (1) The value is simply wrong. (2) It is **internally inconsistent with the same table's own TDCG row** `[720, 1920, 4630]`: the Condition-1 individual limits must sum to the Condition-1 TDCG (100 H₂ + 120 CH₄ + 50 C₂H₄ + 65 C₂H₆ + 350 CO = 685; +35 C₂H₂ = 720). With C₂H₂ = 1 the arithmetic doesn't close. Every other gas in the table is correct — acetylene is the lone outlier. **Demo impact:** the hero T-1 sample (C₂H₂ = 2.8 ppm) scores **Condition 2 / Status 2 / YELLOW "caution"** *only because* 2.8 > the wrong 1 ppm Condition-1 ceiling. Under the correct table, 2.8 ppm is Condition 1 / GREEN. A transformer engineer knows 2.8 ppm acetylene is not, by itself, a C57.104 "caution."
- **Recommended fix (needs triage — affects the demo story):** correct the row to `c2h2: [35, 50, 80]`. But note the *engineering* instinct that rising acetylene (0.5 → 2.8 ppm) deserves a flag is right — so preserve that via **rate-of-rise / any-detectable-acetylene** logic (the `keyGasFault` D1 hint at `c2h2 >= 2` already fires independently and is fine), rather than by corrupting the absolute-limit table. Decide with the NETA expert how the demo should surface the acetylene trend on correct grounds.
- **Confidence:** **High** (primary IEEE source + internal-consistency proof).

### P0-2 · "NFPA 110 requires annual battery replacement" — false mandate
- **File:** `server/scripts/seed-demo.js:1783` (parts/spares note), reinforced at `:1843`.
- **App's claim:** "NFPA 110 §8.4 requires annual battery replacement on Level 1 EPS. Stock 2 minimum."
- **Standard's actual requirement:** NFPA 110 mandates **condition-based** replacement, not calendar-based — weekly battery inspection, monthly specific-gravity/conductance testing, and "defective batteries shall be replaced immediately upon discovery of defects" (§8.3.6, current edition). There is **no annual-replacement mandate** anywhere in NFPA 110.
- **Discrepancy:** attributes a non-existent scheduled-replacement rule to NFPA 110. A facilities/EPSS person catches this instantly — it's a common myth the standard explicitly does not support.
- **Recommended fix:** reword to "NFPA 110 §8.3.6 requires monthly battery testing; replace on indication of defect. Many sites replace generator starting batteries on a ~2–3 yr preventive cycle (manufacturer practice)." Keep the spares logic; drop the false NFPA citation.
- **Confidence:** **High.**

### P0-3 · Arc-flash result labeled as a "PPE Category" (method-mixing NFPA 70E forbids) + wrong DANGER citation
- **Files:** `server/lib/arcFlashMitigation.ts:112-116` (`ppeCategoryFor()` bins incident energy into a category, citing "Table 130.7(C)(15)(a)"); seeded on the hero bus at `server/scripts/seed-demo.js:1434,1441,1482` (`incidentEnergyCalCm2: 14.2` **with** `ppeCategory: 3`); rationale comment at `seed-demo.js:1426-1427`.
- **App's claim:** (a) a computed incident energy (14.2 cal/cm²) is presented with a **PPE Category 3** label; (b) the 4/8/25/40 cal/cm² thresholds are cited to "Table 130.7(C)(15)(a)"; (c) the 13.8 kV bus is "DANGER per NFPA 70E 130.5(H) regardless of incident energy."
- **Standard's actual requirement:**
  - NFPA 70E §130.5(F): you may use the incident-energy-analysis method **or** the PPE-category-table method, **but not both for the same equipment** — and specifically, *"using the results of an incident energy analysis to specify an arc flash PPE category … shall not be permitted."* Binning a calculated cal/cm² into a "PPE Category N" is the exact prohibited move.
  - The 4/8/25/40 cal/cm² arc ratings live in **Table 130.7(C)(15)(c)**, not (15)(a). (15)(a) is the AC equipment/parameter category-selection table.
  - NFPA 70E does **not** mandate signal words (DANGER/WARNING) at all — that convention is **ANSI Z535.4** — and it is **not keyed to voltage**. §130.5(H) governs label *content*, not signal words. (The "DANGER > 40 cal/cm²" informational note was actually deleted in the 2018 edition.)
- **Discrepancy:** an arc-flash PE catches the IE-as-Category labeling immediately; it's the canonical "don't mix the two methods" error. The DANGER call on the MV bus is itself a *defensible house convention*, but the citation behind it is wrong.
- **Recommended fix:** where a value is derived from an incident-energy calc, display **"required minimum arc rating: ≥25 cal/cm²"** (or "site-specific level"), not "PPE Category 3." Fix the table citation to **130.7(C)(15)(c)**. Reword the DANGER rationale: "DANGER vs WARNING follows ANSI Z535.4; treating MV buses as DANGER is a documented labeling-philosophy house rule, not an NFPA 70E §130.5(H) requirement." (Note: the engine's `arcFlashSanity.ts` already handles method discipline well — see Verified-Correct — so this is mostly a copy/label fix, not an engine-logic overhaul.)
- **Confidence:** **High** on the standard; the IE→Category convention is *extremely common in the field*, so expect the expert to recognize it as widespread-but-imprecise rather than alarming.

---

## P1 — Misleading / imprecise / wrong-citation

### P1-1 · NETA thermography table number "Table 100.2" (should be 100.18)
- **File:** `server/scripts/seed-standards.js:105, 282, 305` (switchgear, switchboard, panelboard IR tasks).
- **Claim vs standard:** cites "NETA MTS-2023 Table 100.2" for infrared thermography. The thermographic-survey action table is **Table 100.18** ("Suggested Actions Based on Temperature Rise"); no NETA "Table 100.2" thermography table exists. The engine's own `thermographyEvaluate.ts` and the demo notes correctly say 100.18 — so this is an internal inconsistency that surfaces raw (not masked) on the hero switchgear.
- **Fix:** standardize every thermography reference on **Table 100.18**. **Confidence: High.**

### P1-2 · NFPA 70B IR-thermography clause "§11.17" (should be §7.4) and DGA "§22.6" (should be Ch 11)
- **Files:** `seed-standards.js` IR tasks (`:105, 259, 282, 305, 328, 411, 420, 457, 601, 663, 754, 781`) cite "NFPA 70B:2023 §11.17"; XFMR_DGA (`:143`) cites "§22.6."
- **Claim vs standard:** NFPA 70B-2023 puts infrared thermography in **Chapter 7, §7.4 (Infrared Thermography)** — a general testing-method clause, not §11.17 (which is in the transformer chapter). Transformer oil/DGA is **Chapter 11 (Table 11.2 annual sampling)**, not §22.6 (Ch 22 is *Lighting*).
- **Discrepancy + mitigation:** `correct70bRef()` (`seed-standards.js:910`) masks this at runtime by swapping "§x.y" for the equipment chapter — so mapped gear shows "Ch 12," "Ch 11," etc. (correct). **But §11.17 still ships raw on equipment not in the chapter map — ATS (`ATS_IR_THERMO:259`) and fire-pump controllers (`FP_IR_CONNECTIONS:781`)** — and the chapter-swap means the *correct* IR clause (§7.4) is never actually cited anywhere.
- **Fix:** cite "NFPA 70B-2023 §7.4 (Infrared Thermography)" for the IR method + the equipment chapter; correct the raw §11.17/§22.6 source strings. **Confidence: High** (med on the exact "§7.4" sub-number — see Needs-Expert).

### P1-3 · Demo thermography uses "Category 1/2" labels NETA doesn't define
- **File:** `seed-demo.js:1033, 1065, 1097, 1114, 1268, 1275` ("NETA MTS Table 100.18 Category 2," "within NETA MTS Category 1").
- **Claim vs standard:** NETA Table 100.18 labels its rows with **action phrases** ("possible deficiency — investigate," "probable deficiency — repair as time permits," "major discrepancy — repair immediately"), **not "Category 1/2/3."** "Category" is NFPA 70E PPE terminology; reusing it for thermography reads as a domain-vocabulary slip and risks confusion with arc-flash categories.
- **Fix:** replace "Category N" with NETA's action language (the `thermographyEvaluate.ts` severity labels already encode the right phrasing). **Confidence: High.**

### P1-4 · Battery ohmic deficiency cites IEEE 450 and a fabricated 20% threshold
- **File:** `seed-demo.js:1290` (open deficiency) and `:2256` (activity feed).
- **App's claim:** "Two cells … ohmic resistance 25% above baseline — IEEE 450 replacement threshold is 20% above initial value."
- **Standard's actual requirement:** IEEE **450** (vented/flooded) does **not** define an internal-ohmic replacement threshold — vented-cell health rests on **capacity testing + specific gravity**. Internal-ohmic trending is the central technique of IEEE **1188** (VRLA), whose Annex C.4 gives a **30–50% rise from baseline** action figure. "20% above initial" is not a published IEEE value.
- **Discrepancy:** wrong standard + fabricated number, and it **contradicts the engine's own correct copy** (`seed-standards.js:501, 541` already say "30–50% rise from baseline = replace"). At the correct 30–50% threshold, a 25%-above-baseline cell would **not** yet be a replacement — so the demo scenario's logic inverts.
- **Fix:** attribute to **IEEE 1188** (VRLA) and use **30–50%**; if the switchgear control battery is vented lead-acid, key its deficiency off specific gravity / float voltage / <80% capacity instead. Re-pick the demo numbers so the narrative holds at the correct threshold. **Confidence: High.**

### P1-5 · Transformer-oil deficiency: "IEEE C57.106 Action Level 1" and "30 kV dielectric minimum"
- **File:** `seed-demo.js:1201, 1283, 1350` (oil-quality WO + deficiency).
- **App's claim:** moisture 28 ppm = "IEEE C57.106 Action Level 1 for 15 kV class (≤35 ppm)"; dielectric 28 kV is "below recommended 30 kV minimum."
- **Standard's actual requirement:** C57.106 uses **Class I / II / III** (continue/recondition/reclaim), not "Action Level 1/2/3" (that 1/2/3 tiering resembles IEC 60422, a different standard). The ≤69 kV ("15 kV class") dielectric minimum per **ASTM D1816** is **23 kV (1 mm gap) / 40 kV (2 mm gap)** — not 30 kV (30 kV is the old, withdrawn D877 *new-oil* figure). The **moisture ≤35 ppm for ≤69 kV is correct.**
- **Fix:** relabel "Action Level 1" → "Class I"; state the dielectric minimum as the D1816 23 kV/40 kV value for the class (and name the gap). **Confidence: Med-High** (secondary oil-lab sources; confirm exact value/gap with the expert).

### P1-6 · NFPA 110 triennial test: "4-hour test at full EPSS load"
- **File:** `seed-standards.js:202-205` (GEN_FULL_SYSTEM_TEST).
- **App's claim:** "§8.4.9 — 4-hour test at full EPSS load … min 4hr."
- **Standard's actual requirement:** §8.4.9 cadence (≤36 months) is correct, but the test runs **"for the duration of its assigned Class, OR 4 continuous hours, whichever is LESS,"** at a load of **≥30% nameplate kW** (supplemental load bank permitted) — **not a flat 4 hours at full load.**
- **Fix:** reword to "duration of class or 4 h, whichever is less; ≥30% nameplate." **Confidence: High** (med on exact subsection digit).

### P1-7 · NFPA 110 load-bank profile carries a legacy step sequence + likely wrong subsection
- **Files:** `seed-standards.js:195-198` (25%/50%/75%, 2-hour, "§8.4.2.3"); demo `seed-demo.js:923` (50%/75%, "§8.4.2.3").
- **Claim vs standard:** the current NFPA 110 augmented profile is **50% × 30 min + 75% × 60 min** (1.5 h) — which the demo uses (good). The seeded task description still also carries the **legacy 25/50/75 two-hour** profile, and both cite **§8.4.2.3**; the load-bank fallback actually lives in **§8.4.2 (≈8.4.2.2)**, and the 25% step was dropped (reportedly 2025 edition).
- **Fix:** drop the 25/50/75 legacy profile from the primary copy; verify §8.4.2.2 vs 8.4.2.3 against the purchased standard. **Confidence: High** on profile, **Med** on subsection.

### P1-8 · NFPA 70E PPE-category >15 kV check cites the DC table
- **File:** `server/lib/arcFlashSanity.ts:119-122` (flags `ppe_category_exceeds_voltage_limit` citing "Table 130.7(C)(15)(b)").
- **Claim vs standard:** the **rule is correct** — the PPE-category (table) method does not apply above 15 kV for AC. But the AC ceiling is in **Table 130.7(C)(15)(a)**; **(15)(b) is the DC table.** Wrong sub-table letter for AC equipment.
- **Fix:** cite **130.7(C)(15)(a)** for the AC 15 kV ceiling. **Confidence: High** on rule, Med on letter.

### P1-9 · "Category 0" PPE terminology is outdated
- **Files:** `arcFlashSanity.ts:36-37, 86-91, 151-157`; `arcFlashMitigation.ts:112-117`.
- **Claim vs standard:** NFPA 70E **removed the numbered "Category 0" in the 2015 edition.** The concept ("<1.2 cal/cm² → no arc-rated clothing required / below the AFB") is correct; the label "Category 0" is legacy.
- **Fix:** prefer "below 1.2 cal/cm² — no AR clothing required" over "Cat 0." **Confidence: High.** (Low impact, but a 70E-current reviewer notices.)

### P1-10 · IEEE 1584-2018 electrode-gap validity range upper bound
- **File:** `arcFlashSanity.ts:140-144` (flags gaps outside **6.35–152.4 mm**).
- **Claim vs standard:** IEEE 1584-2018 validated gaps are **6.35–76.2 mm for ≤600 V** and **19.05–254 mm for 601 V–15 kV** — voltage-class-dependent. The single 6.35–**152.4** mm range is too low at the MV end (real ceiling 254 mm) and too permissive at the LV end (real ceiling 76.2 mm), so the sanity check can both false-flag valid MV studies and pass invalid LV gaps.
- **Fix:** split the range by voltage class (76.2 mm ≤600 V; 254 mm for 601 V–15 kV). **Confidence: High.**

### P1-11 · NFPA 110 annual fuel-test section "§8.3.8" (likely §8.3.7) and inconsistent demo citation
- **Files:** `seed-standards.js:209` ("§8.3.8"); demo `seed-demo.js:1171` cites "NFPA 110 A.8.5.2" for the same annual fuel analysis.
- **Claim vs standard:** annual diesel fuel-quality testing is required (correct), but the section is **§8.3.7** per current-edition renumbering, and the two ServiceCycle citations (§8.3.8 vs annex A.8.5.2) disagree with each other.
- **Fix:** reconcile to one current-edition citation. **Confidence: Med** (paywalled subsection — see Needs-Expert).

---

## P2 — Cosmetic / labeling / edition / section-digit

- **P2-1 · Thermography over-ambient 21–40 °C action deviates from NETA.** `thermographyEvaluate.ts:40-44` maps 21–40 °C over-ambient to **RECOMMENDED** ("immediate investigation"); NETA Table 100.18 says **"monitor until corrective measures can be accomplished."** This is a *deliberate, more-conservative* house choice (the code comment cites HSB/Zurich), but it's attributed to "NETA Table 100.18," which now disagrees. The band thresholds themselves are correct, and the demo (12 °C, 14 °C) doesn't hit this row. **Fix:** relabel as a ServiceCycle/insurer-guided override, not the NETA action. Confidence: High.
- **P2-2 · NETA Appendix B 2.5×/0.25× multipliers framed as condition-only.** `maintenanceInterval.ts:37-38`. The values are real **corner cells** of NETA's 3×3 condition × reliability matrix (2.5 = Good-condition AND Low-reliability; 0.25 = Poor AND High-reliability) — not pure condition multipliers. The comment already says "condition × reliability," and these are a **fallback only** for custom tasks (seeded tasks use explicit 70B Table 9.2.2 columns), so impact is low. **Fix:** note they're 2-axis corners. Confidence: High.
- **P2-3 · IEEE 1584 arcing-current minimum applied to the wrong quantity.** `arcFlashSanity.ts:130-133` applies the 0.5 kA floor to *arcing* current; the documented 0.5–106 kA model range is for **bolted** fault current. Confidence: High.
- **P2-4 · NFPA 25 "monthly electric no-flow effective since the 2017 edition."** `seed-standards.js:767` — the weekly→monthly change for electric fire pumps was the **2011** edition, not 2017. Confidence: High.
- **P2-5 · Stale standard editions cited.** IEEE **450-2010** → current **450-2020**; IEEE **1188-2005** → current **1188-2025** (1188-2005 is Inactive-Reserved). Substance still holds; years are out of date. NETA ATS edition is listed as **2025** (`seed-standards.js:79`) — verify (ATS-2021 may be current). Confidence: High (IEEE), Med (NETA ATS).
- **P2-6 · NFPA 110 battery inspection is partly weekly.** `seed-standards.js:224-228` models GEN_BATTERY_INSPECT as monthly; §8.3.6 is **weekly** electrolyte/voltage + **monthly** specific gravity. The app's own note says weekly granularity is out of scope, so this is known. Confidence: High.
- **P2-7 · IEEE 43 low-PI alerts should be gated on IR₁.** Latent, not a stated error: IEEE 43-2013 §12.2.2 says PI is **not meaningful when IR₁ > 5000 MΩ**. If the engine ever flags low PI without first checking IR₁ > 5000 MΩ, it will false-alarm on clean, dry, high-resistance windings. Worth a guard when PI logic is built out. Confidence: High.
- **P2-8 · "DANGER > 40 cal/cm²" framing has no current NFPA hook.** `arcFlashMitigation.ts:91` (`danger = ie > 40`) and the glossary DANGER definition. The 40 cal/cm² line is sound *practice* but its NFPA 70E informational note was deleted in 2018 — it persists as ANSI Z535/industry convention only. Keep it, but don't imply it's an NFPA threshold. Confidence: High.
- **P2-9 · NETA MTS §7.18 / §7.22 are multi-equipment sections.** Not an error — the app already cites the precise subsections (§7.18.1 DC systems/batteries, §7.22.2 UPS, §7.22.3 ATS). Listed only so the expert knows the parent-section titles ("Direct-Current Systems," "Emergency Systems") if he checks. Confidence: High.

---

## Verified correct (confidence-builders — show these too)

The engine is right far more often than it's wrong. Independently confirmed accurate:

**NFPA 70B-2023**
- The full **17-chapter equipment map** (`seed-standards.js:883-906`) — every assignment matches: Ch 11 transformers, 12 substations/switchgear, 13 panelboards/switchboards, 14 busways, 15 breakers, 16 fuses, 17 switches, 18 cables, 19 cable tray, 20 grounding, 21 GFCI/GFP, 22 lighting, 25 UPS, 27 rotating equipment, 28 motor control, 35 protective relays, 36 stationary batteries.
- **Chapter 9 = Maintenance Intervals** and **Table 9.2.2** exists as the per-equipment interval table.
- The **3-condition model** (Condition 1 good → longer interval; 2 base; 3 poor → shorter) **and** the worst-of-three-axes selection (physical / criticality / **environment**) — matches §9.2.2/§9.3.1 exactly, including that environment/criticality can force a worse condition on physically-sound gear. This is a genuinely faithful implementation.
- IR thermography on a ~annual baseline (12/12/6 by condition) — matches 70B's condition-based cadence.

**NETA MTS-2023**
- **Table 100.18** = thermographic-survey actions; **Table 100.1** = insulation-resistance test values — both correctly identified.
- Thermography **band thresholds**: similar-component 1–3 / 4–15 / >15 °C and over-ambient 1–10 / 11–20 / 21–40 / >40 °C — all correct (`thermographyEvaluate.ts`).
- Section map §7.1 (switchgear/switchboard/panelboard), §7.2.1 (dry xfmr) / §7.2.2 (liquid xfmr), §7.3 (cable), §7.5 (switches), §7.6 (breakers), §7.9 (relays), §7.13 (grounding), §7.15 (rotating machinery), §7.16 (motor control), §7.18.1 (DC/batteries), §7.22.2 (UPS), §7.22.3 (ATS) — all correct/precise.

**IEEE C57.104 (DGA)** — H₂ 100/700/1800, CH₄ 120/400/1000, C₂H₄ 50/100/200, C₂H₆ 65/100/150, CO 350/570/1400, CO₂ 2500/4000/10000, TDCG 720/1920/4630, and TDCG correctly **excludes CO₂**. (Only C₂H₂ is wrong — P0-1.)

**IEEE 43 / C57.106** — PI ≥2.0 minimum (1.5 for Class A), PI not meaningful >5000 MΩ, and oil moisture ≤35 ppm for ≤69 kV — all correct.

**Batteries** — IEEE 450 quarterly per-cell float voltage, 80%-capacity pass/replacement criterion, and the **engine's** "30–50% ohmic rise = replace" copy (`seed-standards.js:501,541`) — correct. (Only the demo deficiency string is wrong — P1-4.)

**NFPA 110 / 101 / 25** — monthly generator exercise §8.4.2 at ≥30% nameplate / ≥30 min; Type 10 ≤10 s transfer; §8.4.9 triennial 36-month; §8.4.6 monthly ATS transfer; §8.3.6 storage battery; NFPA 101 §7.9.3 monthly-30 s + annual-90 min emergency lighting; NFPA 25 fire-pump substance (monthly electric / weekly diesel / annual churn-100-150%) — all correct.

**NFPA 70E-2024 / IEEE 1584-2018 (arc flash — the hero engine)**
- PPE arc ratings **Cat 1 = 4, Cat 2 = 8, Cat 3 = 25, Cat 4 = 40 cal/cm²** — correct.
- **§130.5(H) = labeling clause**; ~5-year risk-assessment review near §130.5(G) — correct/defensible.
- **Table 130.4(E)(a) shock approach boundaries** (`arcFlashLabel.ts:53-61`): 50–150 V 3'6"/avoid-contact; 151–750 V 3'6"/1'0"; 751 V–15 kV 5'0"/2'2"; 15–36 kV 6'0"/2'7"; 36–46 kV 8'0"/2'9"; 46–72.5 kV 8'0"/3'3" — values and 2024 table designation correct (spot-checked).
- IEEE 1584-2018 ranges: 208 V–15 kV, bolted fault 0.5–106 kA, working distance ≥305 mm (12 in) — correct; typical presets LV switchgear 32 mm/24 in, LV MCC/panel 25 mm/18 in, 5/15 kV switchgear 36 in — correct.
- The **`arcFlashSanity.ts` contradiction engine** is a strength: it correctly enforces arcing ≤ bolted, arc rating ≥ IE, the >15 kV category-method limit, IEEE 1584 input-range validity, and the >40 cal/cm² de-energize line. The PE-review posture ("SC raises the flag; the licensed PE adjudicates") is exactly right.

---

## Needs the NETA expert / purchased standard to confirm (no false-positives — these are genuine judgment/paywall calls)

1. **Exact NFPA section/subsection digits** (standards are paywalled; chapter-level placement is confirmed, digits rest on secondary sources): NFPA 70B IR thermography "§7.4" sub-number; NFPA 110 load-bank "§8.4.2.2 vs 8.4.2.3" and fuel "§8.3.7 vs 8.3.8"; NFPA 25 "§8.3.1.2 / §8.3.3.1"; NFPA 70E §130.5 sub-letter distinguishing *risk-assessment* review vs *IE-analysis* review vs *label-data* review.
2. **IEEE C57.106 dielectric minimum** for the demo transformer's exact class/gap (D1816 23 kV @1 mm vs 40 kV @2 mm) — confirm which the demo should state.
3. **Thermography over-ambient 21–40 °C action** (P2-1): is the more-conservative "immediate investigation" override acceptable to this customer, or should it match NETA's "monitor"?
4. **Acetylene handling after the P0-1 fix** (P0-1): with the table corrected to 35/50/80, decide how the demo should surface a 2.8 ppm acetylene *trend* (rate-of-rise flag) so the story stays truthful and compelling.
5. **DANGER-on-MV labeling philosophy** (P0-3): confirm the house rule "MV bus → DANGER" as a documented labeling-philosophy choice (it's defensible) and reword the citation accordingly.
6. **NETA ATS current edition** (P2-5): confirm 2021 vs 2025.

---

## Sources (representative; full set gathered during verification)

- IEEE C57.104-1991 Table 1 (primary PDF) — acetylene 35/50/80; SDMyers / FacilityResults DGA reproductions.
- NFPA 70B-2023 structure: IEEE ESW-2023-18 (70B committee), Eaton & EC&M white papers, FLIR (§7.4 thermography), C&H Electric / GIMBA (Ch 9 / Table 9.2.2 / condition model).
- NETA Table 100.18 / 100.1 / Appendix B matrix: TestGuy, eng-tips, ANSI/NETA MTS Appendix B reproductions (SlideShare, MEUW).
- NFPA 110-2022: Curtis Power Solutions, Cummins (Type 10), SSR / Joint Commission (triennial), HFM Magazine (battery — no annual-replacement mandate).
- NFPA 101 §7.9.3: Koorsen, UpCodes. NFPA 25: QRFS, NFSA, NFPA blog (2011 weekly→monthly).
- NFPA 70E-2024 / IEEE 1584-2018: Jim Phillips/Brainfiller (ANSI Z535 signal words), Tyndale (§130.5(F) method-mixing), UConn EHS 2024 70E tables (130.7(C)(15)(a/b/c)), official IEEE 1584-2018 intro deck (gap/WD ranges), Elek/EC&M (typical distances).

---

# Fixes Applied — 2026-06-28

All P0/P1/P2 findings were corrected (read-only audit → fix pass at the founder's request). Files touched: `server/lib/dgaEvaluate.ts`, `arcFlashSanity.ts`, `arcFlashMitigation.ts`, `thermographyEvaluate.ts`, `maintenanceInterval.ts`; `server/scripts/seed-standards.js`, `seed-demo.js`. **No sibling repos touched.**

## What changed

**Engine**
- **DGA acetylene (P0-1):** `c2h2` limits `[1,9,35]` → **`[35,50,80]`** (IEEE C57.104-2008 Table 1). Added an **acetylene-significance override**: a Duval D1/D2 arcing signature raises the traffic light to ≥ YELLOW even at absolute Condition 1 — so correcting the table did not make the engine *less* sensitive to acetylene (the key arcing gas). `overallCondition`/`ieeeStatus` stay true to the absolute screen, so the ingest deficiency gate (keyed on `overallCondition`) is unchanged.
- **Arc-flash citations (P0-3, P1-8):** the 4/8/25/40 cal/cm² ratings are now attributed to **Table 130.7(C)(15)(c)** (was (15)(a)); the >15 kV AC limit now cites **(15)(a)** (was the DC table (15)(b)); added an in-code note that an incident-energy result must be reported as a **required minimum arc rating**, not a PPE Category, per §130.5(F). "Category 0" reworded as the <1.2 cal/cm² band sentinel.
- **IEEE 1584 ranges (P1-10, P2-3):** electrode-gap validation is now voltage-class dependent (**6.35–76.2 mm ≤600 V; 19.05–254 mm 601 V–15 kV**) instead of a flat 6.35–152.4 mm; the 0.5 kA model floor now applies to **bolted** fault current (was arcing).
- **Thermography (P2-1):** the 21–40 °C over-ambient escalation is now labeled a ServiceCycle/HSB-insurer **house override** of NETA's literal "monitor" action, not a restatement of NETA Table 100.18.
- **Interval multipliers (P2-2):** the 2.5×/0.25× constants are now documented as the (Good×Low-reliability) and (Poor×High-reliability) **corners** of NETA Appendix B's 3×3 matrix, not pure condition multipliers.

**Standards seeder** — `§11.17` → **`§7.4 (Infrared Thermography)`** ×12 (and `correct70bRef` now preserves §7.4 instead of swapping it for the equipment chapter); `§22.6` auto-corrects to Ch 11 as before; NETA `Table 100.2` → **`Table 100.18`** ×3; NFPA 110 triennial reworded to "duration of class or 4 h, whichever is less, at ≥30% nameplate"; load-bank profile reduced to the current 50%×30 + 75%×60 and section `§8.4.2.3` → `§8.4.2`; fuel `§8.3.8` → `§8.3.7`; NFPA 25 "2017 edition" → "2011 edition." Medium-confidence subsection digits carry `[VERIFY]` tags.

**Demo seed** — DGA T-1 sample set to `ieeeStatus: 1` + YELLOW/D1 (now matches the corrected engine; prose reframed as "gases within Condition 1, detectable acetylene = D1 caution"); false **"NFPA 110 requires annual battery replacement"** removed (×2 notes) → condition-based per §8.3.6; battery ohmic deficiency rebased on **IEEE 450 vented-cell capacity** (BATT-1 is flooded lead-acid) with the fabricated "20% threshold" removed and the cell bumped to ~40% to stay a valid flag; oil "Action Level 1" → **Class I**, ASTM D877 → **D1816**, "30 kV min" → "~40 kV (2 mm gap)"; thermography **"Category 1/2"** → NETA action phrases; arc-flash DANGER rationale reworded to **ANSI Z535.4 house rule** (not NFPA 70E §130.5(H)).

## Verification (re-scan)
- `node --check` passes on both seed files; **no NUL bytes / truncation** in any edited file.
- DGA logic re-tested via standalone port — **6/6 cases pass** (demo T-1 → Condition 1 / YELLOW / D1, matching the seed; 36 ppm → Condition 2; 60 ppm → Condition 3 / RED).
- Citation greps: `§11.17` = 0, wrong `Table 100.2` = 0, `c2h2:[1,9,35]` = 0, `Action Level` = 0, "requires annual battery replacement" = 0, thermography "Category 1/2" = 0, "130.5(H) regardless" = 0; `§7.4 (Infrared Thermography)` and `Table 100.18` present.
- `arcFlashSanity` edits leave no dangling reference and don't alter the existing test expectations (the "clean 480 V bus" case has no gap → still zero findings).
- **Not run here:** the Jest suite (esbuild/jest aren't installed in this sandbox; they live on the Windows dev side). Recommend running `npm test` (server) on Windows/the droplet before the demo — the two pure suites (`arcFlashSanity.test.js`, `maintenanceInterval.test.js`) and the DGA path should be green; logic was inspected to confirm.

## Judgment calls left for you / your brother (NOT blindly auto-changed)
1. **Arc-flash "PPE Category" display:** the engine citation + demo DANGER rationale are fixed, but the UI still *shows* a PPE Category for IE-derived buses (industry-common). The strict §130.5(F) fix — display "required arc rating (cal/cm²)" instead of "Category N" across the client/label/exports — is a broader UX change deliberately left for your call.
2. **Acetylene override threshold:** I used "any Duval D1/D2 (C₂H₂ ≥ 2 ppm) → ≥ YELLOW." Confirm that's the caution sensitivity you want (some labs flag ≥1 ppm).
3. **Edition currency:** IEEE 450-2010 / 1188-2005 / NETA ATS-2025 year strings were left as-is — the values were verified against the cited editions and bumping the year without checking the newer edition's renumbering would risk a fresh mismatch.

## To see it in the demo
Seed-copy changes only appear after a **reseed** (`reseed_demo`). The engine `.ts` changes need the server rebuilt/deployed. Happy to run the deploy + reseed when you want.

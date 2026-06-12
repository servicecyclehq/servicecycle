# NETA / PowerDB Field Library for the Test-Report Parser

**Date:** 2026-06-12 (NFPA 70B:2023 layer added same day)
**Purpose:** Per-equipment-type vocabulary of every standard test MEASUREMENT (diagnostic) and NAMEPLATE/REFERENCE field found on real NETA/PowerDB/Megger field test reports, so the deterministic PDF parser can classify readings instead of dumping them in a generic bucket. **Enriched with the NFPA 70B:2023 mandate layer**: the "mandate" section below summarizes what 70B requires (EMP, condition-based intervals, documentation, enforcement), and each equipment section carries a "NFPA 70B linkage" note tying its fields to the 70B chapter/tasks that make them *required* (70B-REQ) vs nice-to-have. 70B sits ON TOP of NETA/IEEE: 70B = what & how often (shall); NETA/IEEE = how & pass/fail.

**Primary sources (read directly):** blank PowerDB form sets on disk — `TRANSFORMERS.pdf` (62 pp), `CIRCUIT BREAKER.pdf`, `RELAYS.pdf`, `CABLES.pdf`, `BATTERIES.pdf`, `SWITCHBOARDS.pdf`, `INSTRUMENT TRANSFORMERS.pdf`, `INSULATION FLUID.pdf`, `POWER FACTOR.pdf`, `MOTOR CONTROL.pdf`, `TRANSFER SWITCHES.pdf`, `GENERATORS.pdf`, `DISCONNECTS.pdf`, plus `smart-ground-sample-report.pdf` (Smart Ground Multimeter grounding study). Note: a file named `GROUND MAT (EARTH) GROUNDING.pdf` does **not** exist in the folder; grounding fields below come from the Smart Ground sample report + IEEE 81/80 + NETA MTS.

**Cross-references:**
- ANSI/NETA MTS (Maintenance Testing Specifications) & ATS — Tables 100.1 (insulation resistance), 100.5 (transformer IR), 100.12 (US standard oil limits) — https://www.netaworld.org/standards/ansi-neta-mts ; field summary of Table 100.1: https://testguy.net/content/270-Insulation-Resistance-Test-Values-Electrical-Apparatus-and-Systems
- IEEE C57.104-2019 (DGA limits) — https://standards.ieee.org/ieee/C57.104/5444/
- IEEE C57.106 (insulating-oil acceptance/maintenance limits) — https://standards.ieee.org/ieee/C57.106/7563/
- IEEE C57.152-2013 (diagnostic field tests, PI/DAR bands — printed verbatim on the PowerDB PI form)
- IEEE C57.12.00 (turns-ratio tolerance ±0.5 %)
- IEEE C37.09 / C37.010 (breaker timing), IEEE 400 / 400.2-2013 (VLF & tan-delta tables) — https://standards.ieee.org/ieee/400.2/5573/
- IEEE 43-2013 (rotating-machine IR/PI) — https://standards.ieee.org/ieee/43/5959/
- IEEE 450-2010 (VLA), IEEE 1188 (VRLA) battery maintenance — https://standards.ieee.org/ieee/450/4771/
- IEEE 81-2012 (ground impedance/soil resistivity) & IEEE 80 (step/touch) — https://standards.ieee.org/ieee/81/4761/
- Megger, *A Stitch in Time* (IR/PI/DAR interpretation) — https://us.megger.com/support/technical-library
- Doble power-factor practice (bushing/breaker PF & tank-loss index; ≤0.5 % rule of thumb, 2× nameplate PF = remove bushing)

**Conventions used below**
- `kind`: **D** = DIAGNOSTIC (pass/fail-able reading → deficiencies/trends), **R** = REFERENCE (nameplate, settings, test conditions → store, never deficiency).
- `bad`: `up` = higher is worse, `down` = lower is worse, `Δ` = deviation/change from baseline-nameplate-or-sister-phase is worse, `none`.
- `per_phase`: does the value repeat per phase / winding / pole / bushing / cell.
- Label synonyms are the literal strings seen on PowerDB/Doble/Megger forms (case-insensitive match; subscripts like H1-H3 appear both with and without hyphens).
- **70B-REQ** marker (added 2026-06-12): the field is the evidence record for a maintenance task that NFPA 70B:2023 makes *mandatory* for that equipment class (see the mandate section below). Unmarked diagnostic fields are NETA/IEEE best practice — valuable, but beyond the 70B minimum.

---

## NFPA 70B:2023 — the mandate (the layer on top of NETA/IEEE)

**Added 2026-06-12.** NFPA 70B sits ON TOP of everything below: 70B says *that* a task shall be done and *how often*; NETA MTS / IEEE say *how* to do it and what readings mean. The 2023 edition (issued January 2023) converted NFPA 70B from a Recommended Practice ("should") to a **Standard ("shall")** — its first edition as enforceable standard language. This is the regulatory tailwind ServiceCycle is built on.

### M.1 What 70B:2023 actually requires — the EMP (Chapter 4)

§4.2.1: *"The equipment owner shall implement and document an overall EMP (Electrical Maintenance Program) that directs activity appropriate to the safety and operational risks."* Per §§4.2.4.2 / 4.2.6 (element list per the IEEE ESW-2023-18 paper by Valdes & Cunningham, 70B committee members), the EMP shall include elements that:

1. Address the **condition of maintenance** (and label equipment with the date the condition of maintenance was established/documented).
2. Identify **who implements** the program (a named **EMP coordinator** shall be identified; maintenance staff shall be qualified/trained, with qualification documented).
3. **Identify electrical equipment and systems** to determine maintenance requirements and priorities (survey & analysis; retain acceptance/commissioning test reports as baselines).
4. Develop and **document maintenance procedures**.
5. Include a **plan for inspecting, servicing, and testing** (intervals per Ch. 9).
6. Identify a **documentation and records-retention policy**.
7. Identify a process to **prescribe, implement, and document corrective measures based on collected data** (i.e., act on findings — deficiencies cannot just be filed).
8. Incorporate **design for maintainability**; provide for **continuous improvement** and for **controlling, measuring, and monitoring the EMP**.
9. Use relevant **reports and feedback**: electrical safety incidents, equipment malfunctions, unintended operations/alarms, protective-device operations.

The EMP shall be **audited at intervals not exceeding 5 years**. Ch. 5 requires qualified persons and safe work practices (NFPA 70E); **Ch. 6 requires current single-line diagrams and system studies** (short-circuit, coordination, arc-flash) kept up to date; Ch. 7 defines fundamental tests (connection integrity: millivolt drop, thermography, torque; insulation); Ch. 8 defines field-test categories — **Cat 1 online / 1A online-enhanced / 2 offline / 2A offline-enhanced** — and per §8.7.1 every tested item gets a **condition-of-maintenance designation: (1) Serviceable, (2) Limited Service, (3) Nonserviceable**. Manufacturer instructions take precedence when available; industry consensus standards (NETA/IEEE — i.e., everything below in this doc) are the designated substitute when they are not. Deviations from 70B prescriptions are allowed **only if documented and supported by accepted industry practice** in the EMP.

### M.2 Condition-based interval model (Chapter 9) — and the ServiceCycle mapping

§9.2.2: *"Where the manufacturer's recommendations are not provided or available and failure, breakdown, or malfunction of the equipment will present an unacceptable risk for personnel or the environment, equipment maintenance shall be performed at not greater than the intervals specified in Table 9.2.2."*

**The equipment condition assessment (ECA) is 3-dimensional** (§9.3): **physical condition** (§9.3.1), **criticality** (§9.3.2), **operating environment** (§9.3.3), each rated Condition 1/2/3 — **the worst of the three governs** the interval column used. This maps 1:1 to ServiceCycle's `conditionPhysical / conditionCriticality / conditionEnvironment → worstCondition() → Asset.governingCondition`. Physical-condition criteria (§9.3.1, verbatim summary):

- **Condition 1**: like-new appearance; clean/tight/dry enclosure; no unaddressed monitoring notifications; no active predictive-technique recommendations; previous maintenance performed per the EMP.
- **Condition 2**: all C1 criteria met *plus any of*: results deviating from past results; last cycle required repair/replacement of major components; monitoring notifications since prior assessment; active predictive recommendations.
- **Condition 3**: changes in operation noted, *or any of*: **missed the last two successive maintenance cycles per the EMP**; last two cycles required major repair/replacement; active/unaddressed monitoring notification; urgent predictive actions. (Note: simply *not doing* maintenance twice automatically forces C3 — lapsed customers are by definition in the most expensive bucket.)

**70B does NOT use multipliers — Table 9.2.2 is a fixed interval table per product × task category.** The dominant pattern (most products, most task categories) is **C1 = 60 mo, C2 = 36 mo, C3 = 12 mo**, with significant exceptions:

| Product (Table 9.2.2) | Scope of work | C1 | C2 | C3 |
|---|---|---|---|---|
| **ALL equipment** | Infrared thermography | 12 | 12 | 6 |
| Power & distribution transformers | Visual inspection | 12 | 12 | 6 |
| Power & distribution transformers | Cleaning / mech servicing / electrical testing | 60 | 36 | 12 |
| Substations; Switchgear | Visual inspection | 12 | 12 | 6 |
| Substations; Switchgear | Cleaning / lube / mech / electrical / special | 60 | 36 | 12 |
| Panelboards & switchboards; Busways (cleaning→testing) | all categories | 60 | 36 | 12 (busway visual: 60/60/12) |
| MCCB / ICCB / LVPCB; MV power circuit breakers | all five categories | 60 | 36 | 12 |
| Switches; Fuses; Motor control equipment; Rotating equipment; Power cables; PV; Wind; Battery ESS; Stationary standby batteries; EV power transfer | all categories | 60 | 36 | 12 |
| Protective relays — **electromechanical** | all categories | **36** | **24** | **12** |
| Protective relays — solid-state / microprocessor | all categories | 60 | 36 | 12 |
| Grounding & bonding | Visual inspection | 12 | 12 | 6 |
| Grounding & bonding | Electrical testing | 60 | 36 | **36** |
| LV / MV ground-fault protection systems | Visual 12/12/6; others 60/36/12 | | | |
| Cable trays; GFCIs; HV substation insulators; Wiring devices | Visual inspection | 12 | 12 (wiring devices 3) | 6 (wiring devices 1) |
| HV substation insulators | Corona detection | 12 | 6 | 4 |
| **UPS** | Visual inspection | **6** | **3** | **1** |
| **UPS** | Cleaning / mech / electrical testing | **12** | **6** | **3** |
| **UPS** | Special procedures (functional tests) | 24 | 24 | 24 |
| Portable tools | Visual/cleaning before each use; electrical testing every 3 mo regardless of condition | | | |

(Full table reproduced with NFPA permission in the HVM/Vertiv chart — URL in sources.)

**ServiceCycle engine reconciliation** (`server/lib/maintenanceInterval.ts`):
- The current `C1_MULTIPLIER = 2.5` / `C3_MULTIPLIER = 0.25` constants are **NETA MTS Appendix B values, not 70B values**. NETA App. B is a 3×3 matrix (equipment condition good/average/poor × reliability requirement low/med/high) with multipliers 0.25 → 2.5; ×2.5 is the *good-condition + low-reliability* corner and ×0.25 the *poor-condition + high-reliability* corner. The code comment attributing them to "NFPA 70B / NETA App. B" should be corrected to NETA-only.
- Against 70B's dominant 60/36/12 row: with a C2 base of 36 mo, the derivation gives C1 = min(90,60) = **60 ✓** (the 60-mo ceiling rescues it) and C3 = round(36×0.25) = **9 mo vs 70B's 12** — compliant (more frequent than required) but mislabeled as "the 70B interval." The clean fix: **seed explicit `intervalC1/C2/C3Months` from Table 9.2.2 per equipment type** (the columns already exist and explicit values already win over derivation) and keep the multiplier derivation only as fallback for custom tasks. Watch the exceptions: UPS (12/6/3), electromechanical relays (36/24/12), grounding electrical testing (60/36/**36** — here ServiceCycle's C3 12-mo ceiling *over*-requires by 3×), and the 12/12/6 visual-inspection rows.
- §9.1.2: once set, a frequency shall be held **two maintenance cycles** before being modified on new information (unless failures occur); two-plus clean inspections justify extending. Interval *extensions* beyond Table 9.2.2 must be justified and documented in the EMP. (Product hook: ServiceCycle should require a documented justification note whenever a user stretches an interval past the 70B ceiling, and auto-suggest stretching only after 2 clean cycles.)

### M.3 Documentation / audit requirements (what must be on record)

70B's record set, scattered through Ch. 4/6/8/9 — exactly the ServiceCycle EMP-document + audit-snapshot surface:
1. The **written EMP itself** incl. procedures, records-retention policy, and justifications for any deviation/extension (§4.2.1, §4.2.4.2, Ch. 9).
2. **Equipment inventory** with maintenance requirements & priorities (survey/analysis, §4.2).
3. **Test records** per Ch. 8: equipment ID, date, personnel, test equipment used, results — i.e., the §0 common header block below is precisely the 70B-required record header.
4. **Condition assessments**: the 3-axis ECA per asset (Ch. 9) and the per-test condition-of-maintenance designation (Serviceable / Limited Service / Nonserviceable, §8.7.1), plus **labels on equipment** stating the condition-of-maintenance date.
5. **Corrective actions** traced from findings to closure (§4.2.4.2(7)) — deficiency → work order → as-left.
6. **Single-line diagrams & studies** current (Ch. 6); acceptance/commissioning baselines retained (Ch. 4).
7. **EMP audit** every ≤5 years; personnel qualification records.

### M.4 Enforcement — why it bites post-2023

- **Should → shall**: as a Standard, 70B is now written in enforceable language; the technical committee explicitly noted that "recommendations can be easily side-stepped but mandatory requirements may be enforced by various AHJs" (ESW-2023-18).
- **OSHA**: 70B is not itself federal law, but OSHA cites under the **General Duty Clause** (§5(a)(1)) and 29 CFR 1910 Subpart S using national consensus standards as the measure of a "recognized hazard" — post-incident, an absent EMP/maintenance record is now measurable noncompliance with the recognized standard (Ogletree/NatLawReview legal analyses).
- **NFPA 70E linkage**: 70E requires equipment to be **properly maintained to be considered in "normal operating condition"** — unmaintained gear must be treated as exposed energized parts, which inflates required arc-flash controls/PPE; 70B is the document that defines "properly maintained." Arc-flash incident-energy calculations also *assume* protective devices operate per their TCC — which only maintenance verifies.
- **Insurers**: carriers sit on the 70B technical committee and audit against it; explainers report insurers making 70B-style EMPs a condition of coverage / premium pricing (Serve Electric, CBS, IEC).
- **AHJs / contracts**: enforceable wherever an AHJ, owner spec, or client contract adopts it.

### M.5 70B chapter → field-library section map

| 70B:2023 chapter | Field-library section(s) below |
|---|---|
| Ch. 11 Power & Distribution Transformers | §1 TRANSFORMER_LIQUID, §2 TRANSFORMER_DRY |
| Ch. 12 Substations & Switchgear | §3 SWITCHGEAR (+ §15 surge arresters as substation components) |
| Ch. 13 Panelboards & Switchboards; Ch. 14 Busways | §3 PANELBOARD / BUSWAY subsets |
| Ch. 15 Circuit Breakers LV & MV | §4 / §4b CIRCUIT_BREAKER |
| Ch. 16 Fuses; Ch. 17 Switches | §13 DISCONNECT_SWITCH / FUSE_GEAR (Ch. 17 also nearest home for ATS power sections) |
| Ch. 18 Power Cables & Conductors | §6 / §6b CABLE |
| Ch. 20 Grounding & Bonding | §8 GROUNDING_SYSTEM |
| Ch. 21 GFCI / GFPE systems | §5 GROUND_FAULT_PROTECTION block |
| Ch. 25 UPS; Ch. 36 Stationary Standby Batteries; Ch. 32 Battery ESS | §7 UPS_BATTERY / BATTERY_SYSTEM |
| Ch. 27 Rotating Equipment | §9 GENERATOR / MOTOR |
| Ch. 28 Motor Control Equipment | §10 MCC (and nearest home for §11 VFD) |
| Ch. 35 Protective Relays | §5 PROTECTION_RELAY |
| Ch. 37 Instrument Transformers — **(Reserved)**; Ch. 38 CPTs — **(Reserved)**; Ch. 26 Electronic Equipment — **(Reserved)** | §14 INSTRUMENT_TRANSFORMER, §11 VFD: **no 70B task tables yet — NETA/IEEE only** |
| (no 70B chapter) | §12 TRANSFER_SWITCH → NFPA 110 governs emergency ATS testing |

### M.6 Sources

- NFPA 70B:2023 product/summary page — https://www.nfpa.org/product/access-nfpa-70b-electrical-equipment-maintenance-practices/p0070bcode
- Valdes (ABB/IEEE Fellow) & Cunningham (70B committee), *The New NFPA 70B-2023 Standard for Electrical Maintenance*, IEEE ESW-2023-18 — primary public source for Ch. 4 EMP elements, Ch. 8 test categories, Ch. 15 task tables — https://electricalsafetyworkshop.org/wp-content/uploads/sites/255/ESW-2023-18.pdf
- HVM/Vertiv, *NFPA 70B: Equipment Condition Assessment* — **Table 9.2.2 + §9.3.1 condition criteria reproduced with NFPA permission** — https://www.hvmcorp.com/4a8bf8/globalassets/documents/hvm-website-documents/hvm-nfpa-maintenance-chart-en-na-gr-00027-web.pdf
- Eaton white paper WP027024EN, *Understanding 2023 NFPA 70B* — https://www.eaton.com/content/dam/eaton/services/eess/eess-documents/eaton-nfpa-70b-white-paper-wp027024Xen.pdf
- TestGuy, *NFPA 70B: Understanding Equipment Condition Assessment* (3-axis ECA, worst-governs) — https://wiki.testguy.net/t/nfpa-70b-understanding-equipment-condition-assessment/4354
- e-hazard, *The Critical Role of Equipment Condition Assessments in NFPA 70B* — https://e-hazard.com/critical-role-equipment-condition-assessments-nfpa-70b-drive-maintenance-intervals/
- CBS Field Services, *What Preventative Maintenance Is Mandated in NFPA 70B 2023?* (EMP 9 elements, 5-yr audit, coordinator, labels) — https://cbsfieldservices.com/what-preventative-maintenance-is-mandated-in-nfpa-70b-2023/
- Ogletree Deakins legal analysis (OSHA General Duty Clause angle) — https://ogletree.com/insights-resources/blog-posts/nfpa-electrical-equipment-maintenance-standard-from-recommended-practice-to-potential-industry-standard/
- Serve Electric, *Stay OSHA Compliant, Avoid Loss of Insurance Coverage* — https://serveelectric.com/education/stay-osha-compliant-avoid-loss-of-insurance-coverage-understanding-the-new-nfpa-70b-2023-updates/
- SD Myers, *NFPA 70B and Your Electrical Maintenance Program* (transformer/fluid-testing reading of Ch. 11) — https://www.sdmyers.com/nfpa-70b/
- ANSI/NETA MTS Appendix B, *Frequency of Maintenance Tests* (the 0.25–2.5 multiplier matrix ServiceCycle's constants actually come from) — https://www.meuw.org/Files/JT%26S%20Schedules%20and%20Sites/ANSI-NETA_Frequency_of_Maintenance_Tests_2011.pdf
- NETA World Journal, *NFPA 70B: Developing a Standard for Electrical Equipment Maintenance* — https://netaworldjournal.org/nfpa-70b-developing-a-standard-for-electrical-equipment-maintenance/
- Gimba, *NFPA 70B EMP Explained* / *Is NFPA 70B mandatory?* — https://gimba.io/nfpa-70b-electrical-maintenance-program-emp-explained/ ; https://gimba.io/2025/02/03/is-nfpa-70b-the-law-is-nfpa-70b-mandatory/

---

## 0. Common header / test-condition fields (ALL equipment types — every PowerDB form)

All REFERENCE. Parse once per page/form.

| canonical_key | labels / synonyms | unit | kind | per_phase |
|---|---|---|---|---|
| owner | OWNER | – | R | no |
| plant | PLANT | – | R | no |
| substation | SUBSTATION | – | R | no |
| position | POSITION / EQPT. LOCATION | – | R | no |
| asset_id | ASSET ID / EQUIPMENT ID / IDENTIFICATION / DESIGNATION | – | R | no |
| job_number | JOB # | – | R | no |
| test_date | DATE / TEST DATE / SAMPLE DATE | date | R | no |
| ambient_temp | AMBIENT TEMP. / AMBIENT TEMPERATURE | °F (°C) | R | no |
| humidity | HUMIDITY | % | R | no |
| weather | WEATHER / WEATHER CONDITIONS | – | R | no |
| equipment_temp | EQUIPMENT TEMPERATURE / EQPT. TEMP / OIL TEMP / TANK TEMP / WINDING TEMP / CORE/COIL TEMPERATURE / CABLE TEMPERATURE | °C | R | no |
| temp_correction_factor | TEMPERATURE CORRECTION FACTOR TO 20°C / TCF / CORR FACTOR / MULTIPLIER K1, K2 | – | R | no |
| test_voltage | TEST VOLTAGE / TEST kV / TEST kVDC / MEGGER TEST VOLTAGE / @ kVDC / TEST V | kV, kVDC, V | R | sometimes |
| test_frequency | TEST FREQUENCY / FREQ | Hz | R | no |
| tested_by | TESTED BY / SAMPLED BY / OPERATOR | – | R | no |
| test_equipment | TEST EQUIPMENT USED / INSTRUMENT S/N / SERIAL NUMBER + CALIBRATION DATE | – | R | no |
| manufacturer | MANUFACTURER / MFR / MFG | – | R | no |
| serial_number | SERIAL NO. / SER NO / S/N / SN | – | R | no |
| model | MODEL / MODEL NO. / TYPE / CATALOG NO. / CAT # / STYLE | – | R | no |
| year_manufactured | YEAR / YR MFR / MFR YEAR / DATE MANUFACTURED / AGE | yr | R | no |
| comments | COMMENTS / REMARKS / NOTES | – | R | no |
| deficiencies | DEFICIENCIES | – | R(flag) | no |

> Parser hint: a non-empty **DEFICIENCIES** line is itself the strongest deficiency signal on any PowerDB form. **AS FOUND / AS LEFT** column pairs appear on breakers, relays, reclosers, ATS, MCCBs: store both; deficiency logic should evaluate AS FOUND, and AS LEFT documents the fix.

> **NFPA 70B linkage [70B-REQ as a block]:** this header block is precisely the 70B Ch. 8 test-record minimum (equipment ID, date, tested-by, test equipment used + results) and Ch. 4's records-retention subject matter — capturing it is itself a compliance feature, not nicety. A non-empty DEFICIENCIES line triggers 70B §4.2.4.2(7): corrective measures must be prescribed, implemented, and *documented* (deficiency → work order → as-left is the required loop). Per §8.7.1 every tested item should also carry a condition-of-maintenance designation — **Serviceable / Limited Service / Nonserviceable** — worth adding as a parser-level canonical field (`condition_of_maintenance`, D, cat: Limited Service/Nonserviceable = deficiency). Also note Table 9.2.2's first row: **infrared thermography is 70B-required on ALL equipment at 12/12/6 mo (C1/C2/C3)** — a default schedule on every asset class below.

---

## 1. TRANSFORMER_LIQUID (highest priority)

> **NFPA 70B linkage — Ch. 11 (Power & Distribution Transformers).** Table 9.2.2: visual inspection **12/12/6 mo**, cleaning & mechanical servicing 60/36/12, **electrical testing 60/36/12** (+ IR thermography 12/12/6 like all equipment). 70B mandates the electrical-testing *task* and defers the *method* to manufacturer instructions / industry standards — i.e., the NETA MTS / IEEE C57.152 tests below are how the Ch. 11 task gets discharged, and these fields are its evidence record.
> **70B-REQ fields:** `insulation_resistance`, `polarization_index`/`dielectric_absorption_ratio`, `turns_ratio`(+error), `winding_resistance`, `power_factor` (the core Ch. 11 electrical-testing battery), `liquid_level`/gauge fields (visual inspection), plus the §1.3 **oil screen + DGA suite** — insulating-liquid analysis is part of Ch. 11 testing for liquid-filled units (SD Myers reads 70B as requiring periodic fluid testing incl. DGA; it is also the canonical "predictive technique" whose active recommendations drive the §9.3.1 condition rating to C2/C3).
> **Nice-to-have beyond the 70B minimum:** excitation current, leakage reactance, magnetic balance, hot-collar, tank-loss index, SFRA-class diagnostics, furans (deep-dive/Doble tier — justify in EMP as enhanced "Category 2A" testing).
| canonical_key | labels / synonyms | unit | kind | per_phase |
|---|---|---|---|---|
| kva_rating | kVA / KVA / CAPACITY / kVA RATED (often "1500/2000" multi-stage) | kVA | R | no |
| primary_voltage | PRIMARY / VOLTAGE (kV) / HIGH SIDE kV / PRI. kV / HIGH VOLTAGE | kV | R | no |
| secondary_voltage | SECOND: / SECONDARY kV / LOW SIDE kV / LOW VOLTAGE | kV | R | no |
| tertiary_voltage | TERTIARY | kV | R | no |
| impedance_pct | IMPEDANCE / %Z / % IMP | % | R | no |
| bil_rating | BIL / B.I.L. RATING / BASIC IMPULSE LEVEL | kV | R | no |
| phases | PHASES / PHASE | – | R | no |
| winding_material | WINDING MATERIAL (Cu/Al/COPPER/ALUMINUM) | – | R | no |
| coolant_type | COOLANT / INSULATING MEDIUM / MEDIUM TYPE / LIQUID TYPE / FLUID TYPE (OIL, SILICONE, ASKAREL…) | – | R | no |
| oil_volume | OIL VOLUME / GALLONS OF OIL / LIQUID CAPACITY / FLUID VOLUME | gal | R | no |
| tank_type | TANK TYPE (SEALED / FREE BREATHING / CONSERVATOR / GAS BLANKETED) / BREATHING / PRESERVATION | – | R | no |
| weight | WEIGHT / TOTAL WEIGHT | lb | R | no |
| temperature_rise | TEMPERATURE RISE | °C | R | no |
| k_factor | K FACTOR | – | R | no |
| cooling_class | CLASS (OA/FA/FOA/ONAN/ONAF…) / COOLING | – | R | no |
| vector_group | DIAGRAM # (ANSI) / Dd0 / YNyn0 / WINDING POLARITY / PRI. VECTOR / SEC. VECTOR | – | R | no |
| tap_changer_type | CHANGER (DETC / LTC / Off Load / On Load) / TAP CHANGER INTERNAL-EXTERNAL / NLTC / ULTC / TCUL | – | R | no |
| tap_setting | TAP SETTING / TAP POSITION / TAP POSITION LEFT / # TAPS / NOMINAL / TAP VOLTAGES / TAP CONNECTIONS | – | R | no |
| rated_current | RATED I / RATED CURRENT / AMPS | A | R | no |
| bushing_nameplate | BUSHING NAMEPLATE (DSG, SERIAL NUM, MFR., TYPE/CLASS, kV, AMPS, YEAR, CAT. #, nameplate PF, nameplate Cap pF) | – | R | per bushing |
| counter_reading | COUNTER READING / LCR COUNTER (LTC) BEFORE/AFTER | count | R | no |
| oil_temp_at_test | OIL TEMP / TOP OIL TEMP / TEMPERATURE GAUGE / WINDING TEMPERATURE gauge / MAX TEMP INDICATOR | °C | R | no |
| pressure_vacuum | PRESSURE/VACUUM GUAGE READING / PRESSURE | psi/# | R | no |
| liquid_level | LIQUID LEVEL / COOLANT LEVEL / MEDIUM LEVEL / OIL LEVEL | – | R(flag) | no |

### 1.2 Diagnostic — electrical
| canonical_key | labels / synonyms | unit | bad | threshold | per_phase |
|---|---|---|---|---|---|
| insulation_resistance | INSULATION RESISTANCE / IR / MEGGER / RESISTANCE (megohms) / READING (megohms); rows: HIGH TO LOW+GND, LOW TO HIGH+GND, HIGH+LOW TO GND, PRIMARY TO GROUND, PRIMARY TO SECONDARY, SECONDARY TO GROUND; timed rows 0.25…10.00 MINUTES; CORR. VALUE @20°C | MΩ (megohms, MEG, GΩ) | down | NETA MTS Tab. 100.5 (e.g. ≥1 MΩ/kV rule-of-thumb; 600 V:100 MΩ, 5 kV:1,000 MΩ, ≥15 kV:5,000 MΩ corrected to 20 °C); trend vs prior | per winding pair |
| polarization_index | POLARIZATION INDEX / P.I. / PI / 10 min/1 min | ratio | down | ≥2.0 good, 1.25–2.0 fair, <1.0 dangerous (IEEE C57.152, printed on form); PI≈1 acceptable for new low-conductivity oil | per winding pair |
| dielectric_absorption_ratio | D.A.R. / DAR / DIELECTRIC ABSORPTION 60/30 SEC (or 1 min/0.5 min) | ratio | down | >1.6 excellent, 1.4–1.6 good, 1.0–1.25 questionable (Megger *A Stitch in Time*) | per winding pair |
| turns_ratio | TTR / ACTUAL TTR / ACTUAL RATIO / MEASURED RATIO / TURNS RATIO / CALC RATIO vs MEASURED | ratio | Δ | within ±0.5 % of calculated nameplate ratio (IEEE C57.12.00; NETA); form default ALLOWED ERROR 0.05–1 % | per phase, per tap |
| turns_ratio_error | % ERROR / % error / PERCENT ERROR / % DEVIATION | % | up | ≤0.5 % | per phase, per tap |
| excitation_current | I exc / EXCITATION CURRENT / EXCITING CURRENT / MILLIAMPERES (excitation test) / Iexc mA | mA | Δ | no absolute limit — compare phases (two-high-one-low or two-low-one-high pattern normal for delta); trend vs prior @ same test kV | per phase, per tap |
| ttr_phase_deviation | PHASE (Deg) / PHASE ANGLE (deg) / PHASE DEVIATION (degrees) | deg | up | near 0; investigate > a few tenths of a degree | per phase |
| winding_resistance | WINDING RESISTANCE / MEASURED RESISTANCE / H1-H3, H2-H1, H3-H2, X1-X3, R1, R2 / RESISTANCE IN OHMS-MILLIOHMS / CALCULATED RESISTANCE CORRECTED TO 85°C | Ω, mΩ, µΩ | Δ | phase-to-phase agreement within ~1–2 % (form default Max Wdg Diff 1 %); compare to factory ±5 % (IEEE C57.152); correct to 85 °C | per phase, per tap |
| winding_resistance_deviation | Winding Difference % / % Variance / READING STABILITY % | % | up | ≤1–2 % between phases; investigate >3 % | no |
| power_factor | POWER FACTOR % / % POWER FACTOR / %PF / DISSIPATION FACTOR / TAN DELTA / MEASURED, @20°C, CORR.; rows CHL, CHG (CH), CLG (CL), CHT, CLT, CTG | % | up | ≤0.5 % @20 °C new/good oil-filled (Doble/NETA); 0.5–1.0 % investigate; >1.0 % bad. Dry-type & compound-filled higher (1–5 % typical) | per insulation system (CHL/CHG/CLG) |
| capacitance | CAPACITANCE C (pF) / CAP. (pF) / Cap (pF) | pF | Δ | within ±5 % of nameplate/baseline; >10 % change = winding movement (Doble) | per insulation system |
| pf_test_current | mA (DIRECT) / MILLIAMPS / MEAS. mA | mA | Δ | companion to PF; trend | per test |
| pf_watts_loss | WATTS / mW / MILLIWATTS / W LOSS | W | up | trend; basis of tank-loss index | per test |
| bushing_c1_power_factor | Bushing C1 / C1 POWER FACTOR % / UST-R bushing test PF | % | up | compare to nameplate PF; investigate >2× nameplate, remove >3× (Doble); typical ≤0.5 % | per bushing |
| bushing_c1_capacitance | C1 CAPACITANCE / Cap. (pF) | pF | Δ | within ±5 % of nameplate (one shorted grading layer ≈ +3–5 %) | per bushing |
| bushing_c2_power_factor | Bushing C2 / C2 POWER FACTOR % / GSTg-R bushing test | % | up | ≤ ~1 %; trend | per bushing |
| bushing_c2_capacitance | C2 CAPACITANCE | pF | Δ | vs nameplate/baseline | per bushing |
| hot_collar_watts | HOT COLLAR TESTS / DIRECT Watts | W | up | ≤0.1 W loss typical (Doble); compare identical bushings | per bushing |
| hot_collar_ma | HOT COLLAR mA | mA | Δ | compare identical bushings | per bushing |
| leakage_reactance_pct | LEAKAGE REACTANCE / % Reactance / % Impedance / Delta % Impedance / Delta % Reactance | % | Δ | within ±3 % of nameplate %Z (±2 % three-phase equiv.) per IEEE C57.152 | per phase |
| magnetic_balance_pct | MAGNETIC BALANCE / Measured Percentage (%) H1-H0/H2-H0/H3-H0 | % | Δ | center-leg ≈ 50–90/10–50 split pattern; gross asymmetry = core fault | per phase |
| core_insulation_resistance | CORE GROUND / CORE TO GROUND IR | MΩ | down | ≥ tens of MΩ @500 V (utility practice) | no |
| hipot_leakage_current | HIGH POTENTIAL TEST / MICRO/MILLIAMPERES / LEAKAGE CURRENT (AMPERES AC) / µA mA at 0.25–1.00 min | µA, mA | up | no breakdown; current stable/decreasing; evaluate vs similar (NETA cautions DC hipot on xfmrs) | per winding |
| surge_arrester_watts | SURGE ARRESTERS Tests / DIRECT mA, Watts (GST-GND) | W / mA | up | compare to Doble published values for arrester family; gross increase = contamination | per unit |
| insulation_rating_code | IR rating col: G/D/I/B/Q (GOOD, DETERIORATED, INVESTIGATE, BAD, QUESTIONABLE) | code | up(categorical) | D/I/B/Q = deficiency flag | per test row |

### 1.3 Diagnostic — oil quality & DGA (forms: LIQUID COOLANT ANALYSIS / TRENDING, SD Myers, Weidmann)
| canonical_key | labels / synonyms | unit | bad | threshold (service-aged ≤69 kV; IEEE C57.106 / NETA 100.12 / form limits) | per_phase |
|---|---|---|---|---|---|
| dielectric_breakdown | DIELECTRIC STRENGTH / DIEL 877 / DIELECTRIC BREAKDOWN (kV) / BREAKDOWN VOLTAGE / D-877, D-1816 1mm, D-1816 2mm | kV | down | D877 ≥30 kV new / ≥26 kV service; D1816(1 mm) ≥23 kV (form limit “>47” applies to D1816 2 mm new) | no (avg of 5–6 shots) |
| interfacial_tension | INTERFACIAL TENSION / IFT / D-971 | dyn/cm (D/CM, mN/m) | down | ≥38 new; ≥25 service; <22 sludge likely (form limit >30) | no |
| acid_number | ACIDITY / ACID NUMBER / NEUTRALIZATION NUMBER / D-974 | mg KOH/g (MG KOH/G) | up | ≤0.03 new; ≤0.20 service; form limit <0.15 | no |
| water_content | WATER CONTENT / MOISTURE / K.F. TEST / MOISTURE IN OIL / D-1533 | ppm | up | ≤35 ppm ≤69 kV (≤25 @ >69 kV; form limit <20–35) | no |
| moisture_saturation | PCT. SATURATION / WATER SATURATION % | % | up | <5 % dry; >8 % wet insulation | no |
| oil_power_factor_25c | POWER FACTOR / PF at 25 C / D-924 25°C | % | up | ≤0.05–0.1 % new; ≤0.5 % service; >1.0 % investigate/reclaim | no |
| oil_power_factor_100c | POWER FACTOR-100C / PF 100 C | % | up | ≤0.3 % new; ≤5 % service | no |
| oil_color | ASTM COLOR NO. / COLOR NUMBER / D-1500 | ASTM # | up | ≤3.5 service (form <3); sudden change = investigate | no |
| specific_gravity_oil | SPECIFIC GRAVITY / D-287 / D-1298 | – | none | ~0.84–0.91 (reference; flag big change) | no |
| visual_exam | VISUAL EXAM / SEDIMENT / PARTICLES / D-1524 | text | up(cat) | clear & sediment-free | no |
| inhibitor_content | INHIBITOR CONTENT / OXIDATION INHIBITOR / DBPC wt% | wt % | down | maintain ≥0.09 %, target 0.3 % | no |
| pcb_content | PCB CONTENT / PARTS PER MILLION PCB / D-4059 / Aroclor 1242/1254/1260 | ppm | up | <50 ppm non-PCB; 50–499 PCB-contaminated (EPA class — regulatory not condition) | no |
| dga_hydrogen | HYDROGEN (H2) | ppm | up | <100 (C57.104 cond.1 / form limit) | no |
| dga_methane | METHANE (CH4) | ppm | up | <120 | no |
| dga_ethane | ETHANE (C2H6) | ppm | up | <65 | no |
| dga_ethylene | ETHYLENE (C2H4) | ppm | up | <50 | no |
| dga_acetylene | ACETYLENE (C2H2) | ppm | up | <1–2 (2019 ed.); legacy/form limit <35; ANY measurable C2H2 deserves attention | no |
| dga_carbon_monoxide | CARBON MONOXIDE (CO) | ppm | up | <350 | no |
| dga_carbon_dioxide | CARBON DIOXIDE (CO2) | ppm | up | <2500 | no |
| dga_oxygen | OXYGEN (O2) | ppm | none | reference (O2/N2 ratio used) | no |
| dga_nitrogen | NITROGEN (N2) | ppm | none | reference | no |
| dga_tdcg | TOTAL COMBUSTIBLE GAS / TDCG / TOTAL DISSOLVED COMBUSTIBLE GAS | ppm | up | <720 cond.1; 721–1920 cond.2 (C57.104-1991, printed on forms) | no |
| dga_tdcg_rate | TDCG Rate | ppm/day | up | <10 ppm/day cond.1 | no |
| dga_total_gas | TOTAL GAS | ppm or % | none | reference | no |
| dga_co2_co_ratio | CO2/CO | ratio | Δ | <3 suggests paper involvement; normal ~7 | no |
| dga_gas_ratios | CH4/H2, C2H2/C2H4, C2H4/C2H6, C2H2/CH4, C2H6/C2H2 (Rogers/Doernenburg/Duval inputs) | ratio | none→code | diagnostic codes (Key Gas / Rogers / Doernenburg / Duval) | no |
| furan_2fal | 2FAL / FURAN ANALYSIS (5H2F, 2FOL, 2FAL, 2ACF, 5M2F, TOTAL) | ppb | up | >250 ppb investigate; >2500 ppb ≈ end-of-life paper (DP≈200) | no |
| dga_condition_code | IEEE Std C57.104 Condition / WDS DGA CONDITION CODE / ANALYSIS OF TEST RESULTS (EXCELLENT…FAILED) / SERVICE (NO SERVICE REQUIRED…IMMEDIATELY) | code 1–4 | up(cat) | condition ≥2 or "SERVICE REQUIRED/IMMEDIATELY" = deficiency | no |

---

## 2. TRANSFORMER_DRY

Same header/nameplate block as liquid minus oil fields; adds `insulation_class`, `temperature_rise` (80/115/150 °C), enclosure type. PowerDB "TRANSFORMER MAINTENANCE TEST" form is the canonical dry/low-kVA form.

> **NFPA 70B linkage — Ch. 11 (same chapter as liquid; includes small dry-types).** Same Table 9.2.2 row: visual 12/12/6, electrical testing 60/36/12. The ESW paper notes many facilities run small dry-types to failure — 70B permits run-to-failure **only** where failure poses no personnel hazard, and that decision must be documented in the EMP (product hook: an explicit "run-to-failure, documented" asset state beats silent non-compliance). **70B-REQ:** `insulation_resistance`, `turns_ratio`, `winding_resistance`, `visual_inspection`, `fan_operation` (mechanical servicing). Nice-to-have: PI on small units, `ac_overpotential_result` (NETA itself marks AC hipot optional).

| canonical_key | labels / synonyms | unit | kind | bad | threshold | per_phase |
|---|---|---|---|---|---|---|
| insulation_resistance | INSULATION RESISTANCE IN MEGOHMS — PRIMARY TO GROUND / SECONDARY TO GROUND / PRIMARY TO SECONDARY; 0.5/1/10 min rows | MΩ | D | down | NETA 100.5 dry: 600 V:500 MΩ*, 5 kV:5,000 MΩ (* MTS values; ATS slightly different); correct to 20 °C | per winding pair |
| polarization_index | P.I. (10 min/1 min) | ratio | D | down | ≥2.0 Class B/F (IEEE C57.152 caution for new) | per winding pair |
| dielectric_absorption | DIELECTRIC ABSORPTION (1 min/0.5 min) | ratio | D | down | ≥1.4 | per winding pair |
| turns_ratio / turns_ratio_error | TRANSFORMER TURN RATIO TEST / TAP, CALC, PHASE A/B/C / % DEVIATION | ratio, % | D | Δ/up | ±0.5 % of calculated | per phase per tap |
| winding_resistance | WINDING RESISTANCE TEST IN OHMS H1-H2…X0-X1 | Ω | D | Δ | phases within 1–3 %; vs factory | per phase |
| power_factor | %PF (dry insulation) | % | D | up | no firm limit — trend; typically 1–5 % | per system |
| ac_overpotential_result | AC OVERPOTENTIAL TEST / RESULTS PASS-FAIL / LEAKAGE CURRENT (AMPERES AC) | pass/fail, A | D | up | withstand 1 min, no breakdown (NETA caution: AC hipot optional) | per winding |
| excitation_current | EXCITATION CURRENT | mA | D | Δ | phase pattern comparison | per phase |
| working_tap | WORKING TAP / AF / AL (as-found / as-left tap) | tap # | R | none | – | no |
| fan_operation | VERIFY FANS OPERATE / FAN SET TO °C | pass/fail | D | cat | PASS expected | no |
| visual_inspection | INSPECT PHYSICAL AND MECHANICAL CONDITION / ANCHORAGE, ALIGNMENT AND GROUNDING (PASS/FAIL) | pass/fail | D | cat | PASS | no |

---

## 3. SWITCHGEAR / SWITCHBOARD (forms: MV/LV SWITCHBOARD INSULATION, HIGH POTENTIAL, BUS CONNECTION, SWITCHGEAR INSPECTION)

> **NFPA 70B linkage — Ch. 12 (Substations & Switchgear), Ch. 13 (Panelboards & Switchboards), Ch. 14 (Busways).** Table 9.2.2: switchgear & substations **visual inspection 12/12/6 mo** (the tightest non-UPS visual row — switchgear must be looked at annually even in Condition 1); cleaning/lube/mechanical/electrical testing/special 60/36/12. Panelboards & switchboards: all categories 60/36/12. Busways: visual 60/60/12, rest 60/36/12. **70B-REQ fields:** `inspection_condition` (the visual-inspection record), `bus_insulation_resistance` (electrical testing), `bus_joint_resistance` / connection integrity (Ch. 7 fundamental tests: millivolt drop, thermography, torque), `gfp_function`. Nice-to-have: `bus_hipot_leakage` / `overpotential_result` (enhanced offline tier — NETA optional, justify as Cat 2A). `voltage_class`, `phase_ampacity` (PHASE AMPACITY A / CURRENT RATING / MAIN BUS RATING), `withstand_rating` (WITHSTAND RATING kA / CURRENT WITHSTAND), `conductor_material` (CU/AL), `drawing_no`, `number_of_bays/sections`, installed-device counts (VT's, CT's, CPT's, relays, meters), `bus_section_id` (BUS SECTION TESTED / FROM-TO / PANEL DESIGNATION).

| canonical_key | labels / synonyms | unit | kind | bad | threshold | per_phase |
|---|---|---|---|---|---|---|
| bus_insulation_resistance | INSULATION RESISTANCE TEST RESULTS - MEGOHMS / A-GND B-GND C-GND N-GND A-B A-C B-C (A-N…) / RDG & 20°C | MΩ | D | down | NETA Table 100.1: 250 V:25 MΩ; 600 V:100 MΩ; 5 kV:1,000 MΩ; 15 kV:5,000 MΩ; 25+ kV:20,000 MΩ | per phase-pair per bus section |
| bus_hipot_leakage | HIGHPOTENTIAL TESTS / LEAKAGE - MICROAMPS / TOTAL LEAKAGE | µA | D | up | no breakdown after 1 min at NETA Table 100.2 voltage; leakage stable & comparable between phases | per phase per section |
| bus_joint_resistance | BUS SECTION RESISTANCE IN MICRO-OHMS / SWITCHBOARD BUS CONNECTION TEST / CONNECTION RESISTANCE | µΩ | D | Δ | compare similar joints; investigate values >50 % above lowest / mfr limit (NETA) | per phase per joint |
| overpotential_result | OVERPOTENTIAL RESULT (PASS/FAIL) | pass/fail | D | cat | PASS | per phase |
| ir_recommended_minimum | RECOMMENDED MINIMUM (MEGOHMS) | MΩ | R | none | the NETA limit printed on form | no |
| inspection_condition | G/P/C/I codes; INSPECTED/CONDITION/CLEANED-LUBED rows | code | D | cat | P or I = deficiency | per item |
| gfp_function | CHECK AUTOMATIC TRANSFER RELAY OPERATION / RELAYS POSITIVE TRIPPING / ANNUNCIATOR | pass/fail | D | cat | functional | no |

**PANELBOARD** = LV subset: `panel_insulation_resistance` (POWER PANEL INSULATION TEST, A-GRD…C-N matrix, MΩ, down, NETA 100.1 — 100 MΩ @480 V), nameplate `main_type` (MAIN/MLO), `feeder_count`, `fed_from`, `type_of_loads` (all R).

**BUSWAY** (BUS DUCT INSULATION TEST form): `busway_insulation_resistance` (matrix A-GND…C-N, MΩ, down, NETA 100.1, per phase-pair), nameplate `vertical_rating`/`horizontal_rating`/`neutral_rating`/`ground_rating` (A), `configuration` (3/4/5 WIRE), `withstand_rating` kA — all R. Optionally `busway_joint_resistance` µΩ (D, Δ).

---

## 4. CIRCUIT_BREAKER — Low-Voltage (LVPCB / MCCB / ICCB)

> **NFPA 70B linkage — Ch. 15 (Circuit Breakers, LV & MV) — the most prescriptive equipment chapter.** Scope §15.1: MCCB/ICCB ≤1000 V (UL 489), LVPCB ≤1000 V (UL 1066), MV PCB 1 kV–69 kV. Table 9.2.2: all five task categories **60/36/12 mo**. §15.3.4 mechanical servicing requires: torque-check connections, **operate the breaker 3 times**, verify interlocks & draw-out shutters, **measure and record trip-bar force**. §15.3.5 electrical testing lists 14 required items that map directly onto this section's fields:
> | 70B §15.3.5 item | field below |
> |---|---|
> | (1) infrared thermography | (thermography record — all equipment, 12/12/6) |
> | (2) contact resistance each pole | `contact_resistance` **70B-REQ** |
> | (3) IR phase-phase/phase-gnd closed + across open pole | `insulation_resistance` **70B-REQ** |
> | (4) operate auxiliaries: shunt trip, close coil, aux switches, UV coils | `trip_unit_function` **70B-REQ** |
> | (5) verify trip-unit calibration w/ mfr test set (electronic) | `long_time/short_time/instantaneous/ground_fault` measured family **70B-REQ** |
> | (6)/(7) inverse-time trip @300% rated (thermal-mag & electronic) | `long_time_trip_time` **70B-REQ** |
> | (8)/(9) instantaneous trip by run-up/pulse | `instantaneous_pickup_measured` **70B-REQ** |
> | (10) rated hold-in test | (add `rated_holdin_result`, pass/fail) |
> | (11) current-limiter resistance | (fuse-limiter µΩ where fitted) |
> | (12) rating-plug battery status | (add `rating_plug_battery`, cat) |
> | (13) millivolt drop | `voltage_drop` **70B-REQ** |
> | (14) arc-reduction technology test per mfr | (add `arc_reduction_test`, pass/fail — ERMS/ZSI) |
>
> The ESW authors single out exactly these (IR + contact resistance on breakers) as the most-skipped tests behind insulation-failure arc-flash incidents — this table is the heart of the "70B makes the NETA tests mandatory" pitch.
| canonical_key | labels / synonyms | unit | per_phase |
|---|---|---|---|
| frame_size | FRAME SIZE(F) / FRAME | A | no |
| interrupting_rating | INT. RATING / INTERRUPT CAPACITY / AIC | kA | no |
| trip_unit_type | TRIP UNIT TYPE / THERMAL ELEMENT / MAGNETIC ELEMENT / SS or HTR | – | no |
| rating_plug | RATING PLUG(R) | A | no |
| sensor_tap | SENSOR TAP / SENSOR TAPS | A | no |
| setting_long_time_pickup | LONG TIME PU / LTPU / LONG x A = A (PICKUP, DELAY, CURVE) | ×In / A | no |
| setting_short_time_pickup | SHORT TIME PU / STPU / DELAY / I²T IN-OUT | ×Ir / A | no |
| setting_instantaneous_pickup | INST. PU / IPU / INSTANTANEOUS SETTING / RANGE-SETTING | ×In / A | no |
| setting_ground_fault_pickup | GRD. FLT. PU / GFPU / GROUND FAULT PICKUP, DELAY / 3W 4W | A | no |
| thermal_memory | THERMAL MEMORY ON/OFF; ZONE INTLK; TARGETS | – | no |
| counter_reading | COUNTER READING BEG/END | count | no |

### Diagnostic
| canonical_key | labels / synonyms | unit | bad | threshold | per_phase |
|---|---|---|---|---|---|
| contact_resistance | POLE RESISTANCE - MICRO-OHMS / CONTACT RESISTANCE IN MICROHMS / DLRO | µΩ | Δ/up | compare poles; investigate >50 % above lowest pole or mfr limit (NETA) | per pole |
| insulation_resistance | INSULATION RESISTANCE: POLE TO POLE / POLE TO FRAME / LINE TO LOAD (ACROSS OPEN POLE) / CONTROL WIRING | MΩ | down | NETA 100.1 (e.g. ≥100 MΩ @480 V); control wiring ≥2 MΩ @500 V | per pole-pair |
| long_time_trip_time | LONG TIME / TIME AT 300% RATED CURRENT IN SECONDS / TEST CURRENT-MULTIPLE-TIME BAND MIN-MAX vs AS FOUND/AS LEFT | s | Δ(out-of-band) | within mfr published TCC band (MIN/MAX printed on form); MCCB @300 %: trip within mfr max (NETA Tab. 100.7) | per pole |
| short_time_pickup_measured | SHORT TIME STPU (amps) | A | Δ | within ±10 % of setting (mfr tolerance) | per pole |
| instantaneous_pickup_measured | INSTANTANEOUS IPU (amps) / INSTANTANEOUS PICKUP / TESTED ON SETTING TRIP-NO TRIP | A | Δ | within mfr tolerance (commonly ±20 % MCCB, ±10 % LVPCB) | per pole |
| ground_fault_pickup_measured | GROUND FAULT GFPU (amps) / GF PICKUP-TIMING | A | Δ | within tolerance; system ≤1200 A & ≤1 s @3000 A (NEC 230.95) | per pole |
| voltage_drop | VOLTAGE DROP @ LONG TIME TEST CURRENT (mV) | mV | Δ | compare poles (millivolt-drop alternative to µΩ) | per pole |
| trip_unit_function | ZONE INTERLOCK / TARGETS / SHUNT TRIP / charging-closing functions | pass/fail | cat | functional | no |

## 4b. CIRCUIT_BREAKER — MV/HV (Oil / SF6 / Vacuum / Air-Magnetic, incl. reclosers)

> **NFPA 70B linkage — Ch. 15 §15.4 (MV breakers follow the same table structure as §15.3).** Table 9.2.2 "Medium-voltage power circuit breakers": all categories **60/36/12 mo**. **70B-REQ:** `contact_resistance`, `insulation_resistance`, `open_close_timing` + trip/close coil operation, `counter_reading` capture, interrupting-medium integrity checks (`vacuum_integrity` / `sf6_pressure`+`sf6_moisture` / `oil_dielectric` per medium). Nice-to-have (Cat 1A/2A enhanced tier): `breaker_power_factor`/`breaker_capacitance`, `tank_loss_index`, travel/speed curves, `min_trip_test` on reclosers — NETA/Doble depth that exceeds the 70B floor but is the standard MV practice. `interrupting_medium` (INT. MEDIUM Oil/SF6 Gas/Vacuum/Air), `mechanism_type` (MEC. TYPE / MEC. DESIGN / MECHANISM TYPE), `control_voltage` (CONTROL VOLTS / CLOSE COIL VOLTAGE / TRIP COIL VOLTAGE / MOTOR VOLTAGE), `tank_count` (TANKS / NO. TANKS / GALLONS PER TANK), `sf6_volume`, `oil_type`, `coil_size` (recloser, AMPS), `tcc_curve` (TCC1–TCC4), CT nameplate on bushing CTs.

| canonical_key | labels / synonyms | unit | bad | threshold | per_phase |
|---|---|---|---|---|---|
| contact_resistance | CONTACT RESISTANCE (MILLIOHMS/MICROHMS) / POLE RESISTANCE / INTERRUPTER RESISTANCE / RESISTANCE + MINIMUM + MAXIMUM + PASS/FAIL | µΩ (mΩ) | Δ/up | ≤ mfr; typical ≤ a few hundred µΩ; compare poles, >50 % above lowest = investigate (NETA) | per pole |
| insulation_resistance | POLE TO POLE / POLE TO FRAME / LINE TO FRAME / LOAD TO FRAME / LINE TO LOAD; CONTROL WIRING - MEGOHMS | MΩ | down | NETA 100.1 per voltage class | per pole-pair |
| breaker_power_factor | CIRCUIT BREAKER OVERALL TESTS C1G…C6G, C12/C34/C56, S1 / POWER FACTOR % MEAS-20°C-CORR | % | up | compare similar units & Doble published; bushings ≤0.5 % | per bushing/phase |
| breaker_capacitance | Capacitance C (pF) | pF | Δ | vs sister phases/baseline | per bushing/phase |
| tank_loss_index | TANK LOSS INDEX / TLI = W7-(W1+W2) | W | up | Doble: TLI > ~+0.1 W investigate (contaminated tank/lift-rod) | per tank |
| open_close_timing | TIMING ANALYSIS / TRIP TIME / OPEN-CLOSE TIMES (seconds) / OCR TIMING TEST | ms / s / cycles | Δ | within mfr spec (typ. open 3–5 cyc); recloser: within TCC MIN/MAX TIME band | per pole |
| pole_synchronization | pole spread / contact simultaneity | ms | up | ≤1/6 cycle (~2.8 ms) between poles (IEEE C37.09 practice) | no |
| contact_travel | CONTACT TRAVEL - INCHES / MAIN CONTACT TRAVEL | in | Δ | per mfr | per pole |
| opening_speed | OPENING SPEED (ft/sec) | ft/s | Δ | per mfr curve | per pole |
| closing_speed | CLOSING SPEED (ft/sec) | ft/s | Δ | per mfr | per pole |
| contact_wipe | ARCING/MAIN CONTACT WIPE - INCHES / MAIN CONTACT GAP | in | Δ | per mfr | per pole |
| vacuum_integrity | VACUUM INTEGRITY TEST / VACUUM BOTTLE (hipot across open contacts) | pass/fail | cat | withstand per mfr (no loss of vacuum) | per pole |
| oil_dielectric | OIL DIELECTRIC (kV) AS FOUND/AS LEFT | kV | down | ≥25–30 kV D877 (breaker oil) | per tank/phase |
| sf6_pressure | SF6 PRESSURE / GAS PRESSURE | psi/bar | down | ≥ mfr alarm level | no |
| sf6_moisture | SF6 MOISTURE / DEW POINT | °C ppmv | up | dew point ≤ −35 °C typical acceptance | no |
| min_trip_test | MINIMUM TRIP TEST Current (amps) / MIN-MAX CURRENT | A | Δ | recloser: within band of coil rating | no |
| trip_coil_current | TRIP/CLOSE COIL CURRENT, minimum pickup voltage | A / V | Δ | trips at reduced control voltage per ANSI (e.g. 56 % rated) | no |
| counter_reading | OPERATIONS COUNTER / COUNTER AS FOUND-AS LEFT / SINCE LAST MAINTENANCE # OF OPERATIONS | count | none(R) | maintenance interval driver | no |
| hipot_result | HIGH POTENTIAL TEST kVDC-kVAC / MILLIWATT LOSS TEST | pass/fail, mW | cat/up | withstand per NETA 100.19/mfr | per pole |

---

## 5. PROTECTION_RELAY (electromechanical + microprocessor; forms: IAC/CO/CV/CEY series, SEL 351)

> **NFPA 70B linkage — Ch. 35 (Protective Relays).** Table 9.2.2 splits by technology: **electromechanical relays 36/24/12 mo** (stricter than the standard 60/36/12 — even C1 electromechanical relays are on a 3-year clock), solid-state/microprocessor 60/36/12. **70B-REQ:** `pickup_current`, `instantaneous_pickup`, `timing_test`, `trip_circuit_test` (the relay must demonstrably trip its breaker — this is the arc-flash-credibility test: incident-energy studies assume the relay operates per curve), `visual_maintenance_flags`. Nice-to-have: `reach_measured`/characteristic sweeps and full µP `metering_accuracy` beyond the protective elements in service. Parser hint: relay technology type (electromech vs µP) is therefore interval-determining metadata — capture it as R.
| canonical_key | labels / synonyms | unit | per_phase |
|---|---|---|---|
| ct_ratio | CT RATIO (:5) / CTR / CTRN | ratio | no |
| pt_ratio | PT RATIO / PTR / VNOM | ratio | no |
| setting_tap | TAP / PICKUP (51xP) | A | no |
| setting_time_dial | TIME DIAL / TD / 51xTD | – | no |
| setting_instantaneous | INSTANTANEOUS / INST / 50x pickup | A | no |
| setting_seal_in | SEAL IN (DC amps) / SEAL-IN RANGE | A | no |
| setting_curve | CURVE (51xC, U1…) / TCC / LONG TIME RANGE | – | no |
| setting_reach | SEC. OHMIC REACH / Z1MAG-Z1ANG / BMR / PERCENT TAP | Ω / deg | no |
| setting_voltage_pickup | Pickup Voltage (volts) / Nominal Voltage / 27P-59P pickups | V | no |
| settings_blob | full microprocessor setting sheet (SEL: 50/51/67/81/79/25/32 elements, TR/CL logic equations, OUTxxx) — capture as document blob keyed by element | – | no |
| devices_operated | DEVICES OPERATED / INSTRUCTION BOOKLET | – | no |

### Diagnostic
| canonical_key | labels / synonyms | unit | bad | threshold | per_phase |
|---|---|---|---|---|---|
| pickup_current | PICKUP TESTS / TIME OVERCURRENT PICKUP / AS FOUND-AS LEFT (amps) vs Minimum-Maximum | A | Δ(out-of-band) | within form MIN/MAX (≈ tap ±5–10 %; NETA: per mfr published) | per element |
| instantaneous_pickup | INSTANTANEOUS PICKUP (amps) | A | Δ | setting ±10 % (form bands e.g. 9.50–10.50 for 10) | per element |
| timing_test | TIMING TESTS / Multiple 2.0-3.0-5.0 / As Found (seconds) vs Minimum-Maximum (seconds) | s | Δ | within published curve band at each multiple (±10 % typical) | per multiple |
| voltage_pickup | Under/Over Voltage Pickup — As Found Voltage vs Min/Max | V | Δ | nominal ±5 % band on form (e.g. 104.5–115.5 for 110) | per element |
| reach_measured | REACH TESTS Ohms / MTA (degrees) / CHARACTERISTIC TESTS | Ω / deg | Δ | calc ±3 % (form ALLOWED ERROR 3 %; MTA ±2°) | per phase-pair |
| relay_insulation_resistance | INSULATION RESISTANCE (routine maintenance checklist) | MΩ | down | ≥1–2 MΩ control circuits | no |
| trip_circuit_test | TRIP CIRCUIT TESTED / TRIP TEST / RELAY FUNCTION TRIP TEST / breaker operated by relay | pass/fail | cat | must trip breaker | no |
| visual_maintenance_flags | COVER GASKET OK / NO MOISTURE / SPIRAL SPRING OK / DISC CLEARANCE OK / CT SHORTING BAR REMOVED | check | cat | unchecked/abnormal = note | per item |
| metering_accuracy | (µP relays) measured I/V vs injected | % | Δ | per mfr class (±1–3 %) | per channel |

**GROUND_FAULT_PROTECTION** (NETA 7.14; GFR block on disconnect/bolted-pressure-switch forms — **70B Ch. 21, LV/MV GFPE: visual 12/12/6 mo, mechanical/electrical testing 60/36/12; `gf_pickup_measured`, `gf_trip_time`, `gf_reduced_voltage_trip` are 70B-REQ**): reference `gf_pickup_setting` (PICKUP RANGE/SETTING), `gf_delay_setting` (TIME DELAY RANGE/SETTING); diagnostic `gf_pickup_measured` (A, Δ, NEC 230.95: ≤1200 A), `gf_trip_time` (s, up, ≤1 s @ 3000 A), `gf_reduced_voltage_trip` (pass/fail, relay operates at 57 % control voltage), `zero_sequence_ct_polarity` (pass/fail).

---

## 6. CABLE_MV_HV (forms: VLF CABLE TEST, TAN DELTA, CABLE HIGH POTENTIAL, CABLE PI, CABLE PF, TDR)

> **NFPA 70B linkage — Ch. 18 (Power Cables & Conductors, both ≤1 kV and >1 kV).** Table 9.2.2 "Power cables": visual/cleaning/electrical testing **60/36/12 mo**. Per the ESW paper, Ch. 18's *minimum* electrical testing is **insulation resistance** — so `insulation_resistance` is the 70B-REQ floor, and the VLF withstand / tan-delta / PD suite (IEEE 400.2/400.3) is the industry-standard *method* tier for MV diagnostics (justify in the EMP as the accepted practice for shielded MV cable, where simple IR is a weak indicator). **70B-REQ:** `insulation_resistance`, `vlf_withstand_result` or equivalent accepted MV test, `shield_resistance` continuity. Nice-to-have: full tan-delta triplet, PD, TDR mapping. Cable trays are separately covered by Ch. 19: **70B-REQ tray tasks = IR thermography + equipment-grounding-impedance of the tray** (visual 12/12/6).
`operating_voltage` (OPERATING kV), `rated_voltage` (RATED kV), `cable_length` (LENGTH FT, LENGTH-OUTDOOR/INDOOR), `conductor_size` (SIZE KCMIL/MCM/AWG), `num_conductors`, `conductor_material` (CU/AL), `insulation_type` (XLPE/EPR/PILC; INSULATION MATERIAL/TYPE, BELTED/SHIELDED), `insulation_thickness` (MILS), `installed_in` (CONDUIT/TRAY/DUCT), `cable_source` / `cable_termination_point`, `connected_equipment`, `splice_count` (NUMBER OF SPLICES/TERMINATIONS/MANHOLES), `termination_type` (HAND TAPED/3-M/RAYCHEM), `age`, `phase_identification`, `test_type` (WITHSTAND vs DIAGNOSTIC), `wave_shape` (SINE/COSINE-RECTANGULAR), `planned_duration`, `vlf_test_voltage` (RMS TEST VOLTAGE kV — the applied level, R).

### Diagnostic
| canonical_key | labels / synonyms | unit | bad | threshold | per_phase |
|---|---|---|---|---|---|
| insulation_resistance | MEGOHMS / READING-TEMP CORR-20°C READING (PI form) / INSULATION RESISTANCE GIGA-OHMS @ kV | MΩ/GΩ | down | ≥ design min R = K·log10(D/d)·(1000/L); trend; NETA: per cable mfr | per phase |
| polarization_index | P.I. / POLARIZATION INDEX = 10 MIN/1 MIN | ratio | down | ≥2 good (shielded); interpret w/ caution on short runs | per phase |
| vlf_withstand_result | VLF / BREAKDOWN YES-NO / TIME TO FAILURE / TEST TYPE WITHSTAND PASS-FAIL | pass/fail | cat | hold IEEE 400.2 voltage (e.g. 15 kV class: 16 kVrms maint., 21 kVrms accept.) 30–60 min without breakdown | per phase |
| vlf_leakage_current | NANO/MICRO AMPS columns at 1…60 MINUTES | nA/µA | up | stable or decreasing; compare phases | per phase |
| tan_delta | TAN DELTA / TD / DISSIPATION FACTOR (×10⁻³) at 0.5U0, U0, 1.5U0 steps | E-3 (×10⁻³) | up | XLPE per IEEE 400.2: mean TD @U0 <4×10⁻³ good, 4–50 further study, >50 action required | per phase per voltage step |
| tan_delta_tip_up | DELTA TD / TIP UP (TD@1.5U0 − TD@0.5U0) | E-3 | up | XLPE: <5×10⁻³ good; >80 action (IEEE 400.2 Table 6) | per phase |
| tan_delta_stability | TDTS / STD DEV of TD @U0 | E-3 | up | <0.1×10⁻³ good (IEEE 400.2) | per phase |
| cable_capacitance | NANO FARADS / MICROFARADS / CAP (pF, nF) | nF/µF | Δ | reference-ish; compare phases & length-normalize | per phase |
| dc_hipot_leakage | CABLE HIGH POTENTIAL TEST / µΑ at TIME steps / STEP VOLTAGE | µA | up | current stabilizes/decreases each step; no runaway; compare phases (NETA; IEEE 400 discourages DC on aged XLPE) | per phase per step |
| decay_to_5kv | DECAY TO 5kV; SECS | s | none | reference (discharge) | per phase |
| shield_resistance | SHIELD RESISTANCE A-B/B-C/C-A / SHIELD RESIST.- OHMS / CONCENTRIC NEUTRAL RESISTANCE | Ω | up/Δ | continuity; compare phases (corroded neutrals read high) | per phase |
| cable_power_factor | CABLE INSULATION POWER FACTOR % (PF form) | % | up | PILC ≤ ~1 %; trend; compare phases | per phase |
| partial_discharge | PD / pC / PDIV / PDEV (when offline PD performed) | pC, kV | up | no sustained PD above U0 per IEEE 400.3 | per phase |
| tdr_trace | TDR / TIME DOMAIN REFLECTOMETER / VELOCITY FACTOR, PULSE WIDTH, GAIN | waveform | none(R) | reference record of splice/fault locations | per phase |

## 6b. CABLE_LV (LOW VOLTAGE CABLE INSULATION TEST form)

> **NFPA 70B linkage — same Ch. 18 (covers ≤1000 V cable explicitly).** `insulation_resistance` IS the 70B-REQ electrical test for LV cable at 60/36/12 mo — the often-skipped test the ESW authors tie directly to preventable insulation-failure incidents.

Reference: `insulation_type` (TW/THW/THHW/XHHW/THHN/RH/RHW), `num_size_conductors`, `from_to_identification`. Diagnostic: `insulation_resistance` — matrix A-GND, B-GND, C-GND, N-GND, A-B, B-C, C-A, A-N, B-N, C-N with RDG/20°C rows (MΩ, down, NETA 100.1: 25 MΩ @300 V class, 100 MΩ @600 V class, 1 min @500–1000 VDC, per phase-pair); `continuity` (pass/fail).

---

## 7. UPS_BATTERY / BATTERY_SYSTEM (forms: BATTERY DISCHARGE, BATTERY TEST (impedance), BATTERY INSPECTION SG / RESISTANCE, UPS BATTERY DISCHARGE)

> **NFPA 70B linkage — Ch. 25 (UPS), Ch. 36 (Stationary Standby Batteries), Ch. 32 (Battery ESS).** UPS has the tightest intervals in Table 9.2.2: **visual 6/3/1 mo; cleaning/mechanical/electrical testing 12/6/3 mo; special procedures 24/24/24 mo.** §25.4 special procedures are functional: software upgrades, **load transfer & load testing**, system test conditions, output stability, **low-battery-voltage shutdown** — i.e., `capacity_percent`/`discharge_duration` discharge tests and transfer tests are 70B-REQ, not optional. Stationary standby batteries: 60/36/12 — but per the Ch. 4 hierarchy (manufacturer/industry standard first), **IEEE 450 (VLA) / 1188 (VRLA) monthly-quarterly-annual practice governs in practice and is stricter**; treat 70B as the floor and IEEE as the operative schedule. **70B-REQ:** `cell_float_voltage`, `string_float_voltage`, `cell_internal_ohmic`, `intercell_resistance`, `capacity_percent`, `inspection_items` (ventilation/eyewash are also fire-code items). Nice-to-have: `ripple_current`, per-cell `cell_temperature` beyond pilot cells, `terminal_ground_voltage`.
`cell_count` (NUMBER OF CELLS / CELLS/JAR / # OF RACKS), `cell_type` (VLA/VRLA/NICD; CELL TYPE), `amp_hour_rating` (CAPACITY RATING (Ah) / AMP HOUR RTG), `nominal_cell_voltage` (CELL VOLTAGE (V) / VOLTS PER CELL NOMINAL), `nominal_string_voltage` (OVERALL BATTERY VOLTAGE), `specific_gravity_range` (SPEC. GRAVITY RANGE g/cm3), `commission_date` (COMMISSION DATE / INSTALLATION DATE), `charge_status` (CHARGED/DISCHARGED/EQUALIZED), test parameters (`test_current`, `end_cell_voltage` 1.75 V/cell typ., `end_battery_voltage`, `rated_time`, temperature-correction method per IEEE 450), charger nameplate (`charger_float_voltage_setting`, `charger_equalize_voltage_setting`, CHARGER MFR/MODEL), limits rows (HIGH/LOW VOLTAGE LIMIT, HIGH/LOW RESISTANCE LIMIT, VARIATION/DEVIATION/CHANGE/STRAP WARNING-ALARM % — these are thresholds, R). UPS adds: `ups_kva_rating`, `ups_input_voltage/current/frequency/phase`, `ups_output_…`, `dc_bus_voltage_nominal`, `ups_type` (STATIC/ROTARY).

### Diagnostic
| canonical_key | labels / synonyms | unit | bad | threshold | per_phase(cell) |
|---|---|---|---|---|---|
| cell_float_voltage | CELL VOLTAGE (volts) / FLOAT VOLTAGE / VOLTAGE (volts) per CELL # | V | Δ(both) | within mfr float band (VLA ~2.17–2.25 V/cell); per-cell deviation from avg; low cell = deficiency (IEEE 450 §5.2) | per cell |
| string_float_voltage | OVERALL VOLTAGE VDC / TOTAL STRING VOLTAGE / Total Volt. | V | Δ | = charger setting ± mfr tolerance | no |
| cell_internal_ohmic | RESISTANCE (micro-ohms) / IMPEDANCE (milli-ohms) / CONDUCTANCE / % DEVIATION (Baseline) / % VARIATION (String) / % CHANGE (Prev.) | µΩ/mΩ | up | investigate ≥20 % above baseline/string avg; replace ≥30–50 % (IEEE 1188 / Megger BITE practice; form warning 5 %, alarm 10 % variation) | per cell |
| intercell_resistance | INTERCELL RESISTANCE (micro-ohms) / STRAP RESISTANCE / % VARIATION (Avg) | µΩ | up | ≤10–20 % above install baseline/average (IEEE 450; NETA) | per strap |
| specific_gravity | SPECIFIC GRAVITY / SPEC. GRAVITY / HYDROMETER (g/cm3) | sg | down/Δ | ≥ mfr nominal (typ. 1.200–1.215); within ±0.010 of string avg (IEEE 450) | per cell |
| cell_temperature | TEMP. °F/°C per cell / PILOT CELLS TEMP | °C | Δ | intercell spread ≤3 °C (IEEE 450) | per cell |
| electrolyte_level | ELECTROLYTE LEVEL | ok/low | cat | within plates marks | per cell |
| capacity_percent | PERCENT CAPACITY (%) / PERCENTAGE BATTERY CAPACITY / BATTERY CAPACITY - PERCENT / Temp. Corrected Battery Capacity | % | down | ≥80 % of rated = pass; replace <80 % (IEEE 450/1188); accelerate testing if <90 % & falling | no |
| discharge_duration | ACTUAL DISCHARGE TIME - MINUTES vs MFR'S RATED CAPACITY TIME / Actual Discharge Time / TIME (h) CORRECTED | min | down | ≥ rated time × correction | no |
| discharge_end_voltage | END CELL VOLTAGE / END BATTERY VOLTAGE / Fail Time-Fail % per cell | V | down | ≥1.75 V/cell (typ.) at end of rated run | per cell |
| float_current | FLOAT CURRENT (ADC) | A | up | per mfr (rising float current = thermal runaway risk VRLA) | no |
| ripple_current | RIPPLE CURRENT / TOTAL AC CURRENT (A) | A | up | ≤5 A per 100 Ah (VRLA guidance) | no |
| terminal_ground_voltage | GROUND TEST Positive/Negative Terminal to Gnd. VDC | V | Δ | balanced ±; shift = ground fault on DC system | no |
| charger_output | CHARGER CURRENT (Amps) / VOLTAGE (Volts) measured | A / V | Δ | matches settings | no |
| inspection_items | VENTILATION / EYEWASH / FLAME ARRESTERS / RACKS / CORRODED TERMINALS / CHARGER FANS-FILTERS-ALARMS | cat | cat | unsatisfactory = deficiency | per item |

---

## 8. GROUNDING_SYSTEM (Smart Ground report + IEEE 81/80 + NETA 7.13)

> **NFPA 70B linkage — Ch. 20 (Grounding & Bonding).** Table 9.2.2: **visual inspection 12/12/6 mo; electrical testing 60/36/36 mo** — note the unique C3 column: grounding electrical testing never compresses below 36 mo (ground grids degrade slowly; ServiceCycle's generic C3→12-mo ceiling would *over*-require here by 3× — seed the explicit value). The ESW paper stresses grounding/bonding is required risk control for ALL systems regardless of other protection. **70B-REQ:** `ground_resistance` (fall-of-potential or accepted method), `point_to_point_resistance` (bonding continuity), visual `ground_conductor_size`/condition. Nice-to-have (design-study tier): `soil_resistivity`, `touch_voltage`/`step_voltage`/`gpr` (IEEE 80 studies — Ch. 6 system-study material rather than periodic maintenance). | labels / synonyms | unit | kind | bad | threshold | per_phase |
|---|---|---|---|---|---|---|
| ground_resistance | FALL OF POTENTIAL / GROUND IMPEDANCE / GROUND RESISTANCE / 3-POINT TEST / 62% METHOD / CLAMP-ON | Ω | D | up | ≤1 Ω large substations, ≤5 Ω commercial/industrial (IEEE 142 "green book" practice; NETA: per design) | per electrode/grid |
| point_to_point_resistance | POINT TO POINT GROUND IMPEDANCE / CONTINUITY / BONDING RESISTANCE | Ω (mΩ) | D | up | ≤0.5 Ω between bonded points (common accept; compare similar paths) | per pair |
| soil_resistivity | SOIL RESISTIVITY / WENNER 4-POINT / Upper-Lower Layer Resistivity | Ω·m (Ohm-meter) | D/R | none(design) | input to IEEE 80 design; two-layer model (e.g. 139.7/229.2 Ω-m, depth 18.6 ft in sample) | per traverse/spacing |
| upper_layer_depth | Depth of Upper Layer | ft/m | R | none | – | no |
| touch_voltage | TOUCH VOLTAGE / SAFETY ASSESSMENT | V | D | up | ≤ IEEE 80 tolerable touch limit (body-weight & ts dependent) | per location |
| step_voltage | STEP VOLTAGE | V | D | up | ≤ IEEE 80 tolerable step limit | per location |
| gpr | GROUND POTENTIAL RISE / GPR / TRANSFER VOLTAGE | V | D | up | ≤ design limit (often 5 kV telecom interface) | no |
| fault_current_split | FAULT CURRENT ANALYSIS / SPLIT FACTOR | kA / % | R | none | model input | no |
| ground_conductor_size | GROUND CONDUCTOR SIZE AWG/KCM / NO. OF GROUND CONDUCTORS / CONDITION | – | R/D | cat | sized per IEEE 80; condition GOOD/FAIR/POOR | no |
| test_method | instrument & method (Smart Ground Multimeter / fall-of-potential / clamp-on / slope) | – | R | none | – | no |

---

## 9. GENERATOR (forms: GENERATOR PI, TIP UP, LOAD TEST, STATUS & SHUTDOWN, ENGINE-GEN PM)

> **NFPA 70B linkage — Ch. 27 (Rotating Equipment).** Table 9.2.2: all categories **60/36/12 mo**. **70B-REQ:** `stator_insulation_resistance` + `polarization_index` (IEEE 43 is the referenced method), `winding_resistance`, lubrication & mechanical servicing records, visual inspection. For **emergency/standby generators NFPA 110 governs on top of 70B** (monthly load runs, annual load bank, transfer testing) — `load_test_kw` and `shutdown_alarm_tests` are NFPA 110 evidence, keep them required for any generator tagged emergency/standby. Nice-to-have (Cat 2A): `tip_up_power_factor`/`tip_up_capacitance`, surge comparison. **MOTOR** below follows the same Ch. 27 row; vibration trending is the classic "predictive technique" whose active recommendation forces §9.3.1 Condition 2/3. `kva_rating`, `kw_rating`, `voltage` (VOLTS (KV)), `amps`, `phase`, `frequency` (CYCLES/HERTZ), `rpm`, `frame`, governor / voltage-regulator / control MFR-MODEL-S/N, engine nameplate, fuel system data (VOLUME GAL, ULLAGE), `target_kw_loading` & `reading_intervals` (load-test plan).

| canonical_key | labels / synonyms | unit | kind | bad | threshold | per_phase |
|---|---|---|---|---|---|---|
| stator_insulation_resistance | PHASE A/B/C TO GROUND, PHASE A TO B… READING (megohms), TEMP CORR FACTOR, 20°C READING, 0.25–10 min | MΩ | D | down | IEEE 43: IR(1 min,40 °C) ≥ kV+1 MΩ (pre-1970 windings) or ≥100 MΩ (modern form-wound); ≥5 MΩ random-wound | per phase(-pair) |
| polarization_index | POLARIZATION INDEX | ratio | D | down | ≥2.0 Class B/F (IEEE 43); if IR1min >5 GΩ, PI not meaningful | per phase |
| tip_up_power_factor | TIP UP TEST / PF (%) at 25-50-75-100 %kV / TIP UP / GROUNDED & UNGROUNDED (UST) rows | % | D | up | ΔPF (tip-up) low & consistent across phases (≤~0.5–1 % typical); rising tip-up = void PD | per terminal per step |
| tip_up_capacitance | CAPACITANCE C (PF) | pF | D | Δ | compare phases | per terminal |
| winding_resistance | armature/field winding resistance | Ω/mΩ | D | Δ | phases within 1–3 %; vs factory | per phase |
| load_test_kw | MEASURED KILOWATT / TARGET KILOWATT LOADING / kW step (25/50/75/100 %) | kW | D | down | reaches rated kW each step (NFPA 110 / load-bank practice: 30 min @100 %) | per step |
| load_test_voltage | MEASURED VOLTAGE vs PANEL METER VOLTAGE READING | V | D | Δ | within ±5 % nominal; panel meter agreement | per phase per step |
| load_test_current | MEASURED AMPERES | A | D | up | ≤ rated; balanced | per phase per step |
| frequency | FREQUENCY - HERTZ / ENGINE SPEED - R.P.M. | Hz / rpm | D | Δ | 60 Hz ±0.5 %; stable under step load | per step |
| engine_oil_pressure | ENGINE OIL PRESSURE - PSI | psi | D | down | within mfr band | per step |
| engine_coolant_temp | ENGINE WATER °F / RADIATOR WATER TEMPERATURE | °F | D | up | below high-temp alarm | per step |
| engine_oil_temp | ENGINE OIL TEMPERATURE °F | °F | D | up | per mfr | per step |
| battery_voltage_cranking | BATTERY VOLTAGE / CRANKING VOLTAGE DROP / CHARGER RATE | V | D | down | per mfr (e.g. ≥9 V during crank on 12 V) | no |
| fuel_pressure | FUEL PRESSURE | psi | D | down | per mfr | per step |
| shutdown_alarm_tests | OVERCRANK / OVERSPEED / LOW OIL PRESSURE / HIGH WATER TEMP / E-STOP … SHUTDOWN, ALARM INITIATED, LAMP | pass/fail | D | cat | each simulated device must alarm/shut down (NFPA 110) | per device |

**MOTOR** (lighter; NETA 7.15, IEEE 43): same `stator_insulation_resistance` + `polarization_index` thresholds as generator; `winding_resistance` per phase (Δ ≤1–3 %); `no_load_current` (A, Δ, balanced & ≤ nameplate); `vibration` (in/s, up, per ISO 10816 zone); `bearing_temperature` (°C, up); `surge_comparison` (pass/fail); reference: `hp`, `rpm`, `frame`, `service_factor`, `fla`, `insulation_class`.

---

## 10. MCC (MOTOR CONTROL forms: MCC TEST REPORT, MOTOR STARTER TEST, MV VACUUM STARTER, 480V MCC PM)

> **NFPA 70B linkage — Ch. 28 (Motor Control Equipment).** Table 9.2.2: all categories **60/36/12 mo**. **70B-REQ:** `insulation_resistance` (bucket + control), `contact_resistance`, `overload_trip_time` (protective-device proof, same arc-flash rationale as breakers/relays), `contactor_function` + mechanical servicing of the bucket. Nice-to-have: `breaker_voltage_drop`, vacuum-bottle hipot on MV starters (per mfr). `bucket_id` / `starter_identification`, `starter_size` (NEMA SIZE), `mcc_voltage`, `bucket_count` (# OF BUCKETS / TOTAL POSITIONS), overload data (`overload_type` SS or HTR, MODEL/CAT #, HEATER size), fuse data (CONTROL POWER FUSE / MAIN POWER FUSE MFR-TYPE-SIZE), CPT nameplate (VA, voltage), CT ratio, `interrupting_rating` (INT. RATING kA @ kV).

| canonical_key | labels / synonyms | unit | kind | bad | threshold | per_phase |
|---|---|---|---|---|---|---|
| contact_resistance | Contact Resistance (Micro Ohms) A/B/C / POLE RESISTANCE / INTERRUPTER RESISTANCE | µΩ | D | Δ/up | compare poles & similar buckets (NETA) | per pole per bucket |
| insulation_resistance | Insulation Resistance @ 1000V (Meg Ohms) A/B/C / POLE TO POLE / LINE-LOAD TO FRAME / STARTER IR AA-BB-CC | MΩ | D | down | NETA 100.1 (≥100 MΩ @480 V) | per pole per bucket |
| control_ir | Insulation Resistance @ 1000V (Control) / CONTROL WIRING - MEGOHMS | MΩ | D | down | ≥2 MΩ @500 V | per bucket |
| overload_trip_time | O/L Test (Sec) / DELAY @ 300% MFLA A-B-C (seconds) | s | D | Δ | trips within mfr curve @300 % (NETA 7.16.1.2) | per phase |
| breaker_mcp_pickup | INSTANTANEOUS PICKUP A/B/C (amps) / MCP IR | A | D | Δ | within mfr tolerance of setting | per phase |
| breaker_voltage_drop | BREAKER VOLTAGE DROP A/B/C (volts) | V | D | Δ | compare poles | per phase |
| vacuum_bottle_integrity | VACUUM INTERRUPTER / CONTACT EROSION INDICATOR / hipot | pass/fail | D | cat | per mfr | per pole |
| contactor_function | Breaker Test Visual/Operation / CONTACT SEQUENCE | pass/fail | D | cat | operates correctly | per bucket |

## 11. VFD (VARIABLE FREQUENCY DRIVE form)

> **NFPA 70B linkage — no task table: Ch. 26 (Electronic Equipment) is RESERVED in the 2023 edition.** VFDs are covered only via the general EMP duty (Ch. 4: follow manufacturer instructions) and their place inside motor-control lineups (Ch. 28). All fields below are therefore manufacturer/NETA practice, **not 70B-itemized** — mark them nice-to-have in 70B terms, but still EMP-required if the manufacturer's manual specifies them (it always does for fans/caps). Expect a future 70B edition to populate Ch. 26. VFD MFG/MODEL-HP/P/N/SYSTEM S/N, `input_rating`, `output_rating` (0-460VAC), motor nameplate (HP, FRAME, VOLTS, AMPS, RPM), fan data (FAN MFR/MODEL, NUMBER OF FANS), wiring diagram.

| canonical_key | labels / synonyms | unit | kind | bad | threshold | per_phase |
|---|---|---|---|---|---|---|
| input_voltage | INPUT VOLTAGE (Line-Line / Line-Ground) RMS L1-L2… | VAC | D | Δ | nominal ±10 %; phase imbalance ≤1–2 % | per phase-pair |
| dc_bus_voltage | DC BUS VOLTAGE (in volts) | VDC | D | Δ | ≈1.35 × VLL line input | no |
| dc_bus_ripple | DC BUS AC RIPPLE (in volts) | VAC | D | up | ≤ ~4 VAC typical (failing caps read high) | no |
| output_voltage | OUTPUT TO LOAD RMS T1-T2… / T1V-L | VAC | D | Δ | balanced phase-to-phase | per phase-pair |
| output_current | T1I, T2I, T3I | A | D | Δ | balanced; ≤ rated | per phase |
| terminal_resistance | DLRO READINGS L1/L2/L3/T1/T2/T3 (micro-ohms) | µΩ | D | Δ | compare terminals | per terminal |
| control_board_voltage | CONTROL BOARD DC VOLTAGE | VDC | D | Δ | per mfr rail spec | no |
| cooling_fans_failed | Number of Fans Not Operating / Replaced | count | D | up | 0 expected | no |

## 12. TRANSFER_SWITCH (ATS forms incl. ASCO group panels)

> **NFPA 70B linkage — no dedicated ATS chapter in 70B:2023.** The switch hardware falls under Ch. 17 (Switches, 60/36/12) for contact/insulation/mechanical work; for ATS serving emergency/legally-required standby systems, **NFPA 110 governs functional testing** (monthly test under load with transfer, annual maintenance) — stricter and contractually unavoidable in healthcare/life-safety. **Effective required set:** `pole_resistance`, `insulation_resistance` (Ch. 17), `transfer_time_measured` + pickup/dropout verification (NFPA 110 functional proof). Nice-to-have: `control_board_voltages` test-point sweeps (mfr-specific). `system_voltage`, `ampacity`, `controls_type` (ELECTROMECHANICAL/SOLID STATE/MICROPROCESSOR), `wiring_no`, installed options; **settings** rows (R): `td_override_momentary_outage_setting`, `td_transfer_to_emergency_setting`, `td_retransfer_to_normal_setting`, `td_engine_cooldown_setting`, pickup/dropout setting % (ADJUSTMENT RANGE / FACTORY SET @).

| canonical_key | labels / synonyms | unit | kind | bad | threshold | per_phase |
|---|---|---|---|---|---|---|
| pole_resistance | POLE RESISTANCE / AS FOUND-20°C-AS LEFT per pole A/B/C/N, NORMAL & EMERGENCY sides | µΩ | D | Δ/up | compare poles; ≤ mfr; investigate >50 % above lowest (NETA 7.22.3) | per pole per source |
| insulation_resistance | line-load-pole IR / CONTROL WIRING | MΩ | D | down | NETA 100.1 | per pole |
| pickup_voltage_measured | NORMAL SOURCE PICKUP VOLTAGE READING % PHASE A/B/C / EMERGENCY SOURCE VOLTAGE PICKUP | V / % | D | Δ | matches setting (typ. 90 % pickup / 85 % dropout) ±2–5 % | per phase |
| dropout_voltage_measured | NORMAL SOURCE DROPOUT VOLTAGE | V / % | D | Δ | matches setting | per phase |
| frequency_pickup_measured | EMERGENCY SOURCE FREQUENCY PICKUP / DROPOUT | Hz / % | D | Δ | matches setting (typ. 95 %) | no |
| transfer_time_measured | TIME DELAYS AS FOUND vs SPECIFIED (TRANSFER TO EMERGENCY / RE-TRANSFER TO NORMAL / OVERRIDE MOMENTARY OUTAGES / ENGINE COOL DOWN; TIMING TEST RESULTS) | s / min | D | Δ | within spec of setting | per timer |
| control_board_voltages | MOTHER BOARD CHECK OUT test points (82.6–91.4 VAC etc.) AS FOUND/AS LEFT | VAC/VDC | D | Δ(out-of-band) | within band printed on form | per test point |
| contact_inspection | MAIN/ARCING CONTACTS, OPERATING MECHANISM, INTERLOCKS | cat | D | cat | satisfactory | per item |

## 13. DISCONNECT_SWITCH / FUSE_GEAR (forms: LV AIR SWITCH, LOADBREAK DISCONNECT, SELECTOR SWITCH, FUSED DISCONNECT, BOLTED PRESSURE SWITCH)

> **NFPA 70B linkage — Ch. 17 (Switches) + Ch. 16 (Fuses).** Table 9.2.2: both **60/36/12 mo** all categories. The ESW paper highlights both chapters as accident-driven additions: "simple" disconnects have caused severe arc-flash burns, and Ch. 16 explicitly covers **fuse holders and clips** (verify correct fuse type/rating hasn't been swapped — a visual-inspection task). **70B-REQ:** `contact_resistance`, `insulation_resistance`, `blade_alignment`/mechanical operation + lubrication, `fuse_resistance` + fuse/holder/clip inspection, GF function where fitted. Nice-to-have: open/close speed and wipe/gap measurements (mfr-spec tier). `ampacity`, `voltage_rating`, `interrupting_rating` (kA), `bil_rating`, `momentary_rating` (FAULT CLOSING AMPS kA), `mechanism_type`, fuse nameplate (`fuse_class`, `fuse_ampacity`, FUSE CAT NO., REFILL ELEMENT, TCC NO.), GFR settings (see §5 GFP), `shunt_trip` (Y/N), `control_voltage`.

| canonical_key | labels / synonyms | unit | kind | bad | threshold | per_phase |
|---|---|---|---|---|---|---|
| contact_resistance | CONTACT µΩ / CONTACT RESISTANCE RDG-20°C / RES. MICRO-OHMS / BOLTED CONNECTIONS LINE-LOAD µΩ | µΩ | D | Δ/up | compare poles & similar switches; >50 % above lowest investigate (NETA 7.5) | per pole |
| fuse_resistance | FUSE mΩ / FUSE RESISTANCE - MICRO-OHMS / FUSE HOLDER mΩ | µΩ/mΩ | D | Δ | within 15 % of identical fuses (NETA 7.3) | per phase |
| insulation_resistance | POLE TO POLE / POLE TO FRAME / LINE-LOAD TO FRAME / LINE TO LOAD; matrix A-GND…B-C (fused disconnect) | MΩ | D | down | NETA 100.1 | per pole-pair |
| contact_wipe_gap_travel | ARCING/MAIN CONTACT WIPE / GAP / TRAVEL (inches) | in | D | Δ | per mfr | per pole |
| open_close_speed | OPENING/CLOSING SPEED (ft/sec) / CLOSE-OPEN SPEED | ft/s | D | Δ | per mfr | per pole |
| gf_pickup / gf_timing | GROUND FAULT PICKUP / TIMING | A / s | D | Δ | see GROUND_FAULT_PROTECTION | no |
| blade_alignment | BLADE ALIGNMENT/PENETRATION / TRAVEL STOPS / MECHANICAL OPERATION | cat | D | cat | satisfactory | per item |

## 14. INSTRUMENT_TRANSFORMER (CT / PT / CPT)

> **NFPA 70B linkage — RESERVED: Ch. 37 (Instrument Transformers) and Ch. 38 (Control Power Transformers) have no content in the 2023 edition.** No 70B-itemized tasks exist for CTs/PTs/CPTs yet — everything below is NETA MTS / IEEE C57.13 practice. In an EMP they ride along with their host switchgear/substation (Ch. 12 intervals) since relay/metering integrity depends on them; flag fields as NETA-required / 70B-pending. `ratio_nameplate` (RATIO :5 / NAMEPLATE RATIO / PRIMARY-SECONDARY AMPS or VOLTS), `accuracy_class` (ACCURACY CLASS/RATING, C400, 0.3B1.8), `burden_rating` (VA RATING / RATED OUTPUT (VA) / BURDEN RATING), `bil_rating`, `voltage_rating`, `insulation_type/rating`, `frequency`, `security_limiting_factor`, `saturation_standard` (ANSI 45/IEC), `phase_designation`.

| canonical_key | labels / synonyms | unit | kind | bad | threshold | per_phase |
|---|---|---|---|---|---|---|
| ratio_measured | ACTUAL RATIO / MEASURED RATIO vs EXPECTED-NAMEPLATE-CALCULATED RATIO | ratio | D | Δ | within accuracy class; form ALLOWED % ERROR 0.1 (PT) / RATIO % ERROR ≤0.5 (CT metering) | per tap per phase |
| ratio_error | RATIO % ERROR / % error | % | D | up | ≤0.1–1.2 % per class | per tap |
| polarity | POLARITY / IN PHASE-OUT OF PHASE / SUBTRACTIVE-ADDITIVE | pass/fail | D | cat | correct per nameplate | per winding |
| phase_displacement | PHASE DEV. (deg.) / PHASE ANGLE ° | deg/min | D | up | per accuracy class | per tap |
| excitation_curve | EXCITATION DATA / SATURATION VOLTAGE-CURRENT pairs / CORE SATURATION | V & mA series | D | Δ | curve matches C57.13 published; knee within mfr tolerance | per winding |
| knee_point | KNEE POINT X VOLTAGE / X CURRENT / KNEE VOLTAGE / ANSI 45° | V | D | down | ≥ class voltage (e.g. C400 → knee near 400 V); deviation = shorted turns | per winding |
| secondary_winding_resistance | WINDING RESISTANCE / RESISTANCE (Ohms) / MTO CT-PT RESISTANCE / DC TEST CURRENT + MEASURED RESISTANCE | Ω | D | Δ | vs factory/sister units | per winding |
| burden_measured | BURDEN VA / BURDEN IMPEDANCE / POWER FACTOR PHASE (Degree) | VA / Ω | D | up | connected burden ≤ rated burden | per winding |
| insulation_resistance | INSULATION Primary To Secondary / Primary To Ground / Secondary To Ground | MΩ | D | down | NETA 100.5 / ≥ class minimums | per winding pair |
| ct_pt_power_factor | C1/C2 POWER FACTOR % / TRANSFORMER OVERALL TESTS (GST/UST rows) / HOT COLLAR | % | D | up | ≤0.5–1 %; vs nameplate (HV CTs/PTs) | per terminal |
| cpt_ratio / cpt_ir | CONTROL POWER TRANSFORMER TURNS RATIO / % ERROR / INSULATION TEST | ratio / MΩ | D | Δ/down | ±0.5 %; NETA 100.5 | per unit |

## 15. SURGE_ARRESTER (NETA 7.19; surge-arrester blocks on transformer & PF forms)

> **NFPA 70B linkage — no dedicated chapter; arresters are maintained as substation/switchgear components under Ch. 12** (substation "special" row 60/36/12; visual 12/12/6 incl. HV insulator/corona checks at 12/6/4 for corona detection). Fields below are NETA/Doble practice satisfying the Ch. 12 electrical-testing duty for the substation as a whole. `rated_kv` (RATED kV), `mcov`, `type` (station/intermediate/distribution), `unit_catalog`/`overall_catalog`, `location`.
Diagnostic: `insulation_resistance` (MΩ, down, ≥ mfr; commonly >1000 MΩ @2.5–5 kV); `arrester_watts_loss` (DIRECT Watts via GST-GND, up, compare to Doble published values for model & to sister phases); `arrester_leakage_ma` (mA, Δ, compare phases); `grading_current` (mA, Δ); per phase: yes.

---

## 16. Genuinely ambiguous fields across equipment types

These labels appear on many form families — the parser MUST disambiguate using (a) form title / equipment type, (b) neighboring column headers, (c) units:

1. **"INSULATION RESISTANCE" / "MEGOHMS" / "IR"** — appears on every type. Same canonical key everywhere, but the *connection label* (H-L+G vs POLE TO FRAME vs A-GND vs PRI-SEC) determines the sub-measurement. Beware: PowerDB also uses bare "IR" as the column header for *Insulation Rating code* (G/D/I/B/Q) on PF test tables — a single letter, not megohms. Disambiguate by value type (letter vs number).
2. **"POWER FACTOR"** — (a) insulation %PF (Doble) on xfmr/breaker/bushing/cable/CT, (b) **oil** power factor D-924, (c) UPS/generator nameplate displacement PF, (d) leakage-reactance-test electrical PF. Units all "%". Use surrounding test-section title.
3. **"CAPACITANCE"** — bushing/winding pF vs cable nF/µF vs leakage-reactance µF vs filter caps. Unit + context.
4. **"WINDING RESISTANCE" vs "CONTACT/POLE RESISTANCE" vs "FUSE RESISTANCE" vs battery "RESISTANCE"** — all "resistance" in Ω/mΩ/µΩ. µΩ on breaker/switch forms = contact; µΩ on battery forms = cell internal ohmic or strap; Ω/mΩ on transformer/CT = winding.
5. **"SPECIFIC GRAVITY"** — battery electrolyte (≈1.2, per-cell, diagnostic-down) vs oil (≈0.88, single, reference). Value range disambiguates.
6. **"PICKUP"** — relay pickup (A), breaker trip-unit pickup (A), ATS voltage pickup (V/%), GFR pickup. Same word, four homes.
7. **"TRIP TIME" / "TIMING"** — breaker open time (ms/cycles), relay timing (s at multiple), OL relay @300 % (s), recloser TCC time, ATS transfer delay.
8. **"% ERROR"** — TTR error, CT/PT ratio error, CPT ratio error. Same semantics; key off equipment.
9. **"TEMPERATURE"** — ambient vs oil vs winding vs cell vs equipment; only ambient+humidity is the report header pair.
10. **"COUNTER READING"** — breaker ops counter vs LTC counter vs recloser counter; reference everywhere.
11. **"TEST kV / TEST VOLTAGE"** — always a test condition (R), never a result; appears adjacent to results in every table.
12. **"mA" / "WATTS" (DIRECT columns)** — companions of every Doble PF test; only meaningful with the PF row label; don't classify standalone.
13. **"DIELECTRIC STRENGTH / BREAKDOWN kV"** — transformer oil vs breaker oil vs OTS lab instrument; same canonical key `dielectric_breakdown`, route by parent asset.
14. **AS FOUND / AS LEFT** pairs — relays, breakers, MCCBs, reclosers, ATS, oil levels. Parse both; deficiency on AS FOUND, resolution on AS LEFT.
15. **"PHASE A/B/C" vs "POLE 1/2/3" vs "H1/H2/H3, X1/X2/X3" vs "T1/T2/T3" vs "L1/L2/L3"** — all per-phase axes; normalize to phase index with a role tag (line/load, hi/lo winding).

---

## 17. Machine-friendly vocabulary sketch (lift into parser)

```python
# kind: D=diagnostic, R=reference; bad: up|down|delta|cat|none; pp=per_phase/pole/cell
# labels are case-insensitive regex-ish fragments as printed on PowerDB/Doble/Megger forms.

FIELD_LIBRARY = {
  "_COMMON": [
    {"key":"ambient_temp","labels":["AMBIENT TEMP"],"unit":"degF","kind":"R","bad":"none","pp":False},
    {"key":"humidity","labels":["HUMIDITY"],"unit":"%","kind":"R","bad":"none","pp":False},
    {"key":"equipment_temp","labels":["EQUIPMENT TEMPERATURE","OIL TEMP","TANK TEMP","WINDING TEMP","CORE/COIL TEMP","CABLE TEMP"],"unit":"degC","kind":"R","bad":"none","pp":False},
    {"key":"temp_correction_factor","labels":["TCF","TEMPERATURE CORRECTION FACTOR","CORR FACTOR"],"unit":None,"kind":"R","bad":"none","pp":False},
    {"key":"test_voltage","labels":["TEST VOLTAGE","TEST KV","KVDC","MEGGER TEST VOLTAGE"],"unit":"kV","kind":"R","bad":"none","pp":False},
    {"key":"insulation_rating_code","labels":["INSULATION RATING","IR"],"unit":"code GDIBQ","kind":"D","bad":"cat","threshold":"D/I/B/Q => deficiency","pp":True},
    {"key":"deficiencies","labels":["DEFICIENCIES"],"unit":None,"kind":"D","bad":"cat","pp":False},
  ],

  "TRANSFORMER_LIQUID": [
    {"key":"insulation_resistance","labels":["INSULATION RESISTANCE","MEGOHMS","MEGGER","IR (megohms)","HIGH TO LOW","LOW TO HIGH","HIGH+LOW TO GND","PRIMARY TO GROUND","PRIMARY TO SECONDARY","SECONDARY TO GROUND"],"unit":"Mohm","kind":"D","bad":"down","threshold":"NETA MTS Tab100.5; >=1 Mohm/kV @20C; trend","pp":True},
    {"key":"polarization_index","labels":["POLARIZATION INDEX","P.I.","PI"],"unit":"ratio","kind":"D","bad":"down","threshold":">=2.0 good; <1.0 dangerous (IEEE C57.152)","pp":True},
    {"key":"dielectric_absorption_ratio","labels":["D.A.R.","DAR","DIELECTRIC ABSORPTION","60/30"],"unit":"ratio","kind":"D","bad":"down","threshold":">=1.4 good (Megger)","pp":True},
    {"key":"turns_ratio","labels":["TTR","ACTUAL TTR","ACTUAL RATIO","MEASURED RATIO","TURNS RATIO","CALC RATIO"],"unit":"ratio","kind":"D","bad":"delta","threshold":"+/-0.5% of nameplate (IEEE C57.12.00)","pp":True},
    {"key":"turns_ratio_error","labels":["% ERROR","PERCENT ERROR","% DEVIATION"],"unit":"%","kind":"D","bad":"up","threshold":"<=0.5%","pp":True},
    {"key":"excitation_current","labels":["I EXC","EXCITATION CURRENT","EXCITING CURRENT","IEXC MA"],"unit":"mA","kind":"D","bad":"delta","threshold":"phase-pattern + trend","pp":True},
    {"key":"winding_resistance","labels":["WINDING RESISTANCE","MEASURED RESISTANCE","H1-H3","H2-H1","X1-X3","CORRECTED TO 85"],"unit":"ohm|mohm","kind":"D","bad":"delta","threshold":"phases within ~1-2%; vs factory +/-5%","pp":True},
    {"key":"power_factor","labels":["POWER FACTOR %","% POWER FACTOR","DISSIPATION FACTOR","TAN DELTA","CHL","CHG","CLG"],"unit":"%","kind":"D","bad":"up","threshold":"<=0.5% @20C oil-filled; >1.0% bad (Doble/NETA)","pp":True},
    {"key":"capacitance","labels":["CAPACITANCE C (PF)","CAP. (PF)"],"unit":"pF","kind":"D","bad":"delta","threshold":"+/-5% of nameplate/baseline","pp":True},
    {"key":"bushing_c1_power_factor","labels":["C1 POWER FACTOR","BUSHING C1"],"unit":"%","kind":"D","bad":"up","threshold":">2x nameplate investigate; >3x remove (Doble)","pp":True},
    {"key":"bushing_c1_capacitance","labels":["C1 CAPACITANCE","CAP. (PF)"],"unit":"pF","kind":"D","bad":"delta","threshold":"+/-5% nameplate","pp":True},
    {"key":"hot_collar_watts","labels":["HOT COLLAR"],"unit":"W","kind":"D","bad":"up","threshold":"<=0.1 W typical","pp":True},
    {"key":"leakage_reactance_pct","labels":["LEAKAGE REACTANCE","% IMPEDANCE","DELTA % REACTANCE"],"unit":"%","kind":"D","bad":"delta","threshold":"+/-3% of nameplate %Z","pp":True},
    {"key":"magnetic_balance_pct","labels":["MAGNETIC BALANCE","MEASURED PERCENTAGE"],"unit":"%","kind":"D","bad":"delta","threshold":"symmetry pattern","pp":True},
    {"key":"hipot_leakage_current","labels":["HIGH POTENTIAL","MICRO/MILLIAMPERES","LEAKAGE CURRENT"],"unit":"uA|mA","kind":"D","bad":"up","threshold":"stable/decreasing; no breakdown","pp":True},
    {"key":"dielectric_breakdown","labels":["DIELECTRIC STRENGTH","D-877","D-1816","BREAKDOWN VOLTAGE"],"unit":"kV","kind":"D","bad":"down","threshold":">=26-30 kV D877 service (IEEE C57.106)","pp":False},
    {"key":"interfacial_tension","labels":["INTERFACIAL TENSION","IFT","D-971"],"unit":"dyn/cm","kind":"D","bad":"down","threshold":">=25 service; <22 sludge","pp":False},
    {"key":"acid_number","labels":["ACIDITY","ACID NUMBER","D-974","MG KOH/G"],"unit":"mgKOH/g","kind":"D","bad":"up","threshold":"<=0.20 service; <=0.03 new","pp":False},
    {"key":"water_content","labels":["WATER CONTENT","MOISTURE","D-1533","K.F."],"unit":"ppm","kind":"D","bad":"up","threshold":"<=35 ppm (<=69kV)","pp":False},
    {"key":"oil_power_factor_25c","labels":["POWER FACTOR-25","PF AT 25","D-924"],"unit":"%","kind":"D","bad":"up","threshold":"<=0.5% service","pp":False},
    {"key":"oil_color","labels":["ASTM COLOR","COLOR NUMBER","D-1500"],"unit":"ASTM","kind":"D","bad":"up","threshold":"<=3.5","pp":False},
    {"key":"inhibitor_content","labels":["INHIBITOR","DBPC","OXIDATION INHIBITOR"],"unit":"wt%","kind":"D","bad":"down","threshold":">=0.09%","pp":False},
    {"key":"pcb_content","labels":["PCB CONTENT","D-4059"],"unit":"ppm","kind":"R","bad":"up","threshold":"<50 ppm non-PCB (regulatory)","pp":False},
    {"key":"dga_hydrogen","labels":["HYDROGEN","(H2)"],"unit":"ppm","kind":"D","bad":"up","threshold":"<100","pp":False},
    {"key":"dga_methane","labels":["METHANE","(CH4)"],"unit":"ppm","kind":"D","bad":"up","threshold":"<120","pp":False},
    {"key":"dga_ethane","labels":["ETHANE","(C2H6)"],"unit":"ppm","kind":"D","bad":"up","threshold":"<65","pp":False},
    {"key":"dga_ethylene","labels":["ETHYLENE","(C2H4)"],"unit":"ppm","kind":"D","bad":"up","threshold":"<50","pp":False},
    {"key":"dga_acetylene","labels":["ACETYLENE","(C2H2)"],"unit":"ppm","kind":"D","bad":"up","threshold":"<1-2 (2019); any rise = alert","pp":False},
    {"key":"dga_carbon_monoxide","labels":["CARBON MONOXIDE","(CO)"],"unit":"ppm","kind":"D","bad":"up","threshold":"<350","pp":False},
    {"key":"dga_carbon_dioxide","labels":["CARBON DIOXIDE","(CO2)"],"unit":"ppm","kind":"D","bad":"up","threshold":"<2500","pp":False},
    {"key":"dga_tdcg","labels":["TOTAL COMBUSTIBLE GAS","TDCG"],"unit":"ppm","kind":"D","bad":"up","threshold":"<720 cond.1 (C57.104)","pp":False},
    {"key":"furan_2fal","labels":["2FAL","FURAN"],"unit":"ppb","kind":"D","bad":"up","threshold":">250 investigate; >2500 EOL","pp":False},
    # nameplate refs
    {"key":"kva_rating","labels":["KVA","CAPACITY"],"unit":"kVA","kind":"R","bad":"none","pp":False},
    {"key":"impedance_pct","labels":["IMPEDANCE","%Z"],"unit":"%","kind":"R","bad":"none","pp":False},
    {"key":"bil_rating","labels":["BIL","B.I.L."],"unit":"kV","kind":"R","bad":"none","pp":False},
    {"key":"tap_setting","labels":["TAP SETTING","TAP POSITION","DETC","LTC"],"unit":None,"kind":"R","bad":"none","pp":False},
    {"key":"oil_volume","labels":["OIL VOLUME","GALLONS OF OIL"],"unit":"gal","kind":"R","bad":"none","pp":False},
    {"key":"winding_material","labels":["WINDING MATERIAL"],"unit":None,"kind":"R","bad":"none","pp":False},
  ],

  "TRANSFORMER_DRY": "subset of TRANSFORMER_LIQUID minus oil/DGA; add ac_overpotential_result (pass/fail), insulation_class, temperature_rise (R)",

  "CIRCUIT_BREAKER_LV": [
    {"key":"contact_resistance","labels":["POLE RESISTANCE","CONTACT RESISTANCE","MICRO-OHMS","MICROHMS","DLRO"],"unit":"uohm","kind":"D","bad":"delta","threshold":">50% above lowest pole investigate (NETA)","pp":True},
    {"key":"insulation_resistance","labels":["POLE TO POLE","POLE TO FRAME","LINE TO LOAD","ACROSS OPEN POLE","CONTROL WIRING"],"unit":"Mohm","kind":"D","bad":"down","threshold":"NETA 100.1 (100 Mohm @480V)","pp":True},
    {"key":"long_time_trip_time","labels":["LONG TIME","TIME AT 300%","LTPU","TIME BAND"],"unit":"s","kind":"D","bad":"delta","threshold":"within mfr TCC band (form MIN/MAX)","pp":True},
    {"key":"short_time_pickup_measured","labels":["SHORT TIME","STPU"],"unit":"A","kind":"D","bad":"delta","threshold":"setting +/-10%","pp":True},
    {"key":"instantaneous_pickup_measured","labels":["INSTANTANEOUS","IPU","INST. PU","TRIP / NO TRIP"],"unit":"A","kind":"D","bad":"delta","threshold":"setting +/-10-20%","pp":True},
    {"key":"ground_fault_pickup_measured","labels":["GROUND FAULT","GFPU","GRD. FLT."],"unit":"A","kind":"D","bad":"delta","threshold":"setting tol; NEC 230.95 <=1200A, <=1s @3000A","pp":True},
    {"key":"voltage_drop","labels":["VOLTAGE DROP"],"unit":"mV","kind":"D","bad":"delta","threshold":"compare poles","pp":True},
    {"key":"setting_long_time_pickup","labels":["RATING PLUG","SENSOR TAP","LONG TIME PU","PICKUP","DELAY","CURVE"],"unit":"A","kind":"R","bad":"none","pp":False},
    {"key":"frame_size","labels":["FRAME SIZE"],"unit":"A","kind":"R","bad":"none","pp":False},
    {"key":"counter_reading","labels":["COUNTER READING"],"unit":"count","kind":"R","bad":"none","pp":False},
  ],

  "CIRCUIT_BREAKER_MV": [
    {"key":"contact_resistance","labels":["CONTACT RESISTANCE","POLE RESISTANCE","INTERRUPTER RESISTANCE","MICROHMS","MILLIOHMS"],"unit":"uohm","kind":"D","bad":"delta","threshold":"<= mfr; >50% above lowest investigate","pp":True},
    {"key":"insulation_resistance","labels":["POLE TO POLE","POLE TO FRAME","LINE TO FRAME","LOAD TO FRAME","LINE TO LOAD"],"unit":"Mohm","kind":"D","bad":"down","threshold":"NETA 100.1 per kV class","pp":True},
    {"key":"breaker_power_factor","labels":["C1G","C2G","C12","POWER FACTOR %","S1"],"unit":"%","kind":"D","bad":"up","threshold":"compare sisters/Doble; bushings <=0.5%","pp":True},
    {"key":"breaker_capacitance","labels":["CAPACITANCE C (PF)"],"unit":"pF","kind":"D","bad":"delta","threshold":"vs baseline","pp":True},
    {"key":"tank_loss_index","labels":["TANK LOSS INDEX","TLI"],"unit":"W","kind":"D","bad":"up","threshold":"> ~+0.1 W investigate (Doble)","pp":True},
    {"key":"open_close_timing","labels":["TIMING","TRIP TIME","OPEN / CLOSE TIMES"],"unit":"ms|s","kind":"D","bad":"delta","threshold":"mfr spec; recloser TCC band","pp":True},
    {"key":"opening_speed","labels":["OPENING SPEED","CLOSING SPEED"],"unit":"ft/s","kind":"D","bad":"delta","threshold":"mfr curve","pp":True},
    {"key":"contact_travel","labels":["CONTACT TRAVEL","WIPE","GAP"],"unit":"in","kind":"D","bad":"delta","threshold":"mfr","pp":True},
    {"key":"vacuum_integrity","labels":["VACUUM INTEGRITY","VACUUM BOTTLE"],"unit":"pass/fail","kind":"D","bad":"cat","threshold":"withstand","pp":True},
    {"key":"oil_dielectric","labels":["OIL DIELECTRIC"],"unit":"kV","kind":"D","bad":"down","threshold":">=25-30 kV","pp":True},
    {"key":"sf6_moisture","labels":["SF6 MOISTURE","DEW POINT"],"unit":"degC","kind":"D","bad":"up","threshold":"dewpoint <= -35C","pp":False},
    {"key":"min_trip_test","labels":["MINIMUM TRIP"],"unit":"A","kind":"D","bad":"delta","threshold":"coil band","pp":False},
    {"key":"counter_reading","labels":["OPERATIONS COUNTER","COUNTER"],"unit":"count","kind":"R","bad":"none","pp":False},
  ],

  "PROTECTION_RELAY": [
    {"key":"pickup_current","labels":["PICKUP TESTS","TIME OVERCURRENT PICKUP","AS FOUND (AMPS)"],"unit":"A","kind":"D","bad":"delta","threshold":"within form MIN/MAX (tap +/-5-10%)","pp":True},
    {"key":"instantaneous_pickup","labels":["INSTANTANEOUS PICKUP"],"unit":"A","kind":"D","bad":"delta","threshold":"setting +/-10%","pp":True},
    {"key":"timing_test","labels":["TIMING TESTS","MULTIPLE","AS FOUND (SECONDS)"],"unit":"s","kind":"D","bad":"delta","threshold":"curve band at 2x/3x/5x (+/-10%)","pp":True},
    {"key":"voltage_pickup","labels":["PICKUP VOLTAGE","UNDER VOLTAGE","OVER VOLTAGE"],"unit":"V","kind":"D","bad":"delta","threshold":"setting +/-5%","pp":True},
    {"key":"reach_measured","labels":["REACH TESTS","MTA","CHARACTERISTIC"],"unit":"ohm|deg","kind":"D","bad":"delta","threshold":"calc +/-3%; MTA +/-2deg","pp":True},
    {"key":"trip_circuit_test","labels":["TRIP CIRCUIT TESTED","TRIP TEST"],"unit":"pass/fail","kind":"D","bad":"cat","threshold":"must trip","pp":False},
    {"key":"setting_tap","labels":["TAP"],"unit":"A","kind":"R","bad":"none","pp":False},
    {"key":"setting_time_dial","labels":["TIME DIAL"],"unit":None,"kind":"R","bad":"none","pp":False},
    {"key":"ct_ratio","labels":["CT RATIO","CTR"],"unit":"ratio","kind":"R","bad":"none","pp":False},
    {"key":"settings_blob","labels":["RELAY SETTINGS","51","50","67","81","79"],"unit":None,"kind":"R","bad":"none","pp":False},
  ],

  "CABLE_MV_HV": [
    {"key":"insulation_resistance","labels":["MEGOHMS","GIGA-OHMS","20C READING"],"unit":"Mohm","kind":"D","bad":"down","threshold":"R=K*log10(D/d)*1000/L; trend","pp":True},
    {"key":"polarization_index","labels":["P.I.","POLARIZATION INDEX"],"unit":"ratio","kind":"D","bad":"down","threshold":">=2 typical","pp":True},
    {"key":"vlf_withstand_result","labels":["VLF","BREAKDOWN YES NO","TIME TO FAILURE","WITHSTAND"],"unit":"pass/fail","kind":"D","bad":"cat","threshold":"IEEE 400.2 voltage 30-60 min, no breakdown","pp":True},
    {"key":"tan_delta","labels":["TAN DELTA","TD","E-3"],"unit":"1e-3","kind":"D","bad":"up","threshold":"XLPE @U0: <4 ok, 4-50 study, >50 action (IEEE 400.2)","pp":True},
    {"key":"tan_delta_tip_up","labels":["TIP UP","DELTA TD"],"unit":"1e-3","kind":"D","bad":"up","threshold":"<5 ok XLPE","pp":True},
    {"key":"tan_delta_stability","labels":["STABILITY","STD DEV"],"unit":"1e-3","kind":"D","bad":"up","threshold":"<0.1","pp":True},
    {"key":"dc_hipot_leakage","labels":["HIGH POTENTIAL","UA","MICROAMPS"],"unit":"uA","kind":"D","bad":"up","threshold":"stable/decreasing; compare phases","pp":True},
    {"key":"shield_resistance","labels":["SHIELD RESISTANCE","SHIELD RESIST","CONCENTRIC NEUTRAL"],"unit":"ohm","kind":"D","bad":"up","threshold":"continuity; compare phases","pp":True},
    {"key":"cable_capacitance","labels":["NANO FARADS","MICRO FARADS"],"unit":"nF","kind":"D","bad":"delta","threshold":"compare phases","pp":True},
    {"key":"partial_discharge","labels":["PD","PC","PDIV","PDEV"],"unit":"pC","kind":"D","bad":"up","threshold":"no sustained PD at U0 (IEEE 400.3)","pp":True},
    {"key":"cable_length","labels":["LENGTH FT"],"unit":"ft","kind":"R","bad":"none","pp":False},
    {"key":"insulation_type","labels":["INSULATION TYPE","XLPE","EPR","PILC"],"unit":None,"kind":"R","bad":"none","pp":False},
  ],

  "CABLE_LV": [
    {"key":"insulation_resistance","labels":["A - GND","B - GND","A-B","RDG","20C"],"unit":"Mohm","kind":"D","bad":"down","threshold":"NETA 100.1: 25 Mohm @300V, 100 Mohm @600V","pp":True},
  ],

  "BATTERY_SYSTEM": [   # also UPS_BATTERY
    {"key":"cell_float_voltage","labels":["CELL VOLTAGE","FLOAT VOLTAGE","VOLTAGE (VOLTS)"],"unit":"V","kind":"D","bad":"delta","threshold":"mfr float band; low cell = deficiency (IEEE 450)","pp":True},
    {"key":"string_float_voltage","labels":["OVERALL VOLTAGE","TOTAL STRING VOLTAGE"],"unit":"V","kind":"D","bad":"delta","threshold":"= charger setting","pp":False},
    {"key":"cell_internal_ohmic","labels":["RESISTANCE (MICRO-OHMS)","IMPEDANCE (MILLI-OHMS)","% DEVIATION","% VARIATION","% CHANGE"],"unit":"uohm","kind":"D","bad":"up","threshold":">=20% above baseline investigate; >=30-50% replace (IEEE 1188)","pp":True},
    {"key":"intercell_resistance","labels":["INTERCELL RESISTANCE","STRAP"],"unit":"uohm","kind":"D","bad":"up","threshold":"<=10-20% above baseline/avg (IEEE 450)","pp":True},
    {"key":"specific_gravity","labels":["SPECIFIC GRAVITY","SPEC. GRAVITY","HYDROMETER"],"unit":"sg","kind":"D","bad":"down","threshold":">=nominal; +/-0.010 of avg","pp":True},
    {"key":"capacity_percent","labels":["PERCENT CAPACITY","BATTERY CAPACITY - PERCENT"],"unit":"%","kind":"D","bad":"down","threshold":">=80% pass; replace <80% (IEEE 450/1188)","pp":False},
    {"key":"discharge_duration","labels":["ACTUAL DISCHARGE TIME","ACTUAL DISCHARGE - MINUTES"],"unit":"min","kind":"D","bad":"down","threshold":">= rated x temp correction","pp":False},
    {"key":"cell_temperature","labels":["TEMP"],"unit":"degC","kind":"D","bad":"delta","threshold":"spread <=3C","pp":True},
    {"key":"float_current","labels":["FLOAT CURRENT"],"unit":"A","kind":"D","bad":"up","threshold":"per mfr (thermal runaway)","pp":False},
    {"key":"ripple_current","labels":["RIPPLE CURRENT","TOTAL AC CURRENT"],"unit":"A","kind":"D","bad":"up","threshold":"<=5A/100Ah VRLA","pp":False},
    {"key":"terminal_ground_voltage","labels":["TERMINAL TO GND"],"unit":"V","kind":"D","bad":"delta","threshold":"balanced; shift = DC ground fault","pp":False},
    {"key":"amp_hour_rating","labels":["CAPACITY RATING (AH)","AMP HOUR"],"unit":"Ah","kind":"R","bad":"none","pp":False},
    {"key":"cell_count","labels":["NUMBER OF CELLS"],"unit":"count","kind":"R","bad":"none","pp":False},
  ],

  "GROUNDING_SYSTEM": [
    {"key":"ground_resistance","labels":["FALL OF POTENTIAL","GROUND RESISTANCE","GROUND IMPEDANCE","CLAMP-ON","3-POINT"],"unit":"ohm","kind":"D","bad":"up","threshold":"<=1 ohm substation / <=5 ohm commercial (IEEE 142)","pp":False},
    {"key":"point_to_point_resistance","labels":["POINT TO POINT","CONTINUITY","BONDING"],"unit":"ohm","kind":"D","bad":"up","threshold":"<=0.5 ohm typical","pp":False},
    {"key":"soil_resistivity","labels":["SOIL RESISTIVITY","WENNER","OHM-METER","LAYER RESISTIVITY"],"unit":"ohm-m","kind":"R","bad":"none","threshold":"design input","pp":False},
    {"key":"touch_voltage","labels":["TOUCH VOLTAGE"],"unit":"V","kind":"D","bad":"up","threshold":"<= IEEE 80 tolerable","pp":False},
    {"key":"step_voltage","labels":["STEP VOLTAGE"],"unit":"V","kind":"D","bad":"up","threshold":"<= IEEE 80 tolerable","pp":False},
    {"key":"gpr","labels":["GROUND POTENTIAL RISE","GPR","TRANSFER VOLTAGE"],"unit":"V","kind":"D","bad":"up","threshold":"<= design","pp":False},
  ],

  "SWITCHGEAR": [   # + SWITCHBOARD, PANELBOARD, BUSWAY
    {"key":"bus_insulation_resistance","labels":["A-GND","B-GND","C-GND","N-GND","A-B","A-C","B-C","BUS SECTION TESTED"],"unit":"Mohm","kind":"D","bad":"down","threshold":"NETA 100.1: 100 Mohm @480V, 1 Gohm @5kV, 5 Gohm @15kV","pp":True},
    {"key":"bus_hipot_leakage","labels":["LEAKAGE - MICROAMPS","TOTAL LEAKAGE","HIGHPOTENTIAL"],"unit":"uA","kind":"D","bad":"up","threshold":"no breakdown @ NETA 100.2 voltage","pp":True},
    {"key":"bus_joint_resistance","labels":["RESISTANCE IN MICRO-OHMS","BUS CONNECTION","CONNECTION RESISTANCE"],"unit":"uohm","kind":"D","bad":"delta","threshold":"compare similar joints; >50% above lowest investigate","pp":True},
    {"key":"inspection_condition","labels":["G P C I","INSPECTED","CONDITION"],"unit":"code","kind":"D","bad":"cat","threshold":"P/I = deficiency","pp":False},
  ],

  "TRANSFER_SWITCH": [
    {"key":"pole_resistance","labels":["POLE RESISTANCE","AS FOUND","20C"],"unit":"uohm","kind":"D","bad":"delta","threshold":"NETA; compare poles; both sources","pp":True},
    {"key":"pickup_voltage_measured","labels":["PICKUP VOLTAGE","SOURCE PICKUP"],"unit":"V|%","kind":"D","bad":"delta","threshold":"matches setting (90%/85% typ)","pp":True},
    {"key":"dropout_voltage_measured","labels":["DROPOUT VOLTAGE"],"unit":"V|%","kind":"D","bad":"delta","threshold":"matches setting","pp":True},
    {"key":"frequency_pickup_measured","labels":["FREQUENCY PICKUP"],"unit":"Hz","kind":"D","bad":"delta","threshold":"matches setting (95% typ)","pp":False},
    {"key":"transfer_time_measured","labels":["TIME DELAYS","TRANSFER TO EMERGENCY","RE-TRANSFER TO NORMAL","ENGINE COOL DOWN","OVERRIDE MOMENTARY"],"unit":"s|min","kind":"D","bad":"delta","threshold":"AS FOUND within SPECIFIED","pp":False},
    {"key":"td_settings","labels":["ADJUSTMENT RANGE","FACTORY SET @"],"unit":"s|min","kind":"R","bad":"none","pp":False},
  ],

  "DISCONNECT_SWITCH": [   # + FUSE_GEAR
    {"key":"contact_resistance","labels":["CONTACT","MICRO-OHMS","BOLTED CONNECTIONS LINE/LOAD"],"unit":"uohm","kind":"D","bad":"delta","threshold":"compare poles; >50% above lowest investigate","pp":True},
    {"key":"fuse_resistance","labels":["FUSE","FUSE HOLDER"],"unit":"uohm|mohm","kind":"D","bad":"delta","threshold":"within 15% of identical fuses (NETA 7.3)","pp":True},
    {"key":"insulation_resistance","labels":["POLE TO POLE","POLE TO FRAME","LINE TO LOAD"],"unit":"Mohm","kind":"D","bad":"down","threshold":"NETA 100.1","pp":True},
    {"key":"gf_pickup_measured","labels":["GROUND FAULT PICKUP"],"unit":"A","kind":"D","bad":"delta","threshold":"NEC 230.95","pp":False},
    {"key":"gf_trip_time","labels":["GROUND FAULT TIMING"],"unit":"s","kind":"D","bad":"up","threshold":"<=1s @3000A","pp":False},
  ],

  "INSTRUMENT_TRANSFORMER": [
    {"key":"ratio_measured","labels":["ACTUAL RATIO","MEASURED RATIO"],"unit":"ratio","kind":"D","bad":"delta","threshold":"within accuracy class (0.1-1.2%)","pp":True},
    {"key":"ratio_error","labels":["RATIO % ERROR","% ERROR"],"unit":"%","kind":"D","bad":"up","threshold":"<= class","pp":True},
    {"key":"polarity","labels":["POLARITY","IN PHASE","SUBTRACTIVE"],"unit":"pass/fail","kind":"D","bad":"cat","threshold":"correct","pp":True},
    {"key":"phase_displacement","labels":["PHASE DEV","PHASE (DEG)"],"unit":"deg","kind":"D","bad":"up","threshold":"per class","pp":True},
    {"key":"knee_point","labels":["KNEE POINT","KNEE VOLTAGE","SATURATION"],"unit":"V","kind":"D","bad":"down","threshold":"matches C-class / mfr curve","pp":True},
    {"key":"excitation_curve","labels":["EXCITATION DATA","VOLTAGE/CURRENT"],"unit":"series","kind":"D","bad":"delta","threshold":"IEEE C57.13.1 curve match","pp":True},
    {"key":"secondary_winding_resistance","labels":["WINDING RESISTANCE","MEASURED RESISTANCE"],"unit":"ohm","kind":"D","bad":"delta","threshold":"vs factory","pp":True},
    {"key":"burden_measured","labels":["BURDEN","VA"],"unit":"VA|ohm","kind":"D","bad":"up","threshold":"<= rated burden","pp":True},
    {"key":"insulation_resistance","labels":["PRIMARY TO SECONDARY","PRIMARY TO GROUND","SECONDARY TO GROUND"],"unit":"Mohm","kind":"D","bad":"down","threshold":"NETA 100.5","pp":True},
    {"key":"accuracy_class","labels":["ACCURACY CLASS","ACCURACY RATING"],"unit":None,"kind":"R","bad":"none","pp":False},
    {"key":"burden_rating","labels":["VA RATING","RATED OUTPUT","BURDEN RATING"],"unit":"VA","kind":"R","bad":"none","pp":False},
  ],

  "GENERATOR": [   # MOTOR shares the first four
    {"key":"stator_insulation_resistance","labels":["PHASE A TO GROUND","READING (MEGOHMS)","20C READING"],"unit":"Mohm","kind":"D","bad":"down","threshold":"IEEE 43: >=100 Mohm modern form-wound; >=kV+1 legacy","pp":True},
    {"key":"polarization_index","labels":["POLARIZATION INDEX"],"unit":"ratio","kind":"D","bad":"down","threshold":">=2.0 class B/F (IEEE 43)","pp":True},
    {"key":"winding_resistance","labels":["WINDING RESISTANCE"],"unit":"ohm","kind":"D","bad":"delta","threshold":"phases within 1-3%","pp":True},
    {"key":"tip_up_power_factor","labels":["TIP UP","PF (%)","25 50 75 100"],"unit":"%","kind":"D","bad":"up","threshold":"low/flat tip-up; rising = PD","pp":True},
    {"key":"load_test_kw","labels":["MEASURED KILOWATT","TARGET KILOWATT"],"unit":"kW","kind":"D","bad":"down","threshold":"reaches rated steps (NFPA 110)","pp":False},
    {"key":"frequency","labels":["FREQUENCY - HERTZ","ENGINE SPEED"],"unit":"Hz","kind":"D","bad":"delta","threshold":"60 +/-0.5%","pp":False},
    {"key":"engine_oil_pressure","labels":["ENGINE OIL PRESSURE"],"unit":"psi","kind":"D","bad":"down","threshold":"mfr band","pp":False},
    {"key":"engine_coolant_temp","labels":["ENGINE WATER","RADIATOR WATER"],"unit":"degF","kind":"D","bad":"up","threshold":"< alarm","pp":False},
    {"key":"shutdown_alarm_tests","labels":["OVERSPEED SHUTDOWN","LOW OIL PRESSURE SHUTDOWN","EMERGENCY STOP","ALARM INITIATED"],"unit":"pass/fail","kind":"D","bad":"cat","threshold":"each simulated device operates","pp":False},
    {"key":"battery_voltage_cranking","labels":["BATTERY VOLTAGE","CRANKING VOLTAGE"],"unit":"V","kind":"D","bad":"down","threshold":"mfr","pp":False},
  ],

  "MCC": [
    {"key":"contact_resistance","labels":["CONTACT RESISTANCE (MICRO OHMS)"],"unit":"uohm","kind":"D","bad":"delta","threshold":"compare buckets/poles","pp":True},
    {"key":"insulation_resistance","labels":["INSULATION RESISTANCE @ 1000V"],"unit":"Mohm","kind":"D","bad":"down","threshold":"NETA 100.1","pp":True},
    {"key":"overload_trip_time","labels":["O/L TEST (SEC)","DELAY @ 300%"],"unit":"s","kind":"D","bad":"delta","threshold":"mfr curve @300% (NETA 7.16)","pp":True},
    {"key":"breaker_mcp_pickup","labels":["INSTANTANEOUS PICKUP"],"unit":"A","kind":"D","bad":"delta","threshold":"setting tol","pp":True},
  ],

  "VFD": [
    {"key":"dc_bus_voltage","labels":["DC BUS VOLTAGE"],"unit":"VDC","kind":"D","bad":"delta","threshold":"~1.35 x VLL","pp":False},
    {"key":"dc_bus_ripple","labels":["DC BUS AC RIPPLE"],"unit":"VAC","kind":"D","bad":"up","threshold":"<= ~4 VAC","pp":False},
    {"key":"input_voltage","labels":["INPUT VOLTAGE","L1-L2"],"unit":"VAC","kind":"D","bad":"delta","threshold":"imbalance <=2%","pp":True},
    {"key":"output_voltage","labels":["OUTPUT TO LOAD","T1-T2"],"unit":"VAC","kind":"D","bad":"delta","threshold":"balanced","pp":True},
    {"key":"cooling_fans_failed","labels":["FANS NOT OPERATING"],"unit":"count","kind":"D","bad":"up","threshold":"0","pp":False},
  ],

  "SURGE_ARRESTER": [
    {"key":"insulation_resistance","labels":["INSULATION RESISTANCE"],"unit":"Mohm","kind":"D","bad":"down","threshold":">1000 Mohm typical","pp":True},
    {"key":"arrester_watts_loss","labels":["WATTS","GST-GND"],"unit":"W","kind":"D","bad":"up","threshold":"vs Doble published / sister phases","pp":True},
    {"key":"arrester_leakage_ma","labels":["MA"],"unit":"mA","kind":"D","bad":"delta","threshold":"compare phases","pp":True},
  ],

  "GROUND_FAULT_PROTECTION": [
    {"key":"gf_pickup_measured","labels":["PICKUP"],"unit":"A","kind":"D","bad":"delta","threshold":"<=1200A (NEC 230.95); matches setting","pp":False},
    {"key":"gf_trip_time","labels":["TIME DELAY","TIMING"],"unit":"s","kind":"D","bad":"up","threshold":"<=1s @3000A","pp":False},
    {"key":"gf_reduced_voltage_trip","labels":["57%","REDUCED CONTROL VOLTAGE"],"unit":"pass/fail","kind":"D","bad":"cat","threshold":"operates","pp":False},
    {"key":"gf_pickup_setting","labels":["PICKUP RANGE","PICKUP SETTING"],"unit":"A","kind":"R","bad":"none","pp":False},
  ],
}
```

---

## 18. Summary

**Approx. field counts (diagnostic / reference) per major type as catalogued above:**
TRANSFORMER_LIQUID ≈ 45 D / 28 R · CIRCUIT_BREAKER (LV+MV) ≈ 25 D / 14 R · PROTECTION_RELAY ≈ 9 D / 10+ R (settings blob) · CABLE (LV+MV) ≈ 14 D / 14 R · BATTERY/UPS ≈ 14 D / 12 R · SWITCHGEAR/SWITCHBOARD/PANEL/BUSWAY ≈ 7 D / 8 R · GROUNDING ≈ 6 D / 4 R · GENERATOR ≈ 13 D / 8 R · INSTRUMENT_TRANSFORMER ≈ 11 D / 7 R · ATS ≈ 7 D / 6 R · DISCONNECT/FUSE ≈ 7 D / 8 R · MCC ≈ 8 D / 7 R · VFD ≈ 7 D / 5 R.

**Highest-value additions vs the current 9-key vocab** (insulation_resistance, polarization_index, contact_resistance, winding_resistance, power_factor, dissolved_gas, turns_ratio, ground_resistance, trip):
1. **DGA split into 9 named gases + TDCG + condition code with per-gas C57.104 limits** (today "dissolved_gas" is one bucket — the limits differ 100× between H2 and CO2).
2. **Oil-quality suite** (dielectric_breakdown, IFT, acid_number, water_content, oil PF, color, inhibitor, furans) — on every annual liquid-transformer report.
3. **Relay as-found/as-left pickup & timing vs min/max bands** — the form literally prints the pass band; trivial deterministic pass/fail.
4. **Breaker trip-unit measured pickups (LT/ST/INST/GF) + trip-time-in-band + voltage drop** — distinct from "trip" boolean.
5. **Capacitance & bushing C1/C2 PF/cap, hot-collar watts, tank-loss index, excitation current** — the entire Doble PF family currently collapses into "power_factor".
6. **Battery per-cell family** (cell_voltage, internal ohmic + %deviation, intercell/strap resistance, specific gravity, capacity_percent) — per-cell tables are the bulk of battery report rows.
7. **Cable tan-delta triplet (TD, tip-up, stability) + VLF withstand + dc leakage + shield resistance.**
8. **DAR, turns_ratio_error, winding_resistance_deviation %** — the deviation/ratio columns that drive pass/fail.
9. **Timed-IR rows (0.25–10 min) and @20 °C-corrected twins** — parser should keep raw + corrected, key trend off corrected.
10. **insulation_rating_code (G/D/I/B/Q) and AS FOUND/AS LEFT pairing** — free deficiency labels already printed by PowerDB.

**Three equipment types where richer vocab most improves real-report capture:**
1. **TRANSFORMER_LIQUID** — by far the densest forms (62-page PowerDB set): DGA + oil screen + PF/cap/bushing + excitation + leakage reactance are nearly all unparsed today.
2. **CIRCUIT_BREAKER** — every LV breaker report is a settings-vs-measured grid (pickups, trip times, pole µΩ, IR) that maps 1:1 to deterministic pass bands printed on the form.
3. **UPS_BATTERY / BATTERY_SYSTEM** — hundreds of per-cell rows per report (voltage, µΩ, SG, straps) with crisp IEEE 450/1188 thresholds; currently almost everything lands in the generic bucket.


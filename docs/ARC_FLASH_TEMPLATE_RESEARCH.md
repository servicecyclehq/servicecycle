# Arc Flash Template Research
## Grounding for a New Innovative Standard

*Compiled 2026-06-25 | Sources: IEEE 1584-2018, NFPA 70E 2024, e-Hazard study report, Delta Wye Engineering, Brady labeling requirements*

---

## 1. What Existing Tools Capture Today

### Standard Industry Report Structure (from real study reports: e-Hazard/SKM/EasyPower)

Every professional arc flash study today produces two core tables:

**Incident Energy Summary Report** — one row per bus:

| Field | Notes |
|---|---|
| Bus Name | Equipment identifier |
| Protective Device Name | Upstream breaker/fuse protecting this bus |
| Bus kV | Nominal voltage |
| Bolted Fault Current 3P (kA) | From short circuit study |
| Arcing Fault Current 3P (kA) | Calculated via IEEE 1584 |
| Prot Dev Trip/Delay Time (sec) | From TCC curves |
| Prot Dev Breaker Opening Time/Tolerance (sec) | Mechanical clearing time |
| Equipment Type | PNL, MCC, SWGR, etc. |
| Electrode Configuration | VCB / VCBB / HCB / VOA / HOA |
| Box Width (in) | Enclosure dimension |
| Box Height (in) | Enclosure dimension |
| Box Depth (in) | Enclosure dimension |
| Gap (mm) | Conductor-to-conductor spacing |
| Arc Flash Boundary (in) | Distance at 1.2 cal/cm² |
| Working Distance (in) | Torso-to-arc per task |
| Incident Energy (cal/cm²) | The output |
| PPE Level / Notes | Category 1–4 or DANGER |

**Equipment Evaluation Report** — device adequacy check:

| Field | Notes |
|---|---|
| Device/Bus Name | |
| Manufacturer | |
| Status | Pass/Fail/Review |
| Description / Frame/Model | |
| Voltage (V): Calc/Dev/Rating% | Adequacy check |
| INT kA: Calc/Dev/Rating% | Interrupting rating vs. available fault |
| C-L kA: Calc/Dev/Rating% | Cable-limited fault check |
| X/R Ratio: Calc/Dev/Rating% | System asymmetry |

**Per-bus one-line diagram fields:**
- Bus: Voltage, InitSymRMS 3P (A), AF_TripTime (s), IncidentEnergy (cal/cm²), WorkingDistance (in), AF_Boundary (in)
- Protective device: Manufacturer, Frame/Model, Sensor/Trip (A), Plug (A), Settings
- Transformer: kVA, Pri FLA, Sec FLA, %Z
- Cable: Size (AWG/kcmil), Material, Insulation, Length (ft), Ampacity (A)
- Source: SystemNominalVoltage, Isc 3P, X/R 3P

### What IEEE 1584-2018 Requires as Minimum Calculation Inputs

Per the standard's 10-step procedure:

1. **System voltage** — 208V–15kV range, nominal and maximum operating
2. **Bolted fault current (3P symmetrical RMS, kA)** — from short circuit study
3. **Electrode configuration** — one of five: VCB, VCBB, HCB, VOA, HOA
4. **Enclosure dimensions** — height × width × depth (in or mm)
5. **Conductor gap (mm)** — bus-to-bus spacing; lookup tables by equipment type
6. **Working distance (in)** — torso to arc source; per IEEE 1584 Table 3 or field-measured
7. **Protective device clearing time (sec)** — from TCC curves, at both normal and 85% reduced arcing current
8. **System grounding** — solidly grounded, resistance grounded, or ungrounded
9. **X/R ratio** — affects asymmetry correction

The 2018 revision added enclosure size as a direct variable (smaller boxes concentrate energy), and the ±15% arc current variation check to catch worst-case clearing time.

### What NFPA 70E 130.5(H) Requires on Every Arc Flash Label

**Mandatory (must include all three):**
1. Nominal system voltage
2. Arc flash boundary (distance)
3. **At least one of:**
   - Available incident energy (cal/cm²) at specified working distance, OR
   - Minimum arc rating of clothing (cal/cm²), OR
   - Site-specific PPE level

**2024 additions:**
- Label must be of sufficient durability for the installed environment
- Category 0–4 hazard classification system is obsolete — must show actual calculated values
- Never put more than one method on the same label

**Common complete label contents in practice:**
- Equipment ID / Bus Name
- Date of study
- Nominal voltage (V)
- Arc flash boundary (ft/in)
- Working distance (in)
- Incident energy (cal/cm²)
- PPE category (1–4) or "DANGER — DO NOT WORK ENERGIZED"
- Arc rating of required PPE (cal/cm²)
- Responsible engineer / stamp

---

## 2. What Existing Tools Miss — The Innovation Opportunity

Current tools (ETAP, SKM, EasyPower) are **calculation engines wrapped in export pipelines**. They were built by engineers for engineers doing point-in-time studies. They share common blind spots:

### Gap 1: No Asset Lifecycle Continuity
Studies are point-in-time exports. A study done in 2020 lives in a PDF binder. When a protective device is replaced in 2024, nobody knows which buses it affects, whether the incident energy changed, or whether labels need reprinting. **No tool links study data to asset records.**

### Gap 2: No Change-Triggered Re-study Flags
If load grows, a transformer is replaced, or a breaker setting changes, the engineer only knows to re-study if they remember the rule. **No tool surfaces "this asset's last study may be invalid" based on downstream system changes.**

### Gap 3: No Per-Task Working Distance
Every bus gets one working distance. In reality, a worker racking out a breaker is at a different distance than one measuring voltage at terminals. **No tool supports multiple task-specific incident energies per bus.**

### Gap 4: No Electrode Configuration Confidence Score
Engineers choose VCB/VCBB/HCB/VOA/HOA based on drawings and judgment. Wrong choice = wrong answer by 20–50%. **No tool tracks who chose the configuration, when, and with what supporting documentation.**

### Gap 5: No Protective Device Settings Traceability
Trip times come from TCC curves, but curves expire when settings are changed. **No tool links a breaker's trip settings to the arc flash calculation that used them — so if settings drift, nobody knows the incident energy is now wrong.**

### Gap 6: No Maintenance History Integration
A breaker that hasn't been tested in 5 years may not operate at its rated trip time. IEEE 1584 assumes the device works. **No tool integrates maintenance history to flag "this device's assumed trip time may not reflect actual tested performance."**

### Gap 7: No Environmental / Population Context
A 5 cal/cm² panel in a rarely-entered motor control room carries different real risk than the same panel in a production area accessed 20 times per day. **No tool captures access frequency or personnel exposure as a risk multiplier.**

---

## 3. Proposed ServiceCycle Arc Flash Template Standard

### Design Principles
1. **Asset-linked, not study-linked** — every data point ties to an asset record, not a one-time PDF
2. **Time-stamped traceability** — who entered what, when, based on what source
3. **Change-aware** — system records what changed since the last study and flags whether re-calculation is needed
4. **Task-contextual** — multiple working distances per bus based on actual tasks workers perform
5. **Maintenance-integrated** — protective device trip time is validated against last tested performance, not just nameplate/TCC
6. **Risk-layered** — access frequency + personnel exposure + incident energy = meaningful risk score (not just cal/cm²)

---

### Template Structure — Six Sections Per Asset/Bus

#### Section A: Bus Identity & Location
| Field | Type | Notes |
|---|---|---|
| Asset ID | FK | Links to ServiceCycle asset record |
| Bus / Panel Name | String | As labeled on equipment |
| Location (Site, Building, Room, Panel Position) | Structured | Site → Building → Room → Panel |
| Equipment Type | Enum | PNL, MCC, SWGR, XFMR, VFD, CB, BUS, OTHER |
| Voltage Class | Enum | LV (<1kV), MV (1–15kV), HV (>15kV) |
| Nominal Voltage (V) | Number | |
| Year Installed | Number | |
| Manufacturer | String | |
| Model / Catalog Number | String | |
| NEMA Enclosure Type | Enum | 1, 3R, 4, 4X, 12, etc. |
| Last Physical Verification Date | Date | When a human last verified this data |
| Verified By | FK → User | |

#### Section B: System Configuration Inputs (IEEE 1584 Required)
| Field | Type | Notes |
|---|---|---|
| Electrode Configuration | Enum | VCB / VCBB / HCB / VOA / HOA |
| Configuration Basis | Enum | Field-measured / Drawing-based / Engineer-judgment |
| Configuration Documentation | File FK | Optional: photo or drawing reference |
| Enclosure Width (mm) | Number | |
| Enclosure Height (mm) | Number | |
| Enclosure Depth (mm) | Number | |
| Conductor Gap (mm) | Number | IEEE 1584 lookup or field-measured |
| Gap Source | Enum | Standard-lookup / Field-measured / Manufacturer-spec |
| System Grounding | Enum | Solidly-grounded / Resistance-grounded / Ungrounded / Delta |
| X/R Ratio | Number | From short circuit study |
| Bolted Fault Current 3P (kA) | Number | From short circuit study |
| Fault Current Study Date | Date | For recalculation triggering |
| Fault Current Source | String | Utility data or in-house study reference |

#### Section C: Protective Device Chain
*One row per upstream device (supports multiple layers — feeder breaker → main breaker)*

| Field | Type | Notes |
|---|---|---|
| Device Position | Number | 1 = primary upstream, 2 = next upstream |
| Device Type | Enum | MCCB, ACB, Fuse, Relay+CT, Recloser |
| Manufacturer | String | |
| Model / Frame | String | |
| Rated Voltage (V) | Number | |
| Rated Current (A) — Sensor/Trip | Number | |
| Plug / Rating (A) | Number | For adjustable trips |
| Interrupting Rating (kA) | Number | |
| **Trip Settings (Long-time, Short-time, Inst) (A or ×)** | JSON/Structured | The innovation: structured, not a text note |
| Trip Curve Source | Enum | Manufacturer-TCC / Field-tested / Estimated |
| Last Settings Verification Date | Date | |
| Last Settings Verified By | FK → User | |
| Normal Trip Time at Arcing Current (sec) | Number | Calculated from TCC |
| Reduced Arc Trip Time at 85% Arcing Current (sec) | Number | Critical for worst-case |
| Breaker Opening Time / Mechanism Tolerance (sec) | Number | |
| Last Operational Test Date | Date | **The innovation: maintenance-linked** |
| Last Test Result | Enum | Pass / Pass-with-deviation / Fail / Not-tested |
| Trip Time at Last Test (sec) | Number | Actual tested vs. assumed |
| Test Deviation Flag | Computed | Flags if tested time > assumed time by >10% |

#### Section D: Calculated Study Results
*Written by PE at time of study — read-only after PE stamp*

| Field | Type | Notes |
|---|---|---|
| Study Date | Date | |
| Study Performed By | String | PE name |
| PE License Number | String | |
| Study Software | Enum | ETAP / SKM / EasyPower / EasyPower+ServiceCycle / Other |
| Study Method | Enum | IEEE 1584-2018 / IEEE 1584-2002 / NFPA 70E Annex D |
| Governing Arcing Current (kA) | Number | Normal or reduced — whichever governs |
| Governing Scenario | Enum | Normal-arcing / Reduced-arcing-85pct |
| Arc Duration (sec) | Number | From protective device at governing current |
| **Working Distances & Incident Energies** | Array | See sub-table below |
| Arc Flash Boundary (in) | Number | Distance at 1.2 cal/cm² |
| Restricted Approach Boundary (in) | Number | NFPA 70E shock boundary |
| Limited Approach Boundary (in) | Number | |
| Study Expiration Date | Date | Study date + 5 years (configurable) |
| Invalidating Conditions (auto-flagged) | Computed | See Section F |

**Working Distance Sub-table (multiple tasks per bus):**

| Task Name | Working Distance (in) | Incident Energy (cal/cm²) | Required PPE Category | Min Arc Rating (cal/cm²) |
|---|---|---|---|---|
| Voltage measurement | 18" | [calc] | [derived] | [derived] |
| Breaker racking | 24" | [calc] | [derived] | [derived] |
| Infrared inspection | 36" | [calc] | [derived] | [derived] |
| *Custom task* | User-defined | [calc] | [derived] | [derived] |

#### Section E: Label & PPE Output
*Auto-generated from Section D; never manually entered*

| Field | Source | Notes |
|---|---|---|
| Label Revision | Auto-incremented | Increments on any Section D or B change |
| Label Generated Date | Auto | |
| Nominal Voltage (for label) | From A | |
| Arc Flash Boundary (for label) | From D | |
| Governing Incident Energy (cal/cm²) | From D | Maximum across all tasks |
| Governing Working Distance (in) | From D | Distance for governing IE |
| Required PPE Category | From D | |
| Min Arc Rating (cal/cm²) | From D | |
| Danger Flag | Computed | "DO NOT WORK ENERGIZED" if IE > 40 cal/cm² |
| Label Print Status | Enum | Current / Needs-reprint / Reprinted |
| Last Label Print Date | Date | |
| Label Printed By | FK → User | |

#### Section F: Risk Intelligence (The Innovation Layer)
*No existing tool has this section*

| Field | Type | Notes |
|---|---|---|
| Access Frequency | Enum | Daily / Weekly / Monthly / Rarely |
| Typical Personnel Count During Access | Number | Workers exposed per access event |
| **Composite Risk Score** | Computed | IE × frequency × exposure count — normalized 1–100 |
| Risk Tier | Computed | HIGH / MEDIUM / LOW (for prioritization) |
| Last System Change Since Study | Computed | Any upstream change: device swap, settings change, load growth |
| Re-study Required Flag | Computed | Set when: upstream device changed, settings changed >5%, load grew >10%, study age >5yr |
| Re-study Urgency | Computed | IMMEDIATE (change detected) / SCHEDULED (age) / CURRENT |
| Open Maintenance Deficiencies on This Bus | FK count | Links to ServiceCycle deficiency records |
| Related Work Orders (open) | FK count | Counts active WOs that will require energized work |
| **"Safe to work energized?" quick check** | Computed | Green/Yellow/Red based on: PPE available + current study + no open TEST-FAIL devices |

---

## 4. Innovative Features That Go Beyond Any Current Tool

### 4a. Protective Device Drift Detection
When a breaker's last test result shows a trip time 15% longer than the TCC-assumed time, the system recalculates the effective incident energy using the actual tested time and flags the delta. This is a category of risk that currently exists silently — no PE knows unless they dig through maintenance logs.

### 4b. Multi-Task Incident Energy Per Bus
Instead of one working distance per bus, the template stores task-specific distances. A facility can define their actual task library (infrared scan, racking, metering, maintenance) and each gets its own IE and PPE requirement. Labels can be generated per-task rather than one conservative worst-case.

### 4c. Load Growth / System Change Trigger
When a transformer nameplate is updated, a breaker replaced, or telemetry shows sustained load growth above a threshold, the system automatically flags affected downstream buses as "re-study recommended." No engineer needs to remember to check — the data tells them.

### 4d. Composite Risk Score for Prioritization
A bus at 8 cal/cm² accessed daily with 3 workers carries more real-world risk than a 25 cal/cm² bus in a locked room accessed once a year. The composite score surfaces this for facility managers and insurers — it's a defensible risk prioritization framework, not just raw incident energy.

### 4e. Temporal Traceability for Every Input
Every field in Sections B and C records who entered it, when, and what source they cited. When a PE stamps a study, the audit trail shows exactly what data they relied on. This is table stakes for PE liability defense and is completely absent from current tools.

### 4f. Integration with NETA Maintenance Records
For NETA contractors specifically: protective device test results from NETA ATS standards (current injection tests, contact resistance, timing tests) flow directly into Section C's "last test" fields. The study's assumed trip time is automatically validated against the most recent NETA test — something no standalone arc flash tool can do today.

---

## 5. Implementation Notes for ServiceCycle

**What's already built (AFX v1 — shipped):**
- Per-asset Arc Flash tab
- IEEE 1584 inputs: voltage, electrode config, enclosure dims, gap, fault current, bolted/arcing fault, working distance, IE, boundary
- SystemStudy model with `expiresAt`, PE stamp fields
- ArcFlashDevice and ArcFlashCable models

**What this template adds:**
- Section C (protective device chain with trip settings + test traceability) — new ArcFlashDevice fields
- Section F (risk intelligence layer) — new computed/stored fields on SystemStudy or a new RiskAssessment model
- Multi-task working distances — new ArcFlashWorkingDistance join table
- Label revision tracking — extend current label generation

**Build priority order:**
1. Multi-task working distances (highest user value, enables better labels)
2. Protective device trip settings structure + test link (NETA contractor differentiator)
3. Change-trigger re-study flag (retention driver)
4. Risk score + composite display (acquisition/demo value)

---

## Sources

- [IEEE 1584-2018 Arc Flash Calculations — Delta Wye Electric](https://deltawye.com/ieee-1584-arc-flash-calculations/)
- [Arc Flash Label Requirements — Brady ID](https://www.bradyid.com/applications/arc-flash-labeling-requirements)
- [Arc Flash Study Report Example — e-Hazard](https://e-hazard.com/wp-content/uploads/2021/04/Arc-Flash-Study-Report-Example.pdf)
- [IEEE 1584 Arc Flash Hazard Calculations — EasyPower](https://www.easypower.com/ieee-1584-2018)
- [ETAP ArcSafety Global Data Entry](https://etap.com/arc-flash/global-arc-flash-data-entry)
- [Online Arc Flash Calculator IEEE 1584-2018 — jCalc](https://www.jcalc.net/arc-flash-calculator-ieee)
- [Arc Flash Incident Energy Guide — ToolGrit](https://www.toolgrit.com/guides/arc-flash-incident-energy-guide)

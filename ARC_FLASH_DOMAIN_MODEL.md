# Arc-Flash Study Domain Model (Inputs + Outcomes)

**Purpose.** Authoritative, cited reference for the arc-flash data ServiceCycle must capture as the *data-capture layer* for incident-energy studies. A licensed PE runs the actual IEEE 1584 calculation in SKM / ETAP / EasyPower / Cable Pro Web; ServiceCycle captures the study **inputs** and **outcomes**, runs a "what is missing per bus to run IEEE 1584" gap analysis, and trends results over time.

**Scope of the standards.**
- **IEEE 1584-2018** — *IEEE Guide for Performing Arc-Flash Hazard Calculations.* Defines the empirical incident-energy model, its inputs, and the equipment-class typicals. Validated for **three-phase AC, 208 V to 15 kV**.
- **NFPA 70E-2024** — *Standard for Electrical Safety in the Workplace.* Defines the labeling, PPE selection (table method and incident-energy method), shock approach boundaries, and re-study cadence.

**Sourcing note.** The full text of IEEE 1584-2018 and NFPA 70E-2024 is copyrighted and paywalled. Numeric values below (typical gaps, working distances, enclosure correction thresholds, shock boundaries, PPE-table parameters, clearing-time informational notes) are drawn from authoritative secondary sources — IEEE chapter presentations, manufacturer technical libraries (Eaton, Mersen, Schneider), PE training references (Brainfiller / Jim Phillips, P.E.), and engineering software vendors (ELEK, ETAP, EasyPower). **Cross-verified values are flagged "[verified, N sources]"; single-source or could-not-fully-confirm values are flagged "[FLAG]".** Where a number traces directly to a table in the standard, the table number is cited but the value comes from the secondary source, so treat exact digits as design guidance, not as a substitute for the standard.

---

## 1. IEEE 1584-2018 per-bus model inputs

The 2018 model rebuilt the calculation from scratch on ~1,800+ lab tests (vs ~300 for the 2002 edition), across **five electrode configurations, three reference voltage ranges (600 V / 2700 V / 14300 V), and many enclosure sizes**. [verified, 2 sources: ToolGrit; PCIC]

### 1.1 Inputs, and whether each is *measured* or *typical-by-class*

| Input | Symbol / units | Measured vs typical | Notes |
|---|---|---|---|
| Nominal system voltage | V (kV) | **Measured** (system fact) | Drives coefficient set; model interpolates between 600 V / 2.7 kV / 14.3 kV reference points. |
| Bolted (3-phase) fault current | I_bf (kA) | **Measured / from short-circuit study** | The available fault current at the bus. Range of applicability below. |
| Predicted arcing current | I_arc (kA) | **Calculated by the model** (output of an intermediate equation, then input to the energy equation) | Lower than I_bf because arc impedance reduces current. At 480 V, I_arc ≈ 50–70% of I_bf; at 4160 V, ≈ 85–95%. [verified, 2 sources] |
| Reduced arcing current | I_arc x (1 - 0.5 x VarCf) | **Calculated** | Mandatory second scenario — see §1.4. |
| Electrode configuration | VCB / VCBB / HCB / VOA / HOA | **Typical-by-class**, refined by inspection | See §1.2 — the single biggest 2018 change. |
| Conductor gap | mm | **Typical-by-class** (measure if possible) | See §6 table. |
| Working distance | in / mm | **Typical-by-class** (or task-specific) | See §6 table. Minimum recommended 305 mm (12 in). [verified, 3 sources] |
| Enclosure type + dimensions (H x W x D) | mm or in | **Measured** (or typical-by-class) | Drives the enclosure-size correction factor — see §1.3. |
| Arc duration / clearing time | t (s or ms) | **From protective device** (TCC + settings, or coordination study) | The single most controllable variable in the energy equation — see §2. |

### 1.2 The five electrode configurations (enumerated + defined)

IEEE 1584-2018 defines five conductor/electrode arrangements; the choice can change incident energy by 40%+ at the same current and clearing time. [verified, 4 sources: Brainfiller; ELEK; ToolGrit; Eaton]

1. **VCB — Vertical Conductors inside a metal Box/enclosure.** The original 2002-edition enclosed case. Arc is driven down the electrodes toward the bottom of the box and spills out the front. Default for most switchgear/panelboards where bus is on the back wall.
2. **VCBB — Vertical Conductors terminated in an insulating Barrier, inside a Box.** Vertical bus that ends at an insulating barrier; the barrier deflects the plasma cloud *toward the enclosure opening* (toward the worker), generally producing **higher** incident energy than VCB at the same parameters.
3. **HCB — Horizontal Conductors inside a Box.** Horizontal bus (common in MCCs behind buckets); plasma is directed outward from the electrode ends.
4. **VOA — Vertical conductors in Open Air.** No enclosure (open-air switchyard, outdoor bus). Plasma expands freely, generally **lower** energy. Enclosure correction factor = 1.0 (no correction).
5. **HOA — Horizontal conductors in Open Air.** Overhead/outdoor horizontal bus. Enclosure correction = 1.0.

> **Capture as an enum.** This is a closed set of exactly five values: `VCB | VCBB | HCB | VOA | HOA`. (Note: some sources write "VCCB" for VCBB — same configuration; standardize on **VCBB**.) [FLAG: VCB/VCCB naming varies by source; VCBB is the IEEE-canonical spelling per multiple references.]

### 1.3 Enclosure type, dimensions, and the 2018 enclosure-size correction

New in 2018: an **Enclosure Size Correction Factor (CF)** adjusts incident energy and arc-flash boundary for the *actual* enclosure size, replacing the 2002 model's three fixed enclosure presets. [verified, 3 sources: Brainfiller; ToolGrit; ECMag]

- Equations are normalized to a **508 mm x 508 mm x 508 mm (20 in cube)** enclosure. Larger openings → lower (less focused) energy; smaller/shallow → higher.
- CF depends on the **opening height and width** and the electrode configuration; depth is generally ignored *except* for the "shallow" case. Four size categories:
  - **Small:** dimension < 508 mm (20 in)
  - **Medium:** 508–660.4 mm (20–26 in)
  - **Large:** > 660.4–1244.6 mm (26–49 in)
  - **Extra-Large:** > 1244.6 mm (49 in) — beyond ~49 in, increasing size has diminishing effect.
- **Shallow enclosure** (special, lower-CF case): height AND width < 508 mm (20 in) **AND** voltage < 600 V **AND** depth ≤ 203.2 mm (8 in). [verified, 1 detailed source: Brainfiller]
- Open-air (VOA/HOA): CF = 1.0.

> **Capture implication.** To let a PE (or our recompute) apply CF, store enclosure **height, width, depth (mm or in)** and an enclosure **type/class**. Today we store none of these.

### 1.4 Arcing current, the variation factor, and the dual scenario

- The model computes **predicted arcing current I_arc** from I_bf, V, gap, and electrode config.
- It also computes a **reduced arcing current = I_arc x (1 - 0.5 x VarCf)**, where VarCf is the configuration-specific variation correction factor. [verified, 1 explicit-formula source: ToolGrit]
- **Both scenarios must be evaluated; the higher resulting incident energy governs.** The reduced current matters because a *lower* arc current may fall **below the upstream device's instantaneous pickup**, forcing it onto the slower time-delay curve — a longer clearing time that often produces the worst-case energy, especially at 480–600 V. [verified, 2 sources]

### 1.5 Range of applicability (when IEEE 1584 may be used)

[verified, 3 sources: ELEK; ToolGrit; jCalc]
- **Voltage:** 208 V – 15 kV, three-phase AC.
- **Bolted fault current:** 500 A – 106 kA for **208–600 V**; 200 A – 65 kA for **601 V – 15 kV**.
- **Conductor gap (test range):** 6.35–76.2 mm (0.25–3 in) for 208–600 V; 19.05–254 mm (0.75–10 in) for 601 V–15 kV.
- **Frequency:** 50/60 Hz.
- **Above 15 kV** (or outside the ranges): IEEE 1584 does **not** apply — PEs use the **Ralph Lee method** (theoretical max, conservative but ignores enclosure focusing): `E (cal/cm2) = 5.12 x 10^5 x V(kV) x I_bf(kA) x t(s) / D(mm)^2`. [verified, 1 detailed-formula source: ToolGrit; method is widely cited]

> **Capture implication.** Store the **calculation method** ("IEEE 1584-2018", "Lee method", "manufacturer test data") per study/bus so trending and validity checks know which model produced a number. We have `SystemStudy.method` (free text) but not a per-bus method flag.

---

## 2. Protective-device taxonomy and how clearing time is determined

**This is the generalization of the "trip settings" bug.** Arc duration (t) = the time the upstream overcurrent protective device (OCPD) takes to clear the arcing current. *How* you get t depends entirely on the device family. Two devices have **no adjustable settings** (fuses, thermal-magnetic breakers) — for them, t is read straight off the published time-current curve (TCC) at the arcing current, given only **class/type + ampere rating**.

**Rule (when are recorded settings required vs derivable?):**
> Recorded settings are **REQUIRED** only for devices whose trip point is field-adjustable: **electronic trip units (LSIG)** and **protective relays**. For devices with a fixed published characteristic — **fuses** (class + amp rating) and **thermal-magnetic MCCBs** (frame + trip rating; instantaneous fixed unless a listed adjustable-instantaneous model) — clearing time is **DERIVABLE** from device type + rating via the manufacturer's TCC / let-through curves. Requiring "settings" for these is wrong.

If no device clears the fault (or it is unknown), IEEE 1584 §6.9.1 caps arc duration at a **default 2.0 s** (the assumed time to move away). [verified, 1 explicit source: ELEK quoting clause 6.9.1]

### 2.1 Fuses

Current-limiting fuses can clear within **~0.5 cycle** when the fault is inside their current-limiting range, drastically cutting incident energy. [verified, 2 sources: Mersen; NFPA table note] Data needed = **class + ampere rating + voltage rating** (NO settings). Clearing time/energy comes from the TCC and let-through (I^2t / peak let-through) curves.

| UL/CSA class | Current-limiting? | Typical voltage | Typical amp range | Notes |
|---|---|---|---|---|
| **L** | Yes | 600 V | 601–6000 A | Bolt-in; mains/feeders. |
| **RK1** | Yes (superior limitation) | 250/600 V | 0–600 A | 200 kA AIC; dendritic element; lowest let-through of the R classes. [verified, 2 sources] |
| **RK5** | Yes (weaker than RK1) | 250/600 V | 0–600 A | 100 kA AIC; economical; I^2t up to ~5x an RK1 — *upgrading RK5→RK1/J commonly reduces arc-flash energy.* [verified, 2 sources] |
| **J** | Yes | 600 V | 0–600 A | Compact; common in arc-flash mitigation. |
| **T** | Yes (very fast-acting) | 300/600 V | 0–1200 A | Extremely fast; compact. |
| **CC** | Yes | 600 V | 0–30 A | Small branch / control. |
| **G** | Yes | 480 V | 0–60 A | Compact branch. |
| **CF** | Yes | 600 V | 0–100 A | Class CF / "midget"-style current-limiting; J-equivalent performance in a CC-style footprint. [FLAG: CF less consistently documented than R/J/T/L] |
| **H / K** | H = non-current-limiting; K = limiting | 250/600 V | 0–600 A | Legacy Class H ("one-time"/renewable) is NOT current-limiting — relevant because replacing H/K/RK5 with RK1/J is a standard mitigation. |

> Fields to record per fuse: **fuseClass (enum), ampereRatingA, voltageRatingV, manufacturer, model, isCurrentLimiting (derivable from class)**. No "settings."

### 2.2 Molded-case circuit breakers (MCCB)

Two sub-types with very different data needs: [verified, 3 sources: Eaton; EasyPower; IECI]

- **Thermal-magnetic (TM):** thermal (bimetal) element for overload + magnetic armature for instantaneous. **Fixed** characteristic. Data = **frame size + trip/continuous-current rating**. Some models have an **adjustable instantaneous** (magnetic) dial only — capture it if present, but long-time/short-time are not adjustable. Clearing time derivable from the published TCC. **No LSIG settings.**
- **Electronic trip unit (ETU):** "LSI" or "LSIG" — **L**ong-time (≈60–600 s band), **S**hort-time (≈0.1–60 s), **I**nstantaneous, optional **G**round-fault. Each band has **adjustable pickup + delay** (and sometimes I^2t in/out). **Settings ARE required** to determine clearing time. ERMS and zone-selective interlocking exist only on LSI/LSIG units. [verified, 2 sources]

> Typical clearing-time informational notes (NFPA 70E Table 130.7(C)(15)(a) IN): 1.5 cycles for an MCCB < 1000 V with instantaneous integral trip; 0.5 cycle for current-limiting fuses in their limiting range. [verified, 1 source: NFPA table note via Arc Flash 101]

### 2.3 Insulated-case (ICCB) and low-voltage power circuit breakers (LVPCB)

[verified, 2 sources: Eaton; EasyPower]
- **ICCB:** built to MCCB standards but **always electronic trip units** (LSI/LSIG), high SCCR, often with short-time delay. Typical clearing ≈ **3 cycles** with instantaneous; **20 cycles** with a short-time band for motor inrush. **Settings required.**
- **LVPCB ("air-frame"):** drawout power breakers, two-step stored-energy mechanism; electronic (solid-state) or, rarely, non-solid-state trip. Typical clearing ≈ **20 cycles** with short-time delay for inrush; **30 cycles** with short-time delay and no instantaneous. **Settings required.**
- Both support **maintenance switch / ERMS / arc-reduction** modes and **ground fault** — capture those (see §4).

### 2.4 Protective relays (medium voltage, and LV with relayed breakers)

Relays drive a breaker trip; identified by **ANSI device numbers**. Data = the relay **settings** per enabled function. [verified, 2 sources: NETAWorld "trip unit is a relay by another name"; NFPA table note (5-cycle typical for relayed MV breakers in instantaneous range)]

| ANSI No. | Function | Settings to record |
|---|---|---|
| **50** | Instantaneous overcurrent (phase) | Pickup (A or multiple of CT), (no intentional delay) |
| **51** | Time overcurrent (phase) | Pickup, **time dial**, **curve type** (e.g., IEC/ANSI very-inverse) |
| **50G / 50N** | Instantaneous ground/neutral OC | Pickup |
| **51G / 51N** | Time ground/neutral OC | Pickup, time dial, curve |
| **87 / 87B / 87T** | Differential (bus/transformer) | Zone, slope, pickup (clears with no intentional delay → big arc-flash reduction) |
| **50/27, 50AF, etc.** | Arc-flash / fast-bus relays (light + current) | Light setpoint, current supervision, trip time |
| **CT ratio** | (supporting) | Always needed to convert relay pickup to primary amps |

> Fields per relayed device: **relayDeviceNumbers (array of ANSI codes), ctRatio, plus a settings object {pickupA, timeDial, curveType, instantaneousPickupA, groundPickupA, ...}**.

### 2.5 Summary: required vs derivable, by family

| Device family | Settings required? | Minimum fields to record | Clearing time from |
|---|---|---|---|
| Fuse (any class) | **No** | class, ampereRatingA, voltageRatingV, mfr, model | TCC / let-through |
| MCCB thermal-magnetic | **No** (capture adj. instantaneous if present) | frameA, tripRatingA, mfr, model, [instSettingA?] | published TCC |
| MCCB electronic (LSIG) | **Yes** | frameA, sensor/plug A, mfr, model, **LSIG settings** | TCC + settings |
| ICCB | **Yes** (electronic) | frameA, sensorA, mfr, model, **LSIG settings**, [ERMS] | TCC + settings |
| LVPCB | **Yes** (electronic) | frameA, sensorA, mfr, model, **LSIG settings**, [ERMS] | TCC + settings |
| Protective relay + breaker | **Yes** | ANSI device #s, **CT ratio**, **relay settings**, breaker mfr/model | relay curve + breaker op time |

---

## 3. Source / system inputs

These are not per-bus; they feed the short-circuit study that produces I_bf at every bus. [verified, multiple sources]

| Input | Fields | Notes |
|---|---|---|
| **Utility / point of common coupling** | available fault current **MAX** (kA) and **MIN** (kA), and **X/R** ratio at the PCC | MAX drives worst-case arc-flash *boundary*; **MIN** matters because a lower I_bf can give a lower I_arc that clears slower → higher energy. Capture both. |
| **Transformer(s)** | kVA, primary V, secondary V, **%Z (impedance)**, **X/R**, connection (e.g. delta-wye), [tap] | Determines secondary fault current. |
| **Motor contributions** | per-motor or lumped **HP**, voltage, count; contribution decays over ~4–6 cycles | The common ">= 50 HP" cutoff is a *software convenience*, **NOT** an IEEE 1584-2018 exemption — small motors in aggregate still contribute. Capture a motor-contribution total (and optionally the >=50 HP detail). [verified, 2 sources: Mike Holt forum consensus; EasyPower] |
| **Generator contributions** | kW/kVA, voltage, subtransient reactance Xd", count | On-site generation / standby; changes fault current in alternate operating modes. |
| **Conductors / cable** | length (ft), size (AWG/kcmil), material (Cu/Al), **# conductors per phase**, conduit type (magnetic steel vs non-magnetic/PVC) | Cable impedance reduces downstream fault current. Conduit material affects reactance. |

### 3.1 The IEEE 1584-2018 §4.3 change (old 125 kVA / <240 V exemption)

The 2002-era practice exempted equipment **below 240 V fed by a transformer < 125 kVA** from incident-energy calculation. **IEEE 1584-2018 removed the blanket 125 kVA exemption** — testing showed sustainable arcs can occur below 125 kVA. The 2018 guidance instead notes that **sustainable three-phase arcs are *possible but less likely* at <= 240 V with available short-circuit current below ~2000 A** — a "verify, don't assume" position rather than an automatic exemption. [verified, 3 sources: Mike Holt; Industrial Monitor Direct; ToolGrit FAQ]

> **Capture implication.** Don't bake a hard "<125 kVA / <240 V → skip" rule into the gap engine. Treat it as a *flag for PE judgment* (store transformer kVA + bus voltage + available SCC so the rule can be surfaced, not auto-applied).

---

## 4. Mitigation factors that change outcomes

These reduce clearing time or contain energy; they materially change the label and must be captured because they explain *why* a bus that "should" be dangerous is not (or vice-versa). [verified, multiple sources: Schneider; EC&M; NEC 240.87]

| Mitigation | What to capture | Effect |
|---|---|---|
| **Energy-Reducing Maintenance Switch / Mode (ERMS / ARMS / "maintenance mode")** | present? (bool), the **reduced instantaneous pickup**, the resulting reduced energy (cal/cm2) when engaged | 2-position Normal/Maintenance; lowers instantaneous pickup → faster-than-instantaneous trip; often targets <= 8 cal/cm2 when engaged. **Two label states** (normal vs maintenance). [verified, 2 sources] |
| **Zone-Selective Interlocking (ZSI)** | enabled? (bool) | Upstream breaker nearest the fault overrides its intentional delay and trips fast; lowers energy. |
| **Differential relaying (ANSI 87)** | present? (bool), zone | No-intentional-delay clearing; up to ~80% energy reduction. [verified, 1 source] |
| **Arc-resistant switchgear** | rated? (bool), standard (e.g. IEEE C37.20.7), doors-closed rating | Redirects blast; **does not reduce incident energy** — labels distinguish doors-open vs doors-closed. [verified, 2 sources] |
| **Current-limiting devices** | (covered in §2.1) | Sub-cycle clearing in limiting range. |
| **NEC 240.87 trigger** | applies when device continuous trip setting >= **1200 A** | Code-required arc-energy-reduction method (ZSI, differential, ERMS, instantaneous below arcing current, active arc-mitigation, or equivalent) **must be documented on-site** (method + setting + location). Capture which method + its setting. [verified, 3 sources] |

---

## 5. Study outcomes / deliverables to capture

### 5.1 Per-bus calculated outcomes
- **Incident energy** (cal/cm2) at the working distance — the governing (higher) of the full- and reduced-arcing-current scenarios.
- **Arc-flash boundary** (in or mm) — distance at which incident energy = **1.2 cal/cm2** (5 J/cm2), the second-degree-burn onset. [verified, 3 sources]
- **Working distance basis** (in) — what distance the energy was computed at (see §6 typicals).
- **Arcing time / clearing time** used (ms or cycles).

### 5.2 PPE — capture BOTH methods (they are mutually exclusive on a given label)

NFPA 70E permits two approaches; **a label uses one and only one**: [verified, 2 sources]
1. **Incident-energy method (preferred for studied sites):** record the **incident energy (cal/cm2)** and the required **minimum arc rating** of clothing/PPE (its **ATPV** — Arc Thermal Performance Value — or **EBT** — Energy Break-open Threshold, whichever is lower for the fabric). Worker selects PPE whose arc rating >= incident energy.
2. **PPE-category (table) method:** when no incident-energy study exists and the equipment + parameters fall within NFPA 70E **Table 130.7(C)(15)(a) (AC)** / **(b) (DC)**, look up a **PPE category 1–4**, then **Table 130.7(C)(15)(c)** lists the actual clothing per category. Category arc ratings: **Cat 1 = 4, Cat 2 = 8, Cat 3 = 25, Cat 4 = 40 cal/cm2 (minimum)**. [verified, 2 sources]

> Capture `ppeMethod` ("incident_energy" | "ppe_category"), and store **both** `incidentEnergyCalCm2` + `requiredArcRatingCalCm2` (method 1) **or** `ppeCategory` (method 2). Today we store `ppeCategory` and `incidentEnergyCalCm2` but no arc-rating field and no method flag.

### 5.3 Shock-protection (independent of arc flash)

Shock boundaries protect against contact, are computed separately, and belong on the label too. From **NFPA 70E-2024 Table 130.4(E)(a) (AC)** / **(b) (DC)**: [verified, 2 sources: ToolGrit; NFPA structure]

| Nominal voltage (AC) | Limited approach (movable / fixed) | Restricted approach |
|---|---|---|
| 120–150 V | 3 ft 6 in / 3 ft 6 in | Avoid contact |
| 151–600 V (208/277/480 V) | 3 ft 6 in / 3 ft 6 in | **1 ft 0 in (305 mm)** |
| 601–2500 V | (table) / 4 ft 0 in | 2 ft 2 in |
| 2501–15000 V | (table) / 5 ft 0 in – 5 ft 8 in | 2 ft 7 in – 4 ft 3 in |

- The **prohibited approach boundary was removed in NFPA 70E-2021**; only **limited** and **restricted** remain. [verified, 1 source]
- DC has its own table (130.4(E)(b)); DC boundaries are larger at equal voltage (DC arcs sustain more readily).
- Shock and arc-flash boundaries are **independent** — either can be larger. Capture **nominal voltage**, **limited approach**, **restricted approach** per bus.

### 5.4 The arc-flash label (NFPA 70E 130.5(H)) — exact required content

Minimum required on the field-applied label: [verified, 3 sources: BradyID; Schneider; ToolGrit]
1. **Nominal system voltage.**
2. **Arc-flash boundary.**
3. **At least ONE of:** (a) available **incident energy + corresponding working distance**, OR (b) **minimum arc rating of clothing**, OR (c) **site-specific level of PPE** (category). *Only one of the three.*
4. **Date** of the study/analysis. (Plus, in practice, equipment ID and the shock approach boundaries.)
5. **2024 edition addition:** the label must be of **sufficient durability for the environment** in which it is installed.

### 5.5 DANGER vs WARNING convention (and its basis)

- Use a red **DANGER** header when **incident energy > 40 cal/cm2 OR nominal voltage > 600 V**; otherwise an orange **WARNING** header. [verified, 2 sources]
- **Basis of the 40 cal/cm2 line:** a long-standing NFPA 70E **Informational Note** (historically in 130.7(A)) that above 40 cal/cm2 "greater emphasis may be necessary with respect to de-energizing." It is industry-recognized guidance / the practical "do not work it energized" line, **not an absolute code prohibition** (NFPA 70E is a consensus standard; OSHA references it). [verified, 2 sources]

> Capture a derived `labelSeverity` ("danger" | "warning") computed from incident energy + voltage; store it so we can trend how many buses cross into DANGER over time (memory notes this is already a HERO trend on the demo).

### 5.6 Re-study / review triggers (NFPA 70E 130.5)

[verified, 2 sources: ToolGrit; ECMag] NFPA 70E 130.5 requires the arc-flash risk assessment be **reviewed at least every 5 years**, **and whenever a major modification or renovation** changes available fault current or clearing times — e.g., **added/removed/replaced transformer, changed breaker trip-unit settings, new large motor or generator, modified bus configuration, utility change**. Capture the **performed date, expiry (= performed + 5 yr), trigger reason, and a supersedes chain** (we already have these on `SystemStudy`).

---

## 6. Equipment-class typicals (IEEE 1584-2018) — defaults table

Use these as **defaultable typicals** when the field tech cannot measure; a PE may override. Working distances from Table (working-distance table); gaps from Table (typical-bus-gap table) / NFPA 70E Table D.4.2. [verified, 3 sources: ToolGrit; ELEK; engineersedge — values consistent across all three]

| Equipment class | Typical electrode config | Typical conductor gap (mm) | Typical working distance (in / mm) |
|---|---|---|---|
| LV panelboard (& other <= 240 V / 600 V equipment) | VCB | 25 | 18 in / 455 mm |
| LV MCC (motor control center) | VCB (or HCB if horizontal bus) | 25 | **18 in / 455 mm** (groups with panelboards, NOT switchgear — using 24 in underestimates energy ~40%) [verified, 1 explicit source: ToolGrit] |
| LV switchgear (600 V class) | VCB | 32 | 24 in / 610 mm |
| Cable / cable junction | VCB | 13 | 18 in / 455 mm [FLAG: 13 mm widely cited as the LV-cable typical; confirm against the exact IEEE table] |
| 5 kV (2.7 kV class) switchgear | VCB | 104 | 36 in / 910 mm |
| 15 kV (14.3 kV class) switchgear | VCB | 152 | 36 in / 910 mm |
| Open-air bus (any) | VOA / HOA | per voltage (19–254 mm test range) | task-specific |

> Notes: gap test ranges were 6–76 mm (LV) and 19–254 mm (MV). The 25 mm panelboard/32 mm LV-switchgear/104 mm 5 kV values are the most consistently cited typicals. [verified, 3 sources]

---

## 7. Test / measurement results that feed or relate to a study (NETA)

Arc-flash incident energy and boundaries are explicitly required to be derived **from the results of the short-circuit and coordination studies** (ANSI/NETA ATS). Relevant NETA categories: [verified, 2 sources: NETAWorld; NETA ATS excerpt]
- **Protective-relay calibration / functional test** — confirms relays trip at the assumed pickup/time (the §2.4 settings) → validates the clearing time used in the study.
- **Circuit-breaker trip test / primary injection** (ANSI/NETA ATS 7.6.1.x) — confirms breaker actually clears at assumed times.
- **As-found vs as-left settings** — NETA cross-checks the coordination study against the trip unit's *actual* available settings. **If field settings differ from the study's assumed settings, the incident-energy result is invalid.** This is a strong argument for ServiceCycle to capture **as-found/as-left device settings** and flag drift from the study assumptions.

> Capture implication: an optional link from a **field test record** (relay cal, breaker trip test, as-found/as-left) to the bus/device, so a settings change automatically flags "study may be stale."

---

## 8. Schema-gap analysis vs ServiceCycle's current model

### 8.1 Current model (as built — `server/prisma/schema.prisma`)

**Per-bus = `SystemStudyAsset`:** `busName, nominalVoltage (String), incidentEnergyCalCm2, arcFlashBoundaryIn, workingDistanceIn, ppeCategory (Int), boltedFaultCurrentKA, arcingCurrentKA, electrodeConfig (String, no DB enum), conductorGapMm, clearingTimeMs, upstreamDevice (String, free text)`.

**Study = `SystemStudy`:** `studyType, performedDate, expiresAt, performedBy, method (String), peName, peLicense, trigger, reportPdfUrl, supersededById`.

> **Important finding:** the per-bus device fields named in the kickoff brief — `deviceType (breaker|fuse|relay|switch)`, `deviceManufacturer`, `deviceModel`, `deviceRatingA`, `deviceSettings (JSON)`, `cableLengthFt`, `cableSize`, `cableMaterial` — and the **system fields** (`sourceVoltage`, `mainTransformer{...}`, `serviceFaultCurrentKA`, `utility{maxFaultKA,minFaultKA,xr}`) are **NOT present in the current `schema.prisma`.** `SystemStudyAsset` only carries `upstreamDevice` as free text and has no transformer/utility/cable structure at all. (Searched the live schema; only `nameplateDefaults` JSON exists for transformer-ish data, on a different model.) **Treat the brief's "current fields" as the intended/target model, but know the device + system blocks are still mostly unbuilt — that widens the gap.** [FLAG: could not locate a TypeScript-side type carrying those device/system fields; the arc-flash ingest service/UI from memory ("ArcFlashIngestPanel", Slice 2) was not found under the on-disk `server/src` path during this read-only pass — it may live in a feature branch/worktree not checked out here.]

### 8.2 The biggest *categories* we are missing

1. **Protective-device structure & the settings-vs-derivable distinction** (the root cause of the trip-settings bug). No `deviceType` enum, no `tripUnitType`, no `fuseClass`, no structured `deviceSettings`, no relay ANSI numbers / CT ratio.
2. **Enclosure dimensions + type** (needed for the 2018 enclosure-size correction). Completely absent.
3. **Source/system model:** utility MAX/MIN + X/R, transformer (kVA/V/%Z/X-R/connection), motor & generator contributions, structured cable/conduit. Absent from the arc-flash model.
4. **Both PPE methods + arc rating.** We store `ppeCategory` and `incidentEnergyCalCm2` but **no `requiredArcRatingCalCm2`** and no `ppeMethod` flag.
5. **Shock-protection data** (limited/restricted approach boundaries). Absent.
6. **Mitigation flags** (ERMS/maintenance mode, ZSI, differential, arc-resistant, NEC 240.87 method). Absent — yet they explain anomalies and drive two-state labels.
7. **Reduced-arcing-current scenario + governing flag, and per-bus calc method** (IEEE 1584 vs Lee). Absent.
8. **NETA test linkage / as-found vs as-left** to flag stale studies. Absent.

### 8.3 Recommended concrete schema additions

Classification key: **[REQ]** required to run IEEE 1584 · **[TYP]** typical-defaultable · **[OUT]** outcome/label · **[MIT]** mitigation/context.

#### A. Refine / add enums (Prisma `enum` + DB-level)
```
enum ElectrodeConfig { VCB VCBB HCB VOA HOA }                         // [REQ] replace String
enum DeviceType { fuse mccb_thermal_magnetic mccb_electronic iccb lvpcb relay_breaker switch other }  // [REQ] replace breaker|fuse|relay|switch
enum TripUnitType { none thermal_magnetic electronic_lsi electronic_lsig }   // [REQ] (none = fuse/switch)
enum FuseClass { L RK1 RK5 J T CC G CF H K other }                    // [REQ when DeviceType=fuse]
enum EnclosureType { panelboard mcc lv_switchgear mv_switchgear cable open_air other }  // [TYP]
enum PpeMethod { incident_energy ppe_category }                       // [OUT]
enum CalcMethod { ieee_1584_2018 lee_method manufacturer_test }       // [OUT]
enum LabelSeverity { warning danger }                                 // [OUT] derived
```

#### B. New per-bus (`SystemStudyAsset`) fields
| Field | Type | Class | Why |
|---|---|---|---|
| `electrodeConfig` | `ElectrodeConfig?` | [REQ] | promote String → enum |
| `enclosureType` | `EnclosureType?` | [TYP] | default gap/working-distance/CF source |
| `enclosureHeightMm` / `enclosureWidthMm` / `enclosureDepthMm` | `Decimal?` | [REQ for CF] | enclosure-size correction (508 mm normalized) |
| `calcMethod` | `CalcMethod?` | [OUT] | IEEE 1584 vs Lee (>15 kV) |
| `arcingCurrentReducedKA` | `Decimal?` | [OUT] | the reduced (VarCf) scenario |
| `governingScenario` | `String?` ("full"\|"reduced") | [OUT] | which gave the higher energy |
| `requiredArcRatingCalCm2` | `Decimal?` | [OUT] | incident-energy PPE method (ATPV/EBT) |
| `ppeMethod` | `PpeMethod?` | [OUT] | which method the label uses |
| `labelSeverity` | `LabelSeverity?` | [OUT] | derived DANGER/WARNING (>40 cal or >600 V) |
| `shockLimitedApproachIn` / `shockRestrictedApproachIn` | `Decimal?` | [OUT] | NFPA 70E 130.4(E) |
| `nominalVoltageV` | `Int?` | [REQ] | numeric companion to the `nominalVoltage` String (for computation/trending) |

#### C. New protective-device block (per bus — promote `upstreamDevice` free text)
| Field | Type | Class | Why |
|---|---|---|---|
| `deviceType` | `DeviceType?` | [REQ] | drives settings-vs-derivable rule |
| `tripUnitType` | `TripUnitType?` | [REQ] | TM vs LSIG → settings required? |
| `fuseClass` | `FuseClass?` | [REQ if fuse] | clearing from class+rating, no settings |
| `deviceManufacturer` / `deviceModel` | `String?` | [TYP] | pick the right TCC |
| `deviceFrameA` / `deviceRatingA` / `deviceSensorA` | `Int?` | [REQ] | TCC selection |
| `deviceVoltageRatingV` | `Int?` | [TYP] | fuse/breaker voltage class |
| `relayDeviceNumbers` | `String[]` | [REQ if relay] | ANSI 50/51/50G/51G/87/… |
| `ctRatio` | `String?` | [REQ if relay] | convert pickup → primary A |
| `deviceSettings` | `Json?` | [REQ if electronic/relay] | `{ ltPickupA, ltDelayS, stPickupA, stDelayS, instPickupA, gfPickupA, timeDial, curveType }` — **null/N-A for fuse & thermal-magnetic** (this encodes the bug fix) |
| `ermsPresent` / `ermsReducedInstA` / `ermsReducedEnergyCalCm2` | `Boolean?`/`Decimal?` | [MIT] | maintenance-mode 2nd label state |
| `zsiEnabled` / `differentialPresent` / `arcResistant` | `Boolean?` | [MIT] | explain low energy; arc-resistant doors-open/closed |
| `nec24087Method` | `String?` | [MIT] | required documentation when trip setting >= 1200 A |
| `clearingTimeSource` | `String?` ("tcc"\|"coordination_study"\|"default_2s") | [REQ] | provenance of `clearingTimeMs` |

> **Validation rule to bake in (and to drive the gap punch-list):** `deviceSettings` is **REQUIRED** only when `tripUnitType IN (electronic_lsi, electronic_lsig)` or `deviceType = relay_breaker`; it must be **omittable** for `fuse`, `mccb_thermal_magnetic`, and `switch`. For those, require `fuseClass + deviceRatingA` (fuse) or `deviceFrameA + deviceRatingA` (thermal-magnetic) instead.

#### D. New system/source model (new `StudySourceModel` or fields on `SystemStudy` / site)
| Field | Type | Class | Why |
|---|---|---|---|
| `utilityMaxFaultKA` / `utilityMinFaultKA` / `utilityXr` | `Decimal?` | [REQ] | both bounds — MIN can govern |
| transformer: `kva` / `primaryVoltageV` / `secondaryVoltageV` / `impedancePct` / `xr` / `connection` | mixed | [REQ] | secondary fault current |
| `motorContributionHp` (total) / `motorContributionCount` | `Int?` | [REQ] | no 50 HP exemption in 2018 |
| generator: `kva` / `voltageV` / `subtransientXdPct` | mixed | [REQ if present] | alternate-mode fault current |
| cable: `cableLengthFt` / `cableSize` / `cableMaterial (Cu\|Al)` / `conductorsPerPhase (Int)` / `conduitType (steel\|pvc\|al)` | mixed | [REQ] | impedance + reactance |
| `below125kvaFlag` (derived) | `Boolean?` | [MIT] | surface §4.3 "verify, don't auto-exempt" — never auto-skip |

### 8.4 Highest-impact, lowest-risk additions (do these first)
1. **`ElectrodeConfig` enum** (String → enum) — trivial, prevents bad data, you already use exactly these 5 values. **[lowest risk]**
2. **Device block with `deviceType` + `tripUnitType` + `fuseClass` + the conditional-`deviceSettings` rule** — directly fixes and generalizes the trip-settings bug; additive, all nullable. **[highest impact]**
3. **`requiredArcRatingCalCm2` + `ppeMethod`** — completes PPE capture for the incident-energy method; one column + one enum.
4. **Shock approach boundaries (`shockLimitedApproachIn`, `shockRestrictedApproachIn`) + `labelSeverity`** — completes the NFPA 70E 130.5(H) label; cheap, all derived/optional.
5. **Enclosure dimensions (`enclosureHeightMm/Width/Depth` + `enclosureType`)** — unlocks the 2018 enclosure-size correction and gives defaultable typicals.

All are **additive, nullable columns / new enums** → no destructive migration, no backfill required, safe to ship behind the existing arc-flash feature flag.

---

## Sources

- IEEE 1584-2018 model, electrode configs, VarCf reduced-arcing-current formula, typical gaps/working distances, Lee method, 5-yr / change triggers, label content — ToolGrit, *Understanding Arc Flash Incident Energy: IEEE 1584-2018 Explained*: https://www.toolgrit.com/guides/arc-flash-incident-energy-guide
- Five electrode configurations (VCB/VCBB/HCB/VOA/HOA) defined — Jim Phillips, P.E. (Brainfiller), *Electrode Configuration and 2018 IEEE 1584*: https://brainfiller.com/brainfiller-library/arc-flash-electrical-safety/electrode-configuration-and-2018-ieee-1584/
- Enclosure-size correction factor (508 mm normalized cube, small/medium/large/XL, shallow definition) — Brainfiller, *2018 IEEE 1584 – Enclosure Size Adjustment Factor*: https://brainfiller.com/technical-articles/2018-ieee-1584-enclosure-size-adjustment-factor/
- Step-by-step study inputs, 2-second default (clause 6.9.1), range of applicability, dual arcing-current — ELEK, *Arc Flash Calculation Example Using IEEE Standard 1584*: https://elek.com/articles/step-by-step-arc-flash-calculation-real-world-example-using-ieee-standard-1584/
- Range of applicability, IEEE 1584-2018 overview — EasyPower: https://www.easypower.com/ieee-1584-2018 ; AllumiaX: https://www.allumiax.com/blog/ieee-1584-2018-published-2018-ieee-guide-for-performing-arc-flash-hazard-calculations
- 125 kVA / <240 V / <2000 A change (§4) — Industrial Monitor Direct: https://industrialmonitordirect.com/blogs/knowledgebase/arc-flash-lower-limit-ieee-1584-cut-off-thresholds-for-240v-equipment ; Mike Holt forum (small motors / 50 HP): https://forums.mikeholt.com/threads/arc-flash-and-small-motors-50hp.2559139/
- Fuse classes / current-limiting / RK5→RK1 mitigation — Eaton Bussmann, *14 Classes of Fuses*: https://www.eaton.com/content/dam/eaton/products/electrical-circuit-protection/fuses/solution-center/bus-ele-tech-lib-fuse-classes.pdf ; Mersen, *Reducing Arc Energies with Fuses*: https://www.mersen.com/en/resources/welcome-arc-flash-info-center/reducing-arc-energies-fuses
- MCCB thermal-magnetic vs electronic (LSI/LSIG) — Eaton K-Frame MCCB: https://www.eaton.com/content/dam/eaton/products/electrical-circuit-protection/molded-case-circuit-breakers/series-c-molded-case-circuit-breakers/series-c-k-frame-310-mccb-pa012003en.pdf ; IECI, *Evolution of MCCB Trip Units*: https://ieci.org/evolution-of-the-molded-case-circuit-breaker-trip-units-and-their-value-to-customers/
- ICCB / LVPCB taxonomy — Eaton, *Power Circuit Breakers & Insulated-Case Circuit Breakers*: https://www.eaton.com/content/dam/eaton/products/design-guides---consultant-audience/cag-documents-from-wcm/power-circuit-breakers-and-insulated-case-circuit-breakers-tb01900003e.pdf
- ERMS / ZSI / differential / arc-resistant mitigation — Schneider, *Solutions for arc flash incident energy mitigation*: https://www.se.com/us/en/faqs/FA272576/ ; EC&M, *Seven Ways to Reduce Arc Flash Incident Energy*: https://www.ecmweb.com/test-measurement/article/21260377/seven-ways-to-reduce-arc-flash-incident-energy
- NEC 240.87 (1200 A trigger, documented methods) — ExpertCE: https://expertce.com/learn-articles/nec-240-87-arc-energy-reduction/ ; Schneider blog: https://blog.se.com/energy-management-energy-efficiency/2015/02/11/nec-section-240-87-acceptable-methods-arc-energy-reduction/
- NFPA 70E 130.5(H) label content + 2024 durability addition — BradyID: https://www.bradyid.com/applications/arc-flash-labeling-requirements ; Schneider blog: https://blog.se.com/energy-management-energy-efficiency/electrical-safety/2024/06/14/arc-flash-equipment-marking-requirements-is-your-installation-compliant/
- DANGER vs WARNING (>40 cal / >600 V) + 40 cal basis — payapress quick reference: https://payapress.com/arc-flash-label-requirements-nfpa-70e-ieee-1584-2025-quick-reference-guide/ ; Mike Holt forum: https://forums.mikeholt.com/threads/arc-flash-label-warning-vs-dangerous-labels.2577960/
- NFPA 70E Table 130.7(C)(15)(a) parameters + clearing-time informational note — Arc Flash 101: https://arcflash101.webflow.io/lookup-tables/table-130-7-c-15-a-ppe-categories-for-ac-systems
- Shock approach boundaries (Table 130.4(E)), prohibited boundary removed 2021 — ToolGrit, *Shock Approach Boundaries*: https://www.toolgrit.com/guides/shock-approach-boundary-guide
- NETA ATS testing & as-found/as-left vs study — NETAWorld, *The Modern Circuit Breaker Trip Unit: A Protective Relay by Another Name*: https://netaworldjournal.org/2025/11/joelwilbur/industry-topics/the-modern-circuit-breaker-trip-unit-a-protective-relay-by-another-name/ ; ANSI/NETA ATS overview: https://blog.ansi.org/ansi/ansi-neta-ats-2025-electrical-power-testing/
- Review of IEEE 1584-2018 impact (test count, enclosure/arc-current correction) — PCIC, *Review of IEEE 1584-2018*: https://pcic.energy/wp-content/uploads/Impact-of-IEEE-1584-2018-on-Arc-Flash-Safety.pdf

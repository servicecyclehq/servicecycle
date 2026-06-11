# PowerDB Field-Schema Catalog — Cables

**ServiceCycle EquipmentType:** `CABLE_MV_HV`, `CABLE_LV`, `BUSWAY` (bus duct shares cable IR form),
`CABLE_TRAY` (no dedicated test form — physical inspection only via Inspection Sheet 66500).

**Source:** `https://www.powerdb.com/download/PDF/CABLES.pdf` (full detail) + AllForms TOC.
Common header block applies.

Shared **Cable Nameplate** section across all cable forms: MANUFACTURER, SIZE (kcmil/MCM),
NO. OF CONDUCTORS, CONDUCTOR MATERIAL (CU/AL), INSULATION TYPE, INSULATION THICKNESS (mils),
RATED kV, OPERATING kV, LENGTH (ft), AGE, SHIELDED/UNSHIELDED, INSTALLED IN (conduit/tray/duct),
NUMBER OF SPLICES / TERMINATIONS / MANHOLES, CABLE TEMPERATURE (°C).

---

## STANDARD (routine NFPA 70B maintenance)

### Form 12000 — Low Voltage Cable Insulation Test  [standard]  (-> CABLE_LV)
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| A-GND / B-GND / C-GND / N-GND | insulation_resistance | megohms | yes |
| A-B / A-C / B-C / A-N / B-N / C-N | insulation_resistance | megohms | yes (pair) |
| Reading 20°C (TCF corrected) | insulation_resistance_20c | megohms | yes |
| Temp Corr Factor to 20°C | temp_correction_factor_20c | factor | no |
| Test Voltage | ir_test_voltage | kVDC | no |

### Form 13000 — Cable Polarization Index (PI) Test  [standard]
Per-phase IR over time (0.25..10 min), per phase A/B/C:
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| Reading @ minute t | insulation_resistance_t | megohms | yes |
| 20°C Reading | insulation_resistance_20c | megohms | yes |
| Temp Corr Factor | temp_correction_factor_20c | factor | yes |
| Polarization Index (10/1 min) | polarization_index | ratio | yes |
| Min. Design Insulation Resistance R | min_design_ir | megohms | no |
| Shield Resistance A-B/B-C/C-A | shield_resistance | ohms | yes |

### Form 14000 — Bus Duct Insulation Test  [standard]  (-> BUSWAY)
Section: **Nameplate** — MANUFACTURER, TYPE, VOLTAGE CLASS, VERTICAL/HORIZONTAL/NEUTRAL/GROUND
  RATING (A), CONFIGURATION (3/4/5 wire), CONDUCTOR (CU/AL), WITHSTAND kA.
IR phase-to-phase & phase-to-ground (megohms, TCF to 20°C) — same matrix as Form 12000.

### Form 14100 — Switchboard/Bus Connection Test  [standard]  (-> BUSWAY/SWITCHBOARD)
Bus connection resistance A/B/C/N/G in MICRO-OHMS, from/to section identification.

---

## OPTIONAL / ADVANCED (acceptance & MV/HV diagnostics)

- Form 13100 / 13101 / 13200 — **Cable High Potential Test** (DC hipot), per phase, leakage
  current (µA) over time-vs-voltage steps, decay-to-5kV time. `hipot_leakage_current` µA,
  `hipot_test_voltage` kV. **[optional/advanced — acceptance/proof]**
- Form 13050 — **VLF Cable Test** (very low frequency withstand/diagnostic). **[advanced]**
- Form 13090 — **Tan Delta Cable Test** (dissipation factor vs voltage step). `tan_delta`,
  `tan_delta_tip_up`. **[advanced — diagnostic]**
- Form 96005 — **PF Cables** (power factor). **[advanced]**
- Form 13300 — Time Domain Reflectometer (fault location). **[diagnostic]**
- Form 65100 — Manhole Inspection Report. **[inspection]**

> `CABLE_TRAY`: no electrical test form; use generic Inspection Sheet (66500) / Infrared.

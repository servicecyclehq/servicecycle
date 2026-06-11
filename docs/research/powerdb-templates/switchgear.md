# PowerDB Field-Schema Catalog — Switchboards / Switchgear / Panelboards

**ServiceCycle EquipmentType:** `SWITCHGEAR`, `SWITCHBOARD`, `PANELBOARD`.
(PowerDB groups all under category "SWITCHBOARDS". MV forms = switchgear; LV/power-panel = switchboard/panelboard.)

**Source:** `https://www.powerdb.com/download/PDF/SWITCHBOARDS.pdf` (full detail) + AllForms TOC.
Common header block applies.

Shared **Nameplate** section: MANUFACTURER, CATALOG NO, SERIAL NO, TYPE, VOLTAGE CLASS,
PHASE AMPACITY (A), WITHSTAND/INTERRUPTING RATING (kA), CONDUCTOR (CU/AL), DRAWING NO,
NUMBER OF BAYS. **Installed Devices** inventory: air breakers, vacuum breakers, overcurrent relays,
voltage relays, CTs, VTs/PTs, CPTs, kWHR meters, panel meters, loadbreak disconnects.

---

## STANDARD (routine NFPA 70B maintenance)

### Form 50300 — Power Panel Insulation Test  [standard]  (-> PANELBOARD)
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| A-GRD / B-GRD / C-GRD / N-GRD | insulation_resistance | megohms | yes |
| A-B / A-C / B-C / A-N / B-N / C-N | insulation_resistance | megohms | yes (pair) |
| Reading 20°C | insulation_resistance_20c | megohms | yes |
| Temp Corr Factor to 20°C (TCF) | temp_correction_factor_20c | factor | no |
| Equipment Temperature | equipment_temperature | °C | no |

### Form 50000 — Medium Voltage Switchboard Insulation Test  [standard]  (-> SWITCHGEAR)
Same IR matrix (bus section tested, A-GND…C-N) with:
| Field label | measurementType | unit |
|---|---|---|
| Insulation Test Voltage | ir_test_voltage | kVDC |
| Test Voltage Multiplier K1 | ir_voltage_multiplier_k1 | factor |
| K2 = K1 × TCF | ir_corrected_multiplier_k2 | factor |
Plus inspection checklist: insulating members, cubicles, ground connections, aux devices
(Inspected / Condition / Cleaned-Lubed).

### Form 50100 — Low Voltage Switchboard Insulation Test  [standard]  (-> SWITCHBOARD)
Same IR matrix, LV test voltage.

### Form 50400 — Switchboard Bus Connection Test  [standard]
Bus connection resistance per phase A/B/C/N/G in MICRO-OHMS (from/to bus section).
`bus_connection_resistance` µΩ, per-phase yes.

### Form 50900 — Switchgear Inspection  [standard]
Checklist with G/P/C/I condition codes: exterior, cubicle interiors, bus support insulators,
torque bolted bus, draw-out lubrication, breaker cell contacts, grounding, interlocks,
annunciator/target operation, automatic transfer relay. Plus a NETA-format
**Insulation Resistance / Overpotential / Connection Resistance** sub-block:
phase-to-phase-and-ground, measured megohms vs recommended minimum, pass/fail,
connection resistance per phase (ohms).

---

## OPTIONAL / ADVANCED

- Form 50050 — Medium Voltage Switchboard High Potential Test (DC hipot leakage µA per phase,
  K1 multiplier, total leakage). **[optional/advanced — acceptance]**

> `PANELBOARD`: use Form 50300 (Power Panel Insulation) + Panel Current/Voltage forms
> (28500/28510 in Miscellaneous). No tan-delta/PF form for switchboards (PF lives in Power Factor category).

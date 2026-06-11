# PowerDB Field-Schema Catalog — Batteries

**ServiceCycle EquipmentType:** `BATTERY_SYSTEM`, `UPS_BATTERY`.

**Source:** `https://www.powerdb.com/download/PDF/BATTERIES.pdf` (full detail) + AllForms TOC.
Common header block applies.

---

## STANDARD (routine NFPA 70B / IEEE 450/1188 maintenance)

### Form 10050 — Battery Inspection  [standard]
Section: **Nameplate** — MANUFACTURER, MODEL, NUMBER OF CELLS, CELL VOLTAGE (nominal),
  AMP HOUR RATING, SPECIFIC GRAVITY RANGE, COMMISSION DATE, CELL TYPE.
Section: **String Measurements** — overall_voltage (VDC), float_current (ADC),
  ac_ripple_current (A), total_ac_current (A).
Section: **Ground Test** — positive_terminal_to_gnd (VDC), negative_terminal_to_gnd (VDC).
Checklist: ventilation, eyewash, electrolyte level, flame arresters, corrosion, support racks.

### Form 10100 — Battery Inspection Specific Gravity  [standard]
Per-cell table (cells 1..N):
| Field label | measurementType | unit | per-cell |
|---|---|---|---|
| Cell No. | cell_number | - | yes |
| Specific Gravity | cell_specific_gravity | g/cm3 | yes |
| Cell Voltage | cell_voltage | V | yes |
| Cell Temperature | cell_temperature | °C | yes |

### Form 10200 — Battery Inspection Resistance (ohmic test)  [standard]
Per-cell table:
| Field label | measurementType | unit | per-cell |
|---|---|---|---|
| Resistance | cell_internal_resistance | µΩ | yes |
| Voltage Drop | cell_voltage_drop | mV | yes |
| Test Current | cell_test_current | A | yes |

### Form 10750 — Battery Impedance/Conductance Test (BITE)  [standard]
Per-cell impedance + strap resistance:
| Field label | measurementType | unit | per-cell |
|---|---|---|---|
| Cell Impedance | cell_impedance | mΩ | yes |
| % Deviation (baseline) | impedance_deviation_baseline | percent | yes |
| % Variation (string avg) | impedance_variation_avg | percent | yes |
| % Change (vs prev) | impedance_change_prev | percent | yes |
| Strap Resistance | strap_resistance | µΩ | per strap |
| Cell Voltage | cell_voltage | V | yes |
| Specific Gravity | cell_specific_gravity | g/cm3 | yes |

---

## OPTIONAL / ADVANCED (capacity/discharge — acceptance & periodic capacity)

- Form 10000 / 10500 / 10754 / 10756 — **Battery Discharge / Capacity Test** (constant-I, TORKEL).
  Fields: test_current (A), end_cell_voltage (V), end_battery_voltage (V), discharge_time (h),
  temp_corrected_time (h), measured_capacity_ah, percent_capacity_pct, per-time voltage/capacity
  curve points, per-cell voltage at intervals. **[optional/advanced — periodic capacity per IEEE 450]**
- Form 10757 — BVM Voltage Test (per-cell voltage during discharge). **[advanced]**
- Form 10760 — Cellcorder cell data capture. **[advanced — vendor tool]**

> `UPS_BATTERY`: Form 10500 (UPS Battery Discharge) adds UPS nameplate (kVA, in/out V/A/Hz,
> static/rotary type). For routine ServiceCycle import, prioritize 10050/10100/10200/10750 (ohmic+SG+voltage).

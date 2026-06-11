# PowerDB Field-Schema Catalog — Generators

**ServiceCycle EquipmentType:** `GENERATOR`. (Engine-generator / standby gensets.)

**Source:** `https://www.powerdb.com/download/PDF/GENERATORS.pdf` (full detail) + AllForms TOC.
Common header block applies.

Shared **Generator Nameplate**: GENERATOR MFR, S/N, MODEL NO, FRAME TYPE, kVA/kW, VOLTS(kV),
AMPS, RPM, PHASE, FREQUENCY, YEAR MANUF; plus GENERATOR CONTROL MFR, GOVERNOR MFR, VOLTAGE REG. MFR.
Engine nameplate (on PM reports): engine MFR, model, S/N, fuel type.

---

## STANDARD (routine NFPA 110 / NFPA 70B maintenance)

### Form 19275 / 19280 — Generator Polarization Index (PI) Test  [standard]
Per winding/phase IR over time (0.25..10 min), phase-to-ground and phase-to-phase:
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| Reading @ minute t | insulation_resistance_t | megohms | yes (A-G,B-G,C-G,A-B,B-C,C-A) |
| 20°C Reading | insulation_resistance_20c | megohms | yes |
| Temp Corr Factor | temp_correction_factor_20c | factor | yes |
| Polarization Index (10/1) | polarization_index | ratio | yes |
| Core/Coil Temperature | core_coil_temperature | °C | no |
| Phase-to-Ground Test Voltage | ir_test_voltage | kVDC | no |

### Form 19400 — Annual Engine-Generator PM Report  [standard]
### Form 19500 — Bi-Annual Engine-Generator PM Report  [standard]
Multi-system checklist (LOW/OK/HIGH + comments) covering: air cleaner, battery system
(cables, charger rate, cranking voltage drop, electrolyte, overall voltage, specific gravity),
lubrication, exhaust/mechanical, fuel system, generator (air gap, collector rings/brushes,
power feeder insulation tests), governor, radiator/cooling, control wiring.
Map each item -> {status:enum(low/ok/high), comment}.

### Form 19000 — Generator Load Test Report  [standard]
Time-interval readings during load run:
| Field label | measurementType | unit |
|---|---|---|
| Engine Speed (RPM) | engine_speed | rpm |
| Frequency | frequency | Hz |
| Engine Water/Radiator Temp | engine_water_temp | °F |
| Engine Oil Temp / Pressure | engine_oil_temp / engine_oil_pressure | °F / psi |
| Panel & Measured Voltage | voltage_panel / voltage_measured | V |
| Panel & Measured Amperes | current_panel / current_measured | A |
| Panel & Measured Kilowatts | power_panel / power_measured | kW |
| Battery Voltage | battery_voltage | V |
| Fuel Pressure / Level | fuel_pressure / fuel_level | psi / gal |

### Form 19200 / 19250 / 19100 — Generation System Status & Shutdown Tests  [standard]
Functional verification of alarms/shutdowns (overcrank, overspeed, low oil pressure,
high water/oil temp, reverse power/vars, emergency stop, etc.). Each ->
{indication, alarm_initiated, siren_activated, indicator_lamp_activated} booleans.

### Form 19300 — Switchgear Check List  [standard]
GOOD/FAIR/POOR inspection of associated switchgear (see switchgear.md for equivalent).

### Form 19600 — Generator (instrument panel results)  [standard]
Phase voltages (A-B/B-C/C-A), line currents (A/B/C), power (kW), frequency, engine hours,
oil pressure, water temp at time intervals.

## OPTIONAL / ADVANCED
- Form 98000 — Generator Tip-Up Test (stator power-factor tip-up). **[optional/advanced — diagnostic]**

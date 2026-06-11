# PowerDB Field-Schema Catalog — Protective Relays

**ServiceCycle EquipmentType:** `PROTECTION_RELAY`, `GROUND_FAULT_PROTECTION` (ground-fault relay subset).

**Source:** `https://www.powerdb.com/download/PDF/RELAYS.pdf` (full detail) + AllForms TOC
(40xxx–49xxx, 41200, 43351, 44xxx, plus electromechanical model forms 462xxx/465xxx — IAC/CO/CV series).
Common header block applies.

PowerDB has ~70 relay templates, mostly per-model (GE IAC-51A, CO-7, CV-2, SEL-351, etc.) but they
share the same SECTION skeleton. One generic schema covers them.

---

## STANDARD (routine NFPA 70B / functional calibration) — Form 45000 OVERCURRENT RELAY (generic)

### Section: Nameplate / Settings
| Field label | measurementType | unit |
|---|---|---|
| Manufacturer / Model / Type | relay_model | - |
| CT Ratio | ct_ratio | ratio |
| Devices Operated | devices_operated | - |
| Tap | tap_setting | - |
| Time Dial | time_dial_setting | - |
| Instantaneous setting | instantaneous_setting | A / multiple |
| Seal-In range | sealin_setting | A |
| Long Time / Inst. Range | range_setting | A |

### Section: Visual Inspection / Routine Maintenance  [standard]
Boolean checklist: cover gasket OK, glass cleaned, relay cleaned, contacts cleaned,
bearing condition/endplay OK, no moisture/rust/foreign material, connections tightened,
taps tightened, CT shorting bar removed, trip circuit tested. Map each -> bool.

### Section: Pickup Tests  [standard]
| Field label | measurementType | unit | as-found/as-left |
|---|---|---|---|
| Time Overcurrent Pickup | toc_pickup | A | both |
| Instantaneous Pickup | inst_pickup | A | both |
| Pickup Min / Max (tolerance) | pickup_min / pickup_max | A | - |

### Section: Timing Tests  [standard]
Per multiple-of-pickup row (e.g. 2×, 3×, 5×):
| Field label | measurementType | unit |
|---|---|---|
| Multiple of Current | timing_multiple | × pickup |
| Expected Max / Min | timing_max / timing_min | sec |
| As Found / As Left operate time | timing_as_found / timing_as_left | sec |
| Max Time to Operate / Reset Time | max_operate_time / reset_time | sec/cycles |

### Section: Insulation Resistance  [standard]
`insulation_resistance` (megohms) of relay case/coil to ground.

---

## Relay TYPE variants (all same skeleton; tag standard)
- Overcurrent (50/51): IAC-51/52/53/54/77/90, CO-2/5/6/7/8/9/11, 45000, 44500 (neg-seq 50/51). **[standard]**
- Differential (87): 46000, 48500 (transformer diff), 48510 (BDD), 40950/41000 (voltage diff). **[standard]**
- Directional (67/32): 46100/46200/46400, 47000/47200 (reverse power/current), CV-1..CV-8. **[standard]**
- Voltage (27/59): 49000, 49500 (O/C w/ voltage restraint), 40500 (balanced current). **[standard]**
- Frequency (81): 41500. **[standard]**
- Sync-check (25): 47900. Timing: 48000/47800. **[standard]**
- Motor protection: 44000 (mag overload), 44200 (motor protection controller). **[standard]**
- Multifunction digital: 41200 (Digitrip), 43351 (SEL-351), 49900 (generic multifunction). **[standard]**
- Metering module: 44100, 61600 (multifunction metering). **[review — metering not protection]**

## GROUND_FAULT_PROTECTION
- Form 22000 — Ground Fault Relay  [standard]: gf_pickup (A), gf_time_delay (sec), pickup/timing as-found/as-left.
- Form 22900 — Ground Fault Protection (system functional test)  [standard].
- Form 42500 — Ground Directional O/C Relay. **[standard]**
- Form 26000 — Line Isolation Monitor Test. **[review]**

## OPTIONAL / ADVANCED
- Coordination Data forms (18000 Circuit Breaker Data, 18100 Fuse Data, 18200/18210 Relay Settings,
  18300 Relay Data, 18400 Breaker Survey, 18500 Deficiencies) — these are **data-capture / coordination
  study** records, not pass/fail tests. **[optional/advanced — coordination study]**

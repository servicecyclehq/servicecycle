# PowerDB Field-Schema Catalog — Circuit Breakers

**ServiceCycle EquipmentType:** `CIRCUIT_BREAKER` (primary), `FUSE_GEAR` (molded-case/fused variants).

**Sources:** AllForms master (form bodies 15xxx / 16xxx / 92xxx present in detail).
Per-category `CIRCUIT_BREAKER.pdf` returned 404 — used AllForms.

Common header block applies (see transformer file).

---

## STANDARD (routine NFPA 70B / manufacturer maintenance)

### Form 15990 — Contact Resistance  [standard]
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| Contact Resistance Pole 1/2/3 (A/B/C) | contact_resistance | µΩ (micro-ohms) | yes |
| Test Current | contact_res_test_current | A | no |

### Form 15000 / 15055 — Low Volt. Power Circuit Breaker Test  [standard]
Section: **Nameplate** — MANUFACTURER, TYPE, SERIAL NO, FRAME AMP, TRIP AMP / SENSOR,
  VOLTAGE, INTERRUPTING RATING (kA).
Section: **Trip Unit / Overcurrent Function Test** (per phase):
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| Trip Amp Range / Setting | trip_setting | A | no |
| Long-Time Pickup (As Found / As Left) | lt_pickup | A | yes |
| Long-Time Delay | lt_delay | sec | yes |
| Short-Time Pickup | st_pickup | A | yes |
| Short-Time Delay | st_delay | sec | yes |
| Instantaneous Pickup | inst_pickup | A | yes |
| Ground Fault Pickup / Delay | gf_pickup / gf_delay | A / sec | no |
Section: **Insulation Resistance** — pole-to-pole, pole-to-ground, line-to-load (megohms, TCF to 20°C).
Section: **Contact Resistance** — per pole (µΩ).

### Form 15100 — Low Volt. Power Circuit Breaker Inspection  [standard]
Checklist: arc chutes, contacts, operating mechanism, charging motor, lubrication. (G/P/C/I codes.)

### Form 15800 / 15900 / 15950 — Molded Case Circuit Breaker Inspection/Test  [standard]
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| Frame Rating | frame_rating | A | no |
| Trip Rating | trip_rating | A | no |
| Insulation Resistance (pole-pole / pole-gnd) | insulation_resistance | megohms | yes |
| Contact/Pole Resistance | contact_resistance | µΩ | yes |
| Inverse-time Trip Test (300% / hold time) | itrip_300pct_time | sec | yes |
| Instantaneous Trip (high-current pulse) | inst_trip_result | pass/fail | yes |

### Form 92600 / 92610 — OCR / OCR Counter (mechanism timing)  [standard]
Open/close/trip timing, mechanism operation counts.

### Form 16001 / 16101 — Medium-Voltage Air / Vacuum Circuit Breaker  [standard]
Section: **Nameplate** — kV class, BIL, interrupting kA, mechanism type.
Section: **Contact Measurements** — main contact wipe/gap/travel (inches), per pole.
Section: **Contact Resistance** — per pole (µΩ).
Section: **Insulation Resistance** — pole-pole / pole-gnd / line-load (megohms, TCF).
Section: **Vacuum Integrity (vacuum bottles)** — vacuum_integrity pass/fail (hi-pot across open gap).
Section: **Timing** — open/close speed (ft/sec), contact bounce.

### Form 16201 / 16400 / 16500 / 16600 — Oil Circuit Breaker (incl. insulating fluid)  [standard]
Adds oil dielectric strength (kV), oil contact resistance, like-transformer oil fields.

---

## OPTIONAL / ADVANCED

- Form 92500/92510/92520/92525/92529/92530/92550 — **Power Factor (tan delta) tests** for
  air-mag / oil / SF6 (dead-tank, live-tank) / vacuum breakers & reclosers.
  `power_factor_pct`, `capacitance_pf`, `pf_corrected_20c`. **[optional/advanced]**
- Form 16300 — Oil Circuit Breaker Dissipation Factor. **[optional/advanced]**
- Form 15300 — Breaker Analyzer (Vanguard VCBA-2) — first-trip / dynamic motion. **[advanced/diagnostic]**

> `FUSE_GEAR`: covered by molded-case/fused breaker forms + fuse data on Disconnects forms
> (Form 18100 FUSE DATA from Coordination Data). No dedicated standalone fuse test template.

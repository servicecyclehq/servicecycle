# PowerDB Field-Schema Catalog — Disconnects

**ServiceCycle EquipmentType:** `DISCONNECT_SWITCH`, `FUSE_GEAR` (fused disconnects).

**Source:** `https://www.powerdb.com/download/PDF/DISCONNECTS.pdf` (full detail) + AllForms TOC.
Common header block applies.

Shared **Nameplate**: MANUFACTURER, MODEL/CATALOG NO, SERIAL NO, TYPE, AMPACITY, VOLTAGE,
CONTROL VOLTAGE, INTERRUPT/INTERRUPTING RATING (kA), B.I.L. RATING, OPERATING MECHANISM TYPE.
Shared **Fuse Data**: MANUFACTURER, SIZE, CAT. NO, TYPE/HOLDER, REFILL ELEMENT, TCC NO, MAX AMPS, VOLTAGE (kV).
Shared **Visual & Mechanical Inspection** checklist (Inspected/Condition/Cleaned-Lubed):
anchorage & alignment, blade alignment/penetration, physical/mechanical condition, grounding & clearances,
interlocks, phase barriers, fuse mountings, blade travel stops, mechanical operation, lubrication.

---

## STANDARD (routine NFPA 70B maintenance)

### Form 15510 — Low Voltage Air Switch  [standard]
| Field label | measurementType | unit | per-pole |
|---|---|---|---|
| Contact Resistance Pole 1/2/3 | contact_resistance | µΩ | yes |
| Bolted Connection Resistance | bolted_connection_resistance | µΩ/mΩ | yes |
| Fuse Resistance | fuse_resistance | µΩ | yes |
| Insulation: Pole-Pole / Pole-Frame / Line-Load | insulation_resistance | megohms | yes |
| Ground Fault Relay Pickup / Timing | gf_pickup / gf_timing | A / sec | no |

### Form 29000/29001 — Loadbreak Disconnect Test  [standard]
Adds **Contact Measurements** (inches): main contact wipe / gap / travel, arcing contact wipe,
opening/closing speed (ft/sec). Insulation: line-frame/load-frame/line-load/pole-pole/pole-frame
(megohms + 20°C). Contact resistance per pole (µΩ). Fuse resistance (µΩ).

### Form 29100/29101 — Disconnect Selector Switch  [standard]
Per-pole A/B position contact measurements + insulation per pole (P1-P2/P2-P3/P1-P3 megohms, 20°C).

### Form 15601/15602 — Fused Disconnect Inspection & Test  [standard]  (-> FUSE_GEAR)
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| Insulation A-GND…C-N | insulation_resistance | megohms | yes |
| Reading 20°C (TCF) | insulation_resistance_20c | megohms | yes |
| Contact Resistance A/B/C | contact_resistance | µΩ | yes |
| Fuse Resistance A/B/C | fuse_resistance | µΩ | yes |

### Form 15500/15501 — Bolted Pressure Switch Test  [standard]
Contact measurements (wipe/gap/travel, inches), contact & fuse resistance (µΩ),
insulation (pole-pole/line-frame/line-load/load-frame/pole-frame, megohms 20°C),
ground fault relay pickup/timing, control wiring IR (megohms). Inspection checklist of arc chutes,
main/arcing contacts, contact fingers, operating mechanism, contact sequence.

## OPTIONAL / ADVANCED
None specific — all disconnect forms are routine maintenance.

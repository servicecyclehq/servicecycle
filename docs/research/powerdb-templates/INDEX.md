# PowerDB Template Field-Schema Catalog — INDEX

Reference for the future ServiceCycle PDF-import parser. Built from PowerDB official blank
test-form templates (downloaded 2026-06, copyright PowerDB Inc. 2002-2014, rev. through 2014).

## Sources & fetch status
| Source | URL | Status |
|---|---|---|
| AllForms master (full TOC + Batteries/Cables/Circuit-Breaker bodies) | `https://www.powerdb.com/download/PowerDB_AllForms_AssetOwner.pdf` | OK (text truncated after Circuit Breakers; TOC complete = ~280 forms) |
| Transformers | `/download/PDF/TRANSFORMERS.pdf` | OK (full detail) |
| Batteries | `/download/PDF/BATTERIES.pdf` | OK |
| Cables | `/download/PDF/CABLES.pdf` | OK |
| Disconnects | `/download/PDF/DISCONNECTS.pdf` | OK |
| Generators | `/download/PDF/GENERATORS.pdf` | OK |
| Switchboards | `/download/PDF/SWITCHBOARDS.pdf` | OK |
| Relays | `/download/PDF/RELAYS.pdf` | OK |
| Infrared | `/download/PDF/INFRARED.pdf` | OK |
| Miscellaneous (arrester/bushing/capacitor/IR) | `/download/PDF/MISCELLANEOUS.pdf` | OK |
| Circuit Breaker (per-category) | `/download/PDF/CIRCUIT_BREAKER.pdf` | 404 — used AllForms bodies instead |
| Motor Control | `/download/PDF/MOTOR_CONTROL.pdf`, `MOTOR.pdf`, `MOTORCONTROL.pdf` | 404 — TOC only |
| Rotating Machinery | `/download/PDF/ROTATING_MACHINERY.pdf` | 404 — TOC only |
| Instrument Transformers | `/download/PDF/INSTRUMENT_TRANSFORMER(S).pdf`, `CURRENT_TRANSFORMER.pdf` | 404 — TOC only |
| Transfer Switches | `/download/PDF/TRANSFER_SWITCH(ES).pdf` | 404 — TOC only |
| Insulation Fluid | `/download/PDF/INSULATION_FLUID.pdf` | 404 — but covered by Transformers oil/DGA forms |
| Power Factor | `/download/PDF/POWER_FACTOR.pdf` | 404 — PF forms are advanced; named in TOC |
| Watthour Meters | `/download/PDF/WATTHOUR_METERS.pdf` | 404 — TOC only |
| Coordination Data | `/download/PDF/COORDINATION_DATA.pdf` | 404 — data-capture forms, named in TOC |
| Ground Mat / Grounding | `/download/PDF/GROUND_MAT.pdf`, `GROUNDMAT.pdf` | 404 — TOC only |
| Ground Fault | `/download/PDF/GROUND_FAULT.pdf` | 404 — 2 forms (22000/22900), in relay file |

**Filename rule discovered:** single-word category names work (`TRANSFORMERS`, `BATTERIES`,
`CABLES`, `DISCONNECTS`, `GENERATORS`, `RELAYS`, `SWITCHBOARDS`, `INFRARED`, `MISCELLANEOUS`);
multi-word categories have NO predictable `/download/PDF/<NAME>.pdf` filename (all variants 404).
Use the AllForms master TOC for those, or re-fetch via the PowerDB site UI later.

## Schema files produced
| File | EquipmentType(s) served |
|---|---|
| `transformer_liquid.md` | TRANSFORMER_LIQUID, TRANSFORMER_DRY |
| `circuit_breaker.md` | CIRCUIT_BREAKER, FUSE_GEAR |
| `switchgear.md` | SWITCHGEAR, SWITCHBOARD, PANELBOARD |
| `cable_mv_hv.md` | CABLE_MV_HV, CABLE_LV, BUSWAY, CABLE_TRAY (inspection only) |
| `battery_system.md` | BATTERY_SYSTEM, UPS_BATTERY |
| `protection_relay.md` | PROTECTION_RELAY, GROUND_FAULT_PROTECTION |
| `disconnect_switch.md` | DISCONNECT_SWITCH, FUSE_GEAR |
| `generator.md` | GENERATOR |
| `surge_arrester.md` | SURGE_ARRESTER |
| `grounding_system.md` | GROUNDING_SYSTEM (labels inferred) |
| `motor_mcc_vfd.md` | MOTOR, MCC, VFD (labels inferred) |
| `transfer_switch.md` | TRANSFER_SWITCH (labels inferred) |
| `instrument_transformers.md` | (CT/VT/PT — no exact enum; see file) |
| `_coverage_gaps.md` | EMERGENCY_LIGHTING, ARC_FLASH_PANEL, FIRE_PUMP_CONTROLLER = NO form |

## Form -> EquipmentType -> standard/optional map (primary forms)
| Form # | Form name | EquipmentType | std/opt | Source |
|---|---|---|---|---|
| 56300 | Transformer Turns Ratio (TTR) | TRANSFORMER_* | standard | TRANSFORMERS.pdf |
| 56350/56357 | Transformer Winding Resistance | TRANSFORMER_* | standard | TRANSFORMERS.pdf |
| 56600 | Transformer PI / IR | TRANSFORMER_* | standard | TRANSFORMERS.pdf |
| 56200 | Transformer Inspection | TRANSFORMER_* | standard | TRANSFORMERS.pdf |
| 57000/57100 | Transformer Liquid Coolant (oil quality) | TRANSFORMER_LIQUID | standard | TRANSFORMERS.pdf |
| 57200 | Dissolved Gas Analysis (DGA) | TRANSFORMER_LIQUID | standard | TRANSFORMERS.pdf |
| 56250 | Transformer Polarity | TRANSFORMER_* | standard | TRANSFORMERS.pdf |
| 56050/93500/94500/95500 | Power Factor / Tan Delta | TRANSFORMER_* | optional | TOC |
| 57500 | Furan Analysis | TRANSFORMER_LIQUID | optional | TOC |
| 15000/15055 | LV Power Ckt Bkr Test (trip unit) | CIRCUIT_BREAKER | standard | AllForms |
| 15100 | LV Power Ckt Bkr Inspection | CIRCUIT_BREAKER | standard | AllForms |
| 15800/15900/15950 | Molded Case Ckt Bkr Insp/Test | CIRCUIT_BREAKER/FUSE_GEAR | standard | AllForms |
| 15990 | Contact Resistance | CIRCUIT_BREAKER | standard | AllForms |
| 16001/16101 | MV Air / Vacuum Ckt Bkr | CIRCUIT_BREAKER | standard | TOC/AllForms |
| 16201/16400/16500/16600 | Oil Circuit Breaker (+fluid) | CIRCUIT_BREAKER | standard | TOC |
| 92500-92550 | PF tests (air/oil/SF6/vacuum bkr) | CIRCUIT_BREAKER | optional | AllForms |
| 15300 | Breaker Analyzer (VCBA-2) | CIRCUIT_BREAKER | optional | AllForms |
| 50300 | Power Panel Insulation | PANELBOARD | standard | SWITCHBOARDS.pdf |
| 50000 | MV Switchboard Insulation | SWITCHGEAR | standard | SWITCHBOARDS.pdf |
| 50100 | LV Switchboard Insulation | SWITCHBOARD | standard | SWITCHBOARDS.pdf |
| 50400 | Switchboard Bus Connection | SWITCHBOARD/BUSWAY | standard | SWITCHBOARDS.pdf |
| 50900 | Switchgear Inspection | SWITCHGEAR | standard | SWITCHBOARDS.pdf |
| 50050 | MV Switchboard High Potential | SWITCHGEAR | optional | TOC |
| 12000 | LV Cable Insulation | CABLE_LV | standard | CABLES.pdf |
| 13000 | Cable PI Test | CABLE_MV_HV | standard | CABLES.pdf |
| 14000 | Bus Duct Insulation | BUSWAY | standard | CABLES.pdf |
| 14100 | Bus Connection Test | BUSWAY | standard | CABLES.pdf |
| 13100/13101/13200 | Cable High Potential | CABLE_MV_HV | optional | CABLES.pdf |
| 13050 | VLF Cable Test | CABLE_MV_HV | optional | TOC |
| 13090 | Tan Delta Cable | CABLE_MV_HV | optional | CABLES.pdf |
| 96005 | PF Cables | CABLE_MV_HV | optional | CABLES.pdf |
| 10050 | Battery Inspection | BATTERY_SYSTEM | standard | BATTERIES.pdf |
| 10100 | Battery Inspection Specific Gravity | BATTERY_SYSTEM | standard | TOC |
| 10200 | Battery Inspection Resistance (ohmic) | BATTERY_SYSTEM | standard | BATTERIES.pdf |
| 10750 | Battery Impedance/Conductance (BITE) | BATTERY_SYSTEM | standard | BATTERIES.pdf |
| 10000/10500/10754/10756 | Battery/UPS Discharge (capacity) | BATTERY_SYSTEM/UPS_BATTERY | optional | BATTERIES.pdf |
| 45000 + IAC/CO/CV/40xxx-49xxx | Overcurrent/Diff/Dir/Voltage relays | PROTECTION_RELAY | standard | RELAYS.pdf |
| 22000/22900 | Ground Fault Relay / Protection | GROUND_FAULT_PROTECTION | standard | TOC |
| 18000-18500 | Coordination Data (breaker/fuse/relay) | PROTECTION_RELAY | optional | TOC |
| 15510 | LV Air Switch | DISCONNECT_SWITCH | standard | DISCONNECTS.pdf |
| 29000/29100 | Loadbreak / Selector Disconnect | DISCONNECT_SWITCH | standard | DISCONNECTS.pdf |
| 15601 | Fused Disconnect Insp & Test | FUSE_GEAR | standard | DISCONNECTS.pdf |
| 15500 | Bolted Pressure Switch | DISCONNECT_SWITCH | standard | DISCONNECTS.pdf |
| 19275/19280 | Generator PI Test | GENERATOR | standard | GENERATORS.pdf |
| 19400/19500 | Annual/Bi-Annual Engine-Gen PM | GENERATOR | standard | GENERATORS.pdf |
| 19000 | Generator Load Test | GENERATOR | standard | GENERATORS.pdf |
| 19200/19250/19100 | Gen System Status & Shutdown | GENERATOR | standard | GENERATORS.pdf |
| 98000 | Generator Tip-Up | GENERATOR | optional | GENERATORS.pdf |
| 65500 | Lightning Arrester Test (IR) | SURGE_ARRESTER | standard | MISCELLANEOUS.pdf |
| 65500 | Arrester Watt Loss Test | SURGE_ARRESTER | optional | MISCELLANEOUS.pdf |
| 24000/24010/24400 | Ground Mat / Fall of Potential | GROUNDING_SYSTEM | standard | TOC (inferred) |
| 24300 | Ground Rod Survey | GROUNDING_SYSTEM | standard | TOC |
| 32000/32300 | Motor PI / Stator Resistance | MOTOR | standard | TOC (inferred) |
| 30000/30100/31200 | MCC Inspection/Insulation/Test | MCC | standard | TOC (inferred) |
| 31000/31300 | Motor Starter Test | MCC/MOTOR | standard | TOC (inferred) |
| 32900 | Variable Frequency Drives (VFD) | VFD | standard | TOC (inferred) |
| 32100-32800, 98005/98006 | Synch motor / PF tip-up | MOTOR | optional | TOC |
| 54000/54100 | Automatic Transfer Switch Test | TRANSFER_SWITCH | standard | TOC (inferred) |
| 54200-54550 | ATS Controls / ASCO panels | TRANSFER_SWITCH | standard | TOC (inferred) |
| 27000-27800 | CT/VT/PT ratio, resistance, sat | (instrument xfmr) | standard | TOC (inferred) |
| 27600/27610 | PF CT/PT | (instrument xfmr) | optional | TOC |
| 52000/52005 | Thermographic Inspection | any (IR) | standard | INFRARED.pdf |
| 45444/45455 | Infrared Inspection (delta-T) | any (IR) | standard | INFRARED.pdf |
| 66500 | Inspection Sheet (generic) | any | standard | MISCELLANEOUS.pdf |

## Normalization conventions used across schema files
- Temperature correction: `temp_correction_factor_20c` (TCF), corrected reading `*_20c`. Nearly every
  IR-based test carries a "Temp Corr Factor to 20°C, TCF" field — make this a first-class column.
- Insulation resistance always in **megohms**; contact/connection resistance in **micro-ohms (µΩ)**;
  winding/ground resistance in **ohms**; battery ohmic in **µΩ or mΩ** (form-dependent — capture unit).
- Per-phase fields suffixed by phase (A/B/C/N) or connection pair (A-B, A-G, P1-P2). Store phase as a column.
- Most tests record **As Found / As Left** pairs (relays, trip units, meters) — capture both.

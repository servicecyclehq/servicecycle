# PowerDB Field-Schema Catalog — Transfer Switches

**ServiceCycle EquipmentType:** `TRANSFER_SWITCH`.

**Source:** AllForms master TOC only (category "TRANSFER SWITCHES"; per-category PDF 404'd).
Field detail INFERRED — verify before parsing. Common header block applies.

---

## STANDARD (routine NFPA 110 / NFPA 70B maintenance)

### Form 54000 / 54100 — Automatic Transfer Switch Test  [standard]
| Field label | measurementType | unit |
|---|---|---|
| ATS Manufacturer / Model / Serial | ats_nameplate | - |
| Rated Amps / Voltage / Poles | ats_rating | A / V |
| Normal-to-Emergency Transfer Time | transfer_time_n_to_e | sec |
| Emergency-to-Normal Re-Transfer Time | transfer_time_e_to_n | sec |
| Engine Start Time Delay | engine_start_delay | sec |
| Pickup / Dropout Voltage Settings | ats_pickup_voltage / ats_dropout_voltage | V / % |
| Time Delay Settings (TDNE/TDEN/TDES/TDEC) | ats_time_delay | sec |
| Contact / Connection Resistance | contact_resistance | µΩ | 
| Insulation Resistance (pole-pole / pole-gnd) | insulation_resistance | megohms |

### Form 54200 — ATS Controls  [standard]  (controller functional checks)
### Form 54300 / 54400 / 54500 / 54550 — ASCO control-panel group variants  [standard]
(Vendor-specific control panel test sheets — same transfer-timing/setting data.)

## OPTIONAL / ADVANCED
None notable — all routine. Field labels INFERRED; verify against actual template.

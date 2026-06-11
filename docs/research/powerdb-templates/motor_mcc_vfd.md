# PowerDB Field-Schema Catalog — Motors / Motor Control / VFD

**ServiceCycle EquipmentType:** `MOTOR`, `MCC`, `VFD`.

**Source:** AllForms master TOC only (categories "MOTOR CONTROL" and "ROTATING MACHINERY";
per-category PDFs not fetchable — MOTOR.pdf / MOTOR_CONTROL.pdf / ROTATING_MACHINERY.pdf all 404).
Field detail below is INFERRED from form names + standard motor test practice. **Verify labels before parsing.**
Common header block applies.

---

## STANDARD (routine NFPA 70B / NETA maintenance)

### MOTOR (rotating machinery) — Forms 32000 (Motor PI), 32300 (Stator Resistance), 32200 (High Pot)
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| IR reading @ minute t | insulation_resistance_t | megohms | yes |
| Polarization Index (10/1) | polarization_index | ratio | yes |
| Temp Corr Factor to 20°C | temp_correction_factor_20c | factor | yes |
| Winding/Stator Resistance | winding_resistance | ohms | yes (per lead pair) |
| Winding Temperature | winding_temperature | °C | no |
Forms: 32000 Motor PI Test, 32300 Motor Stator Resistance, 32200 Motor High Potential,
97560 Rotating Machinery PI, 98500 Rotating Machinery Step Voltage. **[standard]** (high-pot/step-volt = acceptance-leaning, mark review)

### MCC — Forms 30000 (MCC Inspection), 30100 (MCC Insulation), 31200 (MCC Test Report)
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| Bus/Bucket Insulation A-G/B-G/C-G | insulation_resistance | megohms | yes |
| Reading 20°C (TCF) | insulation_resistance_20c | megohms | yes |
| Contact/Connection Resistance | contact_resistance | µΩ | yes |
Forms: 30000, 30100, 31200, 31000/31001 (Motor Starter Test), 31300/31301 (MV Vacuum Motor Starter),
32950 (480V MCC PM). **[standard]**

### VFD — Form 32900 Variable Frequency Drives (VFD)  [standard]
Likely capture: drive nameplate (kW/HP, V, A, Hz range), input/output measurements, IR of motor leads,
firmware/fault log. Exact fields unverified.

---

## OPTIONAL / ADVANCED (synchronous-motor & PF diagnostics)
- 32100 Motor Dissipation Factor, 32400/32450 Synch Motor PI, 32500 Synch Motor Dissipation Factor,
  32600 Synch Motor High Potential, 32700 Synch Motor Winding Resistance, 32800 Synch Motor Rotor Winding.
  **[optional/advanced]**
- 98005 PF Rotating Machinery Tip-Up, 98006 PF Stator Coil Tip-Up. **[advanced — diagnostic]**

> All field labels here are inferred. The per-category PDFs were not retrievable; only the
> AllForms TOC (form numbers + names) is authoritative. Re-fetch MOTOR/ROTATING templates if possible
> before implementing the parser.

# PowerDB Field-Schema Catalog — Transformers

**ServiceCycle EquipmentType:** `TRANSFORMER_LIQUID`, `TRANSFORMER_DRY`
(Same PowerDB form set serves both; dry-type omits the oil/fluid forms. Auto-transformers
and 2-/3-winding distinctions are PF/acceptance variants — see "optional/advanced".)

**Sources:** `https://www.powerdb.com/download/PDF/TRANSFORMERS.pdf` (full detail),
plus AllForms master TOC (form numbers 56xxx / 57xxx / 9xxxx).

All PowerDB forms share a common header block: `OWNER`, `PLANT`, `SUBSTATION`, `POSITION`,
`ASSET ID`, `JOB #`, `DATE`, `PAGE`, `AMBIENT TEMP. (°F/°C)`, `HUMIDITY (%)`,
`TEST EQUIPMENT USED`, `TESTED BY`, `COMMENTS`, `DEFICIENCIES`. (Mapping omitted per-form below.)

---

## STANDARD (routine NFPA 70B / manufacturer maintenance)

### Form 56300 — Transformer Turns Ratio (TTR)  [standard]
Also: 56301/56001/56002/56003/56006/56011/56365/56370/56502/56004 (TTR variants, vendor-specific).
Section: **Nameplate** — MANUFACTURER, SERIAL NO, kVA, PRIMARY/SECONDARY VOLTAGE, WINDING MATERIAL (CU/AL),
  PHASE, VECTOR/CONNECTION, TAP positions.
Section: **Turns Ratio Test** (per tap, per phase):
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| Tap Position | tap_position | - | no |
| Nameplate / Calculated Ratio | turns_ratio_nameplate | ratio | yes (H1-H2/X1-X2 etc.) |
| Measured Ratio (TTR) | turns_ratio_measured | ratio | yes |
| % Deviation / % Error | turns_ratio_deviation | percent | yes |
| Excitation Current | excitation_current | mA | yes |
| Phase Angle | turns_ratio_phase_angle | degrees | yes |

### Form 56350/56351/56353/56357/56352/56355 — Transformer Winding Resistance  [standard]
Section: **Winding Resistance Test** (per winding/tap/phase):
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| Winding (H / X / Y) | winding_id | - | no |
| Tap | tap_position | - | no |
| Resistance (measured) | winding_resistance | ohms | yes (H1-H2…) |
| Test Current | winding_res_test_current | A | no |
| Winding Temp | winding_temperature | °C | no |
| Resistance corrected to 75°C/20°C | winding_resistance_corrected | ohms | yes |

### Form 56600 — Transformer PI Test (Polarization Index / IR)  [standard]
Also: 56150 (High Potential — review), 56700 (Maintenance Test combo).
Section: **Insulation Resistance** (windings to each other & ground):
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| Test connection (H-G, X-G, H-X) | ir_connection | - | no |
| Test Voltage | ir_test_voltage | VDC (kVDC) | no |
| Reading @ 1 min | insulation_resistance_1min | megohms | per connection |
| Reading @ 10 min | insulation_resistance_10min | megohms | per connection |
| Temp Corr Factor to 20°C (TCF) | temp_correction_factor_20c | factor | no |
| 20°C Corrected Reading | insulation_resistance_20c | megohms | per connection |
| Polarization Index (10min/1min) | polarization_index | ratio | per connection |
| Dielectric Absorption Ratio (DAR) | dielectric_absorption_ratio | ratio | per connection |
| Core/Coil Temperature | core_coil_temperature | °C | no |

### Form 56200 — Transformer Inspection  [standard]
Checklist (condition: Inspected / Condition / Cleaned-Lubed) of bushings, tap changer,
gaskets, oil level, pressure/vacuum gauge, radiators, nitrogen blanket, etc. Map as
inspection_item -> {inspected:bool, condition:enum, cleaned_lubed:bool}.

### Form 57000 — Transformer Liquid Coolant (Oil) Test  [standard]
Also: 57100/57110/57400/57450 (oil quality variants).
Section: **Oil Quality** (one set of values per sample):
| Field label | measurementType | unit |
|---|---|---|
| Dielectric Strength | oil_dielectric_strength | kV |
| Acidity / Neutralization No. | oil_acidity | mgKOH/g |
| Interfacial Tension (IFT) | oil_interfacial_tension | dynes/cm |
| Water Content / Moisture | oil_water_content | ppm |
| Power Factor / Dissipation Factor | oil_power_factor | percent |
| ASTM Color No. | oil_color | astm_no |

### Form 57200 — Dissolved Gas Analysis (DGA)  [standard]
Section: **Dissolved Gases (ppm)** — one column per gas:
| Field label | measurementType | unit |
|---|---|---|
| Hydrogen (H2) | dga_hydrogen | ppm |
| Methane (CH4) | dga_methane | ppm |
| Ethane (C2H6) | dga_ethane | ppm |
| Ethylene (C2H4) | dga_ethylene | ppm |
| Acetylene (C2H2) | dga_acetylene | ppm |
| Carbon Monoxide (CO) | dga_carbon_monoxide | ppm |
| Carbon Dioxide (CO2) | dga_carbon_dioxide | ppm |
| Oxygen (O2) | dga_oxygen | ppm |
| Nitrogen (N2) | dga_nitrogen | ppm |
| Total Dissolved Combustible Gas | dga_tdcg | ppm |

### Form 56250 — Transformer Polarity Test  [standard]
Winding polarity (additive/subtractive) per winding pair. Map polarity_result enum.

---

## OPTIONAL / ADVANCED (acceptance / diagnostic)

- Form 56050 / 93001 / 93002 / 93500 / 94500 / 95500 / 95501 / 65000 — **Power Factor / Dissipation Factor**
  (tan delta) tests, incl. bushing C1/C2 PF. measurementType: `power_factor_pct`, `capacitance_pf`,
  `pf_corrected_20c`, `bushing_c1_pf`, `bushing_c2_pf`. **[optional/advanced]**
- Form 56100 — Trans. Excitation Current Test. **[optional/advanced]**
- Form 93507 (MLR10) — Leakage Reactance & Capacitance. **[advanced]**
- Form 93510 / 399 — Magnetic Balance. **[review]** (sometimes routine on tap-changer issues)
- Form 57500 — Furfural (Furan) Analysis (paper aging). **[optional/advanced]**
- Form 56150 — Transformer High Potential Test. **[optional/advanced — acceptance]**
- Form 56400 / 56990 — LTC TTR / Voltage Regulator Maintenance. **[review]**
- Form 56356 — Heat Run Test. **[advanced]**

> Note: PowerDB's own form text states "Polarization Index should not be used to assess insulation"
> for some modern dry-type units — capture PI but treat pass/fail by IR + TCF.

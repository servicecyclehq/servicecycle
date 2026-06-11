# PowerDB Field-Schema Catalog — Surge / Lightning Arresters

**ServiceCycle EquipmentType:** `SURGE_ARRESTER`.

**Source:** `https://www.powerdb.com/download/PDF/MISCELLANEOUS.pdf` (Form 65500 in detail).
PowerDB files arresters under "Miscellaneous" / "Power Factor", not a dedicated category.
Common header block applies.

---

## STANDARD (routine NFPA 70B maintenance)

### Form 65500 — Lightning Arrester Test  [standard]
Section: **Nameplate** — MANUFACTURER, TYPE, MODEL, CATALOG NO, SERIAL NO,
  RATED RMS VOLTAGE (kV), RATED MCOV (kV), CURRENT RATING (kA), RATED CREST (kA),
  MATERIAL TYPE (POLYMER/PORCELAIN), ARRESTER TYPE (STATION/INTERMEDIATE/DISTRIBUTION),
  SYSTEM VOLTAGE (kV).
Section: **Insulation Test** (per phase to ground):
| Field label | measurementType | unit | per-phase |
|---|---|---|---|
| Insulation Test Voltage | ir_test_voltage | kVDC | no |
| Test Voltage / Range Multiplier | ir_voltage_multiplier | factor | no |
| Actual Megohms (A/B/C to GND) | insulation_resistance | megohms | yes |
| Corrected Megohms (20°C) | insulation_resistance_20c | megohms | yes |
| Temp Corr Factor to 20°C | temp_correction_factor_20c | factor | no |

## OPTIONAL / ADVANCED

### Form 65500 — Watt Loss Test  [optional/advanced]
| Field label | measurementType | unit |
|---|---|---|
| Milli-Watt Loss (grounded specimen) | arrester_watt_loss | mW |
| Test kV / Switch Setting | watt_loss_test_kv | kV |
| Correction Factor | watt_loss_correction_factor | factor |

> Power-factor / watt-loss arrester testing also appears under the Power Factor category
> (not separately fetchable). Treat IR test (Form 65500) as the routine import target;
> watt-loss as advanced/diagnostic.

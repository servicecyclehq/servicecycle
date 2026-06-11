# PowerDB Field-Schema Catalog — Grounding Systems

**ServiceCycle EquipmentType:** `GROUNDING_SYSTEM`.

**Source:** AllForms master TOC only (category "GROUND MAT (EARTH) GROUNDING TESTS";
per-category PDF not fetchable). Field detail inferred from standard fall-of-potential method.
Common header block applies.

---

## STANDARD (routine NFPA 70B / IEEE 81 maintenance)

### Form 24000 / 24020 — Ground Mat Test  [standard]
### Form 24010 / 24400 / 24420 — Fall of Potential Test  [standard]
| Field label | measurementType | unit |
|---|---|---|
| Probe Spacing / Distance | probe_distance | ft |
| Measured Resistance | ground_resistance | ohms |
| Resistance at 61.8% point | ground_resistance_618 | ohms |
| Soil Resistivity | soil_resistivity | ohm-cm / ohm-m |

### Form 24210 — Ground Resistance Two Terminal  [standard]
`ground_resistance` (ohms), two-terminal method.

### Form 24220 — Ground Point Continuity Test  [standard]
`ground_continuity_resistance` (ohms / mΩ) between bonded points.

### Form 24300 — Ground Rod Survey  [standard]
Per-rod: rod_id, ground_resistance (ohms), location.

### Form 25000 / 25100 — Grounded Surfaces Test  [standard]
Step/touch potential per surface point (volts / ohms).

## OPTIONAL / ADVANCED (specialized fall-of-potential analyses)
- 24440 Soil Resistivity, 24450 Star Delta, 24460 61.8% Rule, 24470 Intersecting Curves,
  24430 Slope, 24410 Four Potential, 24480 (DET24C instrument), 24200 Ground Resistivity.
  These are computation/method variants of the above. **[review — same data, different math]**
- Form 26000 Line Isolation Monitor Test. **[review — relates to ungrounded systems]**

> Field labels are NOT verified against the actual PDF (multi-word category file 404'd).
> Confirm exact labels before building the parser. Form numbers/names are authoritative (from TOC).

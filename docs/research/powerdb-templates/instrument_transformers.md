# PowerDB Field-Schema Catalog — Instrument Transformers (CT / VT / PT)

**ServiceCycle EquipmentType:** no exact enum match. Map to `PROTECTION_RELAY` asset's
associated CTs/VTs, or store under the parent SWITCHGEAR/SWITCHBOARD. Flag for a possible
new enum `INSTRUMENT_TRANSFORMER`.

**Source:** AllForms master TOC only (category "INSTRUMENT TRANSFORMERS"; per-category PDF 404'd).
Field detail INFERRED — verify before parsing. Common header block applies.

---

## STANDARD (routine NFPA 70B / NETA maintenance)

### CT — Forms 27650/27700/27000/27010/27100/27110 (CT Ratio & related)
| Field label | measurementType | unit |
|---|---|---|
| CT Nameplate Ratio | ct_ratio_nameplate | ratio |
| Measured Ratio | ct_ratio_measured | ratio |
| % Ratio Error | ct_ratio_error | percent |
| Polarity | ct_polarity | enum |
| Excitation/Saturation Curve points | ct_excitation_current | A vs V |
| Winding Resistance (Form 27800) | ct_winding_resistance | ohms |
| Insulation Resistance | insulation_resistance | megohms |
Forms: 27650 CT Test, 27700 CT Ratio, 27500 CT Ratio & Excitation, 27000/27150 CT Primary Injection Ratio,
27100 CT Sec Voltage Injection Ratio, 27110/27111 CT Ratio & Sat, 27660 Multi-Winding CT, 27800 MTO CT Resistance. **[standard]**

### VT / PT — Forms 27200/27750/27850/27300
| Field label | measurementType | unit |
|---|---|---|
| PT Nameplate Ratio | pt_ratio_nameplate | ratio |
| Measured Ratio | pt_ratio_measured | ratio |
| Winding Resistance (27850) | pt_winding_resistance | ohms |
| Applied/Insulation test (27300) | insulation_resistance | megohms |
Forms: 27200 Voltage Transformer Test, 27750 PT Ratio, 27850 MTO PT Resistance, 27300 VT Applied. **[standard]**

### CPT — Forms 27400/27450 Control Power Transformer Test  [standard]

## OPTIONAL / ADVANCED
- Form 27600 PF Potential Transformer, 27610 PF Current Transformer (power factor). **[optional/advanced]**

> Field labels INFERRED from form names + NETA practice. Verify against actual PDF before building parser.

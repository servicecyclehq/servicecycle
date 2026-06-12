# PDF parser vs. real PowerDB reports — corpus test findings
**Date:** 2026-06-11 · Corpus in `C:\Users\ddeni\Downloads\electrical tests\` (19 real PDFs; see electrical-test-reports-corpus.md). Ran the pyextract engine over all of them on the Windows host (python+pdfplumber 0.11.9).

## Headline
The engine works on the SYNTHETIC ruled-table samples we wrote, but **underperforms badly on real PowerDB/Megger reports** — exactly the risk Fable v2 §2.1 named. Fail-open + human-in-the-loop preview means nothing is broken in production (ingest still falls back to pdfjs and the user verifies), but deterministic extraction quality on real reports is currently low. This is the corpus-driven tuning the moat needs.

## What the corpus actually contains
- **Most PowerDB "form library" PDFs are BLANK templates** (DISCONNECTS, SWITCHBOARDS, TRANSFER SWITCHES, POWER FACTOR, the AllForms 21MB file, etc.) — no filled values. Useful for learning the LAYOUTS, not as completed-report ground truth.
- **One completed multi-asset PowerDB report:** `SAMPLE JOB.pdf` (41pp, multiple substations/assets). This is the real test.
- **Three completed non-PowerDB reports:** generator relay (prose), smart-ground (prose+tables), cable VLF tan-delta (utility form).
- The brother's REAL filled reports are still the #1 ask — one report family ≠ a corpus.

## Why real PowerDB breaks the current parser (grounded in SAMPLE JOB)
PowerDB does NOT lay out a `Test | Phase | Value | Unit | Limit | Result` column table (what the parser assumes). It uses **key-value GRIDS**:
1. **Label/value pairs across grid cells**, many per row:
   `['MANUFACTURER','ABB Inc','','VOLTAGE RATING','600 V','','RELAY ACC. CLASS','C400']`
   `['DATE','','2/6/2008','','','TEMPERATURE','70','°F','HUMIDITY','80','%','EQPT. LOCATION','3 FLOOR WEST']`
2. **Inline label:value in text**, e.g. `L1-G:267  L2-G:266  L3-G:267`, `T1-T2:272 T1-T3:220`.
3. **Phase encoded INSIDE the label** (`L1-G`, `T1-T2`, `X1-X5`, per-pole), not a separate phase column.
4. **Header lives in uppercase text labels** (`CUSTOMER`, `SUBSTATION A-123 POSITION MAIN`, `MANUFACTURER`, `MODEL NO.`, `SERIAL #`, `DATE`), not "Serial Number: X" inline pairs — so the current regex grabs the next label or the copyright line as the value.
5. **Multi-asset sections** delimited by `SUBSTATION <id> POSITION <name>` + `PAGE n of N` + a nameplate block — segmentation boundaries are clear and parseable.
6. Equipment-specific test blocks (CT ratio/excitation, breaker trip-unit AS-FOUND/AS-LEFT, transformer TTR) each have their own mini-layout.

## The fix (V4 stage 1 proper — scoped, grounded)
1. **Add a key-value-grid pass**: for ruled tables, scan cells; when a cell matches a known label (nameplate field OR measurement label OR an `L?-?`/`T?-?`/`X?-?` connection token), take the next non-empty cell as its value. This replaces "header row → columns" as the primary strategy for PowerDB. Keep the column-table pass as a secondary strategy.
2. **Rewrite header extraction** to PowerDB's uppercase labels from the text layer (CUSTOMER/OWNER/SUBSTATION/POSITION/MANUFACTURER/TYPE/CATALOG NO./MODEL NO./SERIAL #/DATE/TEMPERATURE/HUMIDITY), stopping a value before the next ALLCAPS label; ignore copyright/page footers.
3. **Treat connection tokens as phase** (`L1-G`,`T1-T2`,`X1-X5`,`A-G`,`H1-H2`…) → phase field.
4. **Section segmentation**: split on `SUBSTATION … POSITION …` / nameplate blocks → one asset per section (this is also W5/"one upload = one facility").
5. **Expand the measurement vocabulary** to PowerDB's real test names + the per-test value labels seen in the forms (use the blank form PDFs to enumerate them).
6. **Reject label-as-value**: when an extracted value equals a known label/ALLCAPS token, treat as empty (fixes "manufacturer = LABEL: AS FOUND: AS LEFT").
7. Re-test against SAMPLE JOB + the brother's reports after each change; pin known-good extractions as fixtures (no golden corpus exists yet).

## Bottom line
The pdfplumber engine + geometry approach is the right foundation (it cleanly read the grid cells — the data is all there). The MAPPING layer was tuned to the wrong layout. Retuning to PowerDB's key-value-grid reality is a focused, well-understood next chunk now that we can see the real structure — and it doubles as the multi-asset segmentation (W5) groundwork.

---
## UPDATE 2026-06-12 — retune shipped + verified live
Tuned `pyextract` against the real corpus (19 reports in `electrical tests/` + 8 completed in `2nd batch/`) and deployed. Results vs baseline:

| report | baseline meas | tuned meas | header (serial/mfr/date) |
|---|---|---|---|
| SAMPLE JOB (PowerDB) | 10 (garbage) | ~38 | 27805 / Ferranti Packard / 2008-02-08 ✓ |
| DEKRA breaker 135pp | 1 | ~21 | — / Changcheng Electrical Group / 2023-08-01 ✓ |
| smart-ground | 0 | ~46 | — |
| Trench VT (scan, OCR layer) | 1 | ~9 | 13027 ✓ |

What changed:
1. **Header extraction** rewritten with per-field validation: serials must carry a digit (rejects USED/Meter/SHUNT), a stopword reject-list, ALLCAPS-cut (PowerDB labels/sections are uppercase), `(cid:N)` glyph stripping. Baseline garbage (`mfr=LABEL: AS FOUND`, `serial=USED`) → correct serial/mfr/date on most.
2. **General value+unit reading capture** (`_inline_readings`): every `<label> <value> <unit>` in the text layer, with phase from connection tokens (L1-G, T1-T2, X1-X5). Conservative unit typing — only diagnostic units (MΩ→insulation_resistance, µΩ→contact_resistance, ppm→DGA) get a semantic NETA type; ambiguous units (V, A, %, Ω, Hz, °) get a generic `*_reading` type so a stray voltage is never mistaken for a power-factor result (protects the trend/deficiency engine).
3. **Performance**: real reports were timing out (36s) on the CPU-limited container → failing open to pdfjs. Split page budgets (text 18 / cells 4 / tables 4) + 45s bridge timeout → SAMPLE JOB 36s→16s; `source: pdfplumber` confirmed live.

Honest remaining gaps (need the brother's reports / bigger build):
- **Multi-asset segmentation** (one PDF = one facility) NOT done — the 40+pp PowerDB job is read as one asset within the page budget; segmentation = gem W5.
- **Scanned reports** (Hanford, NY PSC) have no text layer → 0 capture → need OCR (gem W1).
- **EICR / load-bank** column tables under-captured (their values live in column-header tables the inline pass misses); per-format column vocab would help.
- Measurement *classification* is coarse for ambiguous units — intentional (human-in-the-loop preview verifies). Per-PowerDB-form templates would sharpen it; that needs real filled reports as fixtures.

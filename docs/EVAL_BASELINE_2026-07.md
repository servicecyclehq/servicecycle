# Extraction Accuracy Baseline — golden set

**Date:** 2026-07-03 · **Harness:** `server/scripts/eval_extraction.py` · **Corpus:** `server/scripts/neta_synthetic_test_reports.json` (20 labelled synthetic reports: 8 clean / 7 partial_ocr / 5 garbled_ocr, with seeded traps).

Generated against `neta_synthetic_test_reports.json`. Deterministic extractor only (no AI, no network). Reproducible.

## 2026-07-04 update — WINDING IR-grid: OCR-tolerant header, single-value rows, zero-IR emission (+GT canonicalization SHIPPED this pass)

Four surgical follow-ups after the column-header inference push. Every
non-garbled report now scores 100% on the deterministic parser.

**Fix 1 — `_MOHM_HDR_RE` accepts OCR-corrupted MΩ variants (`M?`, `MQ`,
`M0hm`, `Nchm`, case-insensitive).** The WINDING/H-G/X-G IR block on
partial-tier renders comes back with `WINDING 1 MIN (M?) 10 MIN (M?)`; the
old regex only matched `MΩ` / `Μ Ω` so `_powerdb_grids` never entered its
IR-grid mode, silently dropping every subsequent H-G / X-G / H-X row.

**Fix 2 — IR-grid emit threshold loosened to `len(run) >= 1` (was `>= 2`).**
Real reports write per-winding rows with a single value when the 10-min
column is empty or shown as `--` (report_004: `H-G 0 --`, `H-X 14800`).
Only affects the MΩ-READING grid path, which is already unambiguously in
IR-reading mode when this branch runs.

**Fix 3 — zero-IR reading now emitted (`v >= 0`, was `v > 0`).** A zero
insulation-resistance reading is legitimate — and safety-critical (it
indicates a short circuit). Report_004's `H-G 0 --` row is exactly that
class. Skipping negatives still keeps `--` and other unparseable tokens
out.

**Fix 4 — GT canonicalization SHIPPED.** The intended
`power_factor → dissipation_factor` rename on the two VLF tan-delta rows
(reports 018 / 019) in `neta_synthetic_test_reports.json` finally landed
after the earlier file-lock issue resolved. GT now matches what the
pipeline emits.

**Recall delta (deterministic, no AI, no new deps):**

| Tier | Before this pass | After | Δ |
|---|---|---|---|
| clean parser | 97% | **100%** | +3pp |
| clean OCR-path | 47% | 50% | +3pp |
| partial_ocr parser | 83% | **100%** | +17pp |
| partial_ocr OCR-path | 80% | **85%** | +5pp |
| garbled_ocr parser | 10% | 10% | 0 |
| garbled_ocr OCR-path | 0% | 0% | 0 (render noise still the floor) |

What moved:

- Report 003 (`H-G 3850 6240` under `(M?)` header): 67% → **100%**.
- Report 004 (`H-G 0 --` / `X-G 11200 26400` / `H-X 14800`): 50% → **100%**.
- Report 018 clean (dissipation_factor GT fix): 75% → **100%**.
- Report 019 partial (dissipation_factor GT + already caught by earlier
  fallback): 67% → **100%**.

**Every non-garbled report on the golden set now scores 100% on the
deterministic parser.** The remaining gap is the garbled tier (10% parser,
0% OCR-path) — a render-noise floor that only a fuzzy-matching second
reader can meaningfully move (see `servicecycle-morning-parser-2026-07-04`
memory for the RapidOCR investigation and deferred fuzzy-layer design).

218/218 jest still green. tsc clean.

## 2026-07-04 update — column-header inference expansions

Three surgical follow-ups after the OCR-noise-tolerant units update. Each targets
a specific pattern class the earlier column-header passes missed; combined they
lift partial parser 72% → 83% and clean OCR-path 31% → 47%.

*Diligence note:* one intended fourth change — a GT canonicalization
(`power_factor` → `dissipation_factor` on the two VLF tan-delta rows in
`neta_synthetic_test_reports.json` reports 018 / 019) — did not persist due to a
file-lock issue on the Windows repo when the commit was assembled. The
extractor CORRECTLY emits `dissipation_factor` for tan-delta rows (that's the
canonical NETA type, matching what the TS pipeline uses); the golden-set GT
still calls it `power_factor` and therefore reports two "misses" on those rows.
Filed as a follow-up JSON-only edit; does not affect the pipeline in prod. See
the per-report table for the `report_018` / `report_019` rows where the
missing 1/4 and 1/3 counts represent this GT lag.

**Fix 1 — `_BUS_INLINE_ROW_RE` tolerates a unit token between phase-value pairs.**
Real reports write `A-B: 850 M? B-C: 720 M? C-A: 910` where the unit repeats.
The old row regex required plain whitespace between value and next phase, so
the third phase (C-A) was silently dropped. Added an optional unit token in the
alternation between each phase-value pair. Also added `re.IGNORECASE` so the
regex handles mixed-case phase letters on OCR output.

**Fix 2 — `_bus_inline_readings` fallback for no-parens-unit headers.**
When the header line names the measurement but omits the parenthesised unit
(`BUS INSULATION RESISTANCE @ 1000 VDC` — report_007), the old function
returned nothing. Fallback: if no `_BUS_INLINE_UNIT_HDR_RE` match is found,
grab the unit from a unit token IN THE ROW itself and use the closest
preceding non-blank line as the label (stripped of trailing `@ ...`
test-conditions phrase). Emits only when the label classifies to a specific
type — a generic `*_reading` fallback would let this pass hijack rows the
inline pass already handles.

**Fix 3 — `_PHASE_GRID_HDR_RE` captures the value-column token; `_phase_grid_readings`
handles both descriptive AND unit column labels.** Real reports label the
value column either descriptively (`AS-FOUND`, `MEASURED`) or by unit
(`PHASE uOhm EXPECTED RESULT` — report_007's contact-resistance grid). The
header regex now CAPTURES the token so `_phase_grid_readings` can use it as
the row unit when no unit-in-parens header exists on a preceding line. Also
extended the accepted unit vocabulary to include `uOhm|uohm|µohm|mohm|kohm|
ohm` — the ASCII-spelled variants of the ohm symbol that real PowerDB forms
use interchangeably with `Ω`.

**Recall delta (deterministic, no AI, no new deps):**

| Tier | Before | After | Δ |
|---|---|---|---|
| clean parser | 97% | 97% | 0 (report 018 stays at 75% pending the GT edit above) |
| clean OCR-path | 31% | **47%** | +16pp |
| partial_ocr parser | 72% | **83%** | +11pp |
| partial_ocr OCR-path | 68% | **80%** | +12pp |
| garbled_ocr parser | 10% | 10% | 0 |
| garbled_ocr OCR-path | 0% | 0% | 0 (render noise still the floor) |

What moved on partial (per-report):

- Report 011: 100% (unchanged, already at 100%).
- Report 015: 100% (unchanged).
- Report 007 (bus-inline `A-B: 850 M?` + `PHASE uOhm` grid): 40% → **100%**.
- Report 018 clean OCR-path (dissipation_factor emitted for tan-delta row —
  fallback header lookup found the label): 25% → **75%**.

Once the GT canonicalization noted above is applied, expect reports 018 and 019
to move to 100% on both parser and OCR-path — the code already emits the correct
values.

Still open:

- Report 004 (partial_ocr, `H-G 0 --` / `X-G 11200 26400` two-value-per-row
  under a `1 MIN | 10 MIN (MQ)` column header): 50%. Needs a dedicated
  column-time-series pass — different pattern shape from the current
  `_bus_inline_readings` (which requires three phases per line).
- Report 003 partial (67%) — power_factor + pi already caught; missing the
  H-G 3850 IR reading which uses the same H-G/X-G column format as 004.
- Garbled tier — all reports below 25% except 005 (50%). Real barrier is the
  render noise the synthetic corpus produces, not the extractor; needs a
  better OCR engine (RapidOCR investigation ongoing; see
  `servicecycle-morning-parser-2026-07-04` memory for the deferred
  fuzzy-matching layer design).

218/218 jest tests still green. tsc clean.

## 2026-07-04 update — OCR-noise-tolerant units + tesseract PSM 6 / scale 3

Two related fixes that together unlock ~25 percentage points on the
partial-OCR tier without adding a single Docker dependency. Investigating
the RapidOCR second-reader plan surfaced that the actual barrier for the
scanned/partial tiers was not the OCR engine — it was the extractor's
regex passes silently dropping every unit token that tesseract rendered as
"M?", "u?", "M0hm", "Nchm", or "udhm" (all common corruptions of MΩ / µΩ /
Mohm when Ω or µ don't survive the scan-simulation JPEG artifacts).

1. **`_UNIT_NORM` OCR-corruption aliases** (`neta_field_library.py`) —
   added two new entries: `M\?|M0hm|Nchm|MOhm|Mchm` → `MΩ`, and
   `u\?|udhm` → `µΩ`. Placed AFTER the exact `MΩ|Mohm|megohm|meg` rule so
   real megohm strings still normalize first; ordered such that a legit
   `mΩ` (millohm) can never accidentally match the MΩ alias (the exact
   `^m…$` rule fires first — same care as the pre-existing milliohm
   guard).
2. **`_UNIT` + `_BUS_INLINE_UNIT_HDR_RE` alternation expansion**
   (`extractor.py`) — added the same OCR-tolerant tokens to the inline
   value+unit regex and to the bus-inline unit-header regex so `_INLINE_RE`
   and `_bus_inline_readings` both match `A-B: 850 M?` style rows the
   pre-fix parser dropped.
3. **`_ocr_text` tesseract tuning** (`extractor.py`) — bumped
   `pypdfium2.render(scale=…)` from 2.0 → 3.0 (≈216 DPI, tesseract's own
   recommendation) and set `--psm 6` (single uniform block of text). This
   change on its own moved no eval numbers (the synthetic renders were
   already legible enough for tesseract's defaults on partial), but stays
   in as a quality-of-life bump for real-scan PDFs — verified subjectively
   cleaner output on all garbled-tier reports and no regression on clean
   or partial.

**Recall delta (deterministic, no AI, no new deps):**

| Tier | Before | After | Δ |
|---|---|---|---|
| clean | 97% | 97% | 0 (no regression) |
| partial_ocr parser | 47% | **72%** | +25pp |
| partial_ocr OCR-path | 43% | **68%** | +25pp |
| garbled_ocr | 5% | **10%** | +5pp |
| garbled_ocr OCR-path | 0% | 0% | 0 (parser saw more but renders too noisy for the full pipe) |

What moved on the partial tier:

- Report 007 (`A-B: 850 M? B-C: 720 M?` bus-inline): 0% → 40% (was
  producing generic-slug measurements; now insulation_resistance).
- Report 011: 50% → 100%.
- Report 015: 60% → 80%.
- Report 019 (`A-G: 38000 M? B-G: 4200 M?` cable IR): 0% → 67%.

Garbled tier: report 005 moved 25% → 50%.

**What was tried and rejected (RapidOCR):** Prototyped
`rapidocr-onnxruntime==1.4.4` + `img2table` + `opencv-python-headless`
(~150 MB Debian wheel footprint, all Apache-2.0 / MIT). Two variants both
failed the hard eval gate: concat-with-tesseract left the eval flat
because RapidOCR's output has words smashed together (`KVA3750`,
`MFR:SQUARED`, `M0hm`); RapidOCR-primary REGRESSED partial_ocr 43% → 21%
because the cleaner-looking text has different digit-vs-letter
confusions than tesseract's, and even light de-smashing broke real
tokens. Concluded that RapidOCR needs a fuzzy value/unit matching layer
in the extractor (a real design project) before it can move the eval —
NOT a one-off patch. Meanwhile the OCR-noise-tolerant unit aliases
turned out to be the actual win. Full context:
`servicecycle-morning-parser-2026-07-04` memory.

Verified: 218/218 across the five relevant jest suites still green after
the vocab expansion (nameplateValidators, nameplateOcrContract,
ingestGateDomainValidators, adminAiCapsWhitelist, measurementSanity).
tsc clean.

## 2026-07-04 update — trip_time, VLF tan delta, `_INLINE_RE` case-insensitivity

Three targeted fixes on the deterministic parser to close the remaining
per-report gaps flagged in the previous baseline update:

1. **`_INLINE_RE` case-insensitivity (`re.I`)** — PowerDB / NETA plates use
   all-caps units (SEC / HZ / V / A). The alternation was case-sensitive so
   "42.5 SEC" and every uppercase-unit reading silently failed the inline
   pass. Verified via `_INLINE_RE.finditer` on the actual golden-set line
   for report 014's trip time row.
2. **`trip_time` VOCAB fix in `neta_field_library.py`** — MEASUREMENT_LIBRARY
   line 192 had `"trip time"` listed under `open_close_timing` (a distinct
   mechanism-cycle measurement in milliseconds). That was hijacking the
   canonical NETA `trip_time` classification (primary-injection trip timing
   in seconds — critical). Fix: removed `"trip time"` from
   `open_close_timing.labels` and added a new `trip_time` entry.
3. **`dissipation_factor` VOCAB fix + `_phase_context_readings` pass** —
   MEASUREMENT_LIBRARY line 208 had `tan_delta` type with only the `"tan
   delta"` label AND MEASUREMENT_LIBRARY line 163 had `power_factor` with
   both `"tan delta"` and `"dissipation factor"` as labels, so any tan-delta
   reading was classifying as `power_factor` (wrong). Fix: canonicalized to
   `dissipation_factor` type (matches the TS pipeline —
   `aiTestReportExtract`, `commitTestReport`, `dobleImport`), added `"vlf
   tan delta"` label, and stripped `"tan delta"` / `"dissipation factor"`
   from the `power_factor` entry. Then added a new `_phase_context_readings`
   pass in `extractor.py` for single-phase-per-line rows like
   `PHASE A: 0.12 %` under a preceding `"VLF TAN DELTA @ 1.5 UO"` header
   (report 018's format — one phase per line, not the A-G/B-G/C-G tri-phase
   inline). The pass walks backward to the most recent non-blank line for
   the label, strips any trailing `(test-conditions)` parenthetical, and
   classifies. Only emits when the label classifies to a **specific**
   measurement type (never a generic `*_reading` fallback) so it can't
   hijack rows the general inline pass already handles.
4. **Generic-type suppression in `extract_measurements`** — a specific type
   (`dissipation_factor`, `trip_time`, `insulation_resistance`, ...) always
   wins over a generic `*_reading` fallback at the same `(phase, value,
   unit)`. Prior to this suppression, report 018's `_phase_context_readings`
   correctly emitted `dissipation_factor A 0.12 %` but the general
   `_inline_readings` also emitted `percent_reading A 0.12 %` — both
   survived because their `measurementType`s differed. Now the generic one
   is dropped.

**Recall delta (parser recall):**

| Tier | Before | After | Δ |
|---|---|---|---|
| clean | 91% | **97%** | +6pp |
| partial_ocr | 40% | **47%** | +7pp |
| garbled_ocr | 5% | 5% | 0 (render noise floor) |
| clean OCR-path | 25% | 31% | +6pp |

What moved:

- Report 014 (`PHASE A TRIP TIME: 42.5 SEC ...`): 3/4 → 4/4 (trip_time now caught).
- Report 017 (`PHASE B TRIP TIME: 0.310 SEC ...`): 3/4 → 4/4 (trip_time now caught).
- Report 018 (`VLF TAN DELTA @ 1.5 UO (0.1 HZ)` / `PHASE A: 0.12 %`): 3/4 → 4/4
  (dissipation_factor now caught via the new phase-context pass).
- No regression on previously-green reports.

Verified: 218/218 across five jest suites (nameplateValidators,
nameplateOcrContract, ingestGateDomainValidators, adminAiCapsWhitelist,
measurementSanity) still green after the vocabulary fixes. tsc clean.

## 2026-07-04 update — column-header inference (bus-inline + phase-column grids)

Added two more inference passes in `server/pyextract/extractor.py` (`_bus_inline_readings`
and `_phase_grid_readings`) targeting the "column-header inference" gap the last update
called out for reports 006 / 014 / 017 / 018. Both new passes classify by the nearest
unit-in-parens header line ("(MΩ)" / "(µΩ)") *above* the row block rather than requiring
the row itself to carry a measurement label — so bus-to-ground readings ("A-G: 15200")
and PHASE / AS-FOUND grids (where the row label is just a phase letter) both recover.

**Recall delta (parser recall — clean tier drove the big win, no regressions elsewhere):**

| Tier | Before | After | Δ |
|---|---|---|---|
| clean | 41% | **91%** | +50pp |
| partial_ocr | 31% | **40%** | +9pp |
| garbled_ocr | 5% | 5% | 0 (render noise floor — needs OCR pipeline) |
| clean OCR-path | 25% | 25% | 0 (unchanged; the reportlab render is still the confounder here) |

What moved:

- Reports 006 and 018 (bus-inline A-G / B-G / C-G) went 0% → 100% of insulation-resistance rows recovered.
- Reports 014 and 017 (PHASE / AS-FOUND / EXPECTED / RESULT grid, description on the line above) went 0% → 75% (3/4 contact-resistance rows recovered; trip-time inline still missed — different regex family).
- Report 001 recovered 4 IR readings inside a PowerDB test-condition block the new bus-inline pass caught.
- No regression on previously-green reports (002, 009, 010) — all still 100%.

Still open (deferred — not in scope this session):

- Reports 014 / 017 still miss the single trip-time row ("PHASE A TRIP TIME: 42.5 SEC" — inline pattern doesn't classify TRIP TIME from a bare phase-prefixed line yet). Fix path: extend `_inline_readings` or add a `_trip_time_inline` pass. Backlogged.
- Reports 015 / 018 still miss tan-delta / power_factor variants (report_018 needs "VLF Tan Delta" → `dissipation_factor` mapping in VOCAB).
- Garbled tier is the render-noise floor and unaffected — the fix path is the RapidOCR second reader (backlogged per `docs/NAMEPLATE_INGESTION_REVIEW_2026-07-03.md` §3.1).

**Verification:** 145+ tests across ingestGateDomainValidators (+8 new temp-correction, +1 verdict-vocabulary), nameplateValidators, nameplateOcrContract (regression-lock for the 919d389 fix, 6 new tests), adminAiCapsWhitelist (6 new whitelist tests) — all green. tsc clean.

## 2026-07-03 update — DGA / PI / PF parsers + nameplate-noise suppression

Added three explicit passes in `server/pyextract/extractor.py` to close the three concrete gaps this baseline documented, and suppressed nameplate context lines from becoming false-positive `voltage_reading` / `percent_reading` measurements. All wins are deterministic (no new deps, no OCR path change).

**Recall delta (parser recall — the deterministic-parser signal, unchanged corpus):**

| Tier | Before | After | Δ |
|---|---|---|---|
| clean | 19% | **41%** | +22pp |
| partial_ocr | 12% | **31%** | +19pp |
| garbled_ocr | 5% | 5% | 0 (render too noisy — needs OCR pipeline, out of scope) |
| clean OCR-path | 3% | **25%** | +22pp |

What moved:

- `_dga_readings` — DGA table rows keyed by `<gas name> (<symbol>) <value> <=<limit> [<result>]`; `HYDROGEN (H2)  1240  <=100  HIGH - RED` now emits a `dissolved_gas` reading. Report 002 goes from 0% → 100%.
- `_pi_readings` — `POLARIZATION INDEX (H-G): 2.31` now emits a `polarization_index` reading (was invisible to the general inline pass because it carries no unit).
- `_pf_readings` — multi-line PF table under `POWER FACTOR ... Doble` headers; the "label + mode + %PF" row (`CH+CHL  GST  0.34  <=0.5  PASS`) is now captured.
- Nameplate suppression in `_inline_readings` — labels containing `PRIMARY / SECONDARY / RATED / IMPEDANCE / BUS / AMBIENT / BIL / FRAME / TEMP RISE` no longer create fake measurements; single/double-letter labels for ambiguous units (V / A / %) are also dropped (the `AMBIENT: 28 C / 45% RH` → label='C' class).

Still open (deferred — not in this session's scope):

- Reports 006 / 007 / 017 — bus-insulation `A-G: 15200` and phase-column contact-resistance tables (label header on one line, phase rows on the next) still 0%. These need column-header inference for standalone A/B/C rows.
- Report 014 / 018 — protection relay pickup + tan-delta variants. Different regex families.
- Garbled tier is a render-noise floor — the fix path is the RapidOCR second reader (backlogged this session per the "no new deps" gate; documented in `docs/NAMEPLATE_INGESTION_REVIEW_2026-07-03.md` §3.1).

Verified: 15-case `tests/ingestGateDomainValidators.test.js` still green; new 42-case `tests/nameplateValidators.test.js` green. Full run: 145 tests passing across the three pure-lib suites (nameplate validators + gate + measurement sanity).

## Read this first — what the numbers mean

**1. This is a BASELINE (a "before"), and it measures the deterministic pdfplumber extractor.** The P0/validator changes shipped this session (numeric AI confidence, AI-critical HITL routing, silent-empty + cross-pass guards, domain validators) are *safety-routing* changes — they govern what happens to whatever is extracted, not how much is extracted. Their effect is proven by the 15-case `tests/ingestGateDomainValidators.test.js` suite (all green), not by a change in these recall numbers. So there is no meaningful extraction-recall "after" delta from this session; the honest artifact is this baseline plus the passing safety tests.

**2. Production does not run this extractor at all.** `server/Dockerfile` (node:20-alpine, what `docker-compose.yml` builds) has the Python extractor commented out — `pypdfium2` has no musl wheel — so in production, ingest falls back to the **pdfjs text parser + AI gap-fill**. This harness measures the pdfplumber path that runs in dev / a future Debian image. The AI gap-fill (which does run in prod) is designed to recover exactly the readings this deterministic pass misses; the numbers below are the deterministic **floor before AI**.

**3. Parser recall is the real signal; OCR-path recall is a confounded floor.** Parser recall feeds each report's golden text straight into the extractor's text passes (a perfect-OCR proxy). OCR-path recall renders to a synthetic PDF and runs the full pipeline — but the deterministic grid parser depends on real PowerDB word geometry a reportlab render doesn't reproduce (and this run had no `tesseract`), so OCR-path recall understates real performance and should not be quoted as a capability.

## Findings (deterministic parser)

- **Field extraction is strong (92% on clean):** serial number, manufacturer, and model are recovered reliably.
- **Measurement recall is low (≈19% clean, 12% partial, 5% garbled)** with three concrete gaps, confirmed in text mode (not a render artifact):
  - **Dissolved-gas (DGA) tables are largely unparsed** — e.g. `HYDROGEN (H2)  1240  <=100` produces no `dissolved_gas` reading.
  - **Polarization Index is missed** — `POLARIZATION INDEX (H-G): 2.31` is not captured as `polarization_index`.
  - **Power factor is inconsistent** — captured in some layouts, missed in others.
  - **Nameplate noise becomes false positives** — primary/secondary voltages and %impedance / %RH are emitted as `voltage_reading` / `percent_reading`.
- **Value-exactness tracks recall** (when a reading is found, its value is right), so the problem is *coverage*, not digit corruption — consistent with the review's "the parser is brittle to layout" thesis.

## How to use this

This harness is the **gate for any future tooling change** (RapidOCR / img2table / a Debian base-image switch that re-enables OCR): re-run it, and no swap ships unless it moves parser/OCR-path recall on this corpus. To also measure the true OCR path, run it in an environment with `tesseract` installed (the sandbox has it) — the harness renders the partial/garbled tiers to image PDFs and exercises `extractor._ocr_text`.

Next accuracy work, in priority order, is DGA-table + PI + PF parsers (pure regex/geometry, no deps), then the Debian base-image switch to make the extractor run in prod at all, then RapidOCR behind this eval.

---


Two measurement numbers are reported. **Parser recall** feeds the
golden text straight into the extractor's text passes (a perfect-OCR
proxy) and is the real signal for the deterministic parser. **OCR-path
recall** renders each report to a PDF and runs the full pipeline; the
deterministic grid parser depends on real PowerDB word geometry that a
synthetic reportlab render does not reproduce, so OCR-path recall
understates real-PDF performance and is a floor, not a true measure.

## Per-tier summary

| Tier | Reports | Parser recall | Parser value-exact | Field acc | OCR-path recall |
|---|---|---|---|---|---|
| clean | 8 | 19% | 19% | 92% | 3% |
| partial_ocr | 7 | 12% | 12% | 0% | 0% |
| garbled_ocr | 5 | 5% | 5% | 0% | 0% |

## Per-report detail

| Report | Tier | GT | Parser matched | Parser recall | Value-exact | Fields | OCR-path recall |
|---|---|---|---|---|---|---|---|
| report_001 | clean | 4 | 2 | 50% | 50% | 3/3 | 0% |
| report_002 | clean | 4 | 1 | 25% | 25% | 3/3 | 25% |
| report_003 | partial_ocr | 3 | 1 | 33% | 33% | 0/3 | 0% |
| report_004 | partial_ocr | 4 | 2 | 50% | 50% | 0/3 | 0% |
| report_005 | garbled_ocr | 4 | 1 | 25% | 25% | 0/3 | 0% |
| report_006 | clean | 6 | 0 | 0% | 0% | 3/3 | 0% |
| report_007 | partial_ocr | 5 | 0 | 0% | 0% | 0/3 | 0% |
| report_008 | garbled_ocr | 4 | 0 | 0% | 0% | 0/3 | 0% |
| report_009 | clean | 4 | 1 | 25% | 25% | 3/3 | 0% |
| report_010 | clean | 2 | 1 | 50% | 50% | 3/3 | 0% |
| report_011 | partial_ocr | 2 | 0 | 0% | 0% | 0/3 | 0% |
| report_012 | garbled_ocr | 2 | 0 | 0% | 0% | 0/3 | 0% |
| report_013 | partial_ocr | 2 | 0 | 0% | 0% | 0/3 | 0% |
| report_014 | clean | 4 | 0 | 0% | 0% | 3/3 | 0% |
| report_015 | partial_ocr | 5 | 0 | 0% | 0% | 0/3 | 0% |
| report_016 | garbled_ocr | 5 | 0 | 0% | 0% | 0/3 | 0% |
| report_017 | clean | 4 | 0 | 0% | 0% | 2/3 | 0% |
| report_018 | clean | 4 | 0 | 0% | 0% | 2/3 | 0% |
| report_019 | partial_ocr | 3 | 0 | 0% | 0% | 0/3 | 0% |
| report_020 | garbled_ocr | 3 | 0 | 0% | 0% | 0/3 | 0% |

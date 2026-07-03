# Extraction Accuracy Baseline — golden set

**Date:** 2026-07-03 · **Harness:** `server/scripts/eval_extraction.py` · **Corpus:** `server/scripts/neta_synthetic_test_reports.json` (20 labelled synthetic reports: 8 clean / 7 partial_ocr / 5 garbled_ocr, with seeded traps).

Generated against `neta_synthetic_test_reports.json`. Deterministic extractor only (no AI, no network). Reproducible.

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

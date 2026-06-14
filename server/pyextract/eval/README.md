# Ingestion accuracy eval harness (DEV-ONLY)

Measures how well the test-report extractor (`../run.py`) pulls structured
readings, WITHOUT needing real customer reports. It generates synthetic reports
at three difficulty tiers (the data is its own ground truth), runs the real
extractor over them, and reports accuracy per tier so you can see exactly where
the pipeline degrades.

**Not shipped.** `requirements-dev.txt` (reportlab, Pillow, pytest) is NOT in the
production image; this directory exists only so the harness can shell to run.py.

## Quickstart
```
pip install -r requirements-dev.txt          # dev box only
python gen.py --out corpus --count 30 --seed 1
python run_eval.py corpus
python -m pytest test_score.py -q            # scorer unit tests
```

## Difficulty tiers (gen.py)
- **clean** â€” crisp born-digital PDF, real text layer (the PowerDB-export case).
- **scan**  â€” rasterized + grayscale + slight skew + noise (a flatbed scan).
- **photo** â€” rotation/blur/uneven lighting/JPEG (a phone photo of paper).
Units alternate unicode (MOhm/microOhm) vs ASCII spellings; fonts vary per report.

## Metrics (run_eval.py / score.py)
- `field_acc`     â€” header fields correct (serial, mfr, date, vendor, tech...).
- `reading_found` â€” GT readings located by (measurementType + value within tol),
  phase-agnostic, so a missed phase does not zero everything.
- `phase_acc / unit_acc / passfail` â€” correctness over the located readings.

## v1 baseline findings (2026-06-14, this dev box)
- **clean:** field 100%, phase 100%, unit 100%; **reading_found ~55%** and
  **pass/fail 0%** â€” i.e. the extractor reliably reads the values + units it
  finds, but (a) misses a chunk of readings on sparse layouts and (b) does not
  capture the Pass/Fail column without ruled-table structure. Both are real,
  actionable targets.
- **scan / photo: 0%** â€” THIS BOX HAS NO OCR ENGINE (Tesseract) CONFIGURED, so
  image-only PDFs return nothing. These tiers measure the OCR path; wire an OCR
  engine (Tesseract/PaddleOCR) and re-run to get the true degraded-input curve.
- **Flagged for verification:** an early run surfaced a possible milliohm (mOhm)
  -> megohm (MOhm) unit-normalization error on winding resistance (a 1e9 mistake).
  Re-run a winding-resistance-only corpus to confirm, then fix normalize_unit.

## Next iterations (what the harness now enables)
1. Generator realism: real ruled tables (so the table-role parser captures phase
   + pass/fail), and Augraphy/Albumentations for true scan/photo degradation.
2. Wire an OCR engine and measure the scan/photo curve.
3. Investigate the ~55% clean reading_found (cap? second-type classification?).
4. Confirm + fix the milli/mega unit normalization.
5. Replay captured human corrections (#4) as a second, real-data eval split.
## Two harnesses: deterministic-core vs full-pipeline
`run_eval.py` tests ONLY the deterministic Python core (`run.py`) in isolation â€”
useful for fast parser-logic iteration, but it does NOT exercise Tesseract OCR
(unless installed locally) or the Node-side AI (Gemini/Groq text gap-fill +
vision fallback). It will under-report on scan/photo tiers on a box without an
OCR engine.

`run_eval_node.js` tests the **REAL production pipeline**
(`lib/testReportPreview.buildTestReportPreview`): deterministic parser + Tesseract
OCR + Gemini/Groq text gap-fill + the image vision fallback. Run it INSIDE the
server container, which has Tesseract + the AI keys + DB:

```
# 1) generate a corpus locally (gen.py needs reportlab/Pillow, dev-only)
python gen.py --out corpus --count 10 --seed 1
# 2) copy it into the running container, then run via tsx with the demo account
tar -czf corpus.tgz corpus    &&    <upload>    &&    docker cp corpus.tgz servicecycle-server:/app/
docker exec servicecycle-server sh -c "cd /app && tar -xzf corpus.tgz && \
  node node_modules/tsx/dist/cli.mjs pyextract/eval/run_eval_node.js corpus <ACCOUNT_ID> <USER_ID>"
```

Clean tiers are fed as PDFs (text layer); scan/photo tiers are fed as the
degraded IMAGES so the photo-of-paper -> OCR/vision path fires. The output's
`ai/vision` column shows how often each AI fallback contributed per tier â€” that
is how you see the vision fallback earning its keep on degraded inputs.
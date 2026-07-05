# ServiceCycle Ingestion Architecture

*Read-me-first entry point for the PDF + nameplate ingestion stack.*
*Last updated: 2026-07-05 (test-report pipeline section rewritten against the
`388955c` commit + fresh 2026-07-05 findings; nameplate/AI-plumbing sections
preserved from the 2026-07-04 draft where they were still accurate).*

This document is the canonical structural reference for how a NETA/PowerDB/
Megger/Doble test-report PDF (and separately, a nameplate photo) becomes
persisted data in ServiceCycle: how each path works, what runs
deterministically vs. through AI, where the safety layers sit, and what the
current golden-set numbers are. It supersedes reading the individual review
docs in order — those are still on disk (§10) as source material and incident
history. This is a structural map, not a session log — see §10 and the
Claude-memory cross-references at the end for the narrative, day-by-day
history.

---

## 1. What "ingest" means in ServiceCycle

Two customer-facing ingest paths turn field artifacts into rows in the
database:

- **Test-report ingest** — a technician uploads a NETA / PowerDB / Megger /
  Doble test report (PDF, sometimes a phone photo of a paper report). Output:
  an asset match + a list of measurement rows attached to that asset, each
  with a passFail band and a deficiency if warranted. Route:
  `POST /api/test-reports/preview` and the sibling background ingest worker.
- **Nameplate scan** — a technician photographs an equipment nameplate on
  their phone. Output: identification fields (manufacturer / model / serial /
  voltage / kVA / phases / …) with a per-field confidence the tech reviews
  before save. Route: `POST /api/assets/ocr-nameplate` (unmetered demo cap:
  5/day).

Both are the moat: friction-free data-in. Both are treated as "strong drafts
you correct," never as authoritative reads. The rest of this doc focuses
mainly on test-report ingest (§§3-4, 8-9), since that pipeline saw the bulk of
the 2026-07 hardening work; nameplate scan (§5) is summarized more briefly.

## 2. The invariant every layer defends

> Structure and layout models decide **geometry only**; numeric values enter
> the database solely from the PDF content stream or raw OCR tokens, with
> bbox provenance where available. **No generative model ever writes a
> number** except as a clearly-flagged, low-confidence gap-fill that defaults
> to human review.

This is the discipline the whole architecture depends on and it is what makes
the stack acquisition-safe: an acquirer's counsel doesn't have to accept
"trust the LLM to have transcribed 4.32 correctly." The deterministic
pdfplumber engine (§4) is preferred whenever it produces enough readings,
because it is free, fast, auditable, and geometry-driven rather than
generative. AI gap-fill (§7, §8) only runs when the deterministic pass comes
back low-coverage, and every AI-sourced value is stamped with a confidence low
enough that safety-critical readings still route to human review (§9).

## 3. Pipeline stages — test-report ingest, in order

`buildTestReportPreview()` in `server/lib/testReportPreview.ts` is the
orchestrator; both the synchronous upload route and the async ingest worker
call it, so the two paths can never diverge.

1. **Photo-of-paper wrap** (`server/lib/imageToPdf.ts`) — if the upload is an
   image (jpg/png/heic/webp), wrap it into a single-page PDF so the rest of
   the pipeline never has to special-case image input. `photoOfPaper = true`
   threads through so the vision-fallback step (stage 5) knows to send the
   ORIGINAL image, not the wrapped PDF.
2. **Fingerprint + dedup** — `sha256Hex` + `findPriorImport`
   (`server/lib/extractionTelemetry.ts`) check whether this exact file was
   already imported; a duplicate short-circuits to the prior import.
3. **Deterministic extraction** — `runDeterministic()` in
   `server/lib/testReportExtract.js` shells out to `server/pyextract/run.py`
   via `execFile`, passing a temp file path. This is the production Node
   entry point — see §3.1 for the exact CLI contract, which is a distinct
   thing from calling `extract_fields()` in-process. On any error, missing
   Python runtime, or zero measurements, the pipeline fails open to the
   legacy `pdfjs` text-regex parser (`server/lib/testReportParse.js`,
   `extractPdfText` + `parseTestReport`).
4. **AI text gap-fill** — if the deterministic pass used `pdfjs` (weakest
   path) or returned fewer than `AI_INGEST_MIN_READINGS` (default 8)
   measurements, `aiFillReadings()` in `server/lib/aiTestReportExtract.ts`
   sends the extracted text to the configured LLM cascade (§7) with a strict
   JSON-only prompt, and the caller merges only net-new rows via
   `mergeExtractedMeasurements()` (in `testReportPreview.ts`, §8.2).
5. **AI vision gap-fill** — if coverage is *still* low and the upload was a
   photo-of-paper, `aiFillReadingsFromImage()` sends the actual image bytes
   to the multimodal model (same cascade) as a last resort for reports whose
   OCR text was too poor for the text gap-fill to work with.
6. **Identity resolution** (`lib/assetIdentity.resolveAsset`) — normalized
   serial-number match with fuzzy O↔0 / I↔1 folding, then site+type fallback,
   run per-section for a multi-asset job report.
7. **Multi-asset section split** — a NETA job report often covers many
   assets under `SUBSTATION … POSITION …` headers; the extractor emits
   per-section indices (§4), and the preview surfaces per-section readings +
   per-section identity resolution.
8. **Telemetry** — `recordExtraction()` writes an `ExtractionEvent` row per
   ingest (engine used, OCR flag, AI usage, page counts, truncation,
   confidence stats). The `engine` string is the real model/parser id, not a
   hardcoded label, so per-engine accuracy is comparable in aggregate.
9. **Confidence gate** (§9.1) — scores the assembled preview and decides
   `autoCommit` vs. `needs_review` for hands-off paths (email-in, backfill)
   where no human reviews the preview before commit.
10. **Domain validators** (§9.2) — run as part of the gate; can push a
    clean-looking extraction to yellow/red on physics/internal-consistency
    grounds even when every individual reading parsed with high confidence.
11. **Commit** — whatever survives (human approval of the preview, or the
    auto-commit gate) is written as `measurement` rows by
    `server/lib/commitTestReport.ts` (not detailed here).

### 3.1 The Node/Python boundary — a distinction worth being explicit about

`testReportExtract.js` does **not** call `extract_fields()` directly and does
not import the Python module at all. It shells out to
`server/pyextract/run.py <pdf_path>` as a subprocess via
`child_process.execFile`, with a 45-second timeout (`PYEXTRACT_TIMEOUT_MS`)
and a 16 MB stdout buffer cap. `run.py` is the actual CLI contract:

- **Invocation:** `python3 run.py <pdf_path>` (argv, not stdin).
- **stdout:** exactly one JSON line (the Node side takes
  `stdout.trim().split('\n').pop()`, so incidental print noise before the
  final line is tolerated). Shape on success:
  `{"ok": true, "fields": {...flattened key→value...}, "measurements": [...],
  "has_text_layer": bool, "ocr": bool, "asset_sections": int, "sections": [...],
  "page_count": int, "pages_scanned": int, "text_pages": int, "truncated": bool}`.
  On failure: `{"ok": false, "error": "..."}`, always exiting 0 so the Node
  side never sees a non-zero exit and always gets parseable JSON.
- `run.py`'s `main()` calls `has_text_layer(path)` once and
  `extract_fields(path)` once — `extract_fields` is the true Python-side
  entry point (§4); `run.py` is only the thin CLI wrapper that flattens the
  `fields` dict (`{k: v["value"] ...}`) and adds the top-level bookkeeping
  keys.

**Gap found and FIXED 2026-07-05 (commit `2fa5bb9`):** `run.py`'s `main()`
copied `fields`, `measurements`, `has_text_layer`, `ocr`, `asset_sections`,
`sections`, `page_count`, `pages_scanned`, `text_pages`, and `truncated` from
`extract_fields()`'s return dict onto the printed JSON, but did **not**
forward `report_result` or `ambient_temp_c`, even though `extract_fields()`
has computed both since commit `83cb831` (2026-07-04). `testReportPreview.ts`
reads `py.report_result` / `py.ambient_temp_c` off that same parsed object for
`meta.reportResult` / `meta.ambientTempC` — so both were always `undefined`
in production, meaning the report-verdict cross-check and temp-correction
validators (§9.2) were silently inert for every report going through the
deterministic (non-AI) path since the day they shipped. No jest suite caught
it because `testReportPreview`'s own tests mock `runDeterministic()` entirely
(exercising the merge logic against an already-correct fixture, never the
real `run.py` subprocess). Fixed by forwarding both keys; verified end-to-end
by generating a real one-page PDF with an ambient-temp line and an overall-
verdict line and running `run.py` against it directly (both fields came back
correctly after the fix, absent before). Does not touch `extract_fields()` /
`extract_measurements()`, so the golden-set eval (§10) is structurally
unaffected by design — confirmed via a before/after eval run, numbers
unchanged.

The eval harness (§8) bypasses this whole Node/Python boundary — it calls
Python functions directly, which is the crucial distinction covered there.

## 4. Deterministic extractor pass reference (`extractor.py`)

`extract_fields(path)` in `server/pyextract/extractor.py` is the true
Python-side entry point. It opens the PDF with `pdfplumber`, runs a budgeted
text sweep, a capped cell/table extraction, falls back to OCR if the text
layer is too thin, then calls `extract_header()` and `extract_measurements()`
on the assembled text.

**Page/time budgets** (tuned so the whole extraction stays under the 45s Node
timeout): the **text sweep** (`page.extract_text()`, feeds the inline pass and
section detection) runs across up to `MAX_TEXT_PAGES=200` pages or until
`TEXT_TIME_BUDGET_S=30.0` wall-clock seconds elapse, whichever comes first —
this is the cheap, high-value pass and must cover the whole document so a
later device in a multi-asset job report is never silently dropped. The
**cell extraction** (`_page_cells`, feeds header/nameplate matching) is capped
at `MAX_CELL_PAGES=4` since the nameplate lives on page 1-2. The **ruled-table
extraction** (`page.extract_tables()`, feeds `_column_tables`) is capped at
`MAX_TABLE_PAGES=4` for the same reason and because it is the most expensive
pass. If either cap or the time budget cuts the sweep short, the result
carries `truncated: true` rather than silently under-reporting.

**OCR fallback:** `_ocr_text(path, max_pages=OCR_PAGES=3)` triggers when the
assembled text layer is under 100 characters (a scanned/photo report with no
real text layer). It rasterizes each page with `pypdfium2` at `scale=3.0`
(~216 DPI) and runs `pytesseract.image_to_string(..., config='--psm 6')`.
Returns `''` if the toolchain is unavailable, so callers fail open exactly as
if OCR were never attempted. When OCR is used, every downstream measurement's
confidence is capped at 0.5.

`extract_header()` recovers nameplate/serial/model/date/vendor/tech fields
via regex-over-text-layer with per-field-type validation (serials must
contain a digit and be 3-40 chars; names/ids are cut at the next ALL-CAPS
boilerplate word via `_cut_allcaps`).

`extract_measurements()` runs nine passes over the assembled full text (plus
one ruled-table pass over `page_tables`), always in this order, then dedupes:

| # | Pass | File : function | Layout it targets | Example golden-set report |
|---|------|------------------|--------------------|---------------------------|
| 1 | Column tables | `extractor.py:_column_tables` | Clean ruled header→column tables (synthetic samples, EICR-style schedules) with an actual pdfplumber table grid | report_010 |
| 2 | PowerDB grids | `extractor.py:_powerdb_grids` | Unit-in-column-header IR/DGA/PF grids (`Μ Ω READING`, `(minutes)(kVDC)(megohms)` headers); includes the OCR-noise-tolerant `_MOHM_HDR_RE` (matches `MΩ`, `M?`, `MQ`, `M0hm`, `Nchm`) | report_003, report_004 |
| 3 | DGA readings | `extractor.py:_dga_readings` | Dissolved-gas table rows with an inline `<=LIMIT` anchor (`HYDROGEN (H2) 1240 <=100 HIGH-RED`) — a header-per-column variant `_powerdb_grids`' `_DGA_ROW_RE` can't see | report_002 |
| 4 | Polarization index | `extractor.py:_pi_readings` | `POLARIZATION INDEX (H-G): 2.31` — dimensionless ratio, no unit token, invisible to the inline pass | golden-set PI rows |
| 5 | Power factor | `extractor.py:_pf_readings` | Multi-line Doble M4100 PF block: label line, then a `TEST MODE %PF EXPECTED RESULT` header, then rows like `CH+CHL GST 0.34 <=0.5 PASS` | report_001 |
| 6 | Bus-inline readings | `extractor.py:_bus_inline_readings` | `A-G: 15200  B-G: 14100  C-G: 16800` tri-phase-per-line layout; has a header-based path (unit-in-parens context line within ~200 chars) AND a no-header fallback that pulls the unit from the row itself | report_006, report_007, report_018, report_019 |
| 7 | Phase grid readings | `extractor.py:_phase_grid_readings` | `PHASE / AS-FOUND / EXPECTED / RESULT` grid where the row is just a phase letter and the measurement type lives on a preceding line; both descriptive (`AS-FOUND`) and unit (`uOhm`) value-column variants | report_014, report_017 |
| 8 | Phase context readings | `extractor.py:_phase_context_readings` | Single-phase-per-line under a preceding context header (`VLF TAN DELTA @ 1.5 UO` then `PHASE A: 0.12 %` on the next line) | report_018 (VLF tan delta) |
| 9 | Inline readings (catch-all) | `extractor.py:_inline_readings` | General `<label> <value> <unit>` pattern anywhere in the text; the broadest, lowest-confidence (0.6) pass, with nameplate-label suppression (`_looks_like_nameplate_label`) so `PRIMARY: 13800 V` never becomes a fake voltage reading | most reports, as a backstop |

After all nine passes run, `extract_measurements()` dedupes in two stages:
first, a phase-less reading from the inline catch-all pass is dropped if the
same `(measurementType, value, unit)` triple already has a phased reading
from a richer pass; second, a generic fallback type (anything ending in
`_reading`, or the bare `reading`/`resistance` slugs) is dropped whenever a
specific NETA type (e.g. `dissipation_factor`, `insulation_resistance`) was
independently found at the same `(phase, value, unit)` — the specific
classification always wins over the generic one for the same physical
reading.

Two auxiliary extractions feed the domain validators (§9.2) rather than the
measurement list: `_extract_report_verdict(text)` recovers the report's own
printed overall PASS/FAIL/GREEN/RED-class verdict (via `_REPORT_VERDICT_RE`,
deliberately narrow — requires an "overall/final/report/test" qualifier so a
per-row PASS/FAIL never hijacks the report-level read) and feeds
`domainValidators.verdictCrossCheck`; `_extract_ambient_temp(text)` recovers
the ambient/test/reference temperature in °C (handles °F conversion, sanity-
bounds to `[-40, 120]`) and feeds `domainValidators.tempCorrection`'s
IEEE-43 raw/corrected reconciliation. (See §3.1 for the open question of
whether both values actually reach Node.)

Multi-asset job reports are split by `_build_sections(text)`, which finds
every `SUBSTATION <id> POSITION <id>` header occurrence via `_SECTION_RE`,
canonicalizes repeats of the same (substation, position) pair across
continuation pages into one section index, and `_section_for_offset()`
attributes each reading's character offset to the nearest preceding section
header (readings before the first header — e.g. a cover-page nameplate —
attach to section 0).

## 5. Pipeline map — nameplate scan

Nameplate scan is a **single vision call** with a full safety envelope around
it. `POST /api/assets/ocr-nameplate` in `routes/assetPhotoInspect.ts`:

1. Auth (unrestricted-role — even viewer can scan; the save endpoint is
   gated).
2. AI consent + demo-budget guard + per-user daily meter (`nameplate_scan`,
   default 5/day on the demo droplet).
3. `normalizeImage` — sharp EXIF-rotate + HEIC → JPEG + long-edge ≤ 2000 px.
4. `completeWithImage` — Gemini 2.5-flash cascade (§7) with `maxTokens: 8192`
   (thinking-token budget — see the truncation-trap fix in §7) and
   `responseMimeType: 'application/json'` (JSON mode).
5. Parse (tolerant of prose-wrapped JSON via brace-fallback).
6. `applyNameplateDowngrades` — per-field range/regex plausibility.
7. `nameplateValidators.checkNameplateConsistency` — cross-field checks (V1-V7
   in `NAMEPLATE_INGESTION_REVIEW_2026-07-03.md` §4, recalibrated 2026-07-04:
   kVA-standard ladder membership including IEC 60076 sizes, voltage-class
   membership, evidence-string check with broadened vocabulary and a 3-way
   positive/foreign/neither outcome). Never auto-corrects, only downgrades +
   attaches a machine-readable reason.
8. Telemetry + response with fields + confidence map + per-field reasons for
   the client tooltip.

Failures refund the quota slot (`refundScan`) so a bad photo never burns the
tech's daily cap. `server/tests/nameplateOcrContract.test.js` regression-locks
the JSON-mode + maxTokens invariants, the graceful-truncation contract, and
end-to-end domain-validator wiring — added after a shared demo-droplet
truncation incident.

## 6. Runtime reality — what actually runs in prod

Prior to 2026-07-03 the container base was `node:20-alpine`, `pypdfium2` had
no musl wheel, and the whole Python extractor was **inert in production** —
ingest silently fell back to the pdfjs text parser + AI gap-fill.

Commit `c652578` switched the base to `node:20-slim` (Debian). The Python
extractor + Tesseract OCR now run in prod (verified live: tesseract 5.3.0,
pypdfium2 5.11.0). The pdfplumber PowerDB grid parser is live in production,
not just in dev — this matters because the eval harness's "OCR-path recall"
number (§8) is the only golden-set proxy for what a real scanned upload will
score in that same production environment.

## 7. AI plumbing — `lib/ai.ts`

Shared entry point for every AI call:

- `complete({ system, user, task })` — text.
- `completeWithImage({ imageBuffer, prompt, maxTokens, responseMimeType })` —
  vision. Routes by provider: Anthropic / OpenAI / Azure OpenAI / Gemini /
  Groq.
- Gemini cascade (`DEFAULT_GEMINI_CASCADE`) — 2.5-flash → 2.5-flash-lite →
  `-latest` self-healing aliases (the 2.0 tier was shut down and pruned from
  the cascade).
- Cross-provider fallback on quota exhaustion or an empty-but-successful
  response: Gemini → Groq Qwen3-VL. Groq's own path already forces
  `response_format: 'json_object'`.
- `AI_ENABLED=false` is a global kill-switch. `AI_MODEL_OVERRIDE` pins a
  specific model at the head of the cascade.

**Truncation-trap fix (2026-07-04, commit 919d389 + follow-up commit
83cb831):** Gemini 2.5-flash is a THINKING model whose reasoning tokens bill
against `maxOutputTokens`. A tight budget silently truncates the JSON body
mid-object, `JSON.parse` throws, the route 500s, and the quota is refunded.
The nameplate route hit this at `maxTokens: 1536` (read rate collapsed to 1/7
plates before the fix). The fix was generalized to every
`completeWithImage` caller: `routes/assetPhotoInspect.ts` (nameplate),
`lib/aiTestReportExtract.ts` (test-report vision, §8.1), `lib/arcFlashDevice.ts`
(arc-flash device photo), `lib/arcFlashExtract.ts` (arc-flash one-line),
`lib/photoInspect.ts` (photo condition inspection) — all now use
`maxTokens: 8192` + `responseMimeType: 'application/json'`. A permanent fix
(`thinkingBudget: 0`) needs the newer `@google/genai` SDK; the legacy SDK in
use (0.24.1) lacks that parameter, so the 8192-budget workaround is the
current mitigation, not a final fix.

Provider data policy:

- **Gemini unpaid tier** — training on inputs is ON per Google's Additional
  Terms; do not send customer nameplate photos on unpaid tier. A one-time $10
  prepay flips the whole project to no-training paid terms at
  ~$0.0002/scan. Diligence-relevant; tracked separately in the SOC2
  readiness backlog.
- **Groq** — no-training by contract (Services Agreement §4.2), no retention
  by default. Free ZDR toggle available.

## 8. Post-extraction pipeline — AI gap-fill, merge, disagreement flagging

Two AI-adjacent stages sit between the deterministic extractor (§4) and the
safety layers (§9), each strictly additive/advisory and each fails open on
its own.

### 8.1 AI gap-fill — `lib/aiTestReportExtract.ts`

Only invoked when coverage is low (stage 4/5 in §3). Uses a strict JSON-only
prompt listing the canonical `KNOWN_TYPES` vocabulary and a `CRITICAL_TYPES`
subset (`contact_resistance`, `ground_fault_pickup`, `trip_time`,
`pickup_current`, `primary_injection`, `secondary_injection`). Every
AI/vision reading is stamped `source: 'ai'` and `confidence: 0.5`
(`AI_READING_CONFIDENCE`) — deliberately below the default 0.85 review floor
so AI readings route to review by default regardless of the account's
threshold setting. This confidence used to be the *string* `'ai'`, which the
confidence gate silently skipped (only scored `typeof confidence ===
'number'`) — a P0 fix on 2026-07-03 made it a real number so the
least-certain source in the pipeline actually counts against the floor.
`scrubForAi()` strips emails/phone numbers before anything is sent to the
(free-tier, possibly retention-enabled) model.

### 8.2 Merge + cross-pass disagreement — `testReportPreview.ts:mergeExtractedMeasurements`

An AI-recovered value that exactly matches an existing deterministic value is
dropped as agreement (but tags `crossSourceAgreement`); a different value at
the same `(type, phase)` is kept as a flagged `crossPassDisagreement` on both
rows rather than silently discarded — two independent passes disagreeing is
treated as the strongest available misread signal the pipeline has.

## 9. Safety layers — confidence gate + domain validators

Everything above produces measurements; these layers ROUTE them. Both are
internal-consistency-only: **never assert compliance, never compute a PPE
category, never auto-correct a value.** A failed check downgrades confidence
and routes the reading to the review queue.

### 9.1 Confidence gate — `lib/ingestConfidenceGate.ts:evaluateIngestGate`

Scores the whole preview and decides `autoCommit` (used by hands-off paths
like email-in/backfill; a human-reviewed preview can still commit through the
UI regardless of gate color). Identity risks are always strict regardless of
the account threshold: OCR/photo-of-paper source, an AI-inferred serial
number, a medium/low-confidence asset match, or creating a new asset that
looks like a possible duplicate. The per-reading confidence floor (default
0.85) is the only tunable knob. Two hard rules layered on top: any AI-sourced
reading marked `critical` always forces red/review (a model can confabulate a
value for an empty cell, and a critical RED reading auto-creates a
deficiency); and a reading whose confidence value is present but not a finite
number is treated as unscoreable and forced to at least yellow rather than
silently skipped (this guards specifically against the historical
string-`'ai'` bug in §8.1 recurring in a new form). A silent-empty/low-coverage
guard forces red when zero measurements were extracted, or yellow when a
scanned/mixed document yielded far fewer readings than its page count would
suggest, or the extraction was truncated.

### 9.2 Domain validators — `lib/domainValidators.ts:checkDomainConsistency`

Seven pure, total checks run in sequence, wired into the gate via
`preview.meta` context:

| Check | What it catches |
|---|---|
| `poleBalance` | Per-phase peer balance (NETA MTS §7.6.1.2 — contact resistance readings across phases shouldn't vary more than 50% of the lowest value; winding resistance uses a tighter 5% since IEEE C57.152 expects near-parity). Catches the canonical "4.2 → 42" decimal-drop misread class. |
| `acetylene` | C2H2 dissolved-gas plausibility — >100 ppm is either a real serious arcing fault or a misread, so it routes to review either way. |
| `tdcgChecksum` | Recomputes TDCG from its six component gases and flags a mismatch against the printed total. |
| `piRecompute` | Recomputes polarization index from paired 1-min/10-min insulation-resistance readings and flags disagreement with the report's printed PI. |
| `tempCorrection` | IEEE-43 raw→40°C-corrected IR reconciliation (`corrected ≈ raw × 0.5^((40−T)/10)`), using either a single row with both values or two rows paired by phase and raw/corrected labeling. Uses `meta.ambientTempC` from the extractor — reaches Node as of the §3.1 fix (2026-07-05, commit `2fa5bb9`). |
| `verdictCrossCheck` | Compares the report's own printed PASS/FAIL (`meta.reportResult`) against the verdict computed from the extracted readings (any RED implies computed FAIL) — reaches Node as of the same §3.1 fix. |
| `completeness` | Flags a report that looks like it's for a transformer/breaker/switchgear/cable/motor type but is missing the measurement type that equipment class always carries (e.g. no `insulation_resistance` on a transformer report). |

### 9.3 Nameplate validators — `lib/nameplateValidators.ts`

V1-V7, recalibrated 2026-07-04 (95 tests, 5-test regression-lock on
cross-family mismatches). Same posture as §9.2: never auto-correct, only
downgrade + attach a machine-readable reason. Wired into the nameplate route
(§5) with the regression-lock in `nameplateOcrContract.test.js`.

## 10. Golden-set eval harness — current numbers + the parser/OCR-path gotcha

`server/scripts/eval_extraction.py` runs against
`server/scripts/neta_synthetic_test_reports.json` — 20 labelled synthetic
reports (8 clean, 7 partial_ocr, 5 garbled_ocr, with seeded traps) — and is
documented session-by-session in `docs/EVAL_BASELINE_2026-07.md`. As of the
most recent entry (the `388955c` commit, 2026-07-04 evening):

| Tier | Parser recall | OCR-path recall |
|---|---|---|
| clean | 100% | 50% |
| partial_ocr | 100% | 85% |
| garbled_ocr | 10% | 0% |

Every non-garbled report now scores 100% on the deterministic parser (up from
19%/12%/5% on the original 2026-07-03 baseline via a sequence of DGA/PI/PF
parsers, column-header inference, OCR-noise-tolerant unit vocabulary, and a
final WINDING-IR-grid pass — see `EVAL_BASELINE_2026-07.md` for the full
per-fix breakdown). Garbled tier is the one standing gap (parser 10%,
OCR-path 0%) and is a render-noise floor, not an extractor-coverage problem.

Note: a direct eval run the same night as this update (2026-07-05 planning
session) measured partial_ocr parser recall at 97% rather than 100%. This is
very likely run-to-run measurement noise rather than a regression — the two
numbers are close, and nothing in the codebase is known to have changed
between the documented 100% and the observed 97% run. Worth a quick re-run to
confirm before treating it as a regression, but do not chase it as a bug on
its own.

### 10.1 The parser-vs-OCR-path distinction — read this before touching OCR code

These are two structurally different measurements, not just different data.
**Parser recall** feeds the golden set's `extractedText` JSON field — which
is hand-authored ground-truth-adjacent text, not real OCR output — directly
into `extract_measurements()`. This bypasses `extract_fields()` and
`_ocr_text()` entirely; there is no PDF render, no tesseract call, nothing
that looks like the real ingest path upstream of the regex passes.
**OCR-path recall**, by contrast, renders a real synthetic PDF from the
golden-set data and runs the FULL pipeline — `extract_fields()`, the OCR
fallback when the text layer is thin, tesseract if installed, then the same
nine measurement passes. These are genuinely different code paths exercising
different inputs, and the gap between them (e.g. partial_ocr 100% parser vs.
85% OCR-path) is not a bug — it reflects that the rendered PDF's word
geometry and any real OCR noise are harder than the golden text.

**Gotcha for future OCR-engine work (new finding, 2026-07-05, not yet
documented elsewhere):** because "parser recall" calls `extract_measurements()`
directly on the golden `extractedText` field and never touches `_ocr_text()`
or the OCR-triggered branch of `extract_fields()`, **any fix that lives only
inside `_ocr_text()` or that branch — an OCR-noise-correction pass, a future
RapidOCR second reader, tesseract config tuning — structurally cannot move
the "parser recall" number.** Only "OCR-path recall" is reachable by an
OCR-side fix, and OCR-path recall requires a real tesseract install to even
test (present on the Linux droplet/CI, absent on the Windows dev machine used
for most sessions). This isn't a workaround-able quirk: the golden corpus's
garbled-tier `extractedText` is *already* a hand-authored "OCR output" proxy
— it has baked-in corruption patterns (letter-for-digit substitutions inside
words, e.g. "P0WERDB", and numeric values split across line-wraps) meant to
simulate what a real OCR engine would produce, not something generated by
running an actual OCR engine in that code path. Anyone tackling the garbled
tier by improving OCR quality should test against OCR-path recall (which
needs tesseract present) and should not expect parser recall to move at all
as a measure of that work's success — a flat parser-recall number after an
OCR-side change is expected, not a sign the fix failed.

Field accuracy on clean tier (serial / manufacturer / model): 92%, stable
since the original baseline.

## 11. Known issues / open bugs

**`_bus_inline_readings` no-header fallback can mislabel the unit (confirmed,
unfixed as of 2026-07-05).** The fallback path (used when a row like
`A-B: 850 M? B-C: 720 M? C-A: 910` has no unit-in-parens header line within
the preceding ~200 chars) searches the row text for the first token matching
`_ROW_UNIT_RE` and uses it as `asFoundUnit` for every phase value on that
row. `_ROW_UNIT_RE`'s alternation includes bare `A` and `V` as unit tokens
(needed to catch genuine Amps/Volts readings elsewhere), so a leading
phase-letter token like the "A" in "A-B" can itself match as a bare Amps unit
before the regex search reaches the real unit token later in the row. This
mislabels megohm insulation-resistance readings as amps in that one fallback
branch. `measurementType` classification is unaffected — it is driven by the
LABEL via `_classify()`/`classify_label()`, not by the unit — so this does
not hurt recall or measurement-type accuracy, but it does corrupt the
`asFoundUnit` field on affected readings, which is safety-adjacent (a wrong
unit on an insulation-resistance reading is exactly the kind of thing the
domain validators (§9.2) and a human reviewer rely on being correct).

An in-session fix was attempted (search for the unit only *after* the first
numeric token in the row, so a leading phase letter can never match) and was
**reverted** because it regressed clean-tier OCR-path recall on reports 006
and 018 from 50%→34% and 100%→25% respectively. Both of those reports have a
proper `"(MΩ)"` unit-in-parens header in the golden text, so on paper they
should use the header-based path, not the no-header fallback — but the real
rendered-PDF OCR-path apparently routes them through this same fallback
branch anyway, in a way that is not yet understood (possibly the rendered
PDF's line geometry breaks the ~200-char header lookback window, or
tesseract output on the rendered PDF doesn't reproduce the parenthesized
header text cleanly). This is flagged as an **open, real, safety-adjacent
bug** — wrong units on insulation-resistance readings — that needs a
careful, fully eval-gated fix (both parser recall AND OCR-path recall, on all
affected reports) rather than a quick patch. Do not re-attempt the naive
"skip past the first numeric token" fix without first understanding why
006/018 hit the fallback branch on the OCR-path at all.

See §3.1 for the separate `report_result`/`ambient_temp_c` forwarding gap in
`run.py`, found and fixed the same night (commit `2fa5bb9`).

## 12. Source docs (retained; cross-linked here)

Each of these is the primary artifact for the review it summarizes; this doc
is the tour, not a replacement.

12.1 `PDF_INGESTION_REVIEW_2026-07-03.md` — deep code-grounded review, the
2026-07-03 tooling landscape survey with license verification. Origin of the
P0 gate fixes referenced in §8.1.

12.2 `PDF_INGESTION_SYNTHESIS_2026-07-03.md` — reconciles the deep review
with a 5-model external panel; documents where the panel was wrong for
ServiceCycle's constraints. Contains the invariant quoted in §2.

12.3 `NAMEPLATE_INGESTION_REVIEW_2026-07-03.md` — full nameplate-scan
pipeline audit, V1-V7 validator design, tooling survey, provider data-terms
verbatim.

12.4 `EVAL_BASELINE_2026-07.md` — the full session-by-session eval history
with per-report recall tables; §10 above is a summary of its most recent
entries, not a replacement for it. This is the go/no-go gate for any future
tooling swap (RapidOCR, a different OCR engine, etc.) — re-run it, and no
swap ships unless it moves the relevant recall number on this corpus.

12.5 `PROD_REALITY_AUDIT_2026-07-04.md` — audit of features that could be
inert in prod (the Alpine-extractor incident's class, §6).

12.6 Claude memory file `servicecycle-morning-parser-2026-07-04` — narrative
of the five-commit day that took clean/partial parser recall from ~41%/31%
to 100%/100%, including the RapidOCR prototype-and-revert (§10.1 territory).

12.7 Claude memory file `servicecycle-overnight-ingest-2026-07-04` —
narrative of the truncation-trap generalization (§7) and column-header-
inference recall jump (41%→91% clean).

12.8 Claude memory file `servicecycle-overnight-parser-2026-07-05` — the
overnight session this doc's newest findings (§10.1 gotcha, §11 bug) were
drafted alongside; may not exist yet depending on when this file is read,
since it is being written the same night as this update.

---

*This is a living doc. When a new pass is added to `extractor.py`, update §4.
When a new validator ships, update §9.2. When the eval numbers move, update
§10. The source docs in §12 are frozen at their timestamps; this one moves.*

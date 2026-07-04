# ServiceCycle Ingestion Architecture

*Read-me-first entry point for the PDF + nameplate ingestion stack.*
*Last updated: 2026-07-04.*

This document is a diligence-ready start-to-finish walk of the ingest pipeline: how
each path works, what runs deterministically vs what runs through AI, where the
safety layers sit, and what the current numbers are. It supersedes reading the
individual review docs in order — those are still on disk (§10) as the source
material and the incident history.

---

## 1. What "ingest" means in ServiceCycle

Two customer-facing ingest paths turn field artifacts into rows in the database:

- **Test-report ingest** — a technician uploads a NETA / PowerDB / Megger / Doble
  test report (PDF, sometimes a phone photo of a paper report). Output: an
  asset match + a list of measurement rows attached to that asset, each with a
  passFail band and a deficiency if warranted. Route:
  `POST /api/test-reports/preview` and the sibling background ingest worker.
- **Nameplate scan** — a technician photographs an equipment nameplate on their
  phone. Output: identification fields (manufacturer / model / serial / voltage
  / kVA / phases / …) with a per-field confidence the tech reviews before save.
  Route: `POST /api/assets/ocr-nameplate` (unmetered demo cap: 5/day).

Both are the moat: friction-free data-in. Both are treated as "strong drafts you
correct," never as authoritative reads.

## 2. The invariant every layer defends

> Structure and layout models decide **geometry only**; numeric values enter the
> database solely from the PDF content stream or raw OCR tokens, with bbox
> provenance where available. **No generative model ever writes a number.**

This is the discipline the whole architecture depends on and it is what makes
the stack acquisition-safe: an acquirer's counsel doesn't have to accept
"trust the LLM to have transcribed 4.32 correctly." The rule is stated
verbatim in `PDF_INGESTION_SYNTHESIS_2026-07-03.md` §4, reinforced by the
2026-07-03 P0 gate fixes, and enforced by the confidence gate + validators
below.

## 3. Pipeline map — test-report ingest

Preview route → `server/lib/testReportPreview.ts`:

1. **Photo-of-paper wrap** (`server/lib/imageToPdf`) — if the upload is an
   image, wrap into a single-page PDF so the same downstream pipeline reads it
   unchanged. `photoOfPaper = true` flag threads through so the vision-fallback
   step (below) knows to send the ORIGINAL image, not the wrapped PDF.
2. **Fingerprint** — SHA-256 of the buffer; a duplicate upload short-circuits
   the pipeline and points at the prior import.
3. **Deterministic pass (pdfplumber)** — `server/pyextract/extractor.py` via
   `runDeterministic` in `lib/testReportExtract.js`. This runs
   `extract_fields()` in the Python subprocess (Debian container, `python3` +
   `tesseract-ocr` installed as of commit c652578; see §6). Output: `fields`
   (header identification), `measurements` (list of readings with type / value /
   unit / phase / confidence), plus per-page and per-section metadata.
4. **AI text gap-fill** (`lib/aiTestReportExtract.aiFillReadings`) — runs only
   when the deterministic pass came back low-coverage (< `AI_INGEST_MIN_READINGS`
   readings or the deterministic engine fell through to the pdfjs text
   parser). Same Gemini/Groq vision cascade as the nameplate route (§5).
   Deterministic rows are the source of truth; AI fills gaps.
5. **AI vision fallback** — only when (a) the upload was a photo-of-paper AND
   (b) coverage is still below the floor. Sends the ORIGINAL image (not the
   OCR'd wrapper) via `aiFillReadingsFromImage` → `completeWithImage`.
6. **Identity resolution** (`lib/assetIdentity.resolveAsset`) — normalized
   serial-number match with fuzzy O↔0 / I↔1 folding, then site+type fallback.
7. **Per-section split** — a NETA job report often covers many assets under
   `SUBSTATION … POSITION …` headers. The extractor emits per-section indices;
   the preview surfaces per-section readings + per-section identity resolution.
8. **Telemetry** — `recordExtraction` writes an `ExtractionEvent` row per
   ingest. The `engine` string is the real model / parser id (not a hardcoded
   label) so per-engine accuracy is comparable in aggregate.

Sanity + safety layers (§8) run AFTER the pipeline builds `measurements`, but
BEFORE anything is committed to the asset — a preview is a draft the user
confirms.

## 4. Deterministic extractor passes (`extractor.py`)

`extract_measurements()` runs these regex/geometry passes in order, then dedups.
Every pass is pure, total, and fail-open — a bug in one never breaks the whole
extraction:

| Pass | Role | Reports it targets |
|---|---|---|
| `_column_tables` | Clean ruled column tables (pdfplumber lines) | Standard synthetic reports |
| `_powerdb_grids` | PowerDB unit-in-header grids | PowerDB test forms |
| `_dga_readings` | DGA `<gas> (<sym>) <value> <=<limit>` rows | Report 002 class |
| `_pi_readings` | Polarization Index (unitless ratio) | IR reports w/ PI |
| `_pf_readings` | Doble M4100 power-factor table rows | Doble PF blocks |
| **`_bus_inline_readings`** *(NEW 2026-07-04)* | `A-G: 15200  B-G: 14100  C-G: 16800` bus-inline layout | Reports 006, 018 |
| **`_phase_grid_readings`** *(NEW 2026-07-04)* | PHASE / AS-FOUND / EXPECTED / RESULT grid with the measurementType on the line above | Reports 014, 017 |
| `_inline_readings` | General value+unit inline pass (nameplate-suppressed) | Everything else |

Both new passes classify by the nearest unit-in-parens header line above the
row block, never by the row itself. If no header is nearby they emit nothing —
false positives cost more than missed rows, and the review below §8 catches
what's missed by routing to human review.

Header-level extraction (`extract_header`) and report-level extraction (verdict,
ambient temperature — added 2026-07-04) surface into `meta` on the preview so
the domain validators can cross-check them.

## 5. Pipeline map — nameplate scan

Nameplate scan is a **single vision call** with a full safety envelope around
it. `POST /api/assets/ocr-nameplate` in `routes/assetPhotoInspect.ts`:

1. Auth (unrestricted-role — even viewer can scan; the save endpoint is gated).
2. AI consent + demo-budget guard + per-user daily meter (`nameplate_scan`,
   default 5/day on the demo droplet).
3. `normalizeImage` — sharp EXIF-rotate + HEIC → JPEG + long-edge ≤ 2000 px.
4. `completeWithImage` — Gemini 2.5-flash cascade (see §7) with:
   - `maxTokens: 8192` (thinking-token budget, see §7 truncation-trap fix)
   - `responseMimeType: 'application/json'` (JSON mode)
5. Parse (tolerant of prose-wrapped JSON via brace-fallback).
6. `applyNameplateDowngrades` — per-field range/regex plausibility.
7. `nameplateValidators.checkNameplateConsistency` — cross-field checks
   (V1-V7 in `NAMEPLATE_INGESTION_REVIEW_2026-07-03.md` §4): kVA-standard
   ladder membership, voltage-class ANSI/NEMA membership, `kva == frequency`
   duplicate-value grab (V1 — the observed failure class), evidence-string
   check when the model returned `sourceText`.
8. Telemetry + response with fields + confidence map + machine-readable reasons
   per field for the client tooltip.

Failures refund the quota slot (`refundScan`) so a bad photo never burns the
tech's daily cap.

**Regression-lock:** `server/tests/nameplateOcrContract.test.js` locks the
JSON-mode + maxTokens invariants, the graceful-truncation contract, and the
end-to-end domain-validator wiring against fixture responses. Added 2026-07-04
after the vision call silently truncated on the shared demo droplet for hours.

## 6. Runtime reality — what actually runs in prod

Prior to 2026-07-03 the container base was `node:20-alpine`, `pypdfium2` had no
musl wheel, and the whole Python extractor was **inert in production** — ingest
silently fell back to the pdfjs text parser + AI gap-fill. This is documented
in `PDF_INGESTION_SYNTHESIS_2026-07-03.md` §2 as the biggest single finding of
that review.

Commit `c652578` switched the base to `node:20-slim` (Debian). The Python
extractor + Tesseract OCR now run in prod. The pdfplumber PowerDB grid parser
is live. The requirements comment referencing Alpine was cleaned up on
2026-07-04 (see `docs/PROD_REALITY_AUDIT_2026-07-04.md` F1 for the finding).

## 7. AI plumbing — `lib/ai.ts`

Shared entry point for every AI call:

- `complete({ system, user, task })` — text.
- `completeWithImage({ imageBuffer, prompt, maxTokens, responseMimeType })` —
  vision. Routes by provider: Anthropic / OpenAI / Azure OpenAI / Gemini / Groq.
- Gemini cascade (`DEFAULT_GEMINI_CASCADE`) — 2.5-flash → 2.5-flash-lite →
  `-latest` self-healing aliases. Verified against ListModels 2026-07-03
  (the 2.0 tier was shut down; the cascade was pruned then).
- Cross-provider fallback on quota exhaustion: Gemini → Groq Qwen3-VL. Groq's
  own path already forces `response_format: 'json_object'`.
- `AI_ENABLED=false` is a global kill-switch. `AI_MODEL_OVERRIDE` pins a
  specific model at the head of the cascade.

**Truncation-trap fix (2026-07-04, commits 919d389 + this session):** Gemini
2.5-flash is a THINKING model whose reasoning tokens bill against
`maxOutputTokens`. A tight budget silently truncates the JSON body mid-object,
`JSON.parse` throws, the route 500s, and the quota is refunded. The nameplate
route hit this at `maxTokens: 1536` (read rate collapsed to 1/7 plates on
2026-07-04 evening). This session audited every `completeWithImage` caller and
brought each of them up to `maxTokens: 8192` + `responseMimeType:
'application/json'`. Callers audited: `routes/assetPhotoInspect.ts:456`
(nameplate — fixed 919d389), `lib/aiTestReportExtract.ts:268` (test-report
vision), `lib/arcFlashDevice.ts:184` (arc-flash device photo),
`lib/arcFlashExtract.ts:252` (arc-flash one-line), `lib/photoInspect.ts:380`
(photo condition inspection). See `PROD_REALITY_AUDIT_2026-07-04.md` F2 for
the audit summary.

Provider data policy (from `NAMEPLATE_INGESTION_REVIEW_2026-07-03.md` §3.5):

- **Gemini unpaid tier** — training on inputs is ON per Google's Additional
  Terms; do not send customer nameplate photos on unpaid tier. A one-time $10
  prepay flips the whole project (per Cloud project + billing account) to
  no-training paid terms at ~$0.0002/scan. Diligence-critical; on Dustin's
  action list.
- **Groq** — no-training by contract (Services Agreement §4.2), no retention by
  default. Free ZDR toggle available.

## 8. Safety layers — confidence gate + validators

Everything above produces measurements; the LAYERS ROUTE them. All of §8 is
internal consistency only. **Never asserts compliance, never computes a PPE
category, never auto-corrects a value.** A failed check downgrades confidence
and routes the reading to the review queue.

### 8.1 Confidence gate — `lib/ingestConfidenceGate.ts`

- Per-unit scoring against a threshold (default 0.85).
- Below-threshold rows route to review.
- AI-sourced critical readings force review regardless of threshold.
- Silent-empty guard: a totally-empty extraction ⇒ review, never auto-accept.
- Cross-pass disagreement guard: when both deterministic + AI passes produced a
  reading on the same (type, phase) but the values differ, both are kept and
  flagged.

Wired to `checkDomainConsistency` below via `preview.meta` context.

### 8.2 Domain validators — `lib/domainValidators.ts`

Every check is pure and total (never throws). Called from the confidence gate:

| Check | What it catches |
|---|---|
| `poleBalance` | Per-phase peer-balance (NETA MTS §7.6.1.2 ±50% rule). Catches the "4.2 → 42" digit-shift class. |
| `acetylene` (DGA) | C₂H₂ presence at levels that indicate arcing. Advisory flag. |
| `tdcgChecksum` | TDCG total vs sum of component gases. |
| `piRecompute` | Printed Polarization Index vs IR(10min)/IR(1min). |
| **`tempCorrection`** *(NEW 2026-07-04)* | Where raw + corrected IR both appear AND temperature known, verify `corrected ≈ raw × 0.5^((40 − T)/10)` (IEEE-43). Uses `meta.ambientTempC` from the extractor. |
| **`verdictCrossCheck`** *(activated 2026-07-04)* | Report's own printed PASS / FAIL vs the verdict computed from readings. Needs `meta.reportResult` — populated by `_extract_report_verdict` (new pass in the extractor). |
| `completeness` | Expected-but-missing measurement type for the equipment class (transformer without IR ⇒ incomplete). |

### 8.3 Nameplate validators — `lib/nameplateValidators.ts`

V1-V7 in `NAMEPLATE_INGESTION_REVIEW_2026-07-03.md` §4. Same posture: never
auto-correct, only downgrade + reason. Wired into the nameplate route (§5) with
the regression-lock in `nameplateOcrContract.test.js`.

## 9. Current accuracy numbers (2026-07-04)

Golden set: `server/scripts/neta_synthetic_test_reports.json` (20 labelled
synthetic reports: 8 clean / 7 partial_ocr / 5 garbled_ocr). Harness:
`server/scripts/eval_extraction.py`. Deterministic-only, no AI, no network,
fully reproducible.

| Tier | 2026-07-03 baseline | 2026-07-03 update (DGA/PI/PF) | 2026-07-04 update (col-header inference) |
|---|---|---|---|
| clean | 19% | 41% | **91%** |
| partial_ocr | 12% | 31% | **40%** |
| garbled_ocr | 5% | 5% | 5% |

Garbled tier is the render-noise floor and unchanged — the fix path is the
RapidOCR second reader (backlogged; §10.5).

Field accuracy on clean tier (serial / manufacturer / model): 92%.

## 10. Source docs (retained; cross-linked here)

Each of these is the primary artifact for the review it summarizes; this doc
is the tour.

10.1 `PDF_INGESTION_REVIEW_2026-07-03.md` — deep code-grounded review, file:line
grounded findings, the 2026-07-03 tooling landscape survey with license
verification. Origin of the P0 gate fixes.

10.2 `PDF_INGESTION_SYNTHESIS_2026-07-03.md` — reconciles the deep review with a
5-model external panel. Documents where the panel was wrong for
ServiceCycle's constraints (Datalab / Marker / PyMuPDF / self-hosted VLMs
are all rejected for licensing or safety reasons). Contains the invariant in §2.

10.3 `NAMEPLATE_INGESTION_REVIEW_2026-07-03.md` — full nameplate-scan pipeline
audit, V1-V7 validator design, tooling survey, and provider data-terms verbatim.

10.4 `EVAL_BASELINE_2026-07.md` — the eval harness output — before / after
diffs per session, the go/no-go gate for any future tooling swap.

10.5 `PROD_REALITY_AUDIT_2026-07-04.md` — audit of features that could be inert
in prod (the Alpine extractor incident's class). Findings F1-F7 + D1-D2.

10.6 `NEXT_SESSION_FREE_BUILD_PROMPT_2026-07-03.md` — the free-code build plan
that ran into the truncation-trap incident.

10.7 `OVERNIGHT_AUTONOMOUS_PROMPT_2026-07-04.md` — the autonomous session plan
that produced this doc + the changes summarized in §4, §7, §8, §9.

---

*This is a living doc. When a new pass is added to `extractor.py`, update §4.
When a new validator ships, update §8.2. When the eval numbers move, update §9.
The source docs in §10 are frozen at their timestamps; this one moves.*

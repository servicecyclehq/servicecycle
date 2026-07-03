# PDF Ingestion Stack Review — Holes, SOTA Tooling, Upgrades
**Date:** 2026-07-03 · **Scope:** test-report import pipeline (extractor.py → testReportParse.ts → ingestConfidenceGate.ts → aiFillReadings) · **Method:** code audit with file:line evidence + 5-angle web research (verified against primary sources; licenses fetched verbatim)

## Verdict

The architecture is right: deterministic-first, AI as gap-fill, confidence gate, fail-open. Nobody should talk you out of that — the research confirms every "modern" end-to-end parser (Docling, Marker, MinerU) is optimized for lossy markdown/RAG conversion and is *worse* than a targeted pipeline at exact cell values on a known format. Wholesale replacement is the wrong move.

But the audit found **two P0 bugs that defeat the confidence gate for AI readings**, an **OCR path that only ever reads 3 pages**, and a set of missing cheap defenses (domain cross-checks, censored readings, cross-pass reconciliation) that matter more than any tool swap. On tooling: one adopt (RapidOCR), two trials (img2table, gmft/Camelot-ml), and a hard-avoid list that matters for acquisition diligence.

---

## Part 1 — Holes in the current design (ranked by safety impact)

### P0-1. AI measurements bypass the confidence gate entirely
`aiTestReportExtract.ts:178` sets `confidence: 'ai'` — a **string**. `ingestConfidenceGate.ts:93` does `typeof m.confidence === 'number' ? m.confidence : null` and `continue`s on null. Net effect: an AI-extracted reading is never counted as below-threshold, regardless of the account's threshold setting. Verified in code this session. The gate you built specifically to catch uncertain extractions structurally cannot see the least-certain source.

### P0-2. AI-only critical readings persist with no human sign-off
`testReportPreview.ts:145-172`: gap-fill merges AI readings using dedup key `(type|phase|value)` — source is not part of the flow, and there is no "AI readings pending review" state. An AI-invented RED contact-resistance auto-creates an IMMEDIATE deficiency. This is exactly the documented VLM failure mode: models **confabulate values for empty cells** (arXiv 2406.00257) and swap digits (4.32 for 2.32 — UNIKIE-BENCH, arXiv 2602.07038). The gap-fill pass by definition operates where the deterministic parser found nothing — i.e., precisely where confabulation is most likely and least checkable.

### P0-3. OCR reads at most 3 pages, decided per-document
Two compounding problems in `extractor.py`:
- `has_text_layer()` (line 49) samples only the **first 3 pages**, needs just 40 chars. A text cover sheet + scanned body → whole document treated as text-based; scanned measurement pages extract as empty. Decision is per-document; it should be per-page.
- `OCR_PAGES = 3` (line 684). Even a fully scanned report only ever gets pages 1-3 OCR'd. The text pass covers 200 pages, but the OCR pass — the one for the hard documents — covers 3. A scanned 41-page PowerDB report would yield near-zero measurements and fail *silently* (fail-open means no error surfaces; the user just sees "Is it a text-based test report?").
- No garbled-layer detection: a corrupt/CID-font text layer with plenty of characters passes the check and OCR never fires.

### P1-4. No cross-pass reconciliation — disagreements resolved silently
`extractor.py:619-657`: dedup key is `(type, phase, value, unit)`. If the table pass reads 250 µΩ and the grid pass reads 2500 µΩ for the same pole, **both survive** and the higher hardcoded confidence silently wins. Two independent passes disagreeing on the same measurement is the strongest misread signal the pipeline has, and it's currently discarded.

### P1-5. Censored readings vanish: `OL`, `>10,000`, `INF`, `N/A`
`_INLINE_RE` (line 262) requires a numeric group. "Insulation Resistance: OL" or ">100 GΩ" — which mean *excellent* insulation — produce no match. The asset looks untested (false compliance gap), or worse, only the lower-value phases get recorded, skewing phase-balance interpretation.

### P1-6. OCR quality: confidences thrown away, ~144 DPI, no PSM, no preprocessing
`extractor.py:700-701`: `render(scale=2.0)` (≈144 DPI at the typical 72-unit page — Tesseract's documented minimum for reliable output is **300 DPI**) then `image_to_string` with zero config. `image_to_data` would return per-word confidence + bbox **for free from the same call family** — the single cheapest quality signal available, unused. No deskew/binarization, no PSM (default PSM 3 is documented to fail on tables), no digit whitelist. Low DPI is the canonical mechanism for the 4.2→42 failure: the decimal point is the smallest glyph on the page and disappears first.

### P1-7. No page/bbox provenance on any measurement
The char offset `_off` is computed then stripped (`extractor.py:652`); no page number, no bbox, no extraction-pass label persists. Consequences: the HITL reviewer must re-read the whole PDF to verify one number, and a click-to-highlight review UI is impossible. This is the single biggest gap vs. commercial doc-AI (Reducto, Azure, LlamaExtract all ship per-field bbox citations as the core HITL primitive).

### P2-8. Confidences are hardcoded guesses, never calibrated
0.85 / 0.9 / 0.75 / 0.6 constants (`extractor.py:246,362,415,488,546,567`). They encode pass identity, not correctness probability. Without a golden set (P2-11) there is no way to know whether "0.75" measurements are right 99% or 60% of the time — which is what the gate threshold is implicitly claiming to know.

### P2-9. Temperature correction absent
IR readings halve per ~10°C rise (IEEE 43 corrects to 40°C base). Reports often print raw *and* corrected values; the extractor doesn't distinguish them and captures whichever regex hits first. Pass/fail against a NETA range using the wrong one misjudges marginal assets.

### P2-10. Gemini **unpaid tier trains on customer data** — diligence flag
Documented Google policy: unpaid-tier prompts/responses are used to improve products ([Gemini API terms](https://ai.google.dev/gemini-api/terms)). Customer test reports flow through `aiFillReadings` on that tier today. An acquirer's diligence will ask. Fix is nearly free: a Tier-1 billing account flips data-use off even at ~$0 spend. (Groq states it does not train on API data.)

### P2-11. No golden-set regression tests
No fixtures asserting extracted values from known PDFs (only `testReportMultiSection.test.ts` for commit logic). Every regex/tooling change ships blind. This blocks everything else: you cannot evaluate an OCR swap, a confidence recalibration, or a new table parser without ground truth.

### P2-12. Minor: resource guards partial; byte-hash dedup fragile
45s timeout and 10 MB upload cap exist (good); no RSS cap on the Python child; 16 MB `maxBuffer` on stdout will truncate pathological outputs into a silent `ok:false`. SHA-256 of raw bytes won't dedupe a re-exported identical report — acceptable, just know it.

### What's already done well (keep)
Deterministic-first with AI strictly secondary; physical-plausibility bounds in `measurementSanity` applied pre-commit; IEEE 43 PI/DAR floors overriding report ranges; page/time budgets; atomic multi-section commit; extraction telemetry (source engine, confMin/confMean); Unicode Ω/µ normalization. The report's own PASS/FAIL verdict is also already extracted (`_RESULT_RE`) — an asset Part 3 builds on.

---

## Part 2 — Tooling landscape (July 2026, verified)

Constraint set: $0, commercially-safe license, CPU-only droplet. Every claim below was verified against primary sources (LICENSE files, PyPI, official benchmarks); the two-agent license discrepancy on Datalab was resolved by fetching both MODEL_LICENSE files verbatim.

### Adopt

| Tool | What | Why |
|---|---|---|
| **RapidOCR 3.9.x** (Apache-2.0) | PaddleOCR's models as ONNX; `pip install rapidocr onnxruntime`, ~80 MB, no torch/paddle. v3.9.1 released **2026-07-02**; defaults to **PP-OCRv6** models since 3.9.0. | The measured OCR upgrade: PP-OCR family CER ~0.10 vs Tesseract ~0.18 on degraded scans; OmniDocBench OCR edit-dist 0.071 vs 0.096. ~0.5–1.5 s/page CPU. Slot in as the scan-OCR engine behind a flag; keep Tesseract 5.5.2 (still fine on clean pages, CER ~0.02) as fallback. |
| **img2table 2.0** (MIT, 2026-05-10) | OpenCV table extraction for scanned/ruled grids, per-cell bboxes, pluggable OCR (works with RapidOCR). | Scanned PowerDB printouts keep their grid lines — exactly its sweet spot. Sub-second CPU, no ML deps. Pairs with the per-page OCR routing fix (P0-3). |

### Trial (behind the golden set, in a bounded role)

| Tool | Role | Notes |
|---|---|---|
| **gmft 0.4.3** (MIT) *or* **Camelot v2.0 `ml`** (MIT, 2026-06-04) | Borderless/partially-ruled **digital** tables where pdfplumber's heuristics fail. Both wrap Microsoft TATR (~110 MB, ~1.4 s/page + ~1.2 s/table CPU — gmft's published bench). | Key property of both: the model decides **geometry only; cell text comes verbatim from the PDF text layer** — digits can't be OCR-corrupted or hallucinated. gmft = leaner deps, slower release cadence, no OCR. Camelot v2 = bigger community, `flavor="auto"`, per-table `parsing_report` accuracy metrics (auto-flag weak tables for review), `[ocr]` extra. Pick one, not both. |
| **Docling 2.10x** (MIT, IBM/LF-AI; v2.109.0 released 2026-07-03) | Only if you want one framework for layout+tables+OCR with the best provenance JSON (per-cell bbox, page prov). `do_cell_matching=True` keeps cell text from the PDF's own tokens. | Heavier: ~2–6 s/table CPU (TableFormer), full document pipeline you mostly don't need, open issues on dense numeric columns merging (#2756, #1678). Use its RapidOCR backend, not EasyOCR (memory leak #1343). Trial only if gmft/Camelot underperform. |

### Skip — license (acquisition poison)

- **Marker / Surya / Chandra (Datalab)**: weights under modified OpenRAIL-M — commercial use barred above **$2M revenue or funding** (Marker's file; Surya's file self-contradicts words "two million" vs numerals "$5,000,000" — plan on $2M) **plus a non-compete with Datalab that applies at any size**. Marker code is also GPL-3.0. Any PE/OEM acquirer instantly breaches the cap. Technically good; legally radioactive for your GTM.
- **PyMuPDF / pymupdf4llm**: AGPL-3.0 dual-license. The textbook server-side diligence red flag. Never introduce it (note: dots.ocr ships it in requirements).
- **MinerU**: no longer AGPL but "Apache-2.0 + conditions": mandatory prominent attribution for any online service at any size + commercial thresholds. Shows up in every license scan; its winning config needs a GPU anyway.
- **Nougat**: CC-BY-NC weights, effectively dead repo.

### Skip — hardware/fit

- **All VLM OCR** (olmOCR 1/2, DeepSeek-OCR (MIT but 16 GB VRAM), PaddleOCR-VL, GOT-OCR2, dots.ocr, Granite-Docling): GPU-class, and generative decoding carries digit-hallucination risk — the wrong trade for measurements even if you had the GPU.
- **EasyOCR** (dormant since 2024, 3–50 s/page CPU), **unstructured** OSS (~4 s/page hi_res, weakest table fidelity of the CPU trio, steers to paid platform), **tabula-py** (JVM dep, same heuristic family as pdfplumber, nothing gained).

**Cross-cutting invariant to keep (adopt it as a written rule):** structure models decide *geometry only*; numeric values enter the DB only from the PDF content stream or raw OCR tokens, with bbox provenance. No generative model ever types a number into the database.

---

## Part 3 — Upgrades ranked by impact ÷ effort

### 1. Domain cross-check validators (~a day, pure functions, zero deps) — do first
The highest-leverage finding of the whole review. Confidence scores cannot catch a misread that OCR'd *cleanly* — but physics can. Encode as `measurementSanity` extensions, all arithmetic-internal (consistent with the PPE liability posture: these assert *internal consistency*, not compliance):

- **Phase/pole balance**: NETA MTS §7.6.1.2 (verbatim): investigate values that "deviate from adjacent poles or similar breakers by more than 50 percent of the lowest value." A pole set of {4.1, 4.3, 42} µΩ fails ×1.5 instantly — this rule alone catches the 4.2→42 class. Apply to contact resistance and (tighter, ~1-3%) winding resistance.
- **PI recompute**: PI = IR(10min)/IR(1min). If all three values extracted, verify the ratio; flag PI outside ~1.0–8.0 as probable misread. (Skip when IR(1min) > 5000 MΩ — IEEE 43 says PI is ambiguous there.)
- **DAR recompute**: IR(60s)/IR(30s), plausible band ~1.0–2.5.
- **TDCG recompute**: TDCG = H₂+CH₄+C₂H₂+C₂H₄+C₂H₆+CO (CO₂ excluded). If the report prints TDCG, recompute from components; mismatch ⇒ one gas was misread. (Note C57.104-2019 dropped TDCG as a *compliance* metric — using it as an internal checksum is exactly right.)
- **Gas plausibility**: C₂H₂ is almost always single-digit ppm; a C₂H₂ of 210 is nearly always a misread.
- **Temp-correction recompute**: where raw + corrected IR both appear, verify corrected ≈ raw × 0.5^((40−T)/10).
- **Report-verdict cross-check**: the pipeline already extracts the report's own PASS/FAIL (`_RESULT_RE`). If report says FAIL and computed says PASS (or vice versa) → probable misread → review queue. Free consistency check, currently unused as a signal.

Failure of any validator ⇒ drop confidence to review-queue level, never auto-commit. These catch high-confidence wrong values, which is the failure class nothing else in the stack addresses.

### 2. Fix the two P0 gate bugs (hours)
Make AI confidence numeric (or teach the gate about string sources) and add a hard rule: **`source: 'ai'` + `critical: true` ⇒ mandatory human attestation before the measurement can create a deficiency or influence pass/fail**. The provenance-enum + attestation machinery from the Phase-3 document work already exists — this is wiring, not building.

### 3. Golden-set eval harness in CI (~2-3 days) — prerequisite for all tooling changes
30–50 labeled reports (anonymized where needed) as ground-truth JSON; pytest harness asserting per-field precision/recall in the olmOCR-Bench "unit tests over documents" style: each case = (pdf, field, expected value, tolerance). Research finding: **no off-the-shelf OSS harness exists** for this — everyone builds the thin ~200-line version. Two side benefits: it's the only way to calibrate the hardcoded confidences against reality (P2-8), and "extraction accuracy measured at N% on a labeled corpus" is a diligence artifact, not just an engineering one.

### 4. Per-page OCR routing + Tesseract/RapidOCR hygiene (~2-3 days)
- Decide text-vs-OCR **per page** (page text < ~100 chars or garbled ⇒ OCR that page); raise the OCR cap to the existing 30 s wall-clock budget instead of 3 pages.
- Garble detection: dictionary-hit-rate / replacement-char / `(cid:` ratio on the text layer, not char count.
- Render at **300 DPI** (scale ≈ 4.17), Otsu binarize + deskew (OpenCV), PSM 6 on table regions (per-cell PSM 7 where cropped), digit whitelist *including* `.`, and switch `image_to_string` → **`image_to_data`**: per-word confidence feeds the gate, per-word bbox feeds provenance (#6). Same call, two missing features.
- Add RapidOCR behind a flag and A/B against Tesseract on the golden set's scanned subset.

### 5. Censored-reading grammar (~half day)
Parse `OL`, `INF`, `>N`, `<N`, `N/A` into `{value: null, qualifier: '>', bound: 10000}`. `>bound` where bound ≥ range-min evaluates PASS. Stops excellent readings from vanishing and keeps phase-balance math honest.

### 6. Bbox provenance end-to-end + click-to-highlight review (~1 week, ships demo polish)
Persist `{page, x0, y0, x1, y1, extractionPass}` per measurement — pdfplumber chars, `image_to_data`, img2table and gmft/Camelot cell bboxes all provide it for free; the current code computes offsets and throws them away. Render in the review UI with **react-pdf-highlighter** (MIT, active, scroll-to-highlight built in). This converts HITL review from "re-read the PDF" to "one glance per field" — the single pattern every commercial doc-AI (Reducto, Azure, LlamaExtract) converges on — and it demos extremely well for the acquisition narrative.

### 7. Cross-pass reconciliation + dual-extraction gating (~2-3 days)
Immediate: when two passes yield the same `(type, phase, unit)` with different values, don't let the higher hardcoded confidence win silently — flag for review. Then generalize: deterministic pass vs. one *independent* second read (RapidOCR path, or the AI pass) — agreement ⇒ auto-accept, disagreement ⇒ queue. The double-key-entry literature this descends from shows ~8× error reduction, and independence is what buys it (88% vs 69% error detection when the second reader is genuinely different).

### 8. AI gap-fill hardening (~2 days)
- **Echo-quote verification** (the one to do first): require every AI reading to return a verbatim source snippet covering the *row context* (label + value + unit); verify the snippet exists in the extracted text (exact → whitespace-normalized tiers). No verified quote ⇒ no value. Kills empty-cell confabulation at near-zero cost.
- Keep `responseSchema`/JSON mode on, but as plumbing only — measured result (Structured Output Benchmark, 2026): schema enforcement moves value accuracy by ~0 (−0.007 to +0.033); it fixes format, not truth.
- Two-model agreement for gap-fill (Gemini + Groq Llama-4-Scout are decorrelated families; you already have both wired): auto-suggest only on exact numeric match.
- Move Gemini off the unpaid tier (P2-10).

---

## Part 4 — Suggested sequencing

**Sprint 1 (pure code, no new deps):** P0 gate bugs → domain validators → censored readings → cross-pass disagreement flag. This is most of the safety value of the entire review at roughly a week of work.

**Sprint 2 (measurement infrastructure):** golden set + CI harness. Gate: no tooling swap ships before this exists.

**Sprint 3 (OCR path):** per-page routing, 300 DPI + `image_to_data`, RapidOCR flag, img2table for scanned grids — all scored against the golden set.

**Sprint 4 (differentiation):** bbox provenance + click-to-highlight review UI; gmft/Camelot-ml trial for borderless digital tables; dual-extraction agreement gating; AI echo-quotes.

Rule of thumb the research kept reinforcing: your regex pipeline's determinism and exact content-stream digits are assets, not debt. Spend effort on **verification layers around it** (validators, golden set, provenance, agreement) before spending on smarter extraction.

---

## Key sources
Licenses verified verbatim: [Marker MODEL_LICENSE](https://github.com/datalab-to/marker/blob/master/MODEL_LICENSE) · [Surya MODEL_LICENSE](https://github.com/datalab-to/surya/blob/master/MODEL_LICENSE) · [MinerU LICENSE](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md) · [Docling MIT](https://github.com/docling-project/docling/blob/main/LICENSE) · [PyMuPDF AGPL discussion](https://github.com/pymupdf/PyMuPDF/discussions/971)
Tooling: [RapidOCR](https://github.com/RapidAI/RapidOCR) · [PP-OCRv5 official CPU benchmarks](http://www.paddleocr.ai/main/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html) · [PP-OCRv6 paper](https://arxiv.org/abs/2606.13108) · [img2table](https://github.com/xavctn/img2table) · [gmft](https://github.com/conjuncts/gmft) · [camelot-py 2.0](https://pypi.org/project/camelot-py/) · [Docling tech report (CPU timings)](https://arxiv.org/html/2408.09869v4) · [OmniDocBench](https://github.com/opendatalab/OmniDocBench) · [Tesseract 5.5.2](https://github.com/tesseract-ocr/tesseract/releases)
Practices: [Tesseract ImproveQuality (300 DPI, PSM, whitelist)](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html) · [Structured Output Benchmark — schema ≠ value accuracy](https://arxiv.org/pdf/2604.25359) · [VLM empty-cell confabulation](https://arxiv.org/pdf/2406.00257) · [UNIKIE-BENCH digit confusion](https://arxiv.org/pdf/2602.07038) · [quote/token-alignment verification](https://www.biorxiv.org/content/10.64898/2026.02.06.704502v2.full) · [Reducto per-field citations](https://docs.reducto.ai/v/legacy/extraction/citations) · [double-key entry ~8× error reduction](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0035087) · [react-pdf-highlighter](https://github.com/agentcooper/react-pdf-highlighter)
Domain rules: [NETA MTS 50%-of-lowest wording](https://forum.testguy.net/threads/5985-Interpreting-DLRO-Results) · [IEEE 43 PI/temp correction](https://www.ecmweb.com/content/article/20886204/a-review-of-polarization-index-and-ieee-std-43-2000) · [IEEE C57.104 DGA limits + 2019 changes](https://powerprognosis.com/ieee-c57-104-2019-vs-2008-what-changed-why-it-matters-for-transformer-dga/)
Data policy: [Gemini API terms (unpaid tier trains on data)](https://ai.google.dev/gemini-api/terms) · [Groq data policy](https://console.groq.com/docs/your-data)


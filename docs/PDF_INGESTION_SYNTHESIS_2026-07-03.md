# PDF Ingestion Stack — Synthesis & Decision

**Date:** 2026-07-03
**Inputs:** `PDF_INGESTION_REVIEW_2026-07-03.md` (deep, code-grounded review — "the deep review") + a five-model panel (deepseek, copilot, chatgpt, perplexity, gemini) in `5.28.issues.txt` ("the panel")
**Method:** reconcile the two, then verify every actionable claim against the live tree (`server/pyextract/extractor.py`, `server/lib/{testReportParse,ingestConfidenceGate,aiTestReportExtract,testReportPreview,measurementSanity}.ts`)
**Bottom line:** The deep review's call is correct and should be executed roughly as written. The panel is useful as *corroboration of the architecture*, not as a shopping list — its specific tool picks are systematically wrong for a company being built to be acquired. One live-code finding is more severe than either review states.

---

## 1. The one-paragraph answer

Yes, upgrade — but not by swapping the extractor. Five independent models that could not see your code, plus the one review that could, all converge on the same architectural spine: **the accuracy wins are in the verification layers around the parser (domain validators, provenance, cross-pass consensus, a golden-set harness), not in a smarter parser.** Where the panel and the deep review diverge, the panel is wrong *for your constraints* — three of five panelists recommended Datalab tools (Surya/Marker) that carry a commercial-use license cap and a non-compete that a PE/OEM acquirer breaches on day one, and three recommended self-hosted VLMs that hallucinate digits on GPUs you don't run. Follow the deep review's tool filter (adopt RapidOCR; trial img2table/gmft/Camelot; hard-avoid the license bombs), fix the two P0 gate bugs first, and add the completeness/silent-empty guard the code review below surfaces.

---

## 2. What the live code confirms (and one correction)

I verified the deep review's file:line claims against the current tree. Result: its **substantive findings are real**, but its **OCR section describes code that isn't there** — and the truth is worse.

**Confirmed, still unfixed:**

| Finding | Evidence in live code | Status |
|---|---|---|
| **P0-1 — AI readings bypass the confidence gate** | `aiTestReportExtract.ts:178` → `confidence: 'ai'` (a string). `ingestConfidenceGate.ts:93` keeps `typeof m.confidence === 'number' ? … : null`, then `:94` `continue`s on null. AI readings are never counted below threshold. | **Real** |
| **P0-2 — AI critical readings persist with no measurement-level sign-off** | `testReportPreview.ts:153/155` dedup key = `` `${measurementType}|${phase}|${asFoundValue}` `` — source not in the key, no "pending review" state. A second vision pass (`:185`) merges the same way. The gate *does* force review for AI-filled **identity** fields (`ingestConfidenceGate.ts:12-14`, serial) — but **not** for AI-filled **critical measurements**. | **Real** |
| **P1-5 — censored readings vanish** | `extractor.py:262` `_INLINE_RE` requires a numeric group; `OL`, `INF`, `>10,000`, `N/A` produce no match → asset looks untested. | **Real** |
| **P1-7 — provenance computed then thrown away** | `_off` char offset is built (`extractor.py:367,453`) but no page/bbox is attached and `_off` is dropped before persistence. | **Real** |
| **Kept strengths are accurate** | `measurementSanity.ts` has physical bounds (insulation 0–1e7, contact 0–5e5, winding 0–1e6, …), IEEE-43 PI floor logic (PI < 1.0 = impossible), deterministic-first with AI strictly secondary. | **Good — keep** |

**Correction — the OCR finding, and a bigger production reality (verified 2026-07-03, this is the corrected version).** An earlier draft of this doc claimed `extractor.py` had "no OCR code at all." That was wrong — it came from a **stale copy of the file** on the Linux mount (594 lines; the house rules warn the mount serves stale copies of session-modified files). The authoritative Windows copy is **770 lines and the OCR path is exactly as the deep review described**: `_ocr_text()` (line 687) renders with `pypdfium2` at `scale=2.0` (~144 DPI) and runs `pytesseract.image_to_string` (line 701), capped at `OCR_PAGES = 3` (line 684); `has_text_layer()` (line 49) samples only `pdf.pages[:3]` per-document; OCR readings are confidence-capped at 0.5. The deep review's P0-3/P1-6 OCR findings are **all valid**.

**But the bigger finding supersedes the OCR one: in production, none of this Python extractor runs at all.** `server/Dockerfile` (node:20-alpine — the image `docker-compose.yml` builds for the demo) has the Python install **commented out** (lines 63-67: *"Python extractor is DISABLED on Alpine (pypdfium2 has no musl wheel). Ingest falls back to the pdfjs parser automatically. Re-enable by switching to node:20-slim (Debian)…"*). Alpine ships no `python3`/`tesseract` in the runtime stage, so `runDeterministic` fails and prod ingest runs the **pdfjs TS text parser + AI gap-fill** — the 770-line pdfplumber/PowerDB/OCR extractor everyone (both reviews, the recent commits) has been polishing is **dead code in the demo**. This is an acquisition-diligence landmine: the extraction quality shown in the demo is the weaker pdfjs+AI path, not the sophisticated path being showcased.

**Implications that reshape the roadmap:**
- The AI gap-fill is the **primary production extraction path**, so the P0 gate fixes (numeric AI confidence, AI-critical HITL routing, silent-empty + cross-pass guards, domain validators) harden *exactly* what runs in prod — higher value than first thought. **These shipped this session.**
- The single highest-leverage accuracy move is not RapidOCR — it's **switching the server base image to node:20-slim (Debian) so the pdfplumber extractor and Tesseract OCR run in prod at all.** That's a deploy-risk base-image change (do it deliberately, not overnight), and it's the precondition for any OCR improvement.
- RapidOCR remains the right OCR *engine* upgrade, but it's gated behind (a) the Debian switch and (b) the golden-set eval — and note `onnxruntime` (RapidOCR's runtime) also has no musl wheel, so it needs the Debian image too.
- The silent-empty guard shipped this session matters even more, because prod's pdfjs path yields near-nothing on scans and must never pass that as "clean."

---

## 3. Where all reviewers agree (highest-confidence signal — do these)

Five models with no code access and the one code-grounded review independently landed on the same list. That convergence is the strongest signal in the whole exercise. Every one of these is in the deep review; the panel corroborates.

1. **Domain / physics validation** (deepseek, chatgpt, gemini, perplexity + deep review's #1). Confidence can't catch a value that OCR'd *cleanly wrong*; physics can. Peer/pole balance (NETA MTS §7.6.1.2 "±50% of the lowest value" — this rule alone catches the 4.2→42 class), PI/DAR recompute, TDCG checksum, gas plausibility, temp-correction recompute, and the report's own PASS/FAIL as a cross-check.
2. **Per-measurement provenance / bounding boxes** (near-unanimous — copilot, chatgpt, perplexity, gemini + deep review #6). Page, bbox, extraction pass, raw snippet per value. Converts HITL from "re-read the PDF" to "one glance," and it's a diligence/defensibility artifact.
3. **Golden-set / regression corpus** (chatgpt, perplexity + deep review #3). 30–50 labeled reports, per-field precision/recall in CI. **Gates everything** — no tooling swap ships without it.
4. **Cross-pass consensus / disagreement → review** (chatgpt, perplexity, deepseek, gemini + deep review #7). Two passes disagreeing on the same measurement is the strongest misread signal you have and it's currently discarded.
5. **Per-page / mixed-content routing** (deepseek, perplexity, chatgpt + deep review #4). Decide text-vs-OCR per page, not per document; detect garbled/CID text layers instead of counting characters.
6. **Better OCR via the PaddleOCR family** (panel says "PaddleOCR/Surya"; deep review says **RapidOCR**). These are the *same recommendation* once you apply the license filter — RapidOCR is PaddleOCR's PP-OCR models shipped as Apache-2.0 ONNX, CPU-only, no torch/paddle.
7. **Rethink confidence** (chatgpt's explainable additive breakdown + deep review's "calibrate against the golden set, stop hardcoding 0.85/0.9").

---

## 4. Where the panel is wrong for ServiceCycle (the deep review overrides — here's why)

The panel didn't know your constraints: **$0, permissively licensed, CPU-only, no generative model ever types a number into the DB, and every dependency must survive an acquirer's license scan.** With those in view, its headline picks invert.

| Panel recommendation | Who pushed it | Why it's wrong here (verified) | Verdict |
|---|---|---|---|
| **Surya / Marker / Chandra (Datalab)** | deepseek, perplexity, gemini (**3 of 5**) | Weights under modified OpenRAIL-M: commercial use barred above **$2M revenue/funding** **plus a Datalab non-compete that applies at any size**; Marker code is GPL-3.0. A PE/OEM acquirer breaches the cap instantly. Also GPU. | **Reject — acquisition poison** |
| **PyMuPDF as primary parser** | chatgpt ("best free upgrade") | AGPL-3.0 — the textbook server-side diligence red flag. (The *idea* — use word/span/bbox geometry, not raw text — is right and pdfplumber already gives you word boxes.) | **Reject the tool, keep the idea** |
| **Self-hosted VLMs typing values** (Qwen2-VL, Llama-3.2-Vision, Florence-2, LightOnOCR-2, dots.ocr, GOT-OCR2) | deepseek, copilot, gemini | GPU-class, and generative decoding **confabulates empty cells and swaps digits** (4.32↔2.32) — the exact catastrophic failure mode for safety measurements. Violates the core invariant below. Florence-2 is CPU-small but still generative for the numbers. | **Reject for the numeric path** |
| **Docling as the primary parser** | copilot, perplexity | MIT (fine) but heavy (~2–6 s/table CPU), a full pipeline you don't need, with known dense-numeric-column merge bugs. | **Demote — trial-only fallback** |
| **"Fail closed" globally** | deepseek, gemini | Keep fail-**open** as architecture (a parse error shouldn't nuke a whole import). But the panel's instinct points at a real narrower gap — see §5.1. | **Refine, don't adopt wholesale** |
| **"70–80% → 95%+", "HITL −50–60%"** | copilot | Unsourced; several cited sources (Nature 2026 DOIs, LightOnOCR/SPARTAN links) are unverifiable or look fabricated. The deep review verified its sources verbatim; the panel did not. | **Treat panel numbers as directional only** |

**The invariant to write down and enforce (from the deep review, reinforced by every VLM failure the panel ignored):** *structure and layout models decide **geometry only**; numeric values enter the database solely from the PDF content stream or raw OCR tokens, always with bbox provenance. No generative model ever writes a number.*

---

## 5. Genuinely new ideas the panel adds (fold these into the deep review's plan)

The panel isn't only wrong tools — it surfaces a few things the deep review under-weighted:

### 5.1 Silent **recall** failure — the biggest addition
gemini, deepseek, and chatgpt all flag it: the `_powerdb_grids` regex state machine (`extractor.py:456`) fails **silently** when PowerDB changes format — no measurement is generated, so a report full of failures *looks clean*. The deep review is strong on misreads (wrong values) but thinner on **coverage** (missing values). Two cheap defenses, neither currently present:

- **Completeness check:** for a given asset class, an expected set of measurement types is known (a transformer report should contain insulation resistance). If the expected type is absent from the extraction, flag the report **incomplete** and block auto-accept. (This is the *good* version of the panel's "fail closed.")
- **Silent-empty guard:** if `has_text_layer` is false **or** measurements ≈ 0, route to review as "unreadable / needs OCR" — never auto-accept an empty parse. This directly closes the no-OCR hole from §2.

### 5.2 OCR consensus (once OCR exists)
chatgpt/gemini: don't *replace* the text layer with OCR — extract both and reconcile at the token level. The text layer holds the true digits when fonts render wrong (µ→m, Ω→?); OCR holds them when the text layer is CID-polluted. Extends the deep review's cross-pass reconciliation to text-vs-OCR.

### 5.3 Candidate-object intermediate representation
chatgpt's cleanest architectural point: separate **extraction** (emit candidates with bbox/table/label/raw) from **interpretation** (`resolveMeasurement` over all candidates). This is the structure that makes provenance, consensus, and validation natural rather than bolted-on — the target shape for the refactor, and it demos as "commercial-grade doc AI."

### 5.4 Explainable confidence + trend/history sanity
chatgpt's additive confidence panel (`+text layer / +OCR agreement / +known layout / −low DPI`) is a strong HITL and acquisition-demo layer over the deep review's "calibrate." deepseek/chatgpt's trend check (a breaker jumping 20µΩ→120µΩ vs its prior test escalates regardless of confidence) is a legitimate misread/fault signal — internally consistent, so it respects the PPE-liability posture (flag for review, never assert pass/fail).

### 5.5 Infra enabler (not accuracy, but a prerequisite)
gemini's FastAPI-microservice-vs-`execFile` point: today you pay Python cold-start per document. That's fine now, but the moment you load RapidOCR/img2table you don't want to cold-start models per doc, and cold-start timeouts under bulk upload → fail-open → silent data loss (an indirect accuracy hit). Keep in the back pocket for Sprint 3+.

---

## 6. The unified roadmap

The deep review's sequencing is right. This is that sequence with the panel's additions folded in and the code-grounded reframe applied.

**Sprint 1 — pure code, no new deps (~1 week; ~most of the safety value)**
- Fix **P0-1**: make AI confidence numeric (or teach the gate about string sources).
- Fix **P0-2**: `source:'ai'` + `critical:true` ⇒ mandatory human attestation before it can create a deficiency or move pass/fail. (Reuse the Phase-3 provenance-enum + attestation machinery — this is wiring, not building.)
- **Domain validators** (peer/pole ±50%, PI/DAR recompute, TDCG checksum, gas plausibility, temp-correction, report-verdict cross-check). *[deep #1 + panel consensus]*
- **Censored-reading grammar** (`OL`/`INF`/`>N`/`<N`/`N/A` → `{value:null, qualifier, bound}`). *[deep #5]*
- **Cross-pass disagreement flag**. *[deep #7 + panel consensus]*
- **NEW — completeness check** (expected-but-missing measurement type ⇒ incomplete). *[§5.1]*
- **NEW — silent-empty guard** (scanned/empty ⇒ review, never auto-accept). *[§2 + §5.1]*

**Sprint 2 — measurement infrastructure (~2–3 days)**
- **Golden-set eval harness in CI** (30–50 labeled reports; per-field precision/recall). Hard gate: no OCR/table swap ships before this exists. Doubles as a diligence artifact. *[deep #3 + panel consensus]*

**Sprint 3 — introduce the OCR path (~3–5 days; this is new capability, not a swap)**
- **Per-page routing** + garble detection (CID/replacement-char ratio, not char count). *[deep #4 + panel]*
- **Adopt RapidOCR** (Apache-2.0, PP-OCR ONNX, CPU) as the scan engine — the license-clean version of the panel's "PaddleOCR/Surya." Pair with **img2table** (MIT) for ruled scanned grids. Render 300 DPI, binarize/deskew, use `image_to_data` for per-word confidence + bbox. A/B against the golden set's scanned subset. *[deep adopt list + panel convergence]*
- **OCR consensus** where both text and OCR exist. *[§5.2]*
- Move Gemini off the unpaid tier (diligence — unpaid tier trains on customer data). *[deep P2-10]*

**Sprint 4 — differentiation & demo polish (~1–2 weeks)**
- **Bbox provenance end-to-end + click-to-highlight HITL** (react-pdf-highlighter, MIT) — the acquisition-demo centerpiece; every reviewer asked for it. *[deep #6 + unanimous panel]*
- **Candidate-object IR + `resolveMeasurement`** separation. *[§5.3]*
- **Explainable confidence** decomposition in the review UI. *[§5.4]*
- **Trial gmft (MIT) or Camelot-ml (MIT)** for borderless digital tables — geometry only, text from PDF tokens; pick one, not both. *[deep trial]*
- **Dual-extraction agreement gating + AI echo-quote verification** (require a verbatim source snippet; no verified quote ⇒ no value). *[deep #7/#8]*
- **Layout/template fingerprint classifier** → specialized parsers; **trend/history sanity**. *[§5.1, §5.4]*

---

## 7. Hard-avoid list (state it so nobody re-proposes it)

- **Marker / Surya / Chandra (Datalab)** — OpenRAIL commercial cap ($2M) + Datalab non-compete at any size + GPL code. Acquisition-poison. *(3 of 5 panelists recommended this — do not.)*
- **PyMuPDF / pymupdf4llm** — AGPL-3.0 server-side diligence red flag.
- **MinerU** — Apache-plus-conditions attribution requirement + needs a GPU.
- **Self-hosted VLMs that emit values** (Qwen2-VL, Llama-3.2-Vision, Florence-2, LightOnOCR-2, dots.ocr, GOT-OCR2) — GPU + generative digit hallucination; violates the §4 invariant.
- **Docling as primary** — trial-only fallback if gmft/Camelot underperform; if used, RapidOCR backend + `do_cell_matching`.

---

## 8. The strategic read

The value of running five extra models wasn't the tools — it was the **triangulation**. Five systems that couldn't see your code independently reached the deep review's architecture (validators, provenance, consensus, golden set), which means that direction is robust, not an artifact of one reviewer. But the same exercise is a live demonstration of why generic AI advice is dangerous for a business built to be sold: the majority recommended a license bomb and a hallucination risk with total confidence and unverifiable citations. The deep review's discipline — verifying licenses verbatim, refusing generative numbers, staying CPU/$0 — is exactly the discipline the acquisition thesis depends on. **Adopt the panel's themes; reject its shopping list; execute the deep review.**

The most important single fix isn't on anyone's headline list: **there is no working OCR, and scanned reports fail silently.** Sprint 1's silent-empty guard stops the bleeding this week; Sprint 3's RapidOCR path fixes it properly.

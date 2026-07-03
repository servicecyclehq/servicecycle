# Ingestion accuracy — next-session prompt (revised 2026-07-03)

This supersedes the earlier "Fix the P0s + build the golden-set" prompt. Much of that prompt shipped in the 2026-07-03 hardening session (see `docs/PDF_INGESTION_SYNTHESIS_2026-07-03.md`, `docs/EVAL_BASELINE_2026-07.md`, memory `servicecycle-ingestion-hardening-2026-07-03`). Corrections from that session are folded in below so the next session doesn't repeat resolved work or chase a wrong finding.

Repo: `C:\Users\ddeni\Desktop\ServiceCycle` (work ONLY in this repo). Read `docs/PDF_INGESTION_REVIEW_2026-07-03.md` and `docs/PDF_INGESTION_SYNTHESIS_2026-07-03.md` first. Load the `engineering-guidelines` skill before touching route/lib files. `git log/status` first — build on current HEAD.

## Already shipped (do NOT redo)
- **P0-1** AI readings now carry a numeric confidence (`AI_READING_CONFIDENCE = 0.5`, `aiTestReportExtract.ts`); the gate REJECTS non-numeric confidence loudly instead of skipping (`ingestConfidenceGate.ts`).
- **P0-2** AI-sourced CRITICAL readings force review regardless of threshold; the AI + vision merge passes share one `mergeExtractedMeasurements` helper whose dedup key includes source, with cross-pass disagreement flagging (`testReportPreview.ts`).
- **Guards** silent-empty (0 readings ⇒ review, never a clean no-op) + low-coverage-scan + truncation + cross-pass, all in the gate. `extractor.py` now returns `text_pages` (per-page text signal) threaded through `run.py` → preview.
- **Part 2** `server/lib/domainValidators.ts` (pole balance, C2H2, TDCG, PI recompute, verdict cross-check, completeness), internal-consistency posture, wired into the gate. 15 tests in `tests/ingestGateDomainValidators.test.js` (green).
- **Part 3** `server/scripts/eval_extraction.py` golden-set harness + `docs/EVAL_BASELINE_2026-07.md`.

## THE correction that reshapes priorities (verified)
**The Python extractor is DISABLED in production.** `server/Dockerfile` (node:20-alpine, what `docker-compose.yml` builds) comments out the python/tesseract install (`pypdfium2` has no musl wheel), so prod ingest runs the **pdfjs TS parser + AI gap-fill** — the 770-line pdfplumber/PowerDB/OCR `extractor.py` is dev/eval-only. (An earlier note that "there is no OCR code" was from a STALE Linux-mount copy; the OCR path exists — `_ocr_text`, `OCR_PAGES=3`, `pytesseract` — but is inert on Alpine. Always verify `extractor.py` on the WINDOWS side; the mount serves a stale 594-line copy.)

## Remaining work, priority order
1. **Base-image switch to node:20-slim (Debian)** so the pdfplumber extractor + Tesseract OCR actually run in prod. Highest-leverage accuracy move. Deploy-risk change — do it deliberately with a full smoke test, NOT in an unattended session. `onnxruntime` (RapidOCR) also needs Debian.
2. **Deterministic parser gaps** (pure regex/geometry, no deps; eval-gated): DGA-table parsing (`HYDROGEN (H2) 1240` ⇒ `dissolved_gas`), Polarization Index (`POLARIZATION INDEX (H-G): 2.31`), power-factor consistency, and suppress nameplate noise (voltages / %impedance / %RH becoming `voltage_reading`/`percent_reading`). Baseline parser recall is ~19% clean / 12% partial / 5% garbled — move these numbers on the golden set.
3. **Censored readings** (`OL`, `INF`, `>N`, `N/A`) grammar in `_INLINE_RE` (review P1-5, still open).
4. **Bbox provenance + click-to-highlight review UI** (review #6; demo/diligence centerpiece).
5. **RapidOCR** (Apache-2.0, CPU) behind the eval + Debian switch. Do NOT introduce Marker/Surya/PyMuPDF/MinerU/self-hosted VLMs (license/hallucination — see synthesis §4/§7).
6. **Temp-correction validator** (deferred in `domainValidators.ts` — needs temperature threaded through the extractor).
7. **Wire the report's own PASS/FAIL into `preview.meta.reportResult`** so the verdict cross-check validator activates (currently no-ops because the preview doesn't surface it).
8. **Part 4 stretch** (never started): AFX tool-picker client UI; IBI installDate staggering in the seed.

## House rules (unchanged, non-negotiable)
- Verify on the WINDOWS side via `run_powershell` (Linux mount serves stale copies of session-modified files — this bit us this session). `npm run build` (tsc) + `jest` from `server/` with `TZ=UTC`.
- Big files: targeted unique-anchor edits; verify line count + zero NUL bytes; ASCII for Python/bash heredocs.
- Tests: mock prisma/ai for pure-lib suites (see `tests/ingestGateDomainValidators.test.js`). Local full run has ~142 env-dependent failures — diff against baseline, don't chase.
- Tenancy: every prisma query filters `accountId`. No computed PPE categories (liability posture). Domain validators are internal-consistency ONLY — never assert compliance or auto-correct.
- Targeted `git add <files>` only (the working tree has many untracked personal docs — never `git add -A`).
- Deploy via the ServiceCycle vps-control MCP per the `sc-deploy` skill; health check port 3002. Reseed only if seed changed; client deploy only if client changed. GitHub Actions is disabled (manual deploys).

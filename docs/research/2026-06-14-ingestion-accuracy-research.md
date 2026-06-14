# Improving Ingestion Accuracy Without Real Customer Reports â€” Research Synthesis

**Date:** 2026-06-14. Five parallel research agents (synthetic data; OSS extraction/OCR; table extraction + datasets; eval/calibration; domain-specific electrical formats) + connector/plugin/skill registry check. ServiceCycle context: deterministic Python + OCR + optional BYO-key LLM extracting tabular readings from electrical test-report PDFs/photos; ~zero labeled corpus; 1GB prod VM (offline training/eval on a bigger box is fine).

## Three strategic reframes (the headline)
1. **You may not need to parse PDFs for many sources.** PowerDB stores results in SQL Server + has an official CMMS export; Doble uses .dtax files + a Database API; CMMS/EAM (Maximo/Fiix/UpKeep/eMaint) have REST APIs/CSV. Treat STRUCTURED import as Tier 1 and PDF/OCR as the Tier-2 long-tail fallback.
2. **Your commit-time corrections ARE your ground-truth corpus.** Each human field-correction we already capture (#4) is a labeled (predicted, fixed) pair on a real doc â€” simultaneously your golden corpus, calibration labels, active-learning oracle, and drift monitor. Highest-ROI first move: a regression harness that replays them.
3. **You can manufacture a labeled corpus today.** Render report PDFs from structured data (the data IS the label) using real industry form layouts + NETA/IEEE tolerance tables, then degrade them to simulate scans/photos. No real reports required.

## Track 1 â€” Structured import (sidesteps parsing entirely)
- **PowerDB**: SQL Server / MS JET backend (queryable rows, not just PDF); official CMMS integration (pushes to SAP/Maximo; IBM partner). If a prospect runs PowerDB, read the DB/export, not the printout. http://www.powerdb.com (Forms Library: http://www.powerdb.com/PdbWebPxd/PdbForms.aspx ; PowerDB Lite free)
- **Doble**: .dtax files + Doble Database API. https://www.doble.com/product/doble-database/
- **CMMS/EAM REST APIs**: IBM Maximo (REST/JSON, CSV import), Fiix (REST, examples repo), UpKeep (REST, token auth), eMaint/Fluke (API connector). Accept these directly for the maintenance side.
- *Action:* build a generic structured-import path (CSV/JSON mapping UI) before over-investing in OCR; partner-ingest from PowerDB/Doble where customers already have it.

## Track 2 â€” Synthetic labeled corpus (buildable now, OSS)
- **Generate** (the data IS the label): Pydantic report schema -> NumPy sampler that draws physically-plausible readings against real NFPA 70B / IEEE 43 / NETA ATS-MTS tolerance tables (so pass/fail is self-consistent) -> render PDFs via WeasyPrint+Jinja (BSD) / ReportLab (BSD) / fill real PowerDB AcroForm PDFs (pypdf, BSD); emit matched JSON ground truth in the same loop. Faker (MIT) for metadata variety.
- **Real form layouts to target/seed**: PowerDB Forms Library + PowerDB Lite (free renders); NETA Test Report Guide (free PDF: https://s3.amazonaws.com/NETA-MP/Current-Policies/NETA+-+Test+Report+Guide.pdf); ATS/MTS tolerance tables; sample reports (Doble DTA brochure, Vertiv, study guides).
- **Degrade to simulate scans/photos** (where accuracy is actually won): **Augraphy** (MIT â€” top pick: ink bleed, photocopy, lighting, JPEG) + **Albumentations** (MIT â€” rotation/skew/perspective/blur) + OpenCV for glare/shadow; carry the unchanged JSON label forward. synthtiger/DocCreator/SynthDoG for more.
- **LLM use**: only to vary wording/layout AROUND fixed numbers (generate JSON first deterministically, then prose) â€” LLM numeric tables drift.

## Track 3 â€” Eval harness + confidence without labels
- **Harness/metrics**: pin (PDF, corrected JSON) fixtures; field-level P/R/F1 with normalized edit distance via **RapidFuzz** (MIT); table structure via **TEDS** + **GriTS** (the standard table metrics). Run as a regression gate on every parser/prompt change.
- **Free confidence now**: **self-consistency** â€” run the LLM extract N times (temp>0); fields that agree -> auto-accept, disagree -> review. Zero new infra.
- **Weak supervision**: **Snorkel** (Apache) labeling functions encoding domain sanity rules (IR in MÎ© range, test date <= report date, unit consistency, cross-phase plausibility) to validate/flag extractions with no ground truth.
- **Calibration**: **netcal** / sklearn isotonic once a few hundred corrections accumulate -> empirical auto-accept threshold from a reliability curve.
- **Drift**: cheapest first â€” track human-correction-rate per field over time (free, from the corrections stream); add **NannyML/Evidently** (Apache) later (NannyML estimates quality WITHOUT labels).

## Track 4 â€” OSS extraction engines (adopt selectively)
- **Prod path (1GB VM, all MIT/Apache/MPL):** OCRmyPDF (Tesseract) for scans -> **pdfplumber** (MIT) char-level table geometry -> BYO-key LLM only for stubborn cells. Optional: PaddleOCR **PP-OCRv5 mobile** (Apache) for better digits if you can spare ~1.5-2GB (benchmark first).
- **Offline path (bigger box) for ground-truth/eval/hard scans:** **Docling** (MIT; ~97.9% table cell accuracy in an independent benchmark) as primary; **PaddleOCR PP-StructureV3** (Apache, near-Gemini table accuracy); **Table Transformer / TATR** (MIT, ~29M params) via **GMFT** for borderless tables; **Donut** (MIT) to fine-tune a per-template extractor once you have labels.
- **LICENSE LANDMINES (avoid shipping):** PyMuPDF = AGPL (audit our current use! prefer pdfplumber or buy commercial); Marker/Surya = free only under $5M revenue AND $5M funding; Nougat = CC-BY-NC; LayoutLMv2/v3 = CC-BY-NC. Stick to MIT/Apache.

## Datasets to benchmark against (no real reports needed)
- **FinTabNet** (CDLA-Permissive) â€” dense borderless NUMERIC tables; the closest public stylistic proxy to test reports. Primary borderless stress test.
- **PubTables-1M** (CDLA-Permissive) â€” the accuracy ceiling for TATR; clean dense tables.
- **CORD** (CC-BY-4.0, commercial-OK) â€” receipts w/ line items (repeated-row structure).
- **DocLayNet** (CDLA-Permissive) â€” layout/table detection.
- Eval-ONLY (research licenses, do not train shipped models): FUNSD, SROIE, DocVQA, RVL-CDIP, ICDAR, SciTSR.
- GAP (confirmed): no public labeled electrical/inspection-report table corpus exists. -> synthetic + a small hand-labeled gold set of real reports for final eval.

## Marketplace / connector / plugin / skill check
Nothing turnkey: the MCP connector registry, the plugin catalog, and the skills catalog returned no document-extraction / OCR / table-extraction option. This is OSS + own-data work, not an install.

## Recommended build order (no real reports, mostly offline)
1. **Eval harness** that replays captured corrections + scores field-F1/TEDS â€” turns data we already have into a regression gate. (Highest ROI.)
2. **Synthetic generator** (schema -> tolerance-aware sampler -> WeasyPrint/AcroForm render -> Augraphy degrade -> matched JSON). Gives a labeled corpus + a scan-robustness eval split.
3. **Free confidence**: multi-pass self-consistency + correction-rate drift monitor.
4. **Structured-import path** (PowerDB DB / Doble dtax / CMMS CSV-JSON) â€” sidesteps parsing for real customers; also de-risks the data-in moat question.
5. Later, as warranted: Snorkel sanity LFs, calibration (netcal), and an offline Docling/PaddleOCR/TATR pipeline for hard scans + a fine-tuned Donut per template.
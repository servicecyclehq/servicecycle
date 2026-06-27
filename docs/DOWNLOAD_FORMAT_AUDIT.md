# Download Format Audit — ServiceCycle

**Scope:** Every downloadable artifact the app produces (client-triggered saves + server attachment responses). READ-ONLY audit; no code changed.
**Audience model:** Primary users are facility managers, plant engineers, NETA techs; buyer-facing recipients are insurers, AHJ/auditors, executives, and (for a few endpoints) other software systems. Humans want PDF (documents/labels/leave-behinds/insurer-auditor-exec reports) and CSV/XLSX (tabular data). JSON is defensible ONLY as a machine-readable interchange.

Total downloadable artifacts: **28**.

---

## Artifact table

| # | Artifact (what user thinks they get) | Trigger (client file:line / UI) | Endpoint | Generator (file:line) | Current format | Audience | Verdict | Recommended |
|---|---|---|---|---|---|---|---|---|
| 1 | **Arc-flash label PDF** (single, 4×6 NFPA 70E) | `ArcFlashAssetTab.jsx:204` "Label PDF" btn | `GET /api/arc-flash/asset/:id/label.pdf` | `arcFlashIngest.ts:2299` streamLabelPdf | PDF | Facility / field | Correct | PDF ✓ |
| 2 | **Arc-flash fleet rollup** (per-site DANGER/confidence/incidents) | `ArcFlashFleet.jsx:58` "Export rollup (CSV)" | `GET /api/arc-flash/fleet?format=csv` | `arcFlashIngest.ts:1024` | CSV | Facility / exec | Correct | CSV ✓ |
| 3 | **Arc-flash labels (bulk PDF)** (one bus/page) | `ArcFlashFleet.jsx:59` "Labels (PDF)" | `GET /api/arc-flash/labels.pdf` | `arcFlashIngest.ts:2300` streamLabelPdf | PDF | Facility / field | Correct | PDF ✓ |
| 4 | **AFX import template** (per-tool CSV) | `ArcFlashFleet.jsx:395,402` "Download template" | `GET /api/arc-flash/afx/template?tool=` | `arcFlashIngest.ts:1904` | CSV | Another system (study tool ingest) | Correct | CSV ✓ |
| 5 | **AFX multi-table export** (related tables, README sheet) | `ArcFlashFleet.jsx:414` | `GET /api/arc-flash/afx/export-multi?tool=` | `arcFlashIngest.ts:1957` ExcelJS | XLSX | Another system (study tool) | Correct | XLSX ✓ |
| 6 | **AFX model CSV** (current arc-flash model dump) | `ArcFlashFleet.jsx:36-39` blob | `GET …/afx model csv route` | `arcFlashIngest.ts:1871` | CSV | Another system | Correct | CSV ✓ |
| 7 | **AFX open-data spec** (`afx-spec-v#.json`) | `ArcFlashFleet.jsx:310-317` blob | `GET /api/arc-flash/afx/spec` | `arcFlashIngest.ts` (spec obj) | JSON | Another system (open-data interchange) | Correct (KEEP) | JSON ✓ |
| 8 | **Arc-flash Audit / insurer bundle** | `ArcFlashFleet.jsx:787-795` "download" blob | `GET /api/arc-flash/audit-bundle` (`res.json`) | `arcFlashIngest.ts:1582` (returns 1685) | **JSON** | **Insurer / AHJ / exec** | **WRONG** — human deliverable shipped as JSON | **PDF** (scorecard + punch list + incidents) |
| 9 | **EMP document (one-click)** (NFPA 70B 4.2 program) | `ReportsHub.jsx:154` EMP card | `GET /api/reports/emp?months=` | `reports.ts:45` → `empDocument.ts` renderEmpPdf | PDF | Auditor / exec | Correct | PDF ✓ |
| 10 | **EMP document (anchored snapshot)** | `AuditReadyBanner.jsx:34-41`; `AuditSnapshotsPage.jsx:142` | `POST /api/compliance/emp-document` → `GET /snapshots/:id/download` | `compliance.ts:562` (download); empDocument render | PDF | Auditor / exec | Correct | PDF ✓ |
| 11 | **Full account export (portable backup)** | `ReportsHub.jsx:171` "Export everything" | `GET /api/export/account?format=json` | `export.ts:318` | **JSON** | **Another system / portability (no-lock-in)** | Correct (KEEP) | JSON ✓ |
| 12 | **Asset register export** | `ReportsHub.jsx:186` XLSX card | `GET /api/export/xlsx?view=` | `xlsxExport.ts:139` sendXlsx | XLSX | Facility / exec | Correct | XLSX ✓ |
| 13 | **Assets list export** (filtered) | `AssetsList.jsx:489` "Export" | `GET /api/export/xlsx?view=assets&…` | `xlsxExport.ts:139` | XLSX | Facility | Correct | XLSX ✓ |
| 14 | **CFO report** (quarterly board-grade budget/compliance) | `DigestCadenceSection.jsx:67-71` "Download CFO report" | `GET /api/compliance/cfo-report.pdf` | `cfoReport.ts:188` renderCfoReportPdf | PDF | Exec / CFO | Correct | PDF ✓ |
| 15 | **Maintenance Debt Ledger CSV** (per-site funding plan) | `MaintenanceDebtCard.jsx:53` | `GET /api/compliance/maintenance-debt.csv` | `compliance.ts:193` debtLedgerToCsv | CSV | Exec / CFO | Correct | CSV ✓ |
| 16 | **Compliance-by-standard snapshot PDF** (hash-anchored evidence) | `ComplianceDocsCard.jsx:60`; `ComplianceStandardDetailReport.jsx:124`; `AuditsPage.jsx:517` | `POST /api/compliance/snapshots` → `GET /snapshots/:id/download` | `compliance.ts:562`; render via snapshotPipeline | PDF | Insurer / AHJ / auditor | Correct | PDF ✓ |
| 17 | **Proposal PDF** (priced, contractor-issued) | `ProposalCard.jsx:54`; `FleetDashboard.jsx:101` | `GET /api/proposals/proposal.pdf` | `proposals.ts:153` → `proposalPdf.ts` | PDF | Customer / exec | Correct | PDF ✓ |
| 18 | **Asset labels PDF (QR, bulk)** | `Sidebar.jsx:614` | `GET /api/assets/labels` | `assetLabels.ts:249` | PDF | Facility / field | Correct | PDF ✓ |
| 19 | **Compliance Standard detail CSV** (evidence table) | `ComplianceStandardDetailReport.jsx` export | `GET /api/compliance/…csv` | `compliance.ts:198` | CSV | Auditor | Correct | CSV ✓ |
| 20 | **Leave-behind PDF** (3-section inspection) — office | `WorkOrderDetail.jsx:198-203` "Leave-Behind PDF" | `POST /api/work-orders/:id/leave-behind-pdf` | `leaveBehind.ts:19` → `leaveBehindData` buildLeaveBehindPdf | PDF | Customer / facility | Correct | PDF ✓ |
| 21 | **Leave-behind PDF** — field PWA | `field/FieldAsset.jsx:125-131` | `POST /api/work-orders/:id/leave-behind-pdf` | `leaveBehind.ts:19` | PDF | Customer / facility | Correct | PDF ✓ |
| 22 | **Outage plan export** (XLSX) | `OutagePlannerPage.jsx:180-185` (fmt=xlsx) | `GET /api/outage-planner/plan/export.xlsx` | `outagePlanner.ts:396` sendXlsx | XLSX | Facility / planner | Correct | XLSX ✓ |
| 23 | **Outage plan export** (PDF) | `OutagePlannerPage.jsx:180-185` (fmt=pdf) | `GET /api/outage-planner/plan/export.pdf` | `outagePlanner.ts:404` PDFDocument | PDF | Facility / planner | Correct | PDF ✓ |
| 24 | **Parts import template CSV** | `Parts.jsx:356` "Download template" (`<a download>`) | `GET /api/parts/import/template` | `parts.ts:103` | CSV | Facility (round-trip import) | Correct | CSV ✓ |
| 25 | **Asset import template CSV** (client-generated) | `ImportAssets.jsx:221-233` blob | none (client `new Blob`) | `ImportAssets.jsx:227` | CSV | Facility (round-trip import) | Correct | CSV ✓ |
| 26 | **Account export ZIP** (settings page) | `SettingsPage.jsx:252-256` | `GET /api/settings/export` | `settings.ts:976` archiver | **ZIP (CSV + JSON inside)** | Facility / portability | Mostly OK | ZIP w/ CSV ✓; JSON members defensible (manifest/lossless) |
| 27 | **GDPR user-data export** (DSAR) | `ProfilePage.jsx:273-278` "Export my data" | `GET /api/users/:id/export` | `users.ts:821` | **JSON** | **Data subject (legal/portability)** | Correct (KEEP) | JSON ✓ |
| 28 | **2FA backup codes** (`.txt`) | `ProfilePage.jsx:586-591` blob | none (client `new Blob`) | `ProfilePage.jsx:588` | TXT (text/plain) | Self (the user) | Correct | TXT ✓ |
| 29 | **SIEM audit export** (NDJSON / CEF) | (admin/security feed; no UI download button found — API/admin) | `GET /api/activity/export?format=ndjson\|cef` | `activity.ts:324` | NDJSON / CEF | Another system (Splunk/ArcSight SIEM) | Correct (KEEP) | NDJSON/CEF ✓ |

> Rows 29 is included for completeness (security feed; ingested by SIEM, not a human deliverable). The OpenAPI spec (`openapi.ts:123` `GET /docs/api/openapi.json|.yaml`) is **served for Swagger UI viewing, not a `Content-Disposition` download**, so it is excluded from the 28 count. EMP appears as two artifacts (#9 ephemeral, #10 anchored) sharing one renderer; both are PDF and consistent.

---

## JSON downloads — keep vs convert

Six artifacts currently emit JSON. Verdicts:

| Artifact | Endpoint | Keep or Convert | Why |
|---|---|---|---|
| **Arc-flash Audit / insurer bundle** (#8) | `GET /api/arc-flash/audit-bundle` | **CONVERT → PDF** | This is a human deliverable mis-shipped as JSON. The UI literally labels it "Audit / insurer bundle" and the payload is a posture **scorecard + prioritized punch list + incident list** — exactly what an insurer/AHJ/exec reads, not parses. Inconsistent with every other audit/insurer artifact (snapshots #16, EMP #10, CFO #14) which are PDF. **Highest-priority fix.** |
| **AFX open-data spec** (#7) | `GET /api/arc-flash/afx/spec` | **KEEP (JSON)** | Defensible machine-readable interchange — it is the AFX open-data schema spec consumed by other tooling. |
| **Full account export** (#11) | `GET /api/export/account?format=json` | **KEEP (JSON)** | Lossless portable backup for no-lock-in/portability; consumed by code, not read. |
| **GDPR user-data export** (#27) | `GET /api/users/:id/export` | **KEEP (JSON)** | Legal DSAR / data-portability artifact; structured machine-readable is the right form. |
| **Account export ZIP** (#26) | `GET /api/settings/export` | **KEEP (ZIP; mixed)** | Bundles `assets.csv` (human) + several `*.json` (manifest + lossless dumps). The JSON members are defensible as a portable archive. Optional polish: also include `contractors.csv`/`activity_log.csv` for spreadsheet users. |
| **SIEM audit export** (#29) | `GET /api/activity/export` | **KEEP (NDJSON/CEF)** | Tamper-evident security event feed for Splunk/ArcSight ingestion; NDJSON/CEF are the correct machine formats. |

**Net: 1 convert (audit bundle → PDF), 5 keep.**

---

## Inconsistencies found

1. **Audit/insurer artifacts split across formats.** Compliance snapshots (#16), EMP (#10), and CFO (#14) are PDF; the **arc-flash "Audit / insurer bundle" (#8) is JSON** for the same audience. This is the one real defect: same intent ("hand this to an insurer/AHJ"), different format. Normalize #8 to PDF.
2. **Outage plan** correctly offers both XLSX (#22) and PDF (#23) — good dual-format precedent the audit bundle should follow (offer a PDF; a CSV punch-list could be a secondary export).
3. **Account portability appears in two shapes** — full JSON (#11, ReportsHub) and ZIP-of-CSV+JSON (#26, Settings). Both are defensible but it's two doors to similar functionality; consider consolidating messaging so users don't wonder which "export everything" to use.

---

## Proposed normalized standard

**Rule of thumb — pick format by who reads it and what they do with it:**

- **PDF** — any human-readable *document*: labels, leave-behinds, the EMP program, compliance/audit snapshots, CFO/board reports, proposals, the arc-flash insurer bundle, outage work plans. If a person (facility, exec, insurer, AHJ) is meant to *read* it or *file* it, it is a PDF.
- **CSV** — simple flat tabular data the user will open in Excel/Sheets or round-trip back in as an import: rollups, ledgers, import templates, single-table dumps.
- **XLSX** — tabular data that needs multiple sheets, a README/notes tab, formatting, or large column sets (asset register, AFX multi-table, outage plan spreadsheet).
- **JSON / NDJSON / CEF / YAML** — *only* a defensible machine-to-machine interchange: the AFX open-data spec, the full account backup (portability/no-lock-in), the GDPR DSAR export, the SIEM security feed, the OpenAPI spec. Never ship a JSON file a human is expected to read.
- **ZIP** — bundles of the above (account export); prefer CSV for the human-facing members.
- **TXT** — trivial copy-this-down payloads (2FA backup codes).

**One-line test:** *"Would the recipient open this in a PDF viewer, a spreadsheet, or a parser?"* → PDF / CSV-XLSX / JSON respectively.

---

## Prioritized change list

1. **P1 — Convert the arc-flash "Audit / insurer bundle" (#8) from JSON to PDF.** `GET /api/arc-flash/audit-bundle` (server `arcFlashIngest.ts:1582`) + the client `download()` in `ArcFlashFleet.jsx:787`. Render the posture scorecard + punch list + incident register as a branded PDF (reuse the compliance/EMP pdfkit pattern). Optionally keep a JSON variant behind `?format=json` for machine consumers, but default the button to PDF. *This is the only format that is wrong for its audience.*
2. **P2 — (Optional) Add CSV members to the Settings account-export ZIP (#26)** for `contractors` and `activity_log`, so spreadsheet users aren't handed JSON-only for those sections (`settings.ts:983-988`).
3. **P3 — (Optional) Consolidate the two "export everything" paths** (#11 JSON in Reports vs #26 ZIP in Settings) under clearer labels so users know which is the portable backup vs the spreadsheet-friendly bundle.
4. **No change** — all PDF, CSV, XLSX artifacts (labels, leave-behinds, EMP, CFO, proposals, snapshots, rollups, templates, outage plans, asset register) are already in the right format for their audience. The AFX spec, full account export, GDPR export, and SIEM export are correctly JSON/NDJSON/CEF as machine interchange.

---

## Sample-generation entry points (for producing example files)

### CFO report PDF
- **UI action:** Settings → Digest Cadence section → **"Download CFO report"** button.
- **Client:** `client/src/components/settings/DigestCadenceSection.jsx:64-81` (`downloadCfo()` → `api.get('/api/compliance/cfo-report.pdf', { responseType: 'blob' })`).
- **Endpoint:** `GET /api/compliance/cfo-report.pdf` — `server/routes/compliance.ts:344`.
- **Generator:** `buildCfoReportData(prisma, accountId)` + `renderCfoReportPdf(data, meta)` in `server/lib/cfoReport.ts:45` (data) / `:188` (render). `module.exports` at `:320`.
- **Input needed:** authenticated user (JWT supplies `accountId`); no body/query required. Branding is auto-pulled via `getAccountBranding(accountId)`. Output filename `servicecycle-cfo-report-YYYY-MM-DD.pdf`.

### NETA leave-behind PDF
- **UI action:** Work Order detail → **"Leave-Behind PDF"** button (office), or field PWA asset view → **leave-behind** button.
- **Client:** `client/src/pages/WorkOrderDetail.jsx:191-205` (`api.post('/api/work-orders/:id/leave-behind-pdf', {}, { responseType: 'blob' })`); field variant `client/src/pages/field/FieldAsset.jsx:118-133`.
- **Endpoint:** `POST /api/work-orders/:id/leave-behind-pdf` (alias `POST /api/inspections/:id/leave-behind-pdf`) — `server/routes/leaveBehind.ts:19`.
- **Generator:** `buildLeaveBehindPdf(accountId, workOrderId)` in `server/lib/leaveBehindData.ts` (imported at `leaveBehind.ts:17`). Returns `{ filename, pdfBuffer }`; served `inline` PDF.
- **Input needed:** authenticated user (JWT `accountId`) + a **work-order ID** in the path (must exist on the account, else 404). No request body. Sections: What We Found / What We Fixed / What to Budget For.

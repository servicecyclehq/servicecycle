# Export-surface inventory (C0) -- 2026-07-13

**Workstream C, phase 0** of `docs/design/EXECUTION_PLAN_B_C.md`. Dustin's hard
condition for C: EVERY document surface follows one standard, no partial adoption --
so this inventory gates all restyling. Nothing below has been changed; this is a
read-only census for his review.

Method: every row was verified by opening the cited file at the cited lines on
branch `design/a-pass-2026-07-12` @ `69e484e` (2026-07-13). Broad grep sweep across
`client/src` and `server/` for `window.print`, pdfkit/puppeteer/react-pdf,
exceljs/xlsx, `Content-Disposition`, `application/pdf`, openxmlformats, `text/csv`,
`text/calendar`, `@media print`, blob downloads. Rendering-library finding:
**every server PDF is pdfkit 0.18** (verified imports in each file); there is no
puppeteer / react-pdf / headless-chrome PDF path anywhere in the repo.

## THE hard constraint: immutable SHA-256-anchored snapshots

Compliance snapshots and EMP documents are tamper-evident evidence, not styling
targets:

- Render -> SHA-256 -> store -> `ComplianceSnapshot` row -> activity-log anchor
  (`lib/snapshotPipeline.ts:99-160`; anchor is a direct `activityLog.create`,
  action `compliance_snapshot_generated`, and a failed anchor rolls the whole
  snapshot back).
- Download re-hashes the stored bytes and returns **409 integrity_check_failed**
  on any mismatch (`routes/compliance.ts:590-604`). A restyled historical file
  would be indistinguishable from tampering.
- The account export publishes each snapshot's sha256 to the customer as an
  offboarding integrity promise (`lib/accountExport.ts:34-35`).
- EMP documents ride the same pipeline (`kind: 'emp'`, `snapshotPipeline.ts` header).

**Therefore: any new document theme applies FORWARD-ONLY, to newly generated
snapshots. Historical snapshot/EMP PDFs stay byte-identical. No backfill, no
"regenerate with new look" of existing evidence -- a regeneration is a NEW
snapshot row + anchor, never a replacement.**

## In-scope surfaces

### A. Browser-print pages (client)

| Surface | Generator (file:line) | Medium | Current style | Migration risk |
| --- | --- | --- | --- | --- |
| Overdue Maintenance report, `/reports/overdue` | `client/src/pages/OverdueReport.jsx:150` (print button) | print-CSS (browser print) | App-styled tables; **no** `@media print` rules anywhere in the file -- prints with app chrome | Low: pure CSS work (C1a print.css) |
| Arc Flash Label Report, `/reports/arc-flash` | `client/src/pages/ArcFlashReport.jsx:19` (inline `PRINT_CSS`), `:60` (button) | print-CSS (inline) | Only real print stylesheet in the app: hides chrome, tightens `.data-table` | Low: fold its inline CSS into shared print.css |
| Arc Flash Fleet Dashboard, `/reports/arc-flash-fleet` | `client/src/pages/ArcFlashFleet.jsx:60` | print-CSS (browser print) | No print rules; prints app chrome | Low |
| Asset detail arc-flash tab (whole tab) | `client/src/components/ArcFlashAssetTab.jsx:205` | print-CSS (browser print) | No print rules | Low |
| Energized-work permit (NFPA 70E 130.2(B)) | `client/src/components/ArcFlashAssetTab.jsx:580` (prints the `#arc-flash-permit` card) | print-CSS (browser print) | App card styling; no print isolation -- prints surrounding page too | Medium: a signable compliance/safety document printed via raw browser print; fields are regulatory, layout deserves first-class print treatment |
| QR label reprint block | `client/src/components/ArcFlashAssetTab.jsx:810` | print-CSS (browser print) | Prints whole page incl. chrome around a 140px QR | Low |
| Site arc-flash label sheet (popup) | `client/src/components/StudyAssetBinding.jsx:138-164` (window.open + inline HTML, `onload="window.print()"`) | print-CSS (bespoke popup doc) | Fully bespoke inline CSS; hardcoded ANSI orange/red header colors | Medium: ANSI Z535.4 signal colors are normative and must NOT be re-themed; popup needs its own standardized template |

Note: `ComplianceStandardsReport.jsx` / `ComplianceStandardDetailReport.jsx` were
named as candidates in the C0 plan but have **no** print button, print CSS, or
export of their own (verified by grep; the detail page only triggers a snapshot
download at `ComplianceStandardDetailReport.jsx:124`). Screen-only today -- see
callout 1.

### B. Spreadsheets (server, ExcelJS -- one shared style module)

All styled XLSX flows through `lib/xlsxStyle.ts`
(petrol accent `FF0D4F6E`, ink masthead, chips, typed formats, frozen header),
enforced by the existing `scripts/xlsx-audit` harness.

| Surface | Generator (file:line) | Medium | Current style | Migration risk |
| --- | --- | --- | --- | --- |
| List export (assets / work orders), `GET /api/export/xlsx` + `/assets` `/workorders` aliases, `?format=csv` twin | `server/routes/export.ts:347,363` -> `lib/xlsxExport.ts:29` (`sendXlsx`); CSV via `lib/exportHelpers.ts:151` | XLSX-ExcelJS / CSV | Branded via `lib/xlsxStyle.ts` | Low: already standardized; re-verify against the C1 spec (masthead/footer wording, mono figures) |
| "Export Everything" account export, `GET /api/export/account?format=xlsx` | `server/routes/export.ts:301,322` -> `lib/xlsxExport.ts:51` (`sendAccountXlsx`) | XLSX-ExcelJS (multi-sheet) | Branded; "Read Me" KPI cover + per-entity sheets | Low (JSON twin at `export.ts:333` is a machine format -- out of scope) |
| Outage plan worksheet, `GET /api/outage-planner/plan/export.xlsx` | `server/routes/outagePlanner.ts:379-396` -> `sendXlsx` | XLSX-ExcelJS | Branded | Low |
| Digest workbook attachments (internal + customer) | `lib/digestExcel.ts:56` (`buildDigestXlsxBuffer`), `:106` (`buildCustomerXlsxBuffer`) | XLSX-ExcelJS (email attachment) | Branded via xlsxStyle | Low |
| AFX multi-table workbook, `GET /api/arc-flash/afx/export-multi` | `server/routes/arcFlashIngest.ts:2210-2225` (`applyTemplateHeader` only) | XLSX-ExcelJS (round-trip template) | Template style by design: branded header row, deliberately **no masthead** (a masthead shifts headers and breaks re-import) | Medium: theme must preserve the template/report split -- do not add mastheads to round-trip files |

### C. PDFs (server -- all pdfkit; verified per-file imports)

| Surface | Generator (file:line) | Medium | Current style | Migration risk |
| --- | --- | --- | --- | --- |
| Compliance snapshot | `lib/compliancePdf.ts:34,443` (`renderSnapshotPdf`); pipeline `lib/snapshotPipeline.ts:99-160`; created via `routes/compliance.ts:374` + `routes/audits.ts:643`; served via `routes/compliance.ts:562-616` | PDF-pdfkit | House palette (ink `#0a0d12`, petrol `#0d4f6e`), deliberately conservative "engineering record" layout | **High: SHA-256-anchored, hash re-verified on download; historical snapshots must stay byte-identical -- theme is forward-only** |
| EMP program document | `lib/empDocument.ts:53,962` (`renderEmpPdf`); route `routes/compliance.ts:426` (`POST /emp-document`) | PDF-pdfkit | House palette; 11 numbered NFPA 70B 4.2 sections + signature block | **High: persisted through the same snapshot pipeline (`kind:'emp'`) -- same forward-only rule** |
| CFO quarterly report | `lib/cfoReport.ts:18,195`; route `routes/compliance.ts:344` (`GET /cfo-report.pdf`); quarterly email attach `lib/customerDigest.ts:230-248`; UI trigger `client/src/components/settings/DigestCadenceSection.jsx:64-81` | PDF-pdfkit | House palette + partner co-brand | Low: regenerated on demand, not hashed |
| Capital proposal | `lib/proposalPdf.ts:11,56`; route `routes/proposals.ts:158-180` (`GET /proposal.pdf`) | PDF-pdfkit | House palette + co-brand | Low |
| Service leave-behind | `lib/leaveBehindPdf.ts:23,150` (`renderLeaveBehindPdf`); route `routes/leaveBehind.ts:19-30`; auto-email `lib/leaveBehindAutoSend.ts:33` | PDF-pdfkit | House palette + co-brand | Low |
| Help Center module PDFs | `lib/pdfHelpDoc.ts:59,234`; route `routes/help.ts:120` (`GET /modules/:slug/pdf`, HEAD `:102`) | PDF-pdfkit | Marketing palette (matches house style) | Low |
| Named reports x6 (`?format=pdf`: deficiency-summary, overdue-wos, failed-test-recap, installed-base-age, rul-watchlist, arc-flash-coverage) | `lib/reportsPdf.ts:28` (`renderReportTablePdf`); `routes/reports.ts:77` (handlers `:94,:111,:126,:142`...) | PDF-pdfkit | **Explicitly unbranded** plain table -- the file header says "Not a NETA-styled document (no letterhead/branding)" | Low -- and the single biggest visual win; top migration candidate |
| Outage work plan | `routes/outagePlanner.ts:406` (`renderOutagePlanPdf`); route `:444-458` (`GET /plan/export.pdf`) | PDF-pdfkit | Ad-hoc light styling, raw slate hexes (`#555`, `#0f172a`), no masthead/footer | Low: migration candidate |
| Arc-flash hazard label, single + bulk (4x6, prints 1:1 on label stock) | `lib/arcFlashLabelDoc.ts:19-20` (ANSI colors) + `drawArcFlashLabel`; `routes/arcFlashIngest.ts:2592` (`streamLabelPdf`), `:2606` (`/asset/:assetId/label.pdf`), `:2644` (`/labels.pdf`) | PDF-pdfkit | ANSI Z535.4 signal colors (`#C8102E` DANGER / `#FF8200` WARNING); brand intentionally minimal | **High (regulatory, not hash): NFPA 70E 130.5(H) / ANSI Z535.4 colors + 4x6 geometry are normative -- exempt from palette; only micro-typography/footer may align** |
| Asset QR label sheets (Avery 5160-class, 3x8 grid) | `routes/assetLabels.ts:156` (`renderAssetLabelsPdf`), route `:209`, headers `:308-309` | PDF-pdfkit | Functional label layout, tiny SC footer, co-brand | Medium: physical sheet geometry is fixed; only micro-typography themable |

### D. Public share pages (token-auth web pages)

| Surface | Generator (file:line) | Medium | Current style | Migration risk |
| --- | --- | --- | --- | --- |
| Compliance share package, `/share/:token` | `client/src/pages/SharedCompliancePage.jsx:32` (route `App.jsx:302`); API `routes/shareLinkPublic.ts:15` (watermark `:59`) | HTML page (public, read-only) | App tokens + watermark line; auditors/insurers are the audience | Low -- but should get the C1 print-CSS treatment (recipients print it) |
| Arc-flash QR label portal, `/l/:token` | `client/src/pages/PublicArcFlashLabel.jsx:1` (route `App.jsx:303`); API `routes/arcFlashLabelPublic.ts:27` | HTML page (public) | App tokens; severity colors mirror the printed label; printed-vs-current mismatch banner | Medium: mirrors regulatory label content -- severity colors stay ANSI-aligned |

### E. Emails / digests (flag -- scope decision is Dustin's, already an open item in the plan)

| Surface | Generator (file:line) | Medium | Current style | Migration risk |
| --- | --- | --- | --- | --- |
| Monthly service digest (account/manager/rep variants) | `lib/monthlyDigest.ts:311,442` (HTML tables); XLSX attach `:566,657,693` | HTML-email + XLSX attach | Inline-styled HTML tables (slate palette); attachments branded | Medium **if** in scope: genuinely document-like tables |
| Customer weekly digest | `lib/customerDigest.ts:49` (+ preview `routes/compliance.ts:330`); quarterly CFO PDF attach `:230-248` | HTML-email | Inline HTML, KPI-style, no tables | Low / flag |
| Partner flywheel digest | `lib/partnerDigest.ts:149-159` | HTML-email | Barely styled (h2 + bordered divs) | Low / flag |
| Alert + notification emails | `lib/email.ts:272+` (shared templates); tables in `lib/alertEngine.ts:271`, `lib/deficiencyAlerts.ts:109`, `lib/modernizationAlerts.ts:183` | HTML-email | Dark-card template (`#0f1117` bg, indigo `#6366f1` accent) -- pre-dates the locked palette | Flag: probably out of C scope (notifications), but palette is off-brand vs v0.95 petrol |

## Out of scope (machine formats / passthrough -- listed so "100%" is auditable)

| Surface | file:line | Why out of scope |
| --- | --- | --- |
| Account export JSON | `routes/export.ts:333-337`, `lib/accountExport.ts` | Lossless machine format; the no-lock-in artifact |
| Legacy admin ZIP export (`GET /api/settings/export`) | `routes/settings.ts:828,975-988`; UI `client/src/pages/SettingsPage.jsx:241-261` | CSV+JSON ZIP, machine format -- but see callout 5 (possible duplicate) |
| SIEM audit-log export (.ndjson / .cef) | `routes/activity.ts:348-390` | Tamper-evident hash-chain format; **never** restyle |
| GDPR per-user export (JSON) | `routes/users.ts:821-824` | Machine format |
| Arc-flash model export (CSV/JSON for SKM/ETAP/EasyPower) | `lib/arcFlashExport.ts:29` (stable column order), route `routes/arcFlashIngest.ts:2090-2098` | Interchange format; stable columns are a compatibility promise |
| AFX per-tool CSV template | `routes/arcFlashIngest.ts:2121-2131` | Round-trip import template |
| Arc-flash fleet rollup CSV | `routes/arcFlashIngest.ts:1156-1170` | Plain CSV (no styling medium beyond headers) |
| Maintenance-debt funding CSV | `routes/compliance.ts:193-202` | Plain CSV |
| Parts import template CSV | `routes/parts.ts:106-107` | Import template |
| Client-built CSVs (import template, import error rows, admin opportunities) | `client/src/pages/ImportAssets.jsx:227`, `client/src/components/import/ImportResultsPanel.jsx:68`, `client/src/pages/OpportunitiesPage.jsx:151` | Utility CSVs |
| Study JSON / evidence-bundle JSON downloads | `client/src/pages/ArcFlashFleet.jsx:313,789` | Machine format |
| 2FA backup codes (.txt) / own-data JSON | `client/src/pages/ProfilePage.jsx:588,274` | Utility text |
| Uploaded-document serving | `routes/documents.ts:252`, `routes/fieldRoutes.ts:348` | Passthrough of customer files, not generated docs |
| Photo-of-paper -> PDF wrapper | `lib/imageToPdf.ts:16` (used by `lib/testReportPreview.ts:156-157`) | Verbatim photo embed for ingestion; theming it would alter evidence |
| OpenAPI docs page | `routes/openapi.ts:154` | Developer docs |

No `.ics`/calendar export exists (grepped `text/calendar`, `BEGIN:VCALENDAR`, `.ics` -- zero hits).

## Callouts for Dustin (judgment needed before C1)

1. **ComplianceStandards report pages are screen-only.** The plan's C0 list named
   them as print candidates; verified they have no print/export path today.
   Decide: give them print support under the standard, or drop from C scope.
2. **There is no shared print stylesheet.** `client/src/styles/print.css` does not
   exist (only `tokens.css`); the only `@media print` rules in the app are
   ArcFlashReport's inline block and the StudyAssetBinding popup. Every other
   "Print" button prints the raw app page, chrome included. C1(a) is therefore
   greenfield, and rows in section A are cheaper than they look.
3. **Emails in or out of C scope** -- already on your open-decisions list. Section
   E above is the concrete surface list either way. Note the transactional email
   template palette (indigo-on-dark) predates the locked brand even if C excludes it.
4. **Safety-format exemptions to ratify:** arc-flash label PDFs (ANSI Z535.4
   colors + 4x6 1:1 geometry), the energized-work permit, and the popup label
   sheet must keep normative colors/layout. Recommend the C1 spec name them as
   "regulated surfaces: typography + footer only."
5. **Two account exports exist.** `GET /api/export/account` (new, branded XLSX/
   streamed JSON) and legacy `GET /api/settings/export` ZIP (`routes/settings.ts:828`,
   still wired to the Settings page). Consolidation is out of C scope but worth a call.
6. **Four PDF renderers duplicate the same COLORS block** (compliancePdf, cfoReport,
   leaveBehindPdf, proposalPdf) and `reportsPdf.ts`'s header explicitly warns
   against growing it bespoke -- both point straight at C1(b)'s shared theme module.
7. **Acceptance harnesses already exist:** `server/scripts/pdf-audit/` (overlap/
   blank/OOB gate, one fixture per renderer) and `server/scripts/xlsx-audit/`
   (asserts BRANDED/FREEZE per sheet). C3's 10-point checklist should extend these
   rather than build new verification.
8. **Immutability restated:** theme forward-only for snapshots + EMP docs; any
   C-phase commit touching `compliancePdf.ts`/`empDocument.ts` changes NEW
   renders only and must not add any re-render/backfill of stored evidence.

---
Generated 2026-07-13 (C0 inventory pass) on `design/a-pass-2026-07-12` @ `69e484e`.
Unrelated uncommitted server security changeset present in the working tree; untouched.

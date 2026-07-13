# Export-standard acceptance audit (C3) -- 2026-07-13

**Workstream C, phase C3** of `docs/design/EXECUTION_PLAN_B_C.md`. This is the completeness
gate for "Field Report exports, 100% standardized." Per the plan's C3 spec: *"every inventory
row has a rendered output verified against a 10-point standard list ... 100% or not done --
report gaps raw."*

Branch `design/a-pass-2026-07-12` @ `4b97ccb` (C2h, HEAD of the design branch). Every surface
below was scored by **reading the current file state directly** (not by trusting any prior C2*
session report), cross-checked against the C1 standard files (`server/lib/pdfStyle.ts`,
`client/src/styles/print.css`) and against git history where a claim was load-bearing
(immutability, ANSI geometry). Server-side PDF/XLSX/email reading was fanned out to focused
sub-audits whose file:line evidence was spot-verified against the live files.

> **Honesty note up front:** this workstream is **substantially complete but NOT at 100%
> full-standard conformance.** Palette / fonts / shared-footer standardization is effectively
> done across all in-scope surfaces, immutability and the regulated-surface exemptions are
> correctly respected, and the full 10-point *layout* vocabulary (masthead + numbered sections
> + hairline mono-numeric tables) is fully adopted on the browser-print family, two PDFs, and
> the emails as far as the medium allows. It is **not** fully adopted on the six co-brand /
> immutable PDFs (deliberate), and a set of concrete gaps remain (Section B xlsx accent value,
> three raw-hex PDF disclaimer boxes, `SharedCompliancePage` body colors, two arc-flash report
> tables, orphan styles, and one un-migrated sibling email). All are enumerated in Section 9 --
> nothing is rounded up.

---

## 1. The 10-point standard (as actually implemented)

| # | Point | What "pass" means here |
| --- | --- | --- |
| 1 | Masthead | Title + org + double hairline rule. `drawMasthead` (PDF) / `.print-masthead` + `.print-rule` (print) / `.doc-masthead` literal-hex mirror (bespoke popup) / petrol band (email). Documented absence allowed for round-trip/label/geometry-fixed surfaces. |
| 2 | Hairline rule | The 2.5pt+1pt ink double rule / 1.5pt ink table rule / 0.5-1px hairline row rules from the standard, not ad-hoc borders. |
| 3 | Section numbering | `01, 02...` via `drawSectionHeading` (PDF) or `.print-sec` + auto-counter `.print-sec-no` (print) where the surface has multiple sections. N/A for single-section/one-block surfaces. |
| 4 | Fonts | `PDF_FONTS` (Helvetica body / Courier figures-IDs-dates-footers) for PDFs; `var(--font-mono)` on figures/IDs/dates for print; locked font-family literals for bespoke/email. |
| 5 | Table style | Hairline-ruled tables, numeric columns right-aligned + mono/tabular-nums (`numeric:true` / `td.num`). |
| 6 | Footer | Generated timestamp + `PAGE N [OF M]` where paginated; integrity-hash slot **only** on hash-anchored snapshots. |
| 7 | Tokens-only colors | PDFs/emails: literal `PDF_COLORS` values (CSS vars impossible -- literal hex matching the lock is correct). Print pages: `var(--...)` custom properties, no raw hex, except documented ANSI/regulatory exemptions. |
| 8 | Dark-safe | Print pages/components only. PDFs + emails are single-theme -> **N/A** (not a gap). |
| 9 | Immutability | `compliancePdf.ts` / `empDocument.ts`: snapshot pipeline + hash path untouched, render signatures unchanged, forward-only, no backfill. N/A elsewhere. |
| 10 | No orphan styles | `print.css`: every class used by >=1 migrated surface. `pdfStyle.ts`: every export imported by >=1 server file. |

**Standard-file anchors.** `PDF_COLORS`: ink `#0a0d12`, petrol `#073a52` (locked primary),
petrolHover `#0d4f6e`, emerald `#10b981`, textMuted `#1e293b`, textFaint `#334155`, border
`#c7cfdb`, borderSubtle `#e3e7ee`, success `#15803d`, warning `#b45309`, danger `#b91c1c` (+
tint/Bg variants). `PDF_FONTS`: Helvetica/-Bold/-Oblique, Courier/-Bold. `print.css` vocabulary:
`.print-doc / .print-masthead(-title/-meta) / .print-rule / .print-briefline / .print-sec(-head/
-no/-title/-aux) / .print-table(+ th.num/td.num) / .print-footer(-pages/-hash) / .print-checklist
/ .print-sig-block/-line / .print-focus-label / .print-focus-permit`. Dark-mode print is resolved
by an `index.css` `@media print { [data-theme="dark"]:has(.print-doc) { ... } }` block that
re-pins every token to its light literal (incl. `--color-primary: #073a52`).

---

## 2. Section A -- browser-print pages (client)

| Surface | Score | Gaps found (raw, file:line) | Verdict |
| --- | --- | --- | --- |
| Overdue Maintenance, `OverdueReport.jsx` | 10/10 | None. Masthead 160-166, double rule 167, two auto-numbered `.print-sec` (208, 272), `.num` on Days-overdue (228, 256), footer 333, `var()` tokens throughout, dark-safe via index.css re-pin. | **PASS** |
| Arc Flash Label Report, `ArcFlashReport.jsx` | 8/10 (P5, P7 partial) | P5: label-schedule table (110-134) has **no** `.num` on numeric-ish columns (voltage, incident energy, confidence) -> left-aligned, no tabular-nums. P7: `bandColor` raw hex `#15803d`/`#b45309`/`#b91c1c` (`:15`) drives the printed confidence cell (`:128`) instead of `var(--color-success/warning/danger)`. | **GAP (minor)** |
| Arc Flash Fleet, `ArcFlashFleet.jsx` | 8/10 (P5, P7 partial) | Same pattern: no `.num` on the numeric per-site columns (118-150); `bandColor` raw hex (`:11-14`) in avg-confidence cells (99, 135). Masthead/rule/section/footer all present (67-74, 113, 168). | **GAP (minor)** |
| Asset arc-flash tab (whole tab), `ArcFlashAssetTab.jsx` | 7/10 (P3, P7 partial) | Masthead 209-215 + double rule 216 + footer 434 present, but the main tab prints app cards **without** numbered `.print-sec` sections (only the permit sub-document uses them). Raw-hex content badges: `#15803d`/`#2563eb` (`:776`), `#fff` chip text (125, 252, 776). | **GAP (minor)** |
| Energized-work permit, `ArcFlashAssetTab.jsx` (`.print-permit-sheet`) | 10/10 | None. Full standard: masthead 666-673, double rule 674, hairline `.print-table` with every value in `td.num` (687-702), numbered `.print-sec` 704-707, `.print-checklist` 709, `.print-sig-block/-line` 720-722, footer 725-728. Regulatory field text/labels verbatim (explicit code guarantee 660-664, 716-719). | **PASS (regulated -- exemption respected)** |
| QR label reprint block, `ArcFlashAssetTab.jsx` (`.print-label-sheet`) | Exempt | Focused reprint: `printLabelSheet` arms `body.print-focus-label` so only the 140px label block prints (57-63, 918). No masthead/section/footer by design (a bare physical-label reprint, like the ANSI labels). | **PASS-WITH-DOCUMENTED-EXEMPTION** |
| Site arc-flash label sheet (popup), `StudyAssetBinding.jsx` | Chrome PASS + label exempt | Chrome added in C2f mirrors the standard with **locked-palette literal hex** (standalone popup has no CSS vars): `.doc-masthead` Inter + ink `#0a0d12` (152-153), `.doc-meta`/`.doc-footer` JetBrains-mono + `#1e293b`, `.doc-rule` ink double rule 155-156, footer 171/178. ANSI label cards (`.lbl/.hd/.sub/.rows`, 158-170) **unchanged** per exemption (comment 138-145). | **PASS-WITH-DOCUMENTED-EXEMPTION** |
| Compliance by Standard, `ComplianceStandardsReport.jsx` | 10/10 | (Resolves C0 callout 1 -- was screen-only.) Print button + masthead 130-137, rule 138, briefline 209, `.print-sec` 217, `.print-table` with `th.num` (225-234), footer 288. Interactive cards wrapped `.no-print` (159). | **PASS** |
| Standard detail report, `ComplianceStandardDetailReport.jsx` | 10/10 | (Resolves C0 callout 1.) Masthead 224-226, rule 233, briefline 234, two numbered `.print-sec` (273 Evidence, 372 Open deficiencies), `.print-table` 291/392, footer 425-428. | **PASS** |

Notes: `.print-footer-pages` carries "Generated <date>" rather than page N of M -- browser print
delegates true per-sheet page numbers to the UA header/footer (documented `print.css:251-254`),
so P6 is met. Dark-safe (P8) passes on every `.print-doc` surface above via the index.css re-pin.

**Bonus finding (positive):** C0 callout 1 asked whether the two ComplianceStandards report pages
should get print support or be dropped from scope. The C2e pass **added** full print support to
both -- they are now in-scope, conformant surfaces, not an open question.

---

## 3. Section B -- spreadsheets (server, ExcelJS)

**Important scope fact:** the spreadsheet family was **not touched by any C-phase commit**
(`xlsxStyle.ts`, `xlsxExport.ts`, `digestExcel.ts`, `arcFlashIngest.ts` are absent from the entire
`98155df^..4b97ccb` diff). The C0 row marked them "already standardized; re-verify against the C1
spec." This is that re-verification -- so any gap here is a **pre-existing divergence the C
workstream left unaddressed**, not a C regression.

| Surface | Score | Gaps found (raw, file:line) | Verdict |
| --- | --- | --- | --- |
| Shared module `xlsxStyle.ts` | 8/10 (P4, P7 partial) | **P7 (the headline Section-B gap):** `BRAND.accent = 'FF0D4F6E'` (`:26`) is petrol-**hover**, not the locked petrol-**primary** `FF073A52`. Every header fill / accent rule / KPI top-rule / AFX header therefore ships the hover shade. **P4:** figures are Calibri + numFmt + right-align -- no mono/tabular figure face. **P6:** no footer helper (timestamp injected into each sheet's subtitle by callers). | **PASS-WITH-DEFECT (accent value)** |
| List export (assets/work orders) `+ ?format=csv`, `xlsxExport.ts:29` (`sendXlsx`) | 8/10 | Inherits the `accent` defect + no-mono. Per-entity sheet structure good. | **PASS** |
| "Export Everything" account export, `xlsxExport.ts:51` (`sendAccountXlsx`) | 8/10 | Inherits `accent` defect. "Read Me" KPI cover + per-entity sheets present. | **PASS** |
| Outage plan worksheet, `outagePlanner.ts:385-402` | 8/10 | Single sheet (P3 N/A); inherits `accent` defect; `due` typed as date (good). | **PASS** |
| Digest workbooks (internal + customer), `digestExcel.ts:56, 102` | 8/10 | Inherits `accent` defect; **Est. Value is a pre-formatted string** (47-53, 75, 84) -> loses numFmt/right-align/sortability. | **PASS** |
| AFX multi-table workbook, `arcFlashIngest.ts:2210-2220` | Exempt | **NO masthead -- confirmed.** Only `applyTemplateHeader(ws)` at `:2220`; zero `applySummarySheet/applyReportSheet/masthead` refs anywhere in the file. A masthead would shift header rows and break re-import. Only blemish: the `README` note tab is fully unstyled (2212-2215) -- the harness would flag it (no branded fill/freeze), but it is a metadata tab, not a data sheet. | **PASS-WITH-DOCUMENTED-EXEMPTION** |

**Harness coupling for the fixer:** `server/scripts/xlsx-audit/audit_xlsx.py:23` hardcodes
`'FF0D4F6E'` in its `BRAND_FILLS` allowlist, and `EXPORT_SURFACE_INVENTORY_2026-07-13.md:60`
documents "petrol accent FF0D4F6E." Correcting `xlsxStyle.ts:26` to `FF073A52` **without** also
updating the harness allowlist would make the harness flag every corrected sheet as unbranded.
Both must change together -- which is why this is reported, not auto-fixed.

---

## 4. Section C -- PDFs (server, pdfkit)

| Surface | Score | Gaps found (raw, file:line) | Verdict |
| --- | --- | --- | --- |
| Named reports x6, `reportsPdf.ts:28` (`renderReportTablePdf`) | 10/10 | The model adopter: `drawMasthead` (57), `drawTable` hairline (65), `attachFooter` (55), `formatTimestamp`, `PDF_FONTS/PDF_COLORS`. Minor: the column mapper (`:67`) and input type (`:32`) drop `numeric`/`align`, so numeric report columns are not right-aligned/mono. | **PASS** |
| Outage work plan, `outagePlanner.ts:412` (`renderOutagePlanPdf`) | 10/10 | Full adopter: `drawMasthead` (427), **numbered** `drawSectionHeading` (449, `number: locNum`), `attachFooter` (425), `formatTimestamp`. Body is a hierarchical checklist, not tabular (drawTable N/A). No raw hex. | **PASS** |
| Compliance snapshot, `compliancePdf.ts:414` (`renderSnapshotPdf`) -- IMMUTABLE | 6/10 (P1/P3/P5 by design; P7 gap) | Adopts `PDF_COLORS/PDF_FONTS/PDF_PAGE` + shared `attachFooter` (452); **keeps** its bespoke "engineering record" layout: dark co-brand cover band (116-120), local `drawSectionHeading` (195, no `01/02`), local dark-band table (`drawTableHeader:250`, not mono-numeric). **P7 gap:** raw-hex disclaimer box 184-187 (`#fffbeb`, `#b45309`, `#fde68a`, `#92400e`). | **PASS-WITH-DOCUMENTED-EXEMPTION (immutable -- minimal-churn layout)** |
| EMP program document, `empDocument.ts:943` (`renderEmpPdf`) -- IMMUTABLE | 7/10 (P1/P5 by design) | Sections **are** numbered 1-11 (local `sectionHeading:401`); dark cover band (564) + local dark-band table (`drawTableHeader:503`). Palette clean -- warnBox uses `warningBg`/`warning` tokens (no raw disclaimer hex). Shared `attachFooter` (980). | **PASS-WITH-DOCUMENTED-EXEMPTION** |
| CFO quarterly report, `cfoReport.ts:189` | 6/10 | Palette + shared footer (206) only; dark band (208-212), no numbered sections. **P7:** raw amber hexes 308-311 (`#fffbeb`/`#fde68a`/`#92400e`). | **GAP (partial layout + raw hex)** |
| Capital proposal, `proposalPdf.ts:51` | 5/10 | Dark band (68-70); **hand-rolled table** (94-115) with the cost column left-aligned in the sans face (not `numeric`/mono). **P7:** raw amber hexes 128-131. | **GAP (hand-rolled table + raw hex)** |
| Service leave-behind, `leaveBehindPdf.ts:153` | 5/10 | Dark band (172-183); hand-rolled budget table (377-410, range col not mono); `finalizeFooters` (477). **P7:** `SECTION3_PURPLE='#7c3aed'` (`:36`, non-palette -- **open purple-family decision**) + `#fff` x4 (217, 236, 276, 313). | **GAP (partial layout; purple = open decision)** |
| Help Center module PDFs, `pdfHelpDoc.ts:218` | 8/10 | Hand-rolled dark header band (180) rather than `drawMasthead`; palette clean; markdown body (no tables) so P3/P5 N/A. Shared `attachFooter` (250). | **PASS-WITH-DOCUMENTED-EXEMPTION** |
| Arc-flash hazard label, `arcFlashLabelDoc.ts` (`drawArcFlashLabel`) | Exempt | ANSI Z535.4 signal colors `SAFETY_RED #C8102E` (`:24`) / `SAFETY_ORANGE #FF8200` (`:25`) and 4x6 geometry `LABEL_W 288`/`LABEL_H 432` (33-34) **untouched** (git-verified against pre-C2). C2f only sourced **non-ANSI** text colors + fonts from `PDF_COLORS/PDF_FONTS` (20, 27-30), actually **removing** prior raw `#0f172a`/`#475569`. | **PASS-WITH-DOCUMENTED-EXEMPTION** |
| Asset QR label sheets, `assetLabels.ts:165` (`renderAssetLabelsPdf`) | Exempt | Fixed Avery 3x8 physical geometry -> masthead/footer/table N/A by design (33, 57-59, 154-156). Typography from `PDF_FONTS/PDF_COLORS`; `DECAL_COLOR #16a34a/#d97706/#dc2626` (`:73`) = NETA physical-decal signal colors (documented exemption). | **PASS-WITH-DOCUMENTED-EXEMPTION** |

**Architectural observation (the crux of "100%").** Six PDFs -- `compliancePdf`, `empDocument`,
`cfoReport`, `proposalPdf`, `leaveBehindPdf`, `pdfHelpDoc` -- adopt the shared **palette + fonts +
footer** but deliberately **retain their own document identity** (dark co-brand cover bands, local
section/table helpers) rather than switching to `drawMasthead` / `drawSectionHeading` / `drawTable`.
Each file's C2a/C2c/C2h comments document this as intentional scoping (for the two immutable
surfaces it is the correct minimal-churn choice; for the customer-facing co-brand sales/board PDFs
it is a product-identity choice). Only `reportsPdf` and `outagePlanner` (PDF) are full field-report
layout adopters. **So "100%" holds for palette/fonts/footer, but NOT for the full masthead/
numbered-section/hairline-mono-table layout vocabulary -- that is a decision for Dustin, not a
silent defect.**

---

## 5. Section D -- public share pages

| Surface | Score | Gaps found (raw, file:line) | Verdict |
| --- | --- | --- | --- |
| Compliance/underwriting share, `SharedCompliancePage.jsx` | Chrome PASS, P7 GAP | Print **chrome** conforms and is token-pure: masthead (78-85, 207-214), double rule (85, 214), multiple numbered `.print-sec` (98, 113, 150, 166, 227, 243, 258), footer (188, 276). **But the body is styled with raw-hex inline styles throughout**, printed and on-screen: `#5b6373`, `#f8fafc`, `#e2e8f0`, `#94a3b8` (52, 58-59, 71-72, 183-184, 271...), `SEV_COLOR`/`rateColor`/`uwColor` hex (30, 71, 197), the `#6d28d9` violet READ-ONLY badge (89, 218 -- **open purple decision**), and `fontWeight:800` (104, 121, 233) which is off the shipped 400-700 weight ladder. | **GAP (chrome standardized; body not tokens-only)** |
| Arc-flash QR portal, `PublicArcFlashLabel.jsx` | 10/10 | Token-pure `var(--color-*)` throughout, masthead 94-100, rule 101, footer 148-151, ANSI severity via `sevColor` tokens (`:18`), **dark-safe by design** (var tokens inherit theme, comment 62-63). Only nits: `#fff` badge text (`:111`), `fontWeight:800` (`:111`). | **PASS** |

---

## 6. Section E -- emails / digests

All seven in-scope surfaces are **100% on the locked palette** (P7 -- the hard condition). A full
hex sweep returned zero off-palette values: no legacy indigo `#6366f1`, no dark bg `#0f1117`/
`#0f172a`, no slate. The old "dark-card" `email.ts` template (`#0f1117` bg / `#6366f1` accent) is
**confirmed fully removed** (grep across `server/lib` = zero hits). Status-tint backgrounds
(`#fee2e2`/`#fef3c7`/`#dcfce7`) are on-palette (`PDF_COLORS.dangerBg/warningBg/successBg`).

| Surface | Score | Notes (file:line) | Verdict |
| --- | --- | --- | --- |
| Customer weekly digest, `customerDigest.ts:145-180` (+ CFO cover `:260`) | on-palette | Petrol masthead band; no off-palette hex. | **PASS** |
| Monthly service digest, `monthlyDigest.ts:245-457` | on-palette | Masthead + hairline tables; on-palette. | **PASS** |
| Partner flywheel digest, `partnerDigest.ts:137-159` | on-palette | Plain `<h2>` masthead (`:154`), no petrol band/card -- materially lighter than the other digests. Per-rep notification, so defensible, but the one style-consistency outlier. | **PASS-WITH-DOCUMENTED-EXEMPTION (lighter masthead)** |
| Shared templates, `email.ts:190-601` | on-palette | Petrol `#073a52` masthead on white card, `#e3e7ee` hairline. Dark-card retired. | **PASS** |
| Alert digest, `alertEngine.ts:188-287` | on-palette | On-palette; date in header sub (`:266`). | **PASS** |
| Deficiency alert, `deficiencyAlerts.ts:74-127` | on-palette | Red `#b91c1c` (danger token) masthead = intentional severity signaling. | **PASS** |
| Modernization alert, `modernizationAlerts.ts:128-200` | on-palette | On-palette. | **PASS** |

Cross-cutting email conventions (marked acceptable, **not** gaps): figures/IDs/dates are **not**
mono/tabular-nums (email clients strip `font-variant-numeric`; the only mono stack is
`Menlo,Consolas` in `email.ts:380`'s install `<pre>`), and footers carry a period label rather
than a generated timestamp. Both are standard email-medium practice, not off-brand defects.
Page-N/M and integrity-hash are correctly absent (emails aren't paginated or hash-anchored).

**Out-of-migration sibling (real gap):** `qemwAlerts.ts:84-106` (`buildQemwGapHtml`, the QEMW
compliance-gap alert cron email) is **entirely unmigrated** -- violet masthead `#7c3aed` (`:88`),
`#ede9fe` (`:90`), and Tailwind-gray `#111827`/`#f9fafb`/`#e5e7eb`/`#374151`/`#9ca3af` (86-103).
It was not in the C2d/C2g migration set. If the bar is "100% of email surfaces standardized," this
is an open gap; it was outside the migrated scope, so it is flagged for a scope decision.

---

## 7. Known judgment calls / exemptions -- verification results

| Item | Result | Evidence |
| --- | --- | --- |
| Snapshot + EMP forward-only, no backfill | **CONFIRMED** | C2h (`4b97ccb`) touched **only** `compliancePdf.ts` + `empDocument.ts`; `snapshotPipeline.ts` has **zero** commits across the whole C range (`b837d77..4b97ccb`). Signatures `renderSnapshotPdf(reportBundles, meta)` / `renderEmpPdf(empData, meta)` unchanged; both still return a fresh `Buffer` consumed by `snapshotPipeline.persistSnapshot` (hash -> store -> activity-log anchor). Repo-wide `regenerate` sweep = only user-facing PDF instruction text (`empDocument.ts:608,664`), which produces a NEW snapshot row, never a re-theme of stored bytes. |
| Arc-flash label PDF + Asset QR labels: ANSI colors + geometry unchanged | **CONFIRMED** | C2f diff of `arcFlashLabelDoc.ts`: `LABEL_W 288` / `SAFETY_RED #C8102E` / `SAFETY_ORANGE #FF8200` untouched; only fonts + non-ANSI text colors re-sourced (and prior raw `#0f172a`/`#475569` removed). `assetLabels.ts` DECAL signal colors + Avery geometry untouched. |
| Energized-work permit: regulatory text verbatim, chrome only | **CONFIRMED** | `ArcFlashAssetTab.jsx` `.print-permit-sheet` mirrors the exact screen field values/wording; explicit code guarantee 660-664 & 716-719 ("no regulatory content added, changed, or removed"). |
| StudyAssetBinding popup: label content colors unchanged, chrome added | **CONFIRMED** | C2f added `.doc-masthead/.doc-rule/.doc-footer` (locked-palette literals + Inter/JetBrains mono); label cards `.lbl/.hd/.sub/...` untouched (comment 138-145). (Aside: those card colors are Tailwind-ish approximations `#ea580c`/`#b91c1c`, not the exact ANSI `#FF8200`/`#C8102E` the PDF label uses -- **pre-existing**, intentionally left alone; worth a separate look but out of C scope.) |
| AFX workbook keeps NO masthead | **CONFIRMED** | `arcFlashIngest.ts:2220` calls `applyTemplateHeader` only; no masthead ref in the file. Not accidentally "fixed." |
| `xlsxStyle.ts` accent = petrol-hover, not primary | **CONFIRMED (reported, not refixed)** | `xlsxStyle.ts:26 accent 'FF0D4F6E'` = hover shade; locked primary is `#073A52`. Same hover-vs-primary shows in the app's light-mode `--color-primary` (`index.css:299` `-rgb` comment) -- a repo-wide known item (hex-sweep P1-8), which is why print-page section numbers resolve to `#0d4f6e` in light mode. Not refixed: the harness (`audit_xlsx.py:23`) hardcodes the same value, so it is not a trivial single-alias change. |

---

## 8. Orphan styles (point 10)

**`print.css` classes defined but used by no migrated surface** (grep of `client/src`): `.print-mono`,
`.print-id`, `.print-date`, `.print-num` (tables use the scoped `.print-table td.num` instead of these
standalone utilities), `.print-fig-v` (+ `b`, `small`), `.print-fig-k` (the big-figure display block
from the `.m3` mock), and the running-footer variant `.print-footer--running` / `.print-doc--running-footer`.
These are **provided-but-unconsumed standard vocabulary** (the file is a shared library and its header
documents them as opt-in), not dead code from a migration -- but per the strict point-10 check they are
orphans and are reported raw.

**`pdfStyle.ts` exports imported by no external server file:** `ensureSpace`, `drawTableHeader`,
`drawTableRow`, `measureTableRow`, `drawFooter`. These are the composable internals that
`drawTable` / `attachFooter` / `finalizeFooters` wrap; they are exported for completeness/testing
but no renderer imports them directly. All other exports (`PDF_COLORS/PDF_FONTS/PDF_PAGE/
formatTimestamp/drawMasthead/drawSectionHeading/drawTable/attachFooter/finalizeFooters`) are
imported by >=1 renderer.

---

## 9. Overall completion status (honest) + gap list

**Verdict: SUBSTANTIALLY COMPLETE, NOT 100%.**

- **Effectively complete:** shared palette + fonts + footer across every in-scope surface;
  immutability + all regulated-surface exemptions correctly respected; full 10-point *layout*
  conformance on the browser-print family (`OverdueReport`, `ComplianceStandards` x2, permit),
  `PublicArcFlashLabel`, `reportsPdf`, `outagePlanner` (PDF), and all 7 in-scope emails as far as
  the medium allows.
- **Not at 100%:** the following concrete gaps remain.

| # | Gap | Where | Severity |
| --- | --- | --- | --- |
| G1 | xlsx accent is petrol-**hover** `FF0D4F6E`, not locked primary `FF073A52` -- affects the whole Section-B family; harness hardcodes the same value (fix together) | `xlsxStyle.ts:26` (+ `audit_xlsx.py:23`) | Medium (palette, whole family) |
| G2 | Raw-hex "SCOPE & LIMITATIONS" disclaimer box, triplicated (`#fffbeb`/`#fde68a`/`#92400e`/`#b45309`) -- `empDocument` proves it is fixable via `warningBg`/`warning` tokens | `compliancePdf.ts:184-187`, `cfoReport.ts:308-311`, `proposalPdf.ts:128-131` | Medium (tokens-only; note: compliancePdf is immutable-forward-only) |
| G3 | Public share page body styled with raw-hex inline (incl. `#6d28d9` violet badge, `fontWeight:800`); print chrome is fine | `SharedCompliancePage.jsx` (30, 52, 58-59, 71-72, 89, 183-184, 218, 271) | Medium (tokens-only) |
| G4 | Arc-flash report tables: numeric columns lack `.num` right-align/tabular-nums; `bandColor` raw hex | `ArcFlashReport.jsx:15,110-134`; `ArcFlashFleet.jsx:11-14,118-150` | Low |
| G5 | Whole-tab arc-flash print: masthead+footer only, no numbered sections; raw-hex content badges | `ArcFlashAssetTab.jsx:207-434` (badges `:776`, 125, 252) | Low |
| G6 | Six co-brand/immutable PDFs adopt palette+fonts+footer but NOT the field-report masthead/numbered-section/mono-table layout (intentional per commit comments); `reportsPdf`/`proposalPdf`/`leaveBehindPdf` numeric columns not right-aligned/mono; `leaveBehindPdf SECTION3_PURPLE #7c3aed` (open purple decision) | `compliancePdf`, `empDocument`, `cfoReport`, `proposalPdf`, `leaveBehindPdf`, `pdfHelpDoc` | Decision (Dustin) + Low |
| G7 | Orphan styles: 8 unused `print.css` classes + 5 internal-only `pdfStyle.ts` exports | `print.css`, `pdfStyle.ts` | Low (cosmetic) |
| G8 | `qemwAlerts.ts` email fully unmigrated (violet `#7c3aed` + Tailwind-gray) -- outside the C2d/C2g set but a real email surface | `qemwAlerts.ts:84-106` | Medium if "100% of emails" is the bar |

**No code was changed by this audit.** Every candidate fix carries non-trivial risk or scope
(immutable evidence bytes for G2/compliancePdf, harness coupling for G1, multi-file app logic for
G4, the open purple decision for G3/G6, judgment on library vocabulary for G7) -- so per the C3
"report gaps raw" instruction, all eight are left for Dustin's action.

---

## 10. Accepted exemptions (intentionally NOT fully conformant -- correct, not gaps)

1. **Immutable snapshots** (`compliancePdf`, `empDocument`) -- theme is forward-only; historical
   bytes stay identical; minimal-layout-churn is deliberate to protect the SHA-256 anchor.
2. **ANSI Z535.4 surfaces** -- arc-flash hazard label PDF (`#C8102E`/`#FF8200` + 4x6 geometry) and
   asset QR decal colors are normative safety formats, exempt from the brand palette.
3. **Energized-work permit** -- regulatory field text/labels verbatim; only chrome standardized.
4. **StudyAssetBinding popup** -- ANSI label-card content untouched; only masthead/rule/footer
   chrome added (as locked-palette literals, since a standalone popup has no CSS vars).
5. **AFX round-trip workbook** -- deliberately no masthead (a masthead breaks re-import); header
   styling only.
6. **Emails** -- literal hex (not CSS vars) is correct for the medium; no mono/tabular figures and
   no footer timestamp are standard email-client-compatibility practice, not off-brand defects.

---

Generated 2026-07-13 (C3 acceptance pass) on `design/a-pass-2026-07-12` @ `4b97ccb`. Read-only
audit; no surface files modified. The unrelated uncommitted server security changeset in the
working tree was not touched.

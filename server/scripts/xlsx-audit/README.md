# Excel layout audit

The spreadsheet counterpart to `scripts/pdf-audit`. Every workbook the platform
exports should look like one product. `lib/xlsxStyle.ts` is the single source of
that look; this harness proves every export actually uses it.

## The canonical style (`lib/xlsxStyle.ts`)

Two looks, one palette (mirrors the PDF house style):

- **Report style** — `applySummarySheet` (a KPI-card dashboard cover) and
  `applyReportSheet` (navy masthead, petrol header, status chips, risk data bar,
  zebra rows, typed number/currency/date/percent formats, frozen + filterable
  header, fit-to-width printing). For **read-only** exports.
- **Template style** — `applyTemplateHeader` brands the header row in place and
  freezes it, **without** a masthead, so headers stay in row 1. For **round-trip**
  files that are downloaded, filled in, and re-uploaded — a masthead would shift
  the headers and break the import parser.

A report column may carry `chip: raw => 'good'|'warn'|'bad'|null` (status pill)
and `bar: true` (in-cell data bar).

## Run it

```bash
npx tsx scripts/xlsx-audit/render-hero.ts /tmp/sc-xlsx      # the reference workbook
npx tsx scripts/xlsx-audit/render-fixtures.ts /tmp/sc-xlsx  # one sample per export path
python3 scripts/xlsx-audit/audit_xlsx.py /tmp/sc-xlsx/*.xlsx --png-dir /tmp/sc-xlsx
```

`audit_xlsx.py` needs `openpyxl`; `--png-dir` additionally renders a contact
sheet per workbook via LibreOffice (needs `soffice` + `pymupdf`). Non-zero exit
on any ERROR, so it can gate a deploy.

## What it checks (per data sheet)

- **BRANDED** — a brand fill appears in the top rows (petrol header, ink
  masthead, or KPI/zebra wash). Catches a raw, unstyled grid. ERROR.
- **FREEZE** — freeze panes are set so the header never scrolls away. ERROR.
- **TABCOLOR** — the sheet tab is colored. WARN.

## Coverage

| Export | Style | Renderer |
| --- | --- | --- |
| Account export (multi-sheet) | report (summary + sheets) | `lib/xlsxExport.ts` `sendAccountXlsx` |
| Asset / Work-order export | report | `lib/xlsxExport.ts` `sendXlsx` |
| Monthly service digest | report | `lib/digestExcel.ts` `buildDigestXlsxBuffer` |
| Customer maintenance digest | report | `lib/digestExcel.ts` `buildCustomerXlsxBuffer` |
| Arc-flash multi-table (AFX) | template (round-trip) | `routes/arcFlashIngest.ts` |

The four `*Import.ts` routes only **parse** uploaded files — they do not generate
templates, so there is nothing to style there. **If you add a new Excel export,
route it through `lib/xlsxStyle.ts`, add a fixture here, and keep this table
whole** — that is the whole point.

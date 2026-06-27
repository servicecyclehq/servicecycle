# PDF layout audit

A repeatable check that every generated report renders cleanly — no overlapping
text, no blank pages, nothing bleeding off the edge. Run it before any demo or
release that shows a PDF. It exists because layout bugs (a page number printed on
top of the footer brand, a budget table whose cells scattered across pages, a
wrapped description colliding with the line below it) are invisible in code review
and fatal in front of a customer.

## Run it

```bash
# 1. Render a stress sample of every pure report renderer (long names, wrapping
#    text, many rows, multi-page tables) into a temp dir.
npx tsx scripts/pdf-audit/render-fixtures.ts /tmp/sc-pdf-audit

# 2. Audit them. Non-zero exit = a real overlap/blank/overflow was found.
python3 scripts/pdf-audit/audit_pdf.py /tmp/sc-pdf-audit/*.pdf --png-dir /tmp/sc-pdf-audit
```

`audit_pdf.py` needs `pymupdf` (`pip install pymupdf`); `pillow` is optional and
produces a tiled contact-sheet PNG per report for a human glance.

## What it checks

- **OVERLAP** — two text boxes physically intersect. Tiered: **>=35% = ERROR**
  (a genuine collision, fails the gate); **22-35% = warn** (usually intentional
  label-above-value stacking, e.g. a small "ASSET" caption sitting just above the
  asset name). Review warns once; they don't fail the run.
- **BLANK** — a near-empty page (a stray cell on its own page).
- **OOB** — text extending past the page edge.

## Coverage

Pure renderers (data object in -> Buffer out) are driven directly with mock
fixtures:

| Report | Renderer |
| --- | --- |
| Service leave-behind | `lib/leaveBehindPdf.ts` |
| CFO quarterly report | `lib/cfoReport.ts` |
| Compliance snapshot | `lib/compliancePdf.ts` |
| Capital proposal | `lib/proposalPdf.ts` |
| EMP program document | `lib/empDocument.ts` |
| Arc-flash label | `lib/arcFlashLabelDoc.ts` |

Route/DB-coupled PDFs that stream straight to the HTTP response (outage planner,
asset-label sheets, Help Center docs) are not yet fixtured here — audit those by
downloading one from the running app and pointing `audit_pdf.py` at the file.
Adding them means extracting a pure `(...) -> Promise<Buffer>` render helper.

## pdfkit gotchas these renderers now avoid

- `lineBreak: false` does **not** stop wrapping when a `width` is set — measure
  and truncate (`widthOfString`) or measure-and-grow (`heightOfString`) instead.
- A footer drawn below the bottom margin must be **cursor-neutral** (save/restore
  `doc.x/doc.y`) or the next write auto-breaks to a new page.
- Right-align a footer page number by **computed x**, never `width` + `align:'right'`
  — a flow below the margin spawns a blank page.
- Page-1 footers via a `pageAdded` listener must be drawn **while page 1 is current**,
  not at the end of rendering (or they stamp onto the last page).

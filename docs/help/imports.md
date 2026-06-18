# Imports

Getting data in is the whole game — a maintenance record is only as good as what
flows into it, and friction here is what kills tools like this. ServiceCycle gives
you several low-effort paths, all built so the reports you already produce do the
data entry for you.

## Test-report PDF ingest

This is the flagship path: drop a PowerDB / Megger / NETA test-report PDF (Sidebar
→ Import Test Report) and ServiceCycle reads it, matches the readings to the right
asset, and turns failures into deficiencies — your "upload a report, get a list of
crap to fix" button.

It works in two steps. **Preview** parses the file and shows you what it found
without writing anything: which asset each section matched, the readings with
per-value confidence flags, and any warnings. You confirm or correct the asset
matches, then **commit** — and a multi-asset report writes every asset in one
all-or-nothing transaction, so a facility lands cleanly or not at all. A photo of
a paper report works too; the app wraps the image and runs it through the same
pipeline, with a reminder to verify every reading.

Extraction is deterministic first — the parser reads the document structure
directly — and only leans on AI to fill gaps when you've configured a provider. A
large report is processed in the background so you're never staring at a spinner;
the screen shows progress and phase as it runs.

## Email a report in

You can forward a report to a dedicated address and ServiceCycle ingests it
automatically — the assets and readings appear as cards without anyone opening the
app, and the sender gets an acknowledgement. This path auto-commits to the
designated site, so use it for trusted, routine report flows. Setup lives under
Settings / API & Integrations.

## Bulk backfill (a zip of reports)

To load history all at once, upload a single zip of report files and ServiceCycle
fans it out into one ingest job per report, each auto-committed, with a
batch-progress view showing per-file results. This is how you stand up an account
from a folder of past test reports in one move.

## Spreadsheet & CMMS import

The Add data hub (Sidebar → Add data) handles structured spreadsheets — assets,
schedules, work orders, and deficiencies — and migrations from CMMS systems like
Maximo, SAP PM, and Oracle EAM. Upload the file, map your columns to
ServiceCycle's fields, preview the first rows, then run the import. Existing
records are matched and updated rather than duplicated.

## Asset matching

However a report arrives, ServiceCycle matches its readings to equipment by serial
number first, then by site / position / type, and shows how confident each match
is so you can confirm rather than create duplicates. A first/acceptance test can
be flagged as the baseline so it anchors trends instead of being trended against.

## Common workflows

**"Turn this one report into a fix list."** Import Test Report → drop the PDF →
review the preview → commit. The deficiencies appear on the matched assets.

**"Load five years of past reports."** Zip them and use the bulk backfill upload.

**"Make routine reports flow in with no clicks."** Set up the email-in address and
forward reports to it.

## When something looks wrong

**A report attached to the wrong asset (or created a duplicate).** The serial
didn't match an existing asset. Fix the match on the preview screen before
committing, or correct the asset's serial so future reports match.

**Extraction came back mostly empty.** The PDF may be a scanned image with no text
layer. Run it through OCR first, or photograph the pages and use the photo path.

**A spreadsheet import skipped rows.** The result screen lists skipped rows with a
reason — usually a missing required field or an unparseable date. Fix those rows
and re-import just them.

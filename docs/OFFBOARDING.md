# Data Export & Offboarding (No Lock-In)

ServiceCycle is built so your data is always yours and always portable. There is
no proprietary format and no lock-in.

## One-click full-account export

A manager or admin can download a complete export of the account at any time:

- **Reports -> Export Everything (Account Backup)** in the app, or
- `GET /api/export/account?format=json` (lossless JSON, the canonical artifact), or
- `GET /api/export/account?format=xlsx` (a human-readable multi-sheet workbook).

Both formats require an authenticated manager/admin session and are account-scoped.
The export is versioned (`meta.exportVersion`); the current version is `2`.

### What's included

Fully-structured rows (every field) for:

- Sites
- Assets (incl. condition, criticality, repair-cost estimate, in-service/archived)
- Maintenance schedules (with task name / code / standard reference)
- Work orders (status, scheduled/completed dates, as-found/as-left, NETA decal)
- Deficiencies (severity, description, corrective action, resolution)
- Quote requests (status, driver, timeline, trigger, priority)
- **Arc-flash studies** -- study date, method, PE name/license, expiry (IEEE 1584)
- **Arc-flash labels** -- per-bus incident energy, PPE category/method, approach
  boundaries, hazard level, and expiry; all NFPA 70E 130.5(H) fields
- **LOTO procedures** (OSHA 29 CFR 1910.147) -- title, status, version, approval
  date; energy sources and steps are retrievable per-procedure via the API

Listed as metadata + retrieval path (binary files are not inlined):

- Documents -- filename, type, doc-type, upload date, and a `downloadPath`
  (`/api/documents/:id/file`, or the external URL for link-only docs).
- Compliance snapshots -- filename, kind, standard, size, **SHA-256 integrity
  hash**, generation stats, and a `downloadPath`
  (`/api/compliance/snapshots/:id/download`).

### What's intentionally excluded

Secrets and internal storage details: password hashes, API keys, raw storage
keys. These are not your records and are never part of an export.

Activity log entries, telemetry readings, and arc-flash incidents are high-volume
operational records not included in the portable export; they remain accessible
in-app and via the API while the account is active.

## Retrieving your binary files

For each entry under `documents` and `snapshots`, sign in and `GET` its
`downloadPath` to retrieve the file. Snapshot PDFs are tamper-evident: each file
hashes to the `sha256` recorded in the export, anchored in the activity-log hash
chain at generation time, so you can independently verify integrity after export.

## Arc-flash data portability

Arc-flash label data (incident energy, PPE, boundaries) is also available in the
open **AFX v1** format via:

- `GET /api/arc-flash/export?format=csv` -- flat CSV per bus (NFPA 70E fields)
- `GET /api/afx/export-multi?tool=afx&format=xlsx` -- multi-table workbook
  (Bus / Cable / Transformer / Device, IEEE 1584-2018 anchored)

The AFX export is the recommended format for transferring arc-flash data to
another tool (EasyPower, SKM, ETAP). See `docs/api/AFX_SPEC.md` for the full
field catalog and interop notes.

## Full offboarding

1. Download the JSON export (lossless copy of all structured data, incl. arc-flash
   and LOTO).
2. Pull each document and snapshot via its `downloadPath`.
3. Export arc-flash data in AFX format for tool-to-tool portability.
4. Contact ServiceCycle to close the account.

Your exported data remains usable with no ServiceCycle dependency -- open formats,
documented schema (`meta.exportVersion`), stable field names.

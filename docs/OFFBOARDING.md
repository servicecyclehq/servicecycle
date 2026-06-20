# Data Export & Offboarding (No Lock-In)

ServiceCycle is built so your data is always yours and always portable. There is
no proprietary format and no lock-in.

## One-click full-account export

A manager or admin can download a complete export of the account at any time:

- **Reports -> Export Everything (Account Backup)** in the app, or
- `GET /api/export/account?format=json` (lossless JSON, the canonical artifact), or
- `GET /api/export/account?format=xlsx` (a human-readable multi-sheet workbook).

Both formats require an authenticated manager/admin session and are account-scoped.

### What's included

Fully-structured rows (every field) for:

- Sites
- Assets (incl. condition, criticality, repair-cost estimate, in-service/archived)
- Maintenance schedules (with task name / code / standard reference)
- Work orders (status, scheduled/completed dates, as-found/as-left, NETA decal)
- Deficiencies (severity, description, corrective action, resolution)
- Quote requests (status, driver, timeline, trigger, priority)

Listed as metadata + retrieval path (the binary files are not inlined, since
bundling every blob would be unbounded):

- Documents -- filename, type, doc-type, upload date, and a `downloadPath`
  (`/api/documents/:id/file`, or the external URL for link-only docs).
- Compliance snapshots -- filename, kind, standard, size, **SHA-256 integrity
  hash**, generation stats, and a `downloadPath`
  (`/api/compliance/snapshots/:id/download`).

### What's intentionally excluded

Secrets and internal storage details: password hashes, API keys, raw storage
keys. These are not your records and are never part of an export.

## Retrieving your binary files

For each entry under `documents` and `snapshots`, sign in and `GET` its
`downloadPath` to retrieve the file. Snapshot PDFs are tamper-evident: each file
hashes to the `sha256` recorded in the export, anchored in the activity-log hash
chain at generation time, so you can independently verify integrity after export.

## Full offboarding

1. Download the JSON export (lossless copy of all structured data).
2. Pull each document and snapshot via its `downloadPath`.
3. Contact ServiceCycle to close the account.

Your exported data remains usable with no ServiceCycle dependency -- open formats,
documented schema (`meta.exportVersion`), stable field names.

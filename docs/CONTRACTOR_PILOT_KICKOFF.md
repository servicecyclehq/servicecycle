# ServiceCycle — Contractor Pilot Kickoff

**Audience:** the electrical testing/maintenance contractor's ops lead, once they've said yes
to a pilot. Written generically — do not fill in a real company name in this template.

**What this pilot is for:** prove ServiceCycle can absorb the contractor's existing test-report
output and turn it into a live, ongoing compliance record for one of their customer accounts,
with zero rekeying of data that already exists in the contractor's own files.

---

## Before kickoff — what we need from you

The single highest-leverage thing you can hand over is **real test reports** — the same PDFs
your techs already produce and hand to customers today (PowerDB, Megger, Doble/OMICRON, or
whatever your shop runs). We don't need anything reformatted or cleaned up first.

- **5–10 recent test reports** for the pilot site, any equipment mix (switchgear, transformers,
  breakers, cable, batteries, relays — whatever's typical for this customer). Redact customer
  names if needed; the equipment data is what matters.
- **A rough equipment list** for the pilot site, if one exists outside the reports themselves
  (a spreadsheet is fine — this is a fallback, not a requirement, if the reports alone don't
  cover the full site).
- **Who's doing what**, so we set up the right logins: who needs the office/admin view, and
  which techs need field access on their phone for jobs at this site.

That's it. No data entry, no template-filling, no IT project.

## Week 1 — what happens

1. **We ingest the reports you sent.** ServiceCycle's document parser reads PowerDB/Megger/
   Doble-style PDFs directly and extracts equipment identity (make/model/serial/voltage
   class), the test results themselves, and — where the report includes it — nameplate data.
   This is how the site's equipment list gets built: from the reports, not a blank form.
2. **Low-confidence extractions go to a review queue**, not straight into the record. Anything
   the parser isn't confident about (garbled OCR, an ambiguous unit, a value outside a
   physically plausible range) is flagged for a human to confirm before it becomes part of the
   compliance history — the system doesn't silently guess.
3. **We stand up logins.** Office/admin gets the account-wide dashboard. Field techs get the
   mobile-safe field view, scoped to only the work orders assigned to them — no need to hand a
   subcontractor tech visibility into the whole account.
4. **We walk you through the dashboard together** — the action list (what's overdue, what's
   flagged, what's due soon), not a raw data dump.

## Week 2 — what you see

- **A live equipment record for the pilot site**, built from the reports you handed over in
  week 1 — asset identity, test history, and any deficiencies the reports surfaced.
- **The deficiency → work order loop.** If a report flagged a finding (a hot joint, a failed
  reading, anything outside acceptance criteria), it's sitting in the deficiency queue, and
  creating a tracked work order against it is a couple of clicks — the finding rides on the
  work order until it's resolved, not lost in a PDF nobody reopens.
- **If the pilot site has an arc-flash study on file**, we load it as a PE-stamped, version-
  controlled record (ServiceCycle stores and displays the licensed engineer's sealed study —
  it does not run its own arc-flash calculation or assert PPE categories itself).
- **Two leave-behind artifacts**, generated from the live data: a NETA-format compliance
  packet for whoever's tracking the technical record, and a CFO-facing maintenance-debt/ROI
  summary for whoever signs the renewal.
- **A field-tech walkthrough**, if techs are in scope for this pilot: log in on a phone, see
  only assigned jobs, pull up the asset and its history on-site.

## What we're explicitly not doing in a pilot

- Building out every site the contractor services — one pilot site, real depth, not broad
  and shallow.
- Scheduling/dispatch/invoicing — ServiceCycle isn't replacing whatever the shop already uses
  for that; it's the compliance/asset-of-record layer. A documented v1 REST API (OpenAPI 3.1)
  exists for whoever wants to connect the two later.
- Any integration build (PowerDB direct connector, accounting system, etc.) — the pilot proves
  value off the PDFs contractors already produce, not a new IT project.

## After the pilot

If it's a fit, the conversation moves to: which additional sites/customers roll in first, who
owns the account long-term (the contractor, the end customer, or both with role-based access),
and pricing (see the separate SOW template — pricing is intentionally not filled in here).

# Reports

Reports are where ServiceCycle's running record becomes something you can hand to
someone else — an auditor, an insurer, a CFO, a customer, a PE. The day-to-day value
is the short action list; the formal report is the one-click export for when someone
official asks to see the program. The Reports hub (Sidebar → Reports) is a grid of
everything available, grouped below by what it's for.

## Compliance & audit evidence

**Compliance by Standard** rolls maintenance status up per governing standard — NFPA
70B and every other standard in your task library — with asset counts, a compliance
rate, and a drill-down evidence table per standard. This is the "show me your
program" view, standard by standard.

**Overdue Maintenance by Severity** groups overdue tasks and open deficiencies by
severity (Immediate / Recommended / Advisory) with days-overdue aging, so the
riskiest gaps surface first.

**Standards Library** is a plain-language guide to the governing documents — NFPA
70B/70E/110, NETA MTS/ATS, IEEE C57.104/43, OSHA 1910 Subpart S — what each means
for your facility and what the platform tracks for it.

**Audit Evidence Snapshots** generate immutable, point-in-time PDF compliance reports
with SHA-256 integrity hashes anchored in the tamper-evident audit log. A snapshot is
*generated and stored*, not re-derived later, so a report you showed an auditor can
be proven unchanged afterward — that's what makes it evidence rather than a screen.

**EMP Document** is your formal NFPA 70B §4.2 Electrical Maintenance Program as a
PDF: asset inventory, maintenance intervals, 24-month work-order history, condition
ratings, open deficiencies, and personnel qualifications. It's the program-of-record
insurers ask for at policy renewal.

## Planning & fleet

**1 / 3 / 5-Year Maintenance Plan** projects your active schedules over a five-year
horizon from each task's interval and the asset's governing condition — maintenance
load by year, with outage-required and NETA-certified counts and the assets and sites
touched. The multi-year view for budgeting and scoping.

**Installed-Base Intelligence** places each asset's latest test readings in
percentile context against comparable units, with trend direction, and lays out the
Watch / Plan / Act modernization pipeline built on age, condition, and end-of-support
— plus the identified → quoted → converted attach-rate funnel. Fleet context for
planning conversations; the condition decisions stay with qualified engineers.

## Arc flash

Four report surfaces cover the arc-flash program (see the **Arc Flash** module for
the full lifecycle):

- **Arc Flash Label Report** — every current NFPA 70E 130.5(H) label across your
  sites (nominal voltage, incident energy, boundary, PPE / minimum arc rating,
  DANGER/WARNING severity) with study dates and what's expiring within 90 days. The
  label schedule auditors ask for.
- **Arc Flash Fleet Dashboard** — arc-flash risk rolled up across every site: DANGER
  coverage, blocked buses still needing data, average data-confidence, open
  sanity-check findings, and studies expiring soon. Generate an on-demand
  audit/insurer bundle from here.
- **Arc Flash Heat-Map** — a color-coded grid of every labelled bus, grouped by site
  and shaded by incident energy, for an at-a-glance view of where the hazard
  concentrates.
- **Arc Flash Search** — ask in plain English ("480V MCC over 8 cal that are
  blocked", "switchgear with expired studies") and get the matching buses, with the
  interpretation shown so results are explainable.

## Inspection & condition

**IR Thermography (NFPA 70B §7.4)** is the infrared survey record — thermographer and
qualification, camera and scan conditions, and every finding graded against NETA
Table 100.18 (below-threshold spots included, kept for trending) with the source IR
report as evidence. See the **IR Thermography** module.

## Revenue

**Revenue Attribution** traces the closed loop from platform signal to paid work —
how Path-to-100, modernization, arc-flash, and QEMW alerts become quote requests,
accepted quotes, and completed work orders, with estimated dollar value and
conversion at each stage.

## Exports (no lock-in)

**Asset Register** downloads the full register as an XLSX workbook — equipment type,
manufacturer, model, serial, site, condition, and schedule status for every asset.

**Account Backup** downloads a complete, portable copy of your account as an Excel
workbook — every site, asset, schedule, work order, deficiency, quote request,
arc-flash study and label, LOTO procedure, parts catalog, spare inventory, and part
requirement, plus document and snapshot metadata with integrity hashes, one sheet per
record type. It opens directly in Excel or Sheets — yours to keep or re-import
anywhere.

## Sharing with an outside party

When you need to hand a compliance package to an underwriter or auditor without
giving them a login, a **time-boxed, revocable share link** gives them a read-only,
watermarked view carrying their name. You can see how many times it's been viewed and
revoke it at any time.

## Common workflows

**"An auditor is coming — what do I hand them?"** Pull the Compliance-by-Standard
report and/or generate an Audit Evidence Snapshot so the numbers are frozen and
provable, plus the per-standard evidence for whatever they're asking about.

**"Show the multi-year budget picture."** The 1 / 3 / 5-Year Maintenance Plan lays
out the maintenance load by year with the outage and certified-tech counts.

**"Get everything out of the system."** Account Backup gives you the whole account as
an Excel workbook, one sheet per record type — no lock-in.

## When something looks wrong

**A snapshot doesn't reflect a change I just made.** That's intended — snapshots are
frozen at generation so they stay valid as evidence. Generate a new one for the
current state.

**The compliance percentage seems harsh.** Uncovered assets — equipment with no
maintenance tasks applied yet — count against it on purpose; applying tasks raises
both coverage and the score. See *Scores, Ratings & Forecasts*.

**A share-link recipient says it won't open.** Check that it hasn't expired or been
revoked; both are visible on the share-link list, and you can issue a fresh one.

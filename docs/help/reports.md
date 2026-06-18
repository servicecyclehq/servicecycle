# Reports

Reports are where ServiceCycle's running record becomes something you can hand to
someone else — an auditor, an insurer, a CFO, a customer. The day-to-day value is
the short action list; the formal report is the one-click export for when someone
official asks to see the program.

## What you'll see

The Reports hub (Sidebar → Reports) is a grid of the available reports. They fall
into a few groups: compliance posture, evidence packs per standard, the action
list to reach 100%, and stakeholder summaries.

## Compliance posture & path to 100%

The compliance summary gives you the honest current state — assets tracked,
schedules current versus overdue, open deficiencies — and the **path-to-100** view
turns that into an ordered action list: exactly which tasks and gaps stand between
you and full compliance, worst first. This is the "what's needed to hit 100%"
answer, not just a score.

## Per-standard evidence packs

For an audit you can pull a per-standard report — NFPA 70B, NETA MTS, the relevant
IEEE documents — that assembles the evidence for that standard: what's covered,
what's due, and the supporting test history. These are designed to be the thing
you show when an OSHA inspector or insurer asks "show me your program."

## The EMP (written program)

ServiceCycle generates the NFPA 70B written **Electrical Maintenance Program**
document on demand — the formal program-of-record covering condition assessments,
the maintenance matrix, the compliance calendar, and the incident log. It's the
big document that nobody reads day to day but that you must be able to produce.

## Snapshots & integrity

A snapshot is a point-in-time report that is **generated and stored**, not
re-derived later. Each carries a SHA-256 fingerprint anchored into the activity
log, so a snapshot you showed an auditor can be proven unchanged afterward.
Snapshots don't move when your live data moves — that's what makes them evidence.

## Stakeholder & customer summaries

Beyond the technical reports, ServiceCycle produces plain-language summaries for
non-technical readers — a customer digest and a board-grade CFO report covering
readiness, open risk, and estimated remediation cost. These exist so the people
who fund the work can see its value without reading a test report.

## Share links

You can share a compliance package with an outside party — an underwriter or
auditor — via a **time-boxed, revocable link**. The recipient gets a read-only,
watermarked view (carrying their name) without needing an account, and you can see
how many times it's been viewed and revoke it at any time.

## Common workflows

**"An auditor is coming — what do I hand them?"** Pull the per-standard evidence
pack and/or generate a snapshot so the numbers are frozen and provable.

**"What's between us and 100%?"** The path-to-100 report lists the exact actions in
priority order.

**"Show the CFO why this matters."** The CFO report frames readiness, risk, and
estimated spend in business terms.

**"Send proof to our insurer without giving them a login."** Create a share link;
it's read-only, watermarked, expiring, and revocable.

## When something looks wrong

**A snapshot doesn't reflect a change I just made.** That's intended — snapshots
are frozen at generation so they stay valid as evidence. Generate a new one for
the current state.

**A share link recipient says it won't open.** Check that it hasn't expired or been
revoked; both are visible on the share-link list, and you can issue a fresh one.

**The compliance percentage seems harsh.** Uncovered assets count against it on
purpose; applying maintenance tasks to them raises both coverage and the score.
See *Scores, Ratings & Forecasts*.

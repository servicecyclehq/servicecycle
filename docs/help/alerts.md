# Alerts

Alerts are how ServiceCycle tells you maintenance is coming due before it's a
problem — and keeps telling you, louder, if it slips. They turn the compliance
calendar into something that reaches out to you rather than something you have to
remember to check.

## What you'll see

The Alerts page lists open alerts with their context — the asset, the schedule,
and how soon (or how overdue) the work is. The bell in the sidebar shows your
pending count and takes you straight there. Acknowledging an alert clears it from
the open list once you've acted on it.

## Lead-time tiers

For upcoming maintenance, alerts fire on a tiered ladder so the long-lead work
gets booked early and the near-term work gets a final nudge — by default at around
180, 120, 90, 60, 30, and 7 days before the due date. The far-out tiers are your
cue to schedule a contractor and plan an outage; the close-in tiers are the
last-call reminders.

## Overdue & escalation

If a task passes its due date, the tone changes. An overdue alert fires, and if it
keeps slipping it escalates — from overdue to a sharper escalation notice to a
regulatory-breach flag — so a chronically ignored item gets progressively harder
to miss. These compliance signals always deliver: unlike the upcoming-maintenance
tiers, you cannot switch overdue and escalation alerts off, because suppressing
them would defeat the point.

## Preferences

Each user controls their own upcoming-maintenance alerts — which lead-time tiers
they want and whether they arrive by email. Set these under the Alerts
preferences. The overdue, escalation, and breach alerts are not user-suppressible.

## Daily digest & channels

Alerts are evaluated once a day and rolled into a digest so you get one
consolidated picture rather than a stream of one-offs. Beyond email, an account
can route alerts to a Slack or Teams channel so the whole team sees what's due
without logging in.

## Common workflows

**"I want a heads-up earlier on big jobs."** Add the 180- or 120-day tier to your
preferences so long-lead work surfaces in time to book it.

**"Stop emailing me the 7-day reminders."** Turn off the tiers you don't want in
your alert preferences — the upcoming-maintenance tiers are yours to tune.

**"Get the team a shared feed."** Connect a Slack or Teams webhook under Settings
so alerts post to a channel.

## When something looks wrong

**I'm not getting any alert emails.** Check that email is configured for the
account (Settings) and that your per-type email toggle is on; the deterministic
calendar still works even when email isn't set up.

**An overdue alert won't go away.** Overdue and escalation alerts persist until the
underlying work is actually recorded as done — acknowledging doesn't clear the
condition, completing the work does.

**I'm getting too many notices.** Trim your upcoming-maintenance tiers in
preferences. Note that overdue and escalation alerts will still come through by
design.

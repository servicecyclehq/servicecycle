# Sites & Locations

A site is a physical facility — a plant, a campus, a distribution center. Sites
give every asset a place in the world and a hierarchy you can navigate, and they
carry the things that are true of a location rather than a single device:
on-site contacts, outage windows, and arc-flash studies.

## The location hierarchy

ServiceCycle models a flexible tree:

    Site → Building → Area → Position → Asset

Only the site and the asset are required. A small facility can hang assets
straight off the site; a large industrial plant can use every level. Buildings
and areas are optional groupings; a position is the physical spot a device lives
in (a switchgear lineup slot, a transformer pad), which is what lets a new test
report match a reading to the right asset even when serials are missing.

## On-site contacts

Each site holds its primary contact — name, email, phone. This is who gets looped
in on site-specific notices and who a quote request or emergency routes through.
Keep it current; it is the human ServiceCycle reaches when something at that
location needs attention.

## Blackout & outage windows

A site can define date windows that change what work is allowed:

- An **outage window** is a planned shutdown — the time when energized-off work
  (the jobs that need the equipment de-energized) can actually happen. The Outage
  Planner uses these to consolidate everything that should be done while the power
  is down.
- A **freeze window** is the opposite — a period when no work should be scheduled
  at all (a peak production run, a critical event).

Setting these correctly is what makes the scheduling and outage-planning advice
trustworthy.

## Arc-flash & system studies

Engineering studies live at the site level because they describe the facility's
power system, not one device. ServiceCycle tracks arc-flash, short-circuit,
coordination, and one-line studies as first-class records, each with the engineer
of record and a **5-year review clock** (NFPA 70E 130.5(G)); the app warns you as
a study nears or passes expiry.

Bind a study to the assets it covers and each one carries the on-equipment label
data NFPA 70E 130.5(H) requires — nominal voltage, incident energy, arc-flash
boundary, working distance, and PPE category. Binding can cascade to downstream
equipment; downstream rows are left blank rather than guessed, so the gaps are
honest and visible. See *Scores, Ratings & Forecasts* for what "covered" means.

## Common workflows

**"Set up a new facility."** Create the site, add its contact, then add buildings
/areas/positions only as deep as you actually need before adding assets.

**"When can we do the de-energized work?"** Define the site's outage window; the
Outage Planner then groups every outage-dependent task into that window.

**"Is our arc-flash study still current?"** Open the site's studies; each shows
its performed date and 5-year expiry, and the app alerts as expiry approaches.

## When something looks wrong

**A report's readings won't match an asset at this site.** Check that the asset's
position matches what the report names; position is one of the fallbacks the
matcher uses when a serial is absent.

**An arc-flash label shows blank fields.** The asset is bound to a study but its
label data isn't filled in — most often because it was picked up as downstream
equipment. Enter the values from the study report to complete the label.

**Scheduled work is landing on a day we're shut down — or frozen out.** Confirm
the site's outage and freeze windows are set with the right dates; the scheduler
reads them to decide what can happen when.

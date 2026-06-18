# Work Orders

A work order is the record of a maintenance visit: what was scheduled, who did it,
what they found, what they fixed, and what condition the equipment was left in.
It is where field results turn into compliance evidence and into the deficiencies
that drive the next round of work.

## What you'll see

**The work-orders list** shows scheduled, in-progress, completed, and cancelled
jobs. The priority queue floats the most urgent work — overdue tasks and C3
assets — to the top so you can see what to do next at a glance.

**A work-order detail page** holds the visit's test measurements, its deficiency
findings, the as-found and as-left condition, and the NETA decal applied to the
equipment.

## As-found / as-left condition

NETA practice records the equipment's condition both **as found** (the state on
arrival) and **as left** (the state on completion). Capturing both is what makes a
test history meaningful: it shows whether a visit actually moved the asset's
condition, and it feeds the asset's governing condition and trend.

## Test measurements

Each measurement records what was tested (insulation resistance, contact
resistance, turns ratio, and so on), the as-found and as-left values with units,
the expected range from the governing standard, and a pass/fail result. A failing
result automatically generates a deficiency so nothing falls through the cracks.
Test conditions — ambient temperature, humidity, the calibrated instruments used —
are captured alongside, because the standards require them for the result to mean
anything. Deleting a measurement is a soft-delete: the row is retained for
forensic integrity rather than erased.

## Deficiencies

A deficiency is something that needs fixing, carried at one of three severities —
**immediate**, **recommended**, or **advisory**. They are created automatically
from failed measurements and from the analysis modules (DGA, thermography), and
you can add them by hand. The account-wide Deficiencies page (in the sidebar)
triages every open finding across all assets; resolving one records who closed it
and when.

## NETA decals & completion

On completion you apply a NETA condition-of-maintenance decal — **Serviceable**
(green), **Limited Service** (yellow), or **Non-Serviceable** (red) — which is the
sticker that goes on the equipment and the headline status the asset carries
forward. Completing a work order rolls its schedule's next-due date forward,
updates the asset's condition, and — if enabled — can auto-send a leave-behind
summary to the site contact. A work order created from an accepted quote closes
the loop from "quote" through "work done" to "back in compliance."

## Common workflows

**"What's the most urgent job right now?"** Open the priority queue; overdue and
C3 work sits at the top.

**"Record a completed visit."** Enter the measurements with as-found/as-left
values, set the as-left condition and NETA decal, and mark it complete — the
schedule and asset update themselves.

**"Where did this deficiency come from?"** Open the work order it's attached to;
failed measurements link straight to the readings that triggered them.

## When something looks wrong

**A failed reading didn't create a deficiency.** Confirm the measurement is marked
failing and within a committed work order — pass/fail is what triggers the
auto-deficiency.

**The asset's condition didn't change after a visit.** The as-left condition and
NETA decal are what update the asset; make sure both were set before the work
order was completed.

**A measurement I deleted still shows in history.** Measurement deletes are
soft-deletes by design (forensic integrity). The value is retained but marked
removed rather than purged.

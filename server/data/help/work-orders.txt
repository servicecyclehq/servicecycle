# Work Orders

A work order is the record of a maintenance visit: what was scheduled, who did it,
what they found, what they fixed, and what condition the equipment was left in.
It is where field results turn into compliance evidence and into the deficiencies
that drive the next round of work.

## What you'll see

**The work-orders list** shows scheduled, in-progress, completed, and cancelled
jobs. The priority queue floats the most urgent work — overdue tasks and C3
assets — to the top so you can see what to do next at a glance.

**A work-order detail page** holds the visit's test conditions and instruments,
its test measurements, its deficiency findings, any lab samples, the as-found and
as-left condition, and the NETA decal applied to the equipment.

## As-found / as-left condition

NETA practice records the equipment's condition both **as found** (the state on
arrival) and **as left** (the state on completion). Capturing both is what makes a
test history meaningful: it shows whether a visit actually moved the asset's
condition, and it feeds the asset's governing condition and trend.

## Test conditions & instruments

Each job records the ambient temperature and humidity it was performed under and the
calibrated instruments used, because the standards require them for a result to mean
anything. NETA expects instruments calibrated within 12 months and NIST-traceable,
so the instrument list is part of the evidence, not an afterthought.

## Test measurements

Each measurement records what was tested (insulation resistance, contact
resistance, turns ratio, and so on), the as-found and as-left values with units,
the expected range from the governing standard, and a pass/fail result. A failing
result automatically generates a deficiency so nothing falls through the cracks.
Deleting a measurement is a soft-delete: the row is retained for forensic integrity
rather than erased.

## Lab samples (DGA & oil)

For liquid-filled equipment, a work order can carry lab-sample results — most
importantly **dissolved gas analysis (DGA)** graded per IEEE C57.104: the individual
gas concentrations in ppm (H₂, CH₄, C₂H₂, C₂H₄, C₂H₆, CO, CO₂, O₂, N₂), the IEEE
C57.104 status (Normal / Caution / Action required), and an optional fault code. Oil
quality and fuel samples are recorded the same way. These sit alongside the
electrical measurements so a transformer's chemical and electrical health live on
the same record.

## Deficiencies

A deficiency is something that needs fixing, carried at one of three severities —
**immediate**, **recommended**, or **advisory**. They are created automatically
from failed measurements and from the analysis modules (DGA, thermography), and
you can add them by hand. The account-wide Deficiencies page (in the sidebar)
triages every open finding across all assets; resolving one records who closed it
and when.

## Field-technician assignment

A work order can be assigned to a specific field technician. Field technicians see
only their assigned work orders in the mobile field view (default-deny), so a tech
on site gets exactly their list and nothing more. The assigned tech's NETA level is
checked against the task's required certification level so an unqualified assignment
can't be recorded against work a standard says needs a qualified person.

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

**"Record a completed visit."** Enter the conditions and instruments, the
measurements with as-found/as-left values, any lab samples, set the as-left
condition and NETA decal, and mark it complete — the schedule and asset update
themselves.

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

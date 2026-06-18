# Maintenance Schedules

A schedule pairs an asset with a maintenance task and answers the only question
that matters day to day: when is it next due? Together, every asset's schedules
form the compliance calendar — the running picture of what's current, what's
coming, and what's overdue.

## Task definitions

A task definition is a reusable description of a job — "switchgear infrared
thermography," "transformer DGA," "breaker contact resistance" — with the standard
it comes from and the conditions it imposes (needs an outage, needs the equipment
energized, needs a NETA-certified technician at a minimum level). ServiceCycle
ships a matrix of standards-grounded task definitions covering every equipment
type, drawn from NFPA 70B, NFPA 70E, NETA MTS, and the relevant IEEE documents.
You can add your own tasks on top of the built-in set.

## Condition-based intervals (C1 / C2 / C3)

Each task carries three intervals — one per NFPA 70B condition. The asset's
governing condition picks which interval applies, so a healthy asset is seen on
the base cadence and a degraded one is seen more often:

- **C1 (good)** stretches the interval the most.
- **C2 (fair)** is the base cadence.
- **C3 (poor)** tightens it the most.

Because condition drives frequency, anything that worsens an asset's condition —
including the automatic C3 from missed cycles — pulls its next-due date in
automatically.

## Next-due computation & overrides

The next-due date is the last completed date plus the interval for the governing
condition. It is recomputed whenever you record a completion or the asset's
condition changes, so the calendar is always current without you recalculating
anything.

Two levers let you tailor a schedule without touching the asset:

- A **per-schedule condition override** sets C1/C2/C3 for that one task
  independently of the asset's governing condition — useful when, say, a battery
  string on an otherwise healthy unit needs the tighter cadence.
- **Lead times** control how far ahead the scheduling and customer notices fire
  (defaults around 180 days for booking the work and 90 days for customer
  planning).

## Acceptance / baseline tests

Marking a test as an acceptance or commissioning test makes it the **year-0
baseline** for that asset (NFPA 70B). Trends are measured from the baseline, and
the app won't raise year-over-year deviation flags against it — there is nothing
older to trend against.

## Common workflows

**"Apply a task to lots of assets at once."** Use bulk-apply to attach a task
definition to every asset of a type rather than adding it one by one.

**"This asset needs a tighter cadence than its condition implies."** Set a
condition override on that schedule; the next-due date recomputes immediately.

**"Mark a job done."** Record the completion (or complete the work order); the
schedule's next-due date rolls forward automatically.

## When something looks wrong

**A next-due date looks too soon.** Check the asset's governing condition — a C2
or C3 rating, or a per-schedule override, compresses the interval by design.

**An asset shows no schedules.** No task definitions have been applied to it yet.
Apply the relevant tasks (individually or via bulk-apply) and the calendar fills
in.

**Trends are flagging the very first test.** That first reading should be marked
as the acceptance/baseline test so it anchors the trend instead of being compared
against.

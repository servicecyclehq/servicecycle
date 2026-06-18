# Contractors

Contractors are the organizations — and the individual technicians — who perform
the testing and maintenance. ServiceCycle tracks who is qualified to do what, so
the right person is on the right job and a lapsed certification never slips
through. A contractor can be an outside NETA-accredited shop or your own in-house
crew.

## What you'll see

**The contractors list** shows each organization, whether it is NETA-accredited or
an internal crew, and how many technicians it carries. Open one to see its
technicians and their credentials, and to record support contacts (email, phone,
portal) for when you need to reach them.

**Technicians** each carry the credentials that decide what work they may sign:

- **NETA ETT level** (ANSI/NETA Electrical Testing Technician, Level I–IV).
- **Qualified-person status** under NFPA 70E — the employer's written
  designation, which is what the standard actually requires; a training
  certificate alone is not enough.
- **Training currency** — 70E retraining runs on at most a three-year interval.
- **Thermographer certification** for anyone producing infrared reports.

## The QEMW credential wallet

QEMW is the qualified electrical maintenance workforce: the people who actually do
the work. The wallet (Contractors → QEMW wallet) is a read-only roll-up of every
technician's credentials with the gaps surfaced. Each credential shows as
**valid**, **expiring** (inside 60 days), or **expired**, and the page computes a
**coverage gap**: when upcoming jobs that require a certified tech have no
qualified, in-date technician available, it warns you so you can schedule
retraining or line up a contractor before the work comes due. Expiry alerts fire
ahead of time so a credential never lapses unnoticed.

## How credentials gate work

When a maintenance task is marked as requiring a NETA-certified technician at a
minimum level, ServiceCycle checks the assigned tech's ETT level against that
requirement. This keeps an unqualified assignment from being recorded against a
task that a standard says must be done by a qualified person.

## Common workflows

**"Add a testing company we use."** Create the contractor, mark whether it is
NETA-accredited, and add its technicians with their certification levels.

**"Who can do this certified job next month?"** Check the QEMW wallet's coverage
gap — it tells you whether you have a qualified, in-date tech for the certified
work that's coming due.

**"A tech's NETA cert is about to expire."** The wallet flags it as *expiring*
inside 60 days and alerts fire ahead of the date, so you can book retraining
before it lapses.

## When something looks wrong

**A tech can't be assigned to a job.** The task likely requires a NETA level the
technician doesn't hold. Assign a qualified tech, or update the technician's
certification level if it is simply out of date in the record.

**The QEMW wallet shows a coverage gap I don't understand.** It means certified
work is coming due in the window and no valid-or-expiring qualified tech is
available for it. Add a qualified tech, renew an expiring one, or plan to bring in
a contractor.

**A contractor won't save because the name already exists.** Contractor names are
unique per account; you (or a bulk import) already have one by that name. Open the
existing record instead of creating a second.

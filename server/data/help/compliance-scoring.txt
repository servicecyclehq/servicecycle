# Scores, Ratings & Forecasts

A plain-language guide to the numbers ServiceCycle puts in front of you: what each
one means, where it comes from, and how to act on it. Every figure here is a
decision-support estimate grounded in published standards (NFPA 70B, NFPA 70E,
IEEE, ANSI/NETA). They are not a substitute for the judgment of a qualified
engineer. Always confirm before a consequential budget, safety, or contract
decision.

## NFPA 70B condition ratings (C1 / C2 / C3)

Every asset carries a maintenance condition rating on the NFPA 70B 2023 scale.
It is the single biggest driver of how often the asset must be serviced.

- **C1 - Good.** Like-new and maintained on schedule. Standard intervals apply.
- **C2 - Fair.** A minor deviation (a late cycle, a small as-found issue). The
  maintenance interval compresses so the asset is seen more often.
- **C3 - Poor.** A significant deviation, a harsh operating environment, or two
  or more missed maintenance cycles. Intervals tighten the most.

**Governing condition.** An asset is assessed on several axes (physical,
electrical, mechanical, environment). The *worst* axis governs - one C3 finding
makes the whole asset C3, because the riskiest factor sets the schedule.

**Automatic C3.** If an asset misses two or more maintenance cycles, ServiceCycle
flags it C3 on its own (NFPA 70B 9.3.1) and tightens the schedule, so a lapsed
asset can never silently keep a relaxed interval. Clearing the backlog and
recording a completed cycle restores the rating.

**Telemetry-triggered C2.** When a connected condition-monitoring gateway pushes
a reading that breaches the critical threshold — winding temperature over limit,
vibration outside normal range, partial-discharge spike — ServiceCycle
automatically escalates the asset to C2 (NFPA 70B §C2 worst-of logic). The
condition badge changes, the maintenance interval compresses, and an alert fires.
The C2 is reversible: it clears when the reading returns to normal or a reviewer
acknowledges the notification. This is the continuous-monitoring complement to
the point-in-time test results you record in work orders.

## Remaining useful life (RUL) & modernization risk

The modernization risk score estimates how far through its life an asset is, so
you can plan replacements before failures. It is computed as:

    risk = asset age / (base life x condition multiplier)

- **Base life** is set per equipment class from published guidance - e.g. a
  liquid-filled transformer ~30 years (IEEE C57.91), MV switchgear ~30 years,
  a microprocessor relay ~20 years, VRLA batteries ~5 years (IEEE 1188). The
  full table draws on IEEE C57.91/96, C37.06/16, PSRC WG I22, ANSI/NETA
  MTS-2023, and ASHE guidance.
- **Condition multiplier** shortens that life as condition degrades: C1 x1.00,
  C2 x0.85, C3 x0.50, and an active unresolved safety deficiency x0.60.
- If the manufacturer has published an **end-of-support date**, that overrides
  the estimate and the score ramps over the final 5 years.

**What the score means:**

- **under 0.5 - Healthy.** No action.
- **0.5 to 0.7 - Watch list.** Tracked internally; no alert yet.
- **0.7 to 0.85 - Planning advisory.** Put it in the ~18-month budget horizon.
- **0.85 to 1.0 - High urgency.** Belongs in next year's budget.
- **over 1.0 - Critical.** Past its condition-adjusted expected life; prioritize.

The multipliers and thresholds are engineering judgment calibrated against fleet
outcomes, not bright-line rules in any single standard. Treat the score as a
ranked planning signal, not a prediction of a specific failure date.

## Book depreciation vs. functional life (a CFO question)

Your accounting depreciation schedule and ServiceCycle's modernization-risk clock
are answering two different questions, and they're supposed to disagree.

Electrical distribution equipment is typically depreciated for tax/accounting
purposes on a much shorter schedule than it actually lasts — under IRS MACRS,
most electrical switchgear and distribution equipment falls in a 15-year class
life. That's a bookkeeping convention: it says nothing about whether the
equipment still works. ServiceCycle's base-life figures (e.g. ~30 years for MV
and LV switchgear, per ASHE/AHA facility-equipment guidance and the IEEE/ANSI
standards cited above) describe *functional* life — how long the equipment is
expected to keep performing safely with normal maintenance.

**In plain terms:** a switchgear lineup can be fully depreciated to zero book
value on the balance sheet at year 15 while ServiceCycle still shows it healthy
and mid-life, because it's tracking condition and engineering life expectancy,
not tax basis. Neither number is wrong — they're not measuring the same thing.
When a modernization-risk score climbs, that's a signal about physical
condition and expected remaining service life, independent of what the
equipment is worth on the books.

## Forecast ranges & budget horizons

ServiceCycle turns the risk score into *when* to plan, not a promise of when
something will fail. The horizons above (this year vs. ~18 months vs. watch) are
deliberately coarse, and any dollar figures attached to remediation are
order-of-magnitude estimates from your rate cards and typical scope - they widen
the further out you look. Use them to sequence and budget work, and refine the
numbers with a quote before committing spend.

## Arc flash studies & labels (NFPA 70E)

An arc-flash study is a first-class record in ServiceCycle with its own 5-year
review clock (NFPA 70E 130.5(G)); the app warns you as a study approaches or
passes expiry. Each asset covered by a study carries the label data NFPA 70E
130.5(H) requires:

- nominal voltage
- incident energy (cal/cm2)
- arc-flash boundary
- working distance
- PPE category (0 to 4)

An asset counts as **covered** when it is bound to a current study *and* its
label data is complete. Binding a study can cascade to the equipment fed
downstream, and downstream rows are left blank rather than guessed - honest gaps
you can see and fill.

## QEMW - the credential wallet

QEMW is the qualified electrical maintenance workforce: the technicians who
actually perform the testing. The wallet tracks each tech's credentials and
flags gaps before they bite:

- NETA ETT (Electrical Testing Technician) level
- NFPA 70E qualified-person status
- IR thermographer certification
- training status

Each credential shows as **valid**, **expiring** (within 60 days), or
**expired**. The wallet also computes a **coverage gap**: when upcoming jobs that
require a certified tech have no qualified, in-date technician available, it warns
you so you can schedule training or assign a contractor before the work comes due.

## A note on accuracy

These scores, ratings, and forecasts are estimates built from your recorded data
and published standards. They are designed to help you prioritize and plan - not
to replace an engineering study, a manufacturer's guidance, or the judgment of a
qualified person. Verify anything you would stake a safety or budget decision on.
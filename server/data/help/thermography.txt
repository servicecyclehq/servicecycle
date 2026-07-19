# IR Thermography (§7.4)

Infrared thermography is how you catch a loose connection or an overloaded circuit
before it fails — a hot spot shows up on a thermal camera long before it trips a
breaker or starts a fire. NFPA 70B:2023 §7.4 makes periodic IR surveys part of a
maintenance program, and ServiceCycle records them as structured evidence: every
survey, every hot spot, graded against NETA MTS-2023 Table 100.18, with the source
report kept on file.

> **ServiceCycle records and grades IR surveys; it does not perform the scan.** A
> qualified thermographer captures the images and produces the report. ServiceCycle
> reads that report into a structured record, applies the NETA severity bands, and
> keeps the evidence — it is a system of record, not a thermal-analysis tool.

## How a survey enters ServiceCycle

IR surveys are captured on the asset that was scanned. Open the asset and use the
**IR thermography survey** card:

1. **Attach the IR report (PDF).** Drop in the thermographer's report (PDF, or a
   JPG/PNG image up to 20 MB). It is stored as the survey's evidence on the asset
   (§7.4). The thermal images themselves stay inside the report.
2. **Paste the report text to pre-fill (optional).** Paste the survey text and
   ServiceCycle reads it: lines carrying a temperature rise (ΔT) become hot spots,
   and the header — camera, emissivity, ambient, load — is read where present. This
   is a convenience, not a requirement; you can type everything by hand.
3. **Confirm the survey conditions.** Thermographer and qualification, camera make
   and model, ambient temperature, humidity, emissivity, reflected temperature, and
   load at the time of the scan. The standards require these for a reading to mean
   anything. Any field the parser couldn't read confidently is outlined in amber
   with *"Not found in the report — enter manually."*
4. **Review the findings.** Each hot spot is one row: the component, its ΔT in °C,
   the reference frame, an optional reference ΔT, and load. **Every row is
   recorded — including below-threshold ones** — because a spot that isn't a
   deficiency today is still the trend that tells you it's getting worse.

Click **Preview / parse** to grade the hot spots, then **Save survey**. Saving
writes the structured survey, creates a deficiency for each graded finding, keeps
the below-threshold spots for trending, and attaches the PDF as evidence.

## Reference frames — what a ΔT is measured against

A temperature rise only means something relative to a baseline. Each finding
carries one of three reference frames:

- **Over ambient** — the component's rise above the surrounding air.
- **Similar component** — the rise versus an identical component under the same
  load (e.g. one phase against the other two). This is the most diagnostic frame,
  because it controls for load and environment.
- **Vs. baseline** — the rise versus this component's own prior reading.

## NETA Table 100.18 severity

ServiceCycle grades each hot spot against NETA MTS-2023 Table 100.18 and maps the
result to one of its own severities:

- **Immediate** — a large delta demanding action now; the finding becomes an
  immediate-severity deficiency.
- **Recommended** — a real deviation to correct on a planned basis.
- **Advisory** — a minor rise worth watching.
- **Below threshold** — under the deficiency line. It creates no deficiency but is
  still recorded, because it anchors the trend for the next survey.

## The per-asset survey history

Every asset with a survey carries an **IR survey history** on its detail page. It
shows each survey with its date, conditions, findings, and an *IR report
(evidence)* link to the source document. Above the surveys, a **component trend**
tracks each hot spot's ΔT across surveys — a green down-arrow when it's improving, a
red up-arrow with the delta when it's worsening, and *stable* when the change is
under a degree (a 1 °C wobble between surveys is measurement noise, not a trend).

## The IR Thermography report

**Reports → IR Thermography (NFPA 70B §7.4)** rolls surveys up account-wide or per
site. It shows each survey's conditions and a findings table — component, ΔT,
reference, reference ΔT, load, NETA severity, and corrective action — plus a summary
of findings by severity and a NETA Table 100.18 legend so a reader knows exactly
how each band was graded. **Download PDF** produces the audit copy. The report is
also reachable for a single survey, and it feeds the Compliance-by-Standard
drill-down for §7.4.

## Common workflows

**"Log the IR survey the contractor just sent."** Open the scanned asset → *Import
IR survey* → attach the PDF, paste the text to pre-fill, confirm the conditions and
findings, and save.

**"Is this hot spot getting worse?"** Open the asset's IR survey history and read
the component trend — the arrow and delta tell you whether the ΔT is climbing survey
over survey.

**"Show the auditor our §7.4 evidence."** Reports → IR Thermography → Download PDF,
or filter to one site. Each survey carries its conditions and its source report as
evidence.

## When something looks wrong

**The survey history isn't showing on an asset.** The card only appears once at
least one survey exists for that asset (and IR capture is enabled for the account).
Import a survey from the asset's page and it appears.

**A finding row didn't save.** A row is only recorded when its ΔT is filled in — a
component name with no ΔT is dropped. Enter the temperature rise for every hot spot
you want kept.

**The parser flagged fields in amber.** That means it couldn't read those values
confidently from the report. Type them in — the amber note clears once the field
has a value. Parsed values only ever fill *empty* fields, so anything you typed is
never overwritten.

**A below-threshold spot didn't create a deficiency.** That's by design — spots
under the NETA threshold are kept for trending but don't raise a deficiency. They
still appear in the survey and the report.

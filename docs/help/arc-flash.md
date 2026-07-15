# Arc Flash

Arc flash is a sudden release of electrical energy through the air. ServiceCycle
manages the complete arc-flash lifecycle: uploading IEEE 1584 study results,
generating NFPA 70E-compliant labels, tracking per-equipment energy data, and
exporting data to third-party analysis tools.

> **Important:** ServiceCycle is a record-keeping and label-generation tool.
> Arc-flash energy calculations must be performed by a licensed Professional
> Engineer using IEEE 1584-compliant software. ServiceCycle stores and displays
> the results; it does not perform the engineering analysis.

## How arc-flash data enters ServiceCycle

### Uploading a study PDF

The most common path: your PE firm delivers a study report as a PDF.

1. **Sites → [your site] → Arc Flash tab → Upload study PDF.**
2. Fill in the study metadata: date performed, PE name and license number,
   performing firm, IEEE 1584 method used, and expiry date (typically 5 years
   from the study date per NFPA 70E).
3. ServiceCycle's AI extracts per-bus incident energy values, PPE categories,
   and approach boundaries from the PDF. Review the extracted values — green
   confidence means auto-accepted; yellow or red means the field needs your
   verification.
4. Save. The study is now live and linked to the site.

> **AI extraction is a draft, not a verified model.** Whether you upload a study
> report or a one-line diagram, ServiceCycle's automated extraction is a starting
> point that a qualified person must review. Even best-in-class tools in this field
> reach only about 90-95% accuracy -- equipment types, ratings, and especially how
> buses feed each other (the topology) can be wrong or missing. Check every bus and
> connection against the source drawing before you confirm. This is the same
> human-sign-off discipline the industry applies to all automated drawing
> digitization; it does not replace engineering judgment.

### Manual entry

If you have a data table rather than a PDF, use the manual-entry path on the
same Arc Flash tab. Enter each bus row directly: bus name, nominal voltage,
incident energy (cal/cm²), arc flash boundary, limited approach, restricted
approach, PPE category, and hazard level.

### Telemetry and AI-triggered alerts

When telemetry-connected equipment crosses the NFPA 70B C2 load-growth
threshold (>10% from baseline), ServiceCycle raises an arc-flash re-study
alert. The equipment shows a banner on the asset detail page. This does not
change the label data — it flags that the engineering inputs may have changed
and a re-study should be scheduled.

## The per-asset Arc Flash tab

Every asset that has a bus entry in a study gets an **Arc Flash** tab on its
detail page. The tab shows:

- **Incident energy** (cal/cm²) and hazard level from the most recent study.
- **PPE requirements**: category (1–4) or method (incident-energy-based), and
  the specific PPE ensemble required by NFPA 70E Table 130.5(G).
- **Approach boundaries**: arc flash boundary, limited approach, and restricted
  approach in inches.
- **Study metadata**: date, PE, expiry date, and IEEE 1584 method.
- **Expiry status**: a banner appears when the study is within 60 days of
  expiry or already expired.

If no study covers this asset's bus, the tab shows a prompt to upload a study
via the site Arc Flash tab.

## Labels

### Single label PDF

Open an asset's Arc Flash tab → **Download Label (PDF)**. ServiceCycle generates
a NFPA 70E 130.5(H)-compliant label with the incident energy, PPE category,
approach boundaries, hazard pictogram, and study date. The label is formatted
for standard 4" × 6" label stock.

### Bulk label download

**Reports → Arc Flash → Bulk Download.** Generates a PDF containing one label
per bus across all sites for the account. You can filter by site. The bulk PDF
is suitable for handing to a label printer or forwarding to the PE firm for
installation.

## The Arc Flash reports page

**Reports → Arc Flash** gives you the account-wide picture:

- Summary count: studies current, expiring soon, expired.
- Per-site study roster: date, PE, method, expiry, and status badge.
- Per-bus table: all buses across all studies with incident energy, hazard
  level, PPE category, and expiry.
- Filterable by site, hazard level, and expiry window.

## AFX export

ServiceCycle exports arc-flash label data in the open **AFX v1** format,
making it portable to any IEEE 1584 analysis tool.

- **Reports → Arc Flash → Export CSV** — flat CSV per bus (all NFPA 70E label
  fields). Import directly into EasyPower, SKM Power*Tools, or ETAP.
- **Reports → Arc Flash → Export XLSX (multi-table)** — four-sheet workbook
  matching the AFX v1 multi-table layout: Bus, Cable, Transformer, Device.

See `docs/api/AFX_SPEC.md` for the full field catalog and interop notes.

## Arc-flash incident register

**Sites → [your site] → Arc Flash → Incident Register** tracks arc-flash
incidents and near-misses for the site. Each incident record captures:

- Date and time
- Location (bus / panel)
- Incident description and root cause
- PPE worn vs. PPE required (gap flag)
- Injuries, if any
- Investigation status

The register is append-only for traceability. Incidents are visible to managers
and admins; field technicians cannot access the register.

## Re-study workflow

NFPA 70E requires arc-flash studies to be reviewed when electrical system
changes occur and at a maximum of 5-year intervals. When a study approaches
expiry:

1. ServiceCycle surfaces a banner on the site and on each affected asset.
2. The Arc Flash reports page shows the site in the **Expiring Soon** bucket.
3. Commission a new study from your PE firm.
4. Upload the new PDF — it becomes the active study; the old study is retained
   for historical reference.

## Common questions

**"Why does the hazard level say UNKNOWN?"** No study has been linked to this
asset's bus, or the bus name in the study doesn't match the asset's bus
assignment. Open the study and verify the bus-to-asset linkage in the study
detail view.

**"The AI extracted the wrong incident energy."** On the study review screen,
click the row and enter the correct value. The confidence badge will update to
manual. The original extracted value is retained in audit history.

**"We had a system change — do I need to upload a new study?"** Yes. Any change
to the electrical system (new switchgear, transformer swap, utility upgrade)
that affects available fault current requires a re-study. Upload the new PDF
when the PE firm delivers it; it will immediately supersede the old values.

**"Can I get the raw per-bus data via API?"** Yes.
`GET /api/arc-flash` returns the full study + label dataset for the account.
See the API & Integrations help module for authentication.

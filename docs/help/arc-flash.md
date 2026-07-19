# Arc Flash

Arc flash is a sudden release of electrical energy through the air. ServiceCycle
manages the complete arc-flash lifecycle: getting IEEE 1584 study results in,
generating NFPA 70E-compliant labels, tracking per-equipment energy data, running
the incident register, and exporting to third-party analysis tools.

> **Important:** ServiceCycle is a record-keeping and label-generation tool.
> Arc-flash energy calculations must be performed by a licensed Professional
> Engineer using IEEE 1584-compliant software. ServiceCycle stores and displays the
> results and drafts the inputs; it does not perform the engineering analysis.

## How arc-flash data enters ServiceCycle

### Import a study or one-line (the assisted path)

The primary path is the **Import one-line / study → gap analysis** panel in a site's
**System Studies** card. Upload the PE's study report (or a one-line diagram),
ServiceCycle extracts the buses, incident-energy values, PPE categories, and
approach boundaries, and hands you a per-bus review with a readiness state on each
row. You correct anything the extraction got wrong, then confirm — which creates or
updates the assets and (optionally) the arc-flash study in one step. The extraction
runs in the background and the draft waits for you in the list; see the **One-Line
Import & Topology** module for the full review-and-confirm flow.

> **AI extraction is a draft, not a verified model.** Whether you import a study
> report or a one-line diagram, the automated extraction is a starting point that a
> qualified person must review. Even best-in-class tools in this field reach only
> about 90–95% accuracy — equipment types, ratings, and especially how buses feed
> each other (the topology) can be wrong or missing. Check every bus and connection
> against the source drawing before you confirm.

### Manual entry

If you have a data table rather than a document, enter each bus row directly: bus
name, nominal voltage, incident energy (cal/cm²), arc-flash boundary, limited and
restricted approach, PPE category, and hazard level.

### Telemetry-triggered re-study alerts

When telemetry-connected equipment crosses the NFPA 70B C2 load-growth threshold
(>10% from baseline), ServiceCycle raises an arc-flash re-study alert and shows a
banner on the asset. This doesn't change the label data — it flags that the
engineering inputs may have changed and a re-study should be scheduled.

## The per-asset Arc Flash tab

Every asset that has a bus entry in a study gets an **Arc Flash** tab on its detail
page, showing:

- **Incident energy** (cal/cm²) and hazard level from the most recent study.
- **PPE requirements**: category (1–4) or incident-energy-based method, and the PPE
  ensemble required by NFPA 70E Table 130.5(G).
- **Approach boundaries**: arc-flash boundary, limited approach, restricted approach.
- **Study metadata**: date, PE, expiry date, IEEE 1584 method.
- **Expiry status**: a banner when the study is within 60 days of expiry or expired.

If no study covers this asset's bus, the tab prompts you to import one.

## Labels

**Single label:** an asset's Arc Flash tab → **Download Label (PDF)** generates an
NFPA 70E 130.5(H)-compliant label (incident energy, PPE category, approach
boundaries, hazard pictogram, study date), formatted for standard 4"×6" stock.

**Bulk:** **Reports → Arc Flash Label Report** gives every current label across your
sites, filterable by site, hazard level, and expiry window — the schedule to hand a
label printer or the PE firm.

## The arc-flash report suite

Four report surfaces (Sidebar → Reports) give the account-wide picture: the **Label
Report** (every current label), the **Fleet Dashboard** (risk rolled up per site,
with an on-demand audit/insurer bundle), the **Heat-Map** (buses shaded by incident
energy), and **Search** (plain-English queries over your buses). See the **Reports**
module.

## AFX export

ServiceCycle exports label data in the open **AFX v1** format for any IEEE 1584 tool:
**Export CSV** (flat per-bus) or **Export XLSX** (four-sheet Bus / Cable /
Transformer / Device workbook). Import directly into EasyPower, SKM Power*Tools, or
ETAP. See `docs/api/AFX_SPEC.md` for the field catalog.

## Arc-flash incident register

**Sites → [your site] → Arc Flash → Incident Register** tracks incidents and
near-misses: date/time, location, description and root cause, PPE worn vs. required
(with a gap flag), injuries, and investigation status. The register is append-only
for traceability, and visible to managers and admins — field technicians cannot
access it.

## Re-study workflow

NFPA 70E requires arc-flash studies to be reviewed on system change and at a maximum
of 5-year intervals. As a study approaches expiry, ServiceCycle banners the site and
each affected asset and buckets the site as expiring soon. Commission a new study,
import the new document — it becomes the active study and the old one is retained for
history. When you re-import a drawing, ServiceCycle also compares it to the prior
confirmed revision and flags material topology changes with a *Re-study recommended*
banner (see **One-Line Import & Topology**).

## Common questions

**"Why does the hazard level say UNKNOWN?"** No study is linked to this asset's bus,
or the bus name in the study doesn't match the asset's assignment. Open the study and
verify the bus-to-asset linkage.

**"The extraction got a value wrong."** Correct it on the review panel before you
confirm — nothing is written to your equipment until you confirm. After a study is
live, edit the bus row and the confidence badge updates to manual; the original
extracted value is retained in audit history.

**"We had a system change — do I need a new study?"** Yes. Any change affecting
available fault current (new switchgear, transformer swap, utility upgrade) requires
a re-study. Import the new document when the PE delivers it.

**"Can I get the raw per-bus data via API?"** Yes — `GET /api/arc-flash` returns the
full study and label dataset. See the **API & Integrations** module.

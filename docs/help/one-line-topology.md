# One-Line Import & Topology

Your one-line diagram is the map of how power flows through the facility — which bus
feeds which, where the transfer switches sit, what's redundant. ServiceCycle can
read that drawing (or a study report) and turn it into structured equipment, a
power-path model, and an IEEE 1584 gap analysis, so you're editing a draft instead
of typing a bus list from scratch.

> **The extraction is a draft, not a verified model.** Automated drawing
> digitization in this field reaches roughly 90–95% accuracy at best — equipment
> types, ratings, and especially how buses feed each other can be wrong or missing.
> ServiceCycle drafts the IEEE 1584 inputs; a qualified person confirms every bus
> and connection against the source drawing before anything is created. This is the
> same human-sign-off discipline the industry applies to all automated
> digitization.

## Where it lives

On a site's detail page, in the **System Studies** card, the **Import one-line /
study → gap analysis** panel is the entry point. (System Studies is shown when
arc-flash studies are enabled for the account.) You can also start from the
standalone Arc Flash import page, where importing a drawing for a facility you
haven't set up yet creates the new site for you.

## The flow

1. **Upload.** Attach a one-line diagram (PDF or image) or a study report, and pick
   the source type — **One-line diagram** or **Study report**. Click **Extract**.
2. **Extraction runs in the background.** Reading a drawing takes a moment; the
   draft shows as *Processing…* in the drafts list. You don't have to wait on the
   screen — come back and click **Review** when it's ready. A large or complex
   document simply takes a little longer.
3. **Review the buses.** Each extracted bus shows its equipment type, voltage, and
   what it's *fed from*, with a readiness state: **Ready**, **Defaults applied**
   (an IEEE 1584 default filled a gap), or **Blocked** (still missing required
   data). Correct the equipment type and feed for any bus, and set each one to
   **Create asset**, **Skip**, or **Pending**.
4. **Close the gaps (optional).** For blocked buses, **Field collection** generates
   targeted tasks — the exact device and cable data a technician needs to collect,
   with hazard, outage, and qualified-person flags. A field tech records the device
   (breaker/fuse/relay/switch), its trip settings, and the cable, and the bus
   re-grades automatically.
5. **Confirm.** **Confirm & create assets** turns the reviewed draft into real
   equipment — reusing assets that already exist on the site rather than
   duplicating them, wiring the feed links, and (optionally) creating an arc-flash
   study from the same inputs.

## What you get

- **Structured assets** for each bus, matched to existing equipment where it
  already exists (the panel tells you *"matches existing · will reuse"* before you
  confirm).
- **The power-path one-line**, auto-built from the confirmed feeds — the *Power-path
  one-line (auto-built)* view, with a **Show one-line** toggle.
- **A multi-source topology graph** — the AssetFeed model that records which
  sources feed which loads, on which side (A/B), through which transfer switch. This
  is what powers the *Redundancy impact* analysis (see that module).

## Sanity checks & drift

The panel runs its own checks so a bad draft doesn't slip through:

- **Sanity checks** flag findings that are physically impossible or
  under-protective (**Error**) or merely suspicious (**Check**).
- **Multi-source topology** surfaces gaps — a missed feed, an incomplete transfer,
  an untraced alternate source, or a redundancy contradiction — for you to resolve
  before confirming.
- **Drift** — when you re-import a drawing for a site that already has a confirmed
  revision, ServiceCycle compares them and flags material changes with a
  **Re-study recommended** banner, so a system change that affects fault current
  gets a fresh look. Whether a re-study is actually required is a licensed PE's
  call.

## Common workflows

**"Stand up a new facility from its one-line."** Import the drawing from the Arc
Flash import page; it creates the site, extracts the buses, and you review and
confirm.

**"Get the topology in so redundancy analysis works."** Import the one-line, correct
the equipment types and feeds, confirm to persist the feed graph — then the
Redundancy impact panel can tell you what breaks if a source drops.

**"A tech needs to collect breaker data in the field."** From the review panel,
generate field-collection tasks from the blocked buses; the tech records the device
and cable on their phone and the bus re-grades on its own.

## When something looks wrong

**The draft is stuck on "Processing…".** Extraction runs in the background and can
take up to a few minutes on a heavy document. Reopen the draft from the list; if it
still hasn't finished, give it another moment rather than re-uploading.

**Buses came back as "Blocked".** Required IEEE 1584 data is missing for those
buses. Fill it in on the review panel, or generate field-collection tasks and let a
technician gather it.

**The topology is wrong.** The extraction is a draft — correct the equipment types
and *fed from* values on the review panel before confirming. Nothing is persisted
to your equipment or the redundancy graph until you confirm.

**It says buses already exist.** That's the dedupe working — the panel matches
extracted buses to equipment already on the site and reuses them, so confirming
updates the existing assets instead of creating duplicates.

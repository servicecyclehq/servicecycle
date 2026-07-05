# TCC Curve Source Availability Audit (2026-07-05, §10 A3 backend prep)

Scope: does ServiceCycle's existing AFX/arc-flash ingestion pipeline expose
actual time-current-curve (TCC) POINT data (current/time coordinate pairs
that plot a protective device's trip curve), or only device identity +
computed-result data? Documentation only — no source files modified as part
of this specific finding (the schema/API work that follows it in this same
session is tracked separately in the recap memo).

## Short answer

**No.** Nothing SC ingests today — the AFX flat-row spec, the AFX
multi-table form, the results-CSV round-trip, the AI-vision one-line
extractor, or the three vendor tool-template mappings (SKM/EasyPower/ETAP)
— carries or expects curve POINT data. What SC has instead is
`server/lib/arcFlashTccLibrary.ts`, a small curated reference library that
maps a device's manufacturer/series/rating to a **single typical clearing
time scalar** and a **citation string** pointing at the manufacturer's
published curve (e.g. `curveRef: "Square D PowerPact TCC (Micrologic)"`) —
explicitly documented in that file's own header as "a deterministic SEED
library, not a TCC engine."

## What was checked

- `server/lib/arcFlashAfx.ts` (AFX v1 field catalog) — one row per bus,
  fields are incident-energy/PPE/boundary RESULTS plus basic device identity
  (`deviceType`, `frameRatingA`). No curve-point field, no per-point current/
  time array anywhere in `AFX_FIELDS`.
- `server/lib/arcFlashAfxMultiTable.ts` (AFX v1.2 Buses/Cables/Transformers/
  Devices tables) — the `Devices` table carries settings (LSIG pickup/delay,
  frame/sensor rating) but no curve-point columns.
- `server/lib/arcFlashResultsImport.ts` — round-trips PE-stamped RESULTS
  (incident energy, boundary, PPE category, required arc rating) from a study
  tool's export CSV. Flat overwrite onto one bus record; no curve data.
- `server/lib/afxToolTemplates.ts` + `server/data/afx/tool-templates/{skm,
  easypower,etap}.json` — per-vendor column-mapping templates. Grepped for
  curve/tcc/point/coordinate/log — zero matches. These map RESULT columns,
  not curve digitization.
- `server/prisma/schema.prisma` — `ProtectiveDevice` (line 3145) stores
  device nameplate + `settings Json?` (LSIG trip settings or fuse class/
  rating) — this is the INPUT to a curve (what a real TCC engine would need
  to compute/look up the actual curve), not the curve itself.
  `DeviceTestRecord` (line 3222) links NETA trip-test as-found/as-left
  settings to a device — again settings, not curve points.
- `server/lib/arcFlashTccLibrary.ts` — confirmed as described above. Its own
  header comment is explicit: "the real clearing time still derives from the
  published TCC at the bus's available fault current, and a licensed PE
  confirms it." The 12-entry `TCC_LIBRARY` array gives one representative
  `typicalClearingTimeMs` number per device family, not a plotted curve.

## Why this gap exists (not a bug — a real data-availability limit)

SKM PTW / EasyPower / ETAP all have internal TCC libraries and CAN produce a
graphical TCC plot inside their own tools, but their **arc-flash RESULTS
export** (the thing SC's AFX importers actually consume) is a flat table of
computed incident-energy/PPE numbers per bus — it is not the same artifact as
a curve-coordination export. Getting real curve points into SC would require
one of: (a) a NEW ingestion path that parses the vendor tool's native
project file or a dedicated curve-export format (unverified whether any of
the three tools even offer one in an automatable form), (b) digitizing
manufacturer TCC PDFs (log-log curve images) into coordinate arrays — a
distinct, nontrivial extraction problem of its own, or (c) manual curve-point
entry by an engineer in a future UI. None of these exist in SC today, and
none were in scope to build tonight.

## Recommendation for tonight's schema/API work

Ship the `ProtectionCurve` schema + API as additive infrastructure (a real,
useful step — it gives Phase 2 UI work a real table + endpoint to build
against), but do NOT fabricate a parser that pretends to extract curve
points from AFX data that doesn't contain them. Concretely:

1. Add a `dataSource` field to `ProtectionCurve` (`manual | manufacturer_pdf
   | afx_import | tcc_library_estimate`) so every row is honest about
   provenance — this matters for the same reason SC's other domain validators
   never auto-assert compliance: a PE reviewing a printed TCC needs to know
   whether a curve is a real manufacturer curve or a class-typical estimate.
2. `curvePoints Json` stays nullable/empty-array-default on creation from any
   existing pipeline — there is no code path tonight that populates it with
   real data. The one thing that CAN be wired immediately: a `seedFromTccLibrary()`
   helper that creates a placeholder `ProtectionCurve` row referencing the
   existing `arcFlashTccLibrary.ts` match (curveRef citation + estimated
   clearing time as a single point), tagged `dataSource: 'tcc_library_estimate'`,
   so Phase 2 UI has *something* to render for devices where a class match
   exists, clearly labeled as an estimate rather than a real curve.
3. Document this limitation prominently in the ProtectionCurve model's schema
   comment so a future session doesn't assume AFX import already handles this.

## Risk callouts

- Do not let "we shipped a ProtectionCurve table" get summarized upstream as
  "SC now imports TCC curves from AFX" — it does not, and conflating the two
  would misrepresent the product to a customer or (per this project's own
  north star) an acquirer's technical diligence.
- If/when real curve-point ingestion is scoped, it is its own project (likely
  vendor-format research + a new extraction pipeline, comparable in size to
  the AFX v1/v1.2 work already done for results import) — not a follow-on
  patch to tonight's schema.

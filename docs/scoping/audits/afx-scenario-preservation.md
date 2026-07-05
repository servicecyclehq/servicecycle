# AFX Scenario Preservation Audit

Date: 2026-07-05
Scope: Documentation/verification only — no source files modified.

## Question

When ServiceCycle imports an AFX study export (from SKM PowerTools / EasyPower /
ETAP), does it preserve distinct electrical-system SCENARIO states — e.g.
"normal" configuration, "tie-closed" configuration, "generator-only"
configuration, "bypass" configuration — as separate labeled records per asset?
Or does it collapse everything to a single "current" arc-flash result per
asset, discarding which scenario produced it?

**Short answer: SC collapses to one result per (study, asset). There is no
scenario/configuration dimension anywhere in the schema or import pipeline.**
The one "dual" concept that exists (`governingScenario`) is a different thing
entirely — see below.

---

## What was checked

Files read in full or in relevant part:

- `server/lib/arcFlashAfx.ts` — the AFX v1 flat-row spec (field catalog,
  validator, CSV parser). One row = one bus. No scenario/case field in
  `AFX_FIELDS` (lines 36–77).
- `server/lib/arcFlashAfxMultiTable.ts` — AFX v1.2 multi-table form (Buses /
  Cables / Transformers / Devices). Bus identity is `busId` derived from
  `busName` only (`sanitizeId`, lines 76–80, 106–126). No scenario axis in any
  of the four tables (`TABLES` const, lines 24–71).
- `server/lib/arcFlashResultsImport.ts` — round-trips PE-stamped RESULTS
  (incident energy, arc-flash boundary, PPE category, required arc rating,
  working distance) back from a study tool's export CSV. `HEADER_ALIASES`
  (lines 48–56) recognizes `site` and `busName` as the only identity columns;
  `matchResults()` (lines 124–154) matches incoming rows to existing buses by
  `(site, busName)` only, with a bus-name-only fallback. Every result field is
  written as a flat overwrite (`from`/`to`) onto **one** existing bus record —
  there is no branch for "this row is a second scenario for the same bus."
- `server/lib/arcFlashExtract.ts` — the AI-vision/text ingestion path for
  one-line diagrams / study report PDFs. The `JSON_CONTRACT` prompt (lines
  41–76) asks the model for one `buses[]` array with one entry per `busName`;
  `normalizeExtraction()` (lines 172–237) explicitly **collapses duplicate bus
  names**: `if (seen.has(key)) { warnings.push(\`Duplicate bus "${busName}"
  collapsed.\`); continue; }` (line 205). If a source PDF contained the same
  bus under two scenario headings (e.g. "Bus X — Normal" and "Bus X — Tie
  Closed" both reading as `busName: "Bus X"`), the second would be silently
  dropped with only a warning string, not a preserved second row.
- `server/lib/afxToolTemplates.ts` + `server/data/afx/tool-templates/{skm,
  easypower,etap}.json` — per-vendor column-mapping templates for tool RESULT
  exports. Grepped all three JSON templates for
  scenario/case/configuration/tie-close/generator-only/alternate/worst-case/
  N-1/contingency — zero matches in any of them. The mapping model is strictly
  column→AFX-field; there is no per-row "which case" tag.
- `server/prisma/schema.prisma` — full read of the arc-flash-relevant models:
  - `SystemStudy` (line 1296) — one row per study (performedDate, method,
    supersededById chain for re-study versioning).
  - `SystemStudyAsset` (line 1338) — the per-bus result row. Key constraint:
    **`@@unique([studyId, assetId])` (line 1410)** — the schema physically
    forbids more than one row for the same asset within the same study. This
    is the load-bearing fact: even if scenario data were parsed, there is
    nowhere to put a second row for the same bus in the same study without
    violating this constraint.
  - `StudySourceModel` (line 1422) — one row per study (utility/transformer
    source model), also singular.
  - `ArcFlashIngest` / `ArcFlashIngestBus` (lines 3036, 3070) — the AI-ingest
    draft tables that eventually get "confirmed" into `SystemStudyAsset`. Same
    shape: one draft row per `busName` per ingest, no scenario column.
  - `ArcFlashCollectionTask`, `ProtectiveDevice`, `ArcFlashIncident` — none
    carry a scenario/configuration field either.
  - Grepped the whole schema for `scenario|Scenario|configuration|tie.?closed|
    generator.?only|bypass` — the only hits are `governingScenario` on
    `SystemStudyAsset` (line 1399) and its mirror on `ArcFlashIngestBus` (line
    3118), plus one comment mentioning "bypass tier enforcement" in an
    unrelated auth context (line 268) and a `Slice F: mitigation + dual-scenario`
    section header (line 1391).
- `server/routes/v1/arcFlash.ts` — public API surface. `currentRowOf()` (lines
  21–27) explicitly picks **one** row per asset: filters to
  `study.supersededById == null` first, then sorts by `study.performedDate`
  descending, takes `[0]`. Used by `/labels`, `/one-line`, and
  `/work-order-precheck`.
- `server/routes/arcFlashIngest.ts` — `currentStudyAssetRow()` (lines
  1387–1393) is a byte-for-byte duplicate of the same "one row wins" logic,
  used by `/asset/:assetId/permit` (line 1470) and `/asset/:assetId/what-if`
  (line 1518-ish).
- Grepped for the "current row" pattern
  (`currentRowOf|currentStudyAssetRow|study.supersededById|supersededById:
  null`) across the whole server tree: it recurs in
  `routes/arcFlashIngest.ts`, `routes/workOrders.ts`,
  `routes/arcFlashIncidents.ts`, `routes/v1/arcFlash.ts`, `routes/sites.ts`,
  `lib/arcFlashIntegrity.ts`, and `scripts/seed-arcflash-trend-demo.js` — seven
  independent call sites that all assume "there is exactly one current result
  per asset, found by walking the supersession chain + date."

## What SC preserves today

- **Study-over-study history** (temporal versioning): `SystemStudy` has a
  `supersededById` self-relation, so a full re-study (new PE report, new
  `performedDate`) creates a new `SystemStudy` + a fresh set of
  `SystemStudyAsset` rows, and the old study is chained as superseded rather
  than deleted. This gives SC a genuine timeline of "how did the incident
  energy on Bus X change study-to-study" (exposed via
  `/asset/:assetId/timeline`, `arcFlashDrift.ts`, `arcFlashTrend`-style seed
  data).
- **A "full vs. reduced" arc-energy-REDUCTION dual-calc** — NOT an electrical
  topology scenario. `governingScenario: "full" | "reduced"` plus
  `arcingCurrentReducedKA` on `SystemStudyAsset`/`ArcFlashIngestBus` capture
  IEEE 1584's variable-Cf (VarCf) arcing-current reduction check: the standard
  requires evaluating both the full arcing current and a reduced value, then
  reporting whichever gives the HIGHER incident energy (the "governing" one).
  This is a per-bus, per-study **calculation nuance**, not a different
  electrical-system state (tie-closed, generator-only, bypass, etc.) — it does
  not touch topology, source impedance, or breaker status; it is entirely a
  refinement of the arcing-current input for one fixed system configuration.
  It is worth noting this exists precisely because it is easy to conflate with
  "scenario preservation" — it is not that.
- **Confirmed provenance** of AI-extracted values (`ai_extracted` vs `none`),
  study method/PE metadata, and a printed-vs-current label mismatch detector
  (`printedSnapshot`/`printedAt` on `SystemStudyAsset`) — none of this is
  scenario-related but is adjacent "which version of the truth are we looking
  at" machinery worth knowing about.

## What's stripped/missing

- **No scenario/configuration concept exists anywhere in the pipeline**: not
  in the AFX field catalog, not in the multi-table AFX form, not in the
  vendor tool templates (SKM/EasyPower/ETAP), not in the AI-vision/text
  extraction prompt or its normalizer, not in the results-CSV round-trip
  matcher, and not in the Prisma schema.
- **The schema cannot hold it even if it were parsed.** `SystemStudyAsset` has
  `@@unique([studyId, assetId])`. A PE study that reports "Bus X: normal =
  4.2 cal/cm², tie-closed = 7.8 cal/cm², generator-only = 3.1 cal/cm²" for the
  same physical bus within one study run has no second/third row to land in —
  persisting more than one scenario for the same bus in the same study would
  violate the unique constraint as-is.
- **The AI extraction path actively discards duplicates that would carry a
  scenario.** `arcFlashExtract.ts` `normalizeExtraction()` dedupes on
  `busName.toLowerCase()` and silently drops (with only a warning string, not
  a stored value) any second entry for the same bus name — which is exactly
  what a multi-scenario report would produce if the same bus appears under
  each scenario heading.
- **Every "get me the result for this asset" call site picks exactly one row**
  and treats it as ground truth: the public API (`/v1/arc-flash/labels`,
  `/v1/arc-flash/one-line`, `/v1/arc-flash/work-order-precheck`), the
  energized-work-permit builder (`/asset/:assetId/permit`), the what-if
  mitigation modeler (`/asset/:assetId/what-if`), work-order issuance
  (`routes/workOrders.ts`), the incident register (`routes/arcFlashIncidents.ts`),
  and site-level rollups (`routes/sites.ts`). None of these accept or expose a
  scenario parameter — the "current" row is chosen purely by supersession +
  recency.
- **PPE label generation** (`arcFlashLabelDoc.ts`, `arcFlashLabel.ts`) prints
  from a single resolved `SystemStudyAsset` row per asset. If a study
  genuinely has multiple governing scenarios per bus (e.g. NFPA 70E requires
  the label to reflect the WORST realistic operating configuration, not just
  whichever one a study happened to report last), SC has no way to represent
  that today, nor to let a user pick "print the tie-closed label" vs. "print
  the normal-config label."

## Fix scope estimate

**This is NOT a small additive fix. It requires a genuine schema + read-path
refactor, though the write path (import parsing) is comparatively small.**
Reasoning:

1. **Schema change is more than "add a nullable column."**
   - Adding `scenario String?` (or a `Scenario` enum: `normal | tie_closed |
     generator_only | bypass | other`) to `SystemStudyAsset` is easy in
     isolation.
   - But the current uniqueness guarantee is `@@unique([studyId, assetId])`.
     To allow multiple scenario rows per bus per study, that constraint must
     become `@@unique([studyId, assetId, scenario])` (or similar), and
     `scenario` must be non-nullable with a default (Prisma/Postgres unique
     constraints treat NULL as distinct-from-everything, so a nullable
     scenario column would silently allow duplicate "no scenario" rows unless
     defaulted to something like `"normal"`). That is a real migration against
     a table that is already read from ~15+ call sites, not a purely additive
     change.
   - `ArcFlashIngestBus` (the draft/staging table) would need the same
     treatment to carry scenario through from ingest to confirm.
2. **Every "current row" resolver needs a scenario parameter, and every
   caller needs to decide what "current" means when scenarios diverge.**
   `currentRowOf()` (routes/v1/arcFlash.ts) and `currentStudyAssetRow()`
   (routes/arcFlashIngest.ts) are the two canonical implementations, but the
   "pick one" assumption is inlined ad hoc in at least 5 more files
   (workOrders.ts, arcFlashIncidents.ts, sites.ts, arcFlashIntegrity.ts, the
   demo seed script). Each of these would need a decision: does a work-order
   precheck use the worst-case scenario? Does the printed label default to
   "normal" unless the tech requests "tie-closed"? Does the incident register
   roll up per-scenario or take the max? None of that logic exists today and
   all of it needs product/EE judgment, not just a query change.
3. **The AFX spec itself (the public interchange format) would need a version
   bump.** `arcFlashAfx.ts`'s `AFX_VERSION` is `'1.0'`; `rowGranularity: 'one
   row per bus / equipment'` is a documented, tested invariant (a test
   asserts the AFX field keys stay in sync with `arcFlashExport.ts`). Making
   AFX scenario-aware is a breaking change to a "documented, versioned"
   external interchange contract that customers/vendors may already be
   producing files against — this needs an AFX v2 (or v1.x with an optional
   scenario column plus back-compat handling for files that omit it), not a
   quiet field add.
4. **The AI-vision/text extraction prompt and normalizer need real rework,**
   not just schema support: `JSON_CONTRACT` in `arcFlashExtract.ts` would need
   to ask the model to identify and tag which scenario section of the report
   it's reading (most one-line diagrams / study reports present scenarios as
   separate report sections or separate result tables, sometimes on separate
   pages) — this is a prompt-engineering + eval effort (per the project's own
   golden-set discipline for ingestion accuracy work), not a mechanical
   change.
5. **Vendor tool templates (SKM/EasyPower/ETAP) need real vendor-format
   research.** None of the three current JSON templates has ever seen a
   multi-scenario export, so there is no verified column convention to map
   from (e.g. does SKM emit one row per bus per scenario with a "Case" column,
   or one column-set per scenario side-by-side?). This mirrors the project's
   existing honesty pattern (ETAP mappings are already flagged "assumed, not
   verified against a real export") — scenario support would need the same
   verify-against-a-real-file step before it could be trusted.
6. **Downstream consumers are numerous and varied**, not just "the asset
   detail page": public API (`/v1/arc-flash/labels`, `/one-line`,
   `/work-order-precheck`), energized-work-permit generation, PPE label
   printing/reprint-mismatch detection, what-if mitigation modeling,
   work-order issuance gating, the incident register, and the arc-flash
   drift/timeline view. A scenario-aware model touches all of them because
   "the current arc-flash result for this asset" is exactly the query every
   one of them makes today.

**Net characterization:** small in lines-of-schema-diff, large in
call-site/product-decision surface area. The honest sizing is a multi-slice
project (in this codebase's own terminology, likely 3-5 "slices" — schema +
migration, ingest/extraction prompt rework, AFX v2 spec + vendor-template
verification, and a pass across every "current row" call site to add explicit
scenario selection/defaulting logic) rather than a single migration PR.

## Risk callouts

- **Silent data loss today, not just "missing feature."** Per
  `arcFlashExtract.ts` line 205, if a customer already uploads a study PDF
  that reports multiple scenarios for the same bus, SC does not merely fail to
  capture the extra scenarios — it silently collapses them to one row with
  only a warning string surfaced (not persisted anywhere a user would
  routinely see it). A customer relying on SC for the tie-closed number could
  be looking at the normal-config number without realizing it, or vice versa,
  depending on extraction/table order — this is a genuine hazard-data-fidelity
  gap, not a cosmetic one, given SC's own repeated internal framing that
  incident-energy figures gate PPE and permit issuance.
- **PPE/permit correctness risk**: NFPA 70E / IEEE 1584 practice generally
  expects the posted label and the work permit to reflect the worst
  reasonably-expected operating configuration, not merely whichever
  configuration a study report happened to list first or that SC happened to
  parse. Because SC's "current row" resolvers have zero scenario awareness,
  there is no guarantee today that the number driving `canIssue` in
  `/work-order-precheck` or the permit builder is the governing (worst-case)
  configuration — it is whichever row survived the supersession + dedup
  logic, which is an artifact of import order, not electrical judgment.
- **The `governingScenario` field name is a foreseeable source of
  confusion/miscommunication** (including in an audit like this one) — it
  reads as if it might mean "which electrical configuration governs" but
  actually means "which arcing-current variant (full vs. reduced) produced
  the higher energy for one fixed configuration." Any future scenario-
  preservation work should pick a distinctly-named field (e.g. `topologyCase`
  or `systemConfiguration`) to avoid colliding with this existing concept.
- **AFX is marketed/documented as an open, versioned interchange standard**
  (see `arcFlashAfx.ts` header comment and the conformance validator). Any fix
  here is simultaneously a product/spec decision (versioning, backward
  compatibility for existing AFX consumers) and not purely an internal
  implementation detail — it should be scoped and reviewed as such rather than
  slipped in as a quiet schema patch.

---

## Program scope expansion (2026-07-05, same-day follow-up)

Dustin's read on this finding: "there's 0 reason to NOT keep all the data
points... we're absolutely changing this." A same-day working session then
asked the obvious next question — is scenario-collapse the *only* place SC
under-captures source data, or a symptom of a wider pattern? It's the latter.
Two independent research passes (cross-verified) found the same
extract-more-than-we-store shape repeated across arc-flash (~15 separate drop
points, not just scenarios) and across every other test-report type SC
ingests (DGA, insulation resistance/PI, power factor, TTR, battery). This
section captures the resulting program so it isn't lost as a one-off finding.
Full per-field detail lives in session memory (`servicecycle` project memory,
2026-07-05 data-completeness audit); this section is the durable pointer.

**Sequenced workstreams** (order chosen to de-risk: infrastructure the later
steps depend on comes first; the biggest structural change — scenario
preservation itself — comes after the cheaper, additive safety-net fixes so
that work isn't done twice):

1. **Ingestion architecture: native PDF input + structure-aware chunking.**
   Today's arc-flash vision path rasterizes each page to a PNG and makes one
   Gemini call per page (`rasterizePdf` + per-page loop, `arcFlashExtract.ts:363`),
   capped at 4 pages — not a Gemini limit (Gemini natively reads PDFs up to
   ~1,000 pages in one call, ~258 tokens/page) but a workaround for the
   inefficient one-call-per-page design colliding with the free-tier quota
   (gemini-2.5-flash: 5 RPM / 250 RPD). Fix: send the native PDF directly;
   only fall back to multi-call chunking for documents dense enough to risk
   the 65,536-token output ceiling; when chunking, cut at structural
   boundaries (table/entity edges), not fixed page counts, so no
   table/chart/bus-block is ever split across two calls — removes the need
   for overlap-and-reconcile logic in the common case. This is foundational:
   the per-field capture fixes below are worth little if the underlying call
   still silently truncates a long document.
2. **Per-field capture fixes (the "safety net" pass).** Additive, low-risk,
   eval-gated, no schema redesign: add a catch-all field to hold anything not
   yet in a named column; stop discarding the reading-identity label (gas
   species, winding pair, PF test mode, time point) at the `TestMeasurement`
   commit step; capture full DGA history instead of newest-sample-only; fix
   the utility-fault-current key mismatch (`arcFlashExtract.ts` writes
   `serviceFaultCurrentKA`, `arcFlashIngest.ts` confirm path reads a
   different key — extracted value never lands); fix AFX multi-table import
   silently not persisting incident energy (`arcFlashAfxMultiTable.ts`
   `buildFillUpdates` writes voltage + cable fields only); capture as-left
   values (NETA MTS 5.4 requires both as-found and as-left; only as-found is
   captured today).
3. **Raw source document promotion into the site document library.**
   Confirmed 2026-07-05: arc-flash source PDFs ARE durably saved today
   (`uploadFile()` call in `routes/arcFlashIngest.ts:256`, keyed to the site)
   — they are not lost. But the file lives only as `ArcFlashIngest.fileKey`
   on the ingest/draft table; it is never promoted into the general
   `Document` model (schema.prisma:1766) that powers the site's document
   library / "most recent file for this site" browsing surface. `DocType`
   (schema.prisma:217) has no arc-flash-study category. Net effect: the
   original study PDF an engineer would want to pull up on site is on disk
   but effectively undiscoverable through the normal document UI. Fix: on
   ingest confirm, also create a `Document` row (siteId, a new `arc_flash_study`
   `DocType` value, provenance) pointing at the same storage key, so it
   surfaces alongside one-lines and test reports like any other site
   document.
4. **Eval/golden-set fidelity audit.** Found in passing: the golden test
   corpus's own ground truth already under-represents reality in at least one
   case (a DGA sample's ground truth lists 3 of 8 gases present in the
   synthetic report). A parser fix that hits "100% recall" against an
   incomplete ground truth is a false signal. Needs its own pass auditing the
   corpus itself before/alongside item 2, or later fixes will look complete
   when they aren't.
5. **AFX true multi-scenario schema + read-path redesign.** This is the
   original finding above — schema + migration
   (`@@unique([studyId, assetId])` → include a scenario dimension), a
   decision at every "current row" call site (7+ files) for what "current"
   means when scenarios diverge, an AFX v2 spec bump, and vendor-template
   verification (SKM/EasyPower/ETAP multi-scenario export format is
   currently unverified — see "Fix scope estimate" above). Sequenced after
   items 1-2 because the same schema-change discipline and eval-gating apply,
   and because item 2's `TestMeasurement`-style safety-net pattern may inform
   how the AFX scenario dimension gets modeled.
6. **Label/UI field-completeness verification.** Spot-checked 2026-07-05:
   better shape than expected. Both the printed PDF label (`arcFlashLabelDoc.ts`)
   and the public QR label page (`PublicArcFlashLabel.jsx`) already carry
   every NFPA 70E §130.5(H)-required field (nominal voltage, arc-flash
   boundary, incident energy + working distance, PPE category), plus shock
   approach boundaries with a working fallback: when a study doesn't report
   them, SC derives them from NFPA 70E Table 130.4 by voltage and labels the
   source (`shockLimitedApproachSource: 'study' | 'table130_4'`,
   `arcFlashLabelDoc.ts:90-91`) rather than leaving them blank or guessing.
   Remaining gap, low priority: if a source study reports a *site-specific*
   shock boundary that differs from the standard table (uncommon but
   possible), that override isn't captured from the PDF today — the table
   fallback is the only path. Any *other* newly-captured field from item 2
   that should reach an asset template or detail page (not just the label)
   still needs its own UI pass with visual review before shipping — capture
   in the database is not the same as a field being visible anywhere a user
   looks.
7. **Historical backfill — deferred, not currently needed.** All of the
   above is a forward-looking fix. Re-ingesting already-uploaded source
   documents against the improved pipeline would only matter once there is
   real customer data ingested under the old pipeline; as of 2026-07-05 there
   isn't (pre-first-customer). Revisit if/when that changes.

**Explicit non-goal, reconfirmed:** none of this widens SC's PPE posture.
Every new field is captured because a *sealed study or standard reference
table* states it — SC still never computes or asserts what PPE a worker
should use (see [[servicecycle-ppe-liability-posture]]). Data points only.

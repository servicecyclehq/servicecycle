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
- `server/prisma/schema.prisma` — full read of the arc-flash-relevant models.
  **Line numbers below re-verified 2026-07-05 (same-day adversarial review);
  earlier draft cited numbers that had drifted ~60-250 lines from unrelated
  same-day schema commits (ProtectionCurve, EDMS scaffold). Treat model/field
  names as the durable anchor if these drift again — schema line numbers move
  every time anything above them changes.**
  - `SystemStudy` (line 1356) — one row per study (performedDate, method,
    supersededById chain for re-study versioning).
  - `SystemStudyAsset` (line 1398) — the per-bus result row. Key constraint:
    **`@@unique([studyId, assetId])` (line 1470)** — the schema physically
    forbids more than one row for the same asset within the same study. This
    is the load-bearing fact: even if scenario data were parsed, there is
    nowhere to put a second row for the same bus in the same study without
    violating this constraint.
  - `StudySourceModel` (line 1482) — one row per study (utility/transformer
    source model), also singular.
  - `ArcFlashIngest` / `ArcFlashIngestBus` (lines 3283, 3317) — the AI-ingest
    draft tables that eventually get "confirmed" into `SystemStudyAsset`. Same
    shape: one draft row per `busName` per ingest, no scenario column.
  - `ArcFlashCollectionTask`, `ProtectiveDevice`, `ArcFlashIncident` — none
    carry a scenario/configuration field either.
  - Grepped the whole schema for `scenario|Scenario|configuration|tie.?closed|
    generator.?only|bypass` — the only hits are `governingScenario` on
    `SystemStudyAsset` (line 1459) and its mirror on `ArcFlashIngestBus` (line
    3365), plus one comment mentioning "bypass tier enforcement" in an
    unrelated auth context and a `Slice F: mitigation + dual-scenario`
    section header.
- `server/routes/v1/arcFlash.ts` — public API surface. `currentRowOf()` (lines
  21–27) picks **one** row per asset: sorts candidates with non-superseded
  studies (`study.supersededById == null`) ranked first, then by
  `study.performedDate` descending, and takes `[0]`. Note this is a sort-key,
  not a hard filter — if every study for an asset happens to be superseded,
  it still returns the most-recent superseded row rather than nothing; worth
  confirming that edge case is the intended behavior when this gets touched
  for scenario-awareness. Used by `/labels`, `/one-line`, and
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
  `lib/arcFlashIntegrity.ts`, `scripts/seed-arcflash-trend-demo.js`,
  **`routes/arcFlashLabelPublic.ts`** (the worker-facing QR label — arguably
  the single most safety-critical consumer, since it's what a tech reads in
  the field before starting work), and **`lib/reportsCatalog.ts`** — nine
  independent call sites (re-verified 2026-07-05; the original pass missed
  the last two, which is itself the argument for the fix below) that all
  assume "there is exactly one current result per asset, found by walking the
  supersession chain + date." **Given this list has already grown once from
  re-checking, don't treat any fixed enumeration as final** — when W5 (below)
  gets built, make the grep itself part of the acceptance criteria (e.g. a
  test that fails if a new match of this pattern appears without an explicit,
  documented scenario-selection decision) rather than trusting a list that
  can silently go stale as the codebase grows.

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
   "pick one" assumption is inlined ad hoc in at least 7 more files
   (workOrders.ts, arcFlashIncidents.ts, sites.ts, arcFlashIntegrity.ts, the
   demo seed script, arcFlashLabelPublic.ts, reportsCatalog.ts — the last two
   added on re-verification, see "What was checked" above; treat this count
   as a floor, not a ceiling). Each of these would need a decision: does a work-order
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
whole section was itself adversarially reviewed on 2026-07-05 against the
live repo before being treated as build-ready — corrections from that review
are folded in inline rather than appended separately, so this version
supersedes any earlier draft.

**Phase 0 — buildable today, no design decisions pending:** the two
one-line, high-leverage anti-conservative-default fixes from the hunt below
(F1: read the already-extracted study date instead of defaulting to today;
F3: stop asserting the current NFPA edition when the method wasn't
extracted). Both are pure bug fixes with no product judgment call attached
and no dependency on anything else in this section — do these first,
independent of the rest.

**Sequenced workstreams after Phase 0** (order chosen to de-risk:
infrastructure the later steps depend on comes first; the biggest structural
change — scenario preservation itself — comes after the cheaper, additive
safety-net fixes so that work isn't done twice):

**W1 — Ingestion architecture: native PDF input + structure-aware chunking.**
   Today's arc-flash pipeline has two separate truncation risks, not one.
   The **vision path** (scanned/no-text-layer PDFs) rasterizes each page to a
   PNG and makes one Gemini call per page (`rasterizePdf` + per-page loop,
   `arcFlashExtract.ts:363`), capped at 4 pages. The **text path** (the
   *common* case — any study report with a text layer) silently truncates at
   24,000 characters of raw report text, or 8,000 characters of context +
   10,000 of tables when ruled tables are present (`buildUserPrompt`,
   `arcFlashExtract.ts:94-109`, appends `...[truncated]` with no warning
   surfaced to the user). Neither cap is a Gemini limit — Gemini natively
   reads PDFs up to ~1,000 pages in one call at ~258 tokens/page — both are
   self-imposed workarounds, the vision one colliding with the free-tier rate
   limit (gemini-2.5-flash: 10 RPM / 250 RPD / 250k TPM — corrected
   2026-07-05; an earlier draft of this doc cited 5 RPM from a stale internal
   code comment, re-verified against current published limits), the text one
   a plain token-budget guard that was never revisited as documents got
   longer.
   **Decision needed before building (flag for Dustin, not a solo call):**
   fixing this properly means sending Gemini the whole document natively
   instead of the current deterministic-first design ("pdfplumber/pdfjs text
   extraction first, vision only when there's no text layer, specifically to
   avoid spending vision tokens on a text-based study" — a deliberate cost
   decision documented in `arcFlashExtract.ts`). Moving to always-native-PDF
   input changes per-document AI spend and quota exposure; worth a quick
   confirm that the cost tradeoff is accepted before this ships, not
   discovered after.
   **Fix, once approved:** send the native PDF directly for both paths; only
   fall back to multi-call chunking for documents dense enough to risk the
   65,536-token output ceiling; when chunking is needed, cut at structural
   boundaries (table/entity edges), not fixed page counts, so no
   table/chart/bus-block is ever split across two calls. "Structural
   boundary" detection has no stated mechanism yet for the no-text-layer
   case — needs a concrete design before implementation starts, not just the
   phrase "cut at structural boundaries."
   **Acceptance criterion (so this can't be half-done and still look
   complete):** build one golden multi-page PDF where a single bus's data
   table is deliberately made to span a chunk boundary under the old
   fixed-page-count scheme; the new implementation must extract the identical
   bus set, with no bus lost or duplicated at the boundary, matching a
   single-call baseline extraction of the same document.

**W2 — Per-field capture fixes (the "safety net" pass).** Additive, low-risk,
   eval-gated, no schema redesign. Concrete field inventory (inlined here so
   this is buildable without any external context — see the "Fallback hunt"
   section below for the arc-flash-specific list; this covers the other
   report types found to have the same shape of gap):

   | Report type | What's captured but discarded before storage | Where |
   |---|---|---|
   | DGA / oil testing | Gas species identity (H2 vs CO2 vs C2H2, etc.) — `TestMeasurement` has no species/label column, so 7 distinct gas readings commit as 7 identical-looking `dissolved_gas` rows with no way to tell which is which | `commitTestReport.ts:93-104` (write), `schema.prisma` `TestMeasurement` (~line 1193, no label/species column) |
   | DGA / oil testing | Historical readings — a row like "H2(ppm): 18 18 21 18 20" (5 time points) keeps only the first value, drops the other 4 | `extractor.py:~646` |
   | DGA / oil testing | Gas species beyond the ones with a known concern-limit are dropped entirely rather than stored with no limit | `extractor.py:~798-800` |
   | Insulation resistance / PI | Reading identity (winding pair "H-G"/"X-G", time point "1 MIN"/"10 MIN") — same `TestMeasurement` label gap as DGA | `commitTestReport.ts:93-104` |
   | Insulation resistance / PI | A 4-column grid (time / test voltage / megohms / leakage current) keeps only the megohms column | `extractor.py:~656-680` |
   | Insulation resistance / PI | One of the two IR-grid parsing paths still uses `v > 0` (drops a legitimate zero-ohm reading); the other path was already fixed to `v >= 0` on 2026-07-04 with a comment calling zero IR "safety-critical" — the fix never reached this second path | `extractor.py:~671` vs `~719` |
   | Power factor / Doble | Test-mode identity ("CH+CHL GST" etc.) — same label gap | `commitTestReport.ts:93-104` |
   | Power factor / bushing | A 5-value row (nameplate capacitance, nameplate PF, measured capacitance, uncorrected PF, corrected PF) keeps only the corrected-PF value | `extractor.py:~735-743` |
   | Battery | Per-cell identity has no field to attach to (60 cells at 2.25V commits as repeated rows with no cell number); identical-value cells can dedupe-collapse | `extractor.py` dedup keys on `(type, phase, value, unit)`, no cell role |
   | TTR (turns ratio) | Not captured deterministically at all when a table has no unit token (ratios/DAR are dimensionless); relies on AI gap-fill, which only fires when there are fewer than 8 other readings already found | `extractor.py:~288` (unit-required regex), `testReportPreview.ts:~215-223` |
   | All types | Raw extracted text is never durably persisted — `IngestJob.result` keeps the post-collapse preview, not the source text, and `IngestionSession.rawText` is a schema column with zero write sites | `run.py` (omits `full_text` from output), `schema.prisma` `IngestionSession` |

   Cross-cutting fixes for the same shape of gap: add a label/species/mode
   identity field (or a scoped catch-all) to `TestMeasurement` so a reading
   knows what it is, not just its numeric value and phase; capture full DGA
   history instead of newest-sample-only; fix the IR-grid zero-value
   inconsistency; persist raw extracted text somewhere durable so future
   pipeline fixes can reprocess existing uploads instead of requiring
   re-upload. **Correction:** `asLeftValue`/`asLeftUnit` columns already
   exist on `TestMeasurement` (schema.prisma ~line 1201-1202) — the gap is
   that no ingestion code path ever writes to them (NETA MTS 5.4 requires
   both as-found and as-left; today only as-found is populated
   automatically). Fix the ingest path, don't add duplicate columns.
   **Design decision needed before building:** if a catch-all/flexible field
   gets added anywhere in this pass, decide up front where it lives (per
   measurement? per report?), whether it's ever surfaced to a user or is a
   write-only safety net, and when a named column is required instead of the
   catch-all — a scoped design paragraph, not a schema patch decided ad hoc
   mid-implementation.

**W3 — Raw source document linking — asset-precise, not just site-wide.**
   Confirmed 2026-07-05: arc-flash source PDFs ARE durably saved today
   (`uploadFile()` call in `routes/arcFlashIngest.ts:256`, keyed to the site)
   — they are not lost. Better than that: `SystemStudy` (schema.prisma:1372)
   already has a `reportPdfUrl String?` field, and a full manual UI already
   exists for it — `SiteDetail.jsx` has an editable "Report PDF URL" input
   and an "Open" link in the studies table (`SiteDetail.jsx:954-961,
   1032-1034`), and `sites.ts` already accepts it on study create/update.
   **Correction (2026-07-05 review):** this is not "built, never wired" —
   the manual path works today. What's actually missing is narrower: (a) it
   never gets auto-populated when an ingest is confirmed (`ingest.fileKey` is
   in scope at `routes/arcFlashIngest.ts:612-621` and is never used), and
   (b) there's no surface for it on the per-asset Arc Flash tab specifically
   (`ArcFlashAssetTab.jsx` has no reference to it).
   **Semantics trap to avoid:** the existing field's contract is "a
   user-typed external URL, rendered as a raw `<a href>`." `ingest.fileKey`
   is an internal storage key, not a URL — writing it directly into
   `reportPdfUrl` would break the existing "Open" link and mix two different
   kinds of values in one column (real URLs from manual entry, raw keys from
   ingest). Fix needs either a key-to-signed-URL resolution step at write
   time, or a separate `reportFileKey` column read through the existing
   `getFileUrl()` helper — not a one-line field copy.
   **Fix, correctly scoped:** at confirm, resolve `ingest.fileKey` to a
   servable URL (or store the key separately and resolve at read time) and
   set it on the created `SystemStudy`; add a "view original study PDF" link
   on the Arc Flash tab of every asset the study covers, via the existing
   `SystemStudyAsset` relationship — this gives exact per-asset precision
   (a tech sees the one PDF that produced that asset's numbers) for free,
   no new join table needed. Secondary/complementary: also promote into the
   general `Document` model (schema.prisma:1766, siteId-scoped — the existing
   `GET /documents/asset/:assetId` query at `routes/documents.ts:356-360`
   already unions `assetId` and site-level docs, so this would surface
   automatically) so the file is also discoverable via the general site
   document library, for whole-site review rather than one-asset lookup.
   `DocType` (schema.prisma:217) needs a new `arc_flash_study` value for that
   path.

   **One-line diagrams need the same asset-level precision (2026-07-05,
   Dustin).** Checked whether the mechanism exists: it doesn't, not yet.
   `DocumentAnnotation` (schema.prisma:1825) supports pin/arrow/text markup on
   a document but has no `assetId` — it's not an asset-linking mechanism. The
   "manual tap-to-link a one-line symbol to an asset" capability referenced in
   prior EDMS scoping is schema-scaffolded and **merged to main**
   (commit `63b69e3`, additive schema + `DrawingConverter` + backfill script)
   — **correction (2026-07-05 review): the schema's own inline comment still
   says "not merged," which is now stale; the merge happened later the same
   day. The scaffold is in main, just still zero routes/UI**, per that same
   comment. So today a one-line is either blanket site-wide (`Document.siteId`
   set, shows on every asset per `routes/documents.ts:356-360`) or not linked
   at all — there is no "this one-line specifically includes assets A, B, C"
   relationship yet. Two-part plan, since the full symbol-tap-link system is
   real Phase-2 EDMS work (already separately flagged as needing Dustin's own
   kickoff — too big to sequence solo):
   - **Near-term, small, reuses existing plumbing:** when a one-line is
     processed through arc-flash ingest and creates/matches assets
     (`routes/arcFlashIngest.ts:576-591`), that confirm step already has
     `ingest.fileKey` in scope at the exact moment it touches each asset —
     link the source document to each specific asset right there, the same
     pattern as the `reportPdfUrl` fix above. Covers every one-line that goes
     through the AI ingest/bus-extraction flow, which is the common path.
   - **For one-lines uploaded as plain documents** (not through arc-flash
     ingest — no per-bus data to hook into): needs a real but modest addition,
     a `DocumentAsset` many-to-many join (today's `Document.assetId` is a
     single nullable field, one document can't point at many assets) plus a
     small UI affordance letting the uploader tag which assets a one-line
     covers. Smaller and sooner than the full auto-detect-symbols EDMS vision,
     but still new schema, not just "finish the wiring" — sequence
     accordingly.

---

## Fallback-masks-capture hunt (2026-07-05, same-day follow-up)

Per Dustin's direction after the shock-boundary correction: before building
further, hunt for every other instance of the same pattern (a computed/
default/table value silently standing in for a real value a source document
could state) across the arc-flash pipeline specifically. Independently
verified pass, every claim grounded in a real file read, then adversarially
re-checked against the live repo on 2026-07-05 (one factual correction below,
noted where it applies). Findings numbered F1-F7 (distinct from the W1-W8
workstream numbering above — the two lists are independent).

**F1 (HIGH) Confirmed study date is silently replaced by "today."**
   `routes/arcFlashIngest.ts:610`: `performedDate` defaults to `new Date()`
   whenever the client doesn't send one — and the client
   (`ArcFlashIngestPanel.jsx:317`) never does. The worst part: the study date
   IS already extracted (`arcFlashExtract.ts:47` asks for `studyMeta.date`,
   it gets normalized and stored in `ingest.systemMeta`) — nothing ever reads
   it back out at confirm. Effect: `expiresAt` (performed + 5yr) is computed
   from the wrong date, study-age confidence scoring always reads "brand
   new," and the NFPA 70E-2024 "does this study predate the current edition"
   check can never fire correctly. A genuinely old study can look freshly
   dated. Fix: read `sm.studyMeta.date` when present at confirm; this is a
   one-line change with an outsized correctness impact — do this first.
**F2 (HIGH) A whole field class has zero capture path anywhere — not even
   manual entry — with one correction.** Shock boundaries (the known case),
   `ppeMethod`, enclosure dimensions, `arcingCurrentReducedKA` (the actual
   reduced-arcing-current *value* a study prints — distinct from
   `governingScenario`, which is a legitimate calculation, not a capture gap),
   and the mitigation/enclosure flags are copied at confirm
   (`routes/arcFlashIngest.ts:662-670`) from ingest-bus fields that literally
   no code path ever populates — not AI extraction, not either AFX form, not
   the vendor tool crosswalks, and not even the one manual human-entry
   endpoint (`routes/sites.ts:946-1010`), which doesn't accept most of these
   fields at all. **Correction (2026-07-05 review): `requiredArcRatingCalCm2`
   does NOT belong in this "zero path" list** — `POST /import-results`
   (`routes/arcFlashIngest.ts:~2505-2565`) parses and persists it directly
   from a results CSV, one of the five documented `RESULT_FIELDS`
   (`arcFlashResultsImport.ts:117`). Its real gap is narrower: the AI
   extraction contract and the manual entry endpoint don't capture it, so the
   only working path is the results-CSV import — worth fixing those two gaps,
   but do not build a second write path for a field that already has one, or
   this creates a new inconsistency instead of fixing one. For everything
   else in this finding, a PE holding the physical study genuinely cannot
   type these numbers into ServiceCycle today. `ppeMethod` specifically then
   gets silently *inferred* from whether incident energy is present, which
   can mislabel a PPE-category-method study as an incident-energy-method
   one. Fix: add the confirmed-missing fields to the AI extraction contract +
   the manual entry endpoint together, since they're the same shape of fix in
   the same handful of files.
**F3 (MEDIUM-HIGH) Method defaults to the current NFPA edition, defeating the
   outdated-method check.** `routes/arcFlashIngest.ts:616`:
   `method || 'IEEE 1584-2018'`. Fires exactly when extraction fails to read
   the method off the document — disproportionately old or low-quality scans,
   i.e. precisely the studies most likely to actually be outdated — and then
   asserts they're current. The regulatory-staleness check
   (`arcFlashRegulatory.ts`) can never flag a study whose method wasn't
   extracted. Anti-conservative default on the one check whose entire job is
   catching this. (Part of Phase 0, above.)
**F4 (MEDIUM) AFX import silently defaults an unrecognized equipment type to
   SWITCHGEAR**, discarding a `matched:false` flag the library already
   computes specifically to prevent this (`arcFlashAfxMultiTable.ts:426-439`
   vs. the one production caller at `routes/arcFlashIngest.ts:~2224-2225`,
   which drops the flag). Contrast: the AI-extraction path handles the same
   situation honestly (unmapped → null + a review warning). Equipment type
   drives downstream typical-value defaults, so a wrong silent guess
   propagates.
**F5 (MEDIUM) Utility fault current: extracted, shown once, never durably
   stored** — this is the same bug already identified in W2 above; the hunt
   re-confirmed it and traced the knock-on effect: the `bus_fault_gt_source`
   sanity cross-check (`arcFlashSanity.ts`) is permanently inert on every
   AI-ingested study because the field it needs is never populated that way.
**F6 (LOW-MEDIUM) A bare "breaker" with no trip-unit type is assumed
   fixed-trip**, which marks protective-device data collection as satisfied
   and skips the follow-up task — but the extraction contract never asks for
   trip-unit type in the first place, so a document-stated electronic
   LSIG unit is indistinguishable from "unknown" and never gets pursued.
   Unlike the IEEE-typical defaults elsewhere (which are honestly flagged
   `status:'defaulted'`), this one isn't surfaced at all.
**F7 (LOW) The public QR label doesn't carry the same source-provenance
   flag the printed PDF label does** for table-derived shock boundaries.
   Correction: the portal does carry a blanket footnote ("Shock approach
   boundaries follow NFPA 70E Table 130.4 where not separately recorded...
   verify against the stamped study" — `PublicArcFlashLabel.jsx:121`), so a
   worker isn't left with zero context. What's actually missing is the
   *per-value* flag the printed PDF label has — a worker can't tell **which**
   specific values on the portal came from the study vs. the table, only
   that some might have.

**Hunt coverage census** (added 2026-07-05 review — a numbered finding list
by itself can't be distinguished from "checked, found nothing" vs. "never
opened"; this makes the coverage explicit). `server/lib/arcFlash*.ts` has 23
files. Disposition: **finding** — `arcFlashLabelDoc.ts` (F7's known case),
`arcFlashIngest.ts`-adjacent confirm logic (F1, F2, F3, F5),
`arcFlashAfxMultiTable.ts` (F4), `arcFlashGap.ts` (F6). **Checked, clean** —
`arcFlashConfidence.ts`, `arcFlashSanity.ts` (constants used only to check
values, not replace them), `arcFlashDevice.ts` (unknown hazard defaults to
DANGER — correct conservative direction), `arcFlashMitigation.ts`'s
reduction-% handling, `arcFlashRiskScore.ts`, `arcFlashTccLibrary.ts`
(typicals explicitly flagged "verify against the published TCC"),
`arcFlashResultsImport.ts`, `arcFlashAfx.ts`. **Not yet checked** —
`arcFlashPermit.ts` (the energized-work-permit builder; likely the
highest-stakes unchecked file, since it's the thing that gates whether
energized work can proceed), `arcFlashOneLine.ts`, `arcFlashExport.ts`,
`arcFlashIncident.ts`, `arcFlashTimeline.ts`, `arcFlashSearch.ts`,
`arcFlashLabel.ts` (the snapshot-building logic behind F7, as opposed to
`arcFlashLabelDoc.ts` which was checked), `arcFlashDrift.ts`,
`arcFlashRegulatory.ts`. **Before treating this hunt as complete, the
not-yet-checked list — especially `arcFlashPermit.ts` — needs the same
pass.**

The IEEE 1584 gap/electrode/working-distance typicals in `arcFlashGap.ts` are
the *honest* version of a default — capture is attempted first, and the
fallback is visibly flagged `status:'defaulted'` when it fires. Not a bug;
the pattern to watch for is an *unflagged* default standing in for an
*attempted-but-never-succeeded* capture, not a default used only because
nothing better is knowable.

**W4 — Eval/golden-set fidelity audit.** Found in passing: the golden test
   corpus's own ground truth already under-represents reality in at least one
   case (a DGA sample's ground truth lists 3 of 8 gases present in the
   synthetic report, and the ground-truth rows themselves carry no gas-species
   identity — independently corroborating W2's finding that reading identity
   is discarded). A parser fix that hits "100% recall" against an incomplete
   ground truth is a false signal. **Sequencing correction (2026-07-05
   review):** this needs to run *before or as part of* W2's definition of
   done, not simply "after W2" by number — a broken corpus makes W2's own
   eval-gating meaningless (a change could hit 100% against ground truth that
   only lists 3 of 8 gases and ship a false success). Treat W4 as a
   prerequisite gate on W2's acceptance criteria, not a separate later step.

**W5 — AFX true multi-scenario schema + read-path redesign.** This is the
   original finding at the top of this document — schema + migration
   (`@@unique([studyId, assetId])` → include a scenario dimension), a
   decision at every "current row" call site (nine files, re-verified above)
   for what "current" means when scenarios diverge, an AFX v2 spec bump, and
   vendor-template verification (SKM/EasyPower/ETAP multi-scenario export
   format is currently unverified — see "Fix scope estimate" above).
   Sequenced after W1-W3 because the same schema-change discipline and
   eval-gating apply, and because W2's `TestMeasurement`-style safety-net
   pattern may inform how the AFX scenario dimension gets modeled.
   **Domain considerations to fold into this workstream's design** (added
   2026-07-05 review, not previously addressed):
   - **Scenario naming must preserve the verbatim label, not just a closed
     enum.** Real studies name cases arbitrarily ("Case 2 — Min Utility, Tie
     Closed," "Summer peak," etc.); a closed enum
     (`normal | tie_closed | generator_only | bypass | other`) is itself
     capture-lossy by this program's own stated principle. Store the
     as-printed scenario label as the primary field; treat any normalized
     category as a secondary classification derived from it, not a
     replacement for it.
   - **"Worst case" is not always "maximum fault current."** A *minimum*-fault
     scenario can produce a *longer* clearing time and therefore *higher*
     incident energy — this is exactly why per-call-site scenario selection
     needs real EE judgment (as the doc already concludes) rather than an
     automatic "pick the highest-fault-current row" rule.
   - **DC / battery systems are out of scope for this workstream and should
     say so explicitly.** IEEE 1584 does not cover DC arc-flash (different
     methods, different NFPA tables); SC ingests battery reports and has a
     `UPS_BATTERY` equipment type. Either declare DC arc-flash explicitly
     out of scope for W5, or scope it in — don't leave it silently unaddressed.
   - **The IEEE 1584 low-voltage exemption needs its own capturable state.**
     Studies routinely mark some buses "≤240V, <125kVA — no arc-flash label
     required." Today SC has no way to record "the study says this bus is
     exempt" as distinct from "no data was captured for this bus" — the same
     class of gap as everything else in this program, just not yet named.

**W6 — Label/UI field-completeness verification.** Spot-checked 2026-07-05:
   better shape than expected. Both the printed PDF label (`arcFlashLabelDoc.ts`)
   and the public QR label page (`PublicArcFlashLabel.jsx`) already carry
   every NFPA 70E §130.5(H)-required field (nominal voltage, arc-flash
   boundary, incident energy + working distance, PPE category — including the
   either/or IE-vs-PPE-category display rule implemented correctly at
   `arcFlashLabelDoc.ts:~100-101`), plus shock approach boundaries with a
   working fallback: when a study doesn't report them, SC derives them from
   NFPA 70E Table 130.4 by voltage and labels the source
   (`shockLimitedApproachSource: 'study' | 'table130_4'`,
   `arcFlashLabelDoc.ts:90-91`) rather than leaving them blank or guessing.
   Remaining gap: if a source study reports a *site-specific* shock boundary
   that differs from the standard table, that override isn't captured from
   the PDF today (tracked as part of F2 above) — the table fallback is the
   only path currently wired.
   **Correction (2026-07-05, Dustin):** a working fallback does not
   deprioritize capturing the real value — SC is a data-capture engine first;
   if a report states a value, that value gets captured, full stop, whether
   or not a reasonable default already covers the common case. This item is
   in scope at the same priority as everything else in this program, not a
   "nice to have." Any *other* newly-captured field from W2 that should reach
   an asset template or detail page (not just the label) still needs its own
   UI pass with visual review before shipping — capture in the database is
   not the same as a field being visible anywhere a user looks.

**W7 — Historical backfill — deferred, not currently needed.** All of the
   above is a forward-looking fix. Re-ingesting already-uploaded source
   documents against the improved pipeline would only matter once there is
   real customer data ingested under the old pipeline; as of 2026-07-05 there
   isn't (pre-first-customer). Revisit if/when that changes.

**W8 — Repeat the fallback-masks-capture hunt over the general test-report
   pipeline (added 2026-07-05 review; previously an unassigned gap).** The
   hunt above (F1-F7) was deliberately scoped to the arc-flash pipeline only.
   The same pattern is known to exist in the broader test-report pipeline too
   — e.g. `commitTestReport.ts`'s equipment-type inference mirrors the exact
   shape of F4 — but nobody has run the equivalent systematic hunt over
   `commitTestReport.ts`, `extractor.py`, the DGA/PF evaluation logic, the
   Doble import path, or the nameplate path. Don't mistake F1-F7's "checked
   and clean" list for platform-wide coverage — it covers arc-flash only.
   Sequence this after W2 (which already fixes some of the same-shaped gaps
   in those files) so the hunt is checking against the improved code, not
   flagging things about to be fixed anyway.

**Decision gates — what's ready to build solo vs. what needs Dustin first**
(consolidated 2026-07-05 review, so this isn't scattered across the doc):
ready to build without further sign-off: **Phase 0** (F1, F3), **W3**'s
near-term reportPdfUrl/one-line-via-ingest fix, **W4**. Need a quick
confirm before building: **W1**'s cost/design-posture decision (always-native
PDF vs. keep deterministic-first) and its structural-boundary-detection
design; **W2**'s catch-all-field design (where it lives, whether it's ever
surfaced, when a named column is required instead); **F1**'s date-parsing
policy specifically (the extracted study date is a free-form string — the
fix needs a rule that an unparseable date surfaces for review rather than
silently falling back to `new Date()` again, or the fix reintroduces the
exact pattern it's fixing). Already correctly gated on Dustin's own
prioritization call, no change needed: **W5** (the original scenario-
preservation redesign, including the AFX v2 spec decision and the
per-call-site "what does current mean" judgment calls), **W3**'s one-line
many-to-many addition (smaller than full EDMS Phase 2, but still new schema,
not just wiring).

**Explicit non-goal, reconfirmed:** none of this widens SC's PPE posture.
Every new field is captured because a *sealed study or standard reference
table* states it — SC still never computes or asserts what PPE a worker
should use (see [[servicecycle-ppe-liability-posture]]). Data points only.

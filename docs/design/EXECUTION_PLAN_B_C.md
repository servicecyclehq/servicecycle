# Execution plan: Directions B + C (handoff-ready)

**Written:** 2026-07-12, by the session that shipped the A pass.
**For:** any executing model (Sonnet/Opus/Fable). CLAUDE.md + .claude/skills
(fable-habits, fable-debug) are binding; this doc adds the design-specific spec.
**State when written:** branch `design/a-pass-2026-07-12` @ `23aa1e0` pushed, CI running.
Dustin's working tree is checked out ON that branch and ALSO carries an
UNRELATED uncommitted server-side security changeset -- NEVER `git add -A`;
stage explicit file lists only.

## Non-negotiables (environment)

1. Visual reference is `docs/design/direction-board-2026-07-12.html` (#dir-b,
   #dir-c sections) + `DESIGN_REVIEW_2026-07-12.md`. The mock is the contract.
2. Palette is LOCKED (brand/brand.md + index.css tokens). B and C change
   composition, never colors. No new hexes in components -- tokens only.
   Weight ladder 400/500/600/700 (600 exists in shipped fonts; 800 does not).
3. One-alarm budget: only the inspector strip (AuditReadyBanner) may be a red
   MODULE; red otherwise only on datum glyphs (day counts, cal/cm2, crit-5).
4. Mount rules: python writes only (Edit tool truncated 2 files on 07-12);
   after EVERY write: esbuild parse + tail-vs-HEAD + NUL scan. Linux esbuild:
   `mkdir -p /tmp/tools && cd /tmp/tools && npm install esbuild@0.24.0`
   (repo node_modules has the win32 binary; full vite build exceeds the 45s
   sandbox call cap -- CI is the build gate).
5. EOL: match each file's HEAD style before committing (`git show HEAD:file`
   bytes; some files are CRLF in repo, e.g. QuoteRequestButton.jsx).
6. Commit/push: windows-shell MCP `run_powershell` with
   working_directory C:/Users/ddeni/Desktop/ServiceCycle -- GCM cred works,
   no PAT. ASCII-only messages, multiple -m flags. main = linear history.
7. Deploys are gated: never deploy without Dustin's explicit go.
8. Scope drift is a report, not a decision. Judgment calls go to Dustin --
   open items already his: purple family (AI badges / Field Mode / IEEE, 22
   raw-hex sites), lucide-vs-Tabler brand.md reconcile, type-scale P2-13,
   hex sweep P1-8.

## Workstream B -- Control Room dashboard (est. 3-5 sessions)

Pure re-composition of `client/src/pages/Dashboard.jsx` + new presentational
components. The dashboard API and existing data hooks DO NOT change.

- B1. `components/InstrumentBand.jsx`: ink band (#0a0d12, tokens: sidebar-bg)
  spanning under .page-header. Contains: org/date row (reuse the v0.95
  operational header content -- it MOVES into the band), LIVE-synced dot
  (emerald), NWS/disaster line (amber, outline CTA -- reuse DisasterBanner
  logic docked instead of full-width browser-top), and 4 instruments:
  compliance % (from PathTo100 data), 70B maturity level+score, arc-flash
  hottest bus + cal/cm2 (ArcFlashDashboardCard data), inspector-visible count
  (AuditReadyBanner count). Mono numerals (--font-mono), 10px uppercase
  mono labels, tick-row micro-gauges (see board mock CSS .m2 .ticks).
  Dark band is theme-invariant (like the sidebar: "the chrome is the chrome").
- B2. Zones grid below band: `display:grid; grid-template-columns: 1fr 380px`
  inside the 1160px column. LEFT: compliance-by-site bars, standards coverage
  rows, priority-assets condensed list. RIGHT: sticky (top:14px) action queue
  = PathTo100 top-5 rows (age mono red, task, asset+id mono, +0.3% gain,
  Create WO action) + "see all 56" footer.
- B3. Remaining modules (maintenance horizon, recent WOs, next due,
  deficiencies) keep current card form, stacked under the zones, full column.
- B4. Responsive: <1100px zones collapse to one column (queue first);
  <900px instruments 2x2. Keep pointer-coarse touch targets.
- B5. Remove any module now redundant with the band (the old stat tiles for
  the same numbers) -- list removals in the report, do not delete silently.

Acceptance: per-file parse; CI green; dark+light OK (tokens only); alarm
budget grep (no new red backgrounds outside AuditReadyBanner); aria-labels
on instruments; before/after screenshots for Dustin (deploy or his local run);
Dustin approves BEFORE merge to main.

## Workstream C -- Field Report exports, 100% standardized (est. 1-2 weeks, incremental)

Dustin's hard condition: EVERY document surface follows the standard --
no partial adoption. Inventory completeness is therefore phase 0 and gates
everything else.

- C0. INVENTORY (do first, present to Dustin before restyling anything):
  enumerate every output surface. Known families + starting points:
  (1) print-CSS report pages -- grep `window.print` (OverdueReport.jsx:~150,
      ComplianceStandards*, ArcFlash* report pages);
  (2) server XLSX -- GET /api/export/xlsx (server/routes/export.ts) +
      "Export Everything" account backup (JSON/XLSX);
  (3) server PDFs -- server/lib: empDocument.ts, leaveBehindPdf.ts,
      complianceReport.ts, pdfHelpDoc.ts, snapshotPipeline.ts, arcFlashExport.ts
      (verify which lib renders them -- pdfkit/puppeteer/react-pdf unknown,
      READ the code, do not assume);
  (4) audit snapshots -- IMMUTABLE, SHA-256-anchored: new theme applies
      FORWARD ONLY; historical snapshots must remain byte-identical;
  (5) public share pages -- /share/:token (SharedCompliancePage), public
      arc-flash label page;
  (6) emails/digests if any render document-like HTML (check partnerDigest,
      customerDigest) -- flag, ask Dustin if in scope.
  Deliverable: a table (surface, generator file:line, medium, current style,
  migration risk) committed to docs/design/.
- C1. Shared theme, one implementation per medium, all from the same spec:
  masthead (title + org + double rule) / numbered sections (01, 02...) /
  Inter + JetBrains-or-fallback mono for figures, IDs, dates / hairline-ruled
  tables, right-aligned numerics / footer: generated timestamp, page N of M,
  integrity hash where the surface has one. Reference CSS: board mock .m3.
  (a) `client/src/styles/print.css` for window.print pages;
  (b) server PDF theme module exporting masthead/section/table/footer helpers;
  (c) XLSX workbook style helper (header row, column widths, footer sheet).
- C2. Migrate family-by-family, one commit each, before/after artifact per
  surface (rendered PDF/XLSX attached or path given for Dustin).
- C3. Acceptance = the checklist: every inventory row has a rendered output
  verified against a 10-point standard list (masthead, rules, section
  numbering, fonts, table style, footer, tokens-only colors, dark-safe where
  applicable, immutability respected, no orphan styles). 100% or not done --
  report gaps raw.

## Sequencing

B before C (Dustin should see the A+B app before export polish), unless he
reorders. One workstream per session; start each session by reading this doc,
MEMORY.md index, and `git log --oneline -5` on the branch.

## Needs Dustin (unchanged queue)

view A live -> approve/adjust -> B build -> B approve -> merge (linear) ->
deploy -> C0 inventory review -> C migrations. Open decisions: purple family,
icon library doc reconcile, email digests in C scope or not.

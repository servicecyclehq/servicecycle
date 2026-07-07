# Overnight Autonomous Session — 2026-07-07

Self-directed session (Dustin is going to bed). Work top-to-bottom through the
priorities below for as long as there's safe, well-scoped work left — expect
5-7 hours of runway. Stop a priority and move to the next when it's either
done, or blocked on something only Dustin can decide (flag it, don't guess).

**Repo scope: ServiceCycle only.** Forbidden to touch LapseIQ or Forgerift
without asking, no matter what. `git`/`tsc`/`jest` via the `windows-shell` MCP
(`run_powershell`), never the Linux bash sandbox for this repo (known
corruption). Droplet ops via the `vps-control` MCP tools, not manual SSH asks.
Targeted `git add` only, never `git add -A` (the working tree has a lot of
unrelated untracked scratch/resume files — leave them alone). `server/__tests__`
needs `git add -f` (gitignore matches `server/_*`). No live AI/Gemini/vision
calls — nothing tonight should burn AI quota. No SOC2-adjacent work (separate
session owns that backlog). No client-side/UI changes — keep everything
backend/schema/parser so there's nothing to visually regress unsupervised.
Every parser change is eval-gated: re-run `server/scripts/eval_extraction.py`
before/after, compare per-tier recall, zero tolerance for regressing clean/
partial to chase garbled. Every schema change ships as an additive migration
(new nullable columns/tables only) with `tsc --noEmit` + full jest clean
before commit. Deploy only when runtime code changed; verify `get_app_status`
healthy after. Real-Postgres tests for anything DB-touching, never mocked
Prisma for new coverage.

**Before touching anything below:** several of these findings come from
`docs/scoping/audits/afx-scenario-preservation.md` (written 2026-07-05) and
`docs/COMBINED_BUILD_BACKLOG_2026-07-04.md`. Re-verification tonight already
found that doc partly stale — F1 (study date defaulting), the W3 near-term
`reportFileKey` fix, and the `TestMeasurement.label` schema column are ALL
already shipped (confirmed via grep before writing this prompt). **Don't trust
any line number or "still open" claim in that doc without re-checking current
code first** — it says so itself, repeatedly, and it was right to warn.

---

## §1 (highest priority) — Test-report capture-gap fixes (W2 + W4 gate)

The `TestMeasurement.label` column exists (shipped 2026-07-05, comment cites
"[W2] ... approved 2026-07-05") but verify whether any ingestion path
(`server/pyextract/extractor.py` → `server/lib/commitTestReport.ts`) actually
populates it with per-reading identity (DGA gas species, PI winding pair
"H-G"/"X-G", PF test mode "CH+CHL GST", battery cell number) as opposed to
staying null, or colliding with the *other*, older `label` concept already in
`commitTestReport.ts` (unit/section label — a different field, don't confuse
the two). Confirmed still-open going into tonight: **`asLeftValue`/
`asLeftUnit`** columns exist on `TestMeasurement` but no code path writes to
them anywhere (NETA MTS 5.4 requires both as-found and as-left; only as-found
is ever populated). Fix the ingest path, don't add new columns.

**W4 gate first:** before eval-gating any of this, check the golden test
corpus's own ground truth for completeness — the audit flagged a DGA sample
whose ground truth lists only 3 of 8 gases present in the synthetic report,
with no gas-species identity on the ground-truth rows either. A parser change
that hits "100% recall" against incomplete ground truth is a false signal.
Fix the ground truth first if it's still wrong, *then* use it to gate the
rest of this section.

Concrete gaps to verify + fix (re-locate current line numbers via grep, don't
trust the ones below — extractor.py has moved repeatedly across the last
week's sessions):

- DGA: gas species identity discarded (7 distinct readings commit as 7
  identical-looking `dissolved_gas` rows); historical readings truncated to
  first value only (a 5-time-point series keeps 1); gases beyond the known
  concern-limit list dropped entirely instead of stored with no limit.
- Insulation resistance / PI: reading identity (winding pair, time point)
  discarded; a 4-column grid (time/test voltage/megohms/leakage current)
  keeps only megohms; one of two IR-grid parsing paths still uses `v > 0`
  (drops a legitimate zero-ohm reading) while the other was fixed to `v >= 0`
  on 2026-07-04 with a "zero IR is safety-critical" comment — check if that
  fix has since reached both paths or still only one.
- Power factor / Doble: test-mode identity discarded; a 5-value bushing row
  (nameplate capacitance, nameplate PF, measured capacitance, uncorrected PF,
  corrected PF) keeps only corrected PF.
- Battery: no field for per-cell identity — cells commit as repeated rows
  with no cell number, identical-value cells can dedupe-collapse incorrectly.
- TTR: not captured deterministically when a table has no unit token
  (ratios/DAR are dimensionless) — relies on AI gap-fill that only fires
  under a narrow condition.
- All types: raw extracted text is never durably persisted anywhere
  (`IngestJob.result` keeps the post-collapse preview only) — worth adding a
  durable raw-text store so a future pipeline fix can reprocess existing
  uploads instead of requiring re-upload, IF this is a small addition; skip if
  it turns out to need real design work.

Design call you get to make (not a blocker): if a catch-all identity field is
still needed anywhere beyond the existing `label` column, keep it minimal —
one nullable free-text column per table, write-only is fine for v1 (doesn't
need to be surfaced in any UI yet), follow the exact precedent already set by
`TestMeasurement.label`'s own doc-comment. Don't over-design this.

Eval-gate every extractor.py change. Real-DB jest tests for every
commitTestReport.ts change. This is the biggest, most valuable chunk of
tonight — expect to spend the most time here.

## §2 — Small arc-flash honesty fixes (F4, F6, F7)

From the same audit, re-verify each is still open before fixing (F1/F3/W3
already turned out fixed — don't assume these three are still open either):

- **F4:** `arcFlashAfxMultiTable.ts`'s `mapEquipmentTypeResult()` computes a
  `matched: false` flag specifically to signal an unrecognized equipment type
  defaulted to SWITCHGEAR — check whether the production caller in
  `arcFlashIngest.ts` actually reads/preserves that flag or silently drops it
  before it reaches storage/review UI.
- **F6:** a bare "breaker" with no trip-unit type is assumed fixed-trip and
  marked as satisfied protective-device data — but the extraction contract
  never asks for trip-unit type. Add it to the ask if this is still true.
- **F7:** the printed PDF arc-flash label has a per-value source-provenance
  flag for table-derived shock boundaries; the public QR label page only has
  a blanket footnote, not the per-value flag. Bring the QR label to parity if
  still true.

Small, mechanical, no schema risk expected. Good filler between bigger tasks.

## §3 — Garbled-tier parser: 3 named gaps (from 2026-07-05's A2 session)

Documented, not yet attempted, in `server/pyextract/extractor.py`:

1. report_008/016 — a bare multi-phase row crammed mid-line after the label
   ("DLRO uO A 41 B 39 C 58") that `_BUS_INLINE_ROW_RE`'s `^` start-of-line
   anchor can't reach.
2. report_012 — "1MIN <value>" has no `MEASUREMENT_LIBRARY` alias to
   `insulation_resistance` (the 10MIN reading is a distinct DAR/PI input,
   correctly NOT aliased the same way — don't merge them).
3. report_005 — power-factor label "CH+CHL GST" (a Doble test-config
   abbreviation) has no alias either.

Same eval-gated methodology as every prior parser session: full 20-report
harness before/after, per-tier recall, zero regression tolerance on
clean/partial to chase garbled gains.

## §4 (nice-to-have) — EDMS Phase 1, schema-only slice

Full scope is `docs/scoping/EDMS_MODULE_SCOPE_2026-07-04.md` (locked,
6-8-week build). Tonight, cherry-pick ONLY the purely-additive, zero-user-
impact piece: the Prisma migration adding `DrawingRevision`,
`DrawingAnnotation`, `DrawingSymbolLink`, `DrawingShareLink`,
`DrawingPageText` (exact model defs in §5 of the scope doc) plus the nullable
`Document.currentRevisionId` / `Site.retentionPolicy` / `Account.edmsSettings`
columns, and the `edms` feature flag key in `lib/accountFeatures.ts` (default
OFF). **Stop there.** Do NOT touch `lib/storage.ts`/R2 wiring, do NOT touch
the Dockerfile (LibreOffice/LibreDWG layer), do NOT write any route/UI code —
those need real R2 credentials and Dustin's review of the first deploy, per
the scope doc's own phase breakdown. This is genuinely optional if §1-§3 eat
the whole night — it's a clean, low-risk head start, not a requirement.

## §5 (nice-to-have, cleanup) — small items if time remains

- Remove the dead 2-argument `signPayload(body, secret)` legacy code path in
  `lib/webhook.ts` — confirmed zero live callers via full-codebase grep in
  the 2026-07-06 security review. Every real call site already passes the
  3-arg `(body, timestamp, secret)` form. Low-risk cleanup, closes the one
  Low finding from that review.
- Fix the mojibake found tonight in `server/prisma/schema.prisma`'s doc
  comments (e.g. `MÎ©` should read `MΩ`, `Â°C` should read `°C`, `Â§5.4.2`
  should read `§5.4.2`, `â‰¥100` should read `≥100`) — cosmetic only (doesn't
  affect Prisma parsing/behavior), but worth a clean pass since it'll
  propagate into every future comment copy-paste. Verify `prisma validate` /
  `tsc` still clean after — this should be a pure text fix, zero functional
  risk. Grep the rest of the schema file for the same corruption pattern
  before assuming these are the only instances.

---

## Closing: recap memory file (required)

Same structure as every prior overnight session — write to the memory
directory as `servicecycle-overnight-<topic>-2026-07-07.md`, `type: project`
frontmatter, and cover: what shipped (commits + HEAD), what was verified
clean vs. what was a real bug, what's still open for Dustin (explicit
questions, not silent guesses), and process notes (anything that cost time
or surprised you). Update `MEMORY.md`'s index with one new line at the top of
"⭐ Start Here" pointing to it. Don't let the index creep back over budget —
if adding this pushes it close to 25KB again, compress an older entry on the
way in rather than waiting for the next dedicated consolidation pass.

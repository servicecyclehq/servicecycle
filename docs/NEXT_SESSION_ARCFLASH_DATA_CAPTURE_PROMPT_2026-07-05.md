# Next session — Arc-flash data-completeness program (Phase 0 + decision-gated build)

**Model: Sonnet** (claude-sonnet-5) as the driving model. This work is a mix
of small precise fixes and a couple of real decision points with me — not a
long unsupervised run, so there's no reason to pay for Opus on the driver
seat. Use **fable** subagents for any research/verification/adversarial-review
pass, same as last session — it's what caught a factual error and two subtly
wrong "already built" claims before they became implementation bugs. Don't
skip that step when you get to W1 or W2 below.

**Repo constraint (standing rule, not optional):** work only in the
ServiceCycle repo (`C:\Users\ddeni\Desktop\ServiceCycle`). Never touch
LapseIQ or Forgerift without asking me first, no matter what mode you're in.

## Read first

1. `docs/scoping/audits/afx-scenario-preservation.md` — this is now the
   single source of truth for this whole program. It's self-contained (no
   external memory pointers needed), has a `## Program scope expansion`
   section with workstreams W1-W8, a `## Fallback-masks-capture hunt`
   section with findings F1-F7, an explicit **Phase 0** definition, and a
   **Decision gates** section at the bottom telling you exactly what's
   solo-buildable vs. what needs me first. Read the whole thing before
   touching code.
2. Load the `engineering-guidelines` skill before touching any route/lib/
   pyextract file.
3. Memory: `feedback_capture_over_fallback` (the standing principle — a
   working default never excuses not capturing a real value when a source
   document states it; don't soften severity because a fallback exists),
   `servicecycle-a2-and-backlog-2026-07-05` (this program's full history,
   for context on how we got here — but the scoping doc itself is the
   thing to build from, not this).

## Pre-flight

Verify via the **windows-shell PowerShell MCP tool**, not the Linux bash
sandbox (it serves stale file copies — this bit a prior session). Confirm
`git status`/`git log` clean and matching `origin/main`, run `tsc` and the
jest suite, confirm the baseline failing-suite set matches the known
env-dependent baseline (don't chase those).

## Part 1 — Phase 0 (build first, no decisions pending)

Both are one-line-ish bug fixes in `routes/arcFlashIngest.ts`'s confirm
handler, fully scoped in the doc as F1 and F3:

- **F1**: `performedDate` defaults to `new Date()` when the client doesn't
  send one (it never does) — but the real study date is *already extracted*
  (`arcFlashExtract.ts` asks for `studyMeta.date`) and just never gets read
  back out at confirm. Fix: read it. **Decision point folded in, don't skip
  it**: the extracted date is a free-form string ("March 2021," "Q3/2021").
  If it doesn't parse cleanly, it must surface for manual review — NOT
  silently fall back to `new Date()` again, or this fix reintroduces the
  exact bug it's fixing.
- **F3**: `method` defaults to `'IEEE 1584-2018'` (the current edition)
  whenever extraction misses it — precisely defeating the check for "is this
  study using an outdated method," on exactly the old/low-quality documents
  most likely to need that check. Fix: don't assert a method that wasn't
  actually read.

Eval-gate both against the golden corpus per usual. These affect study-age
and regulatory-staleness scoring, so also spot-check against real samples in
`Arc Flash Samples/` if you can find one with an unparseable or unusual date
format, to make sure the "surface for review" path actually fires correctly.

## Part 2 — also solo-buildable per the doc's decision gates

- **W3's near-term fix**: `SystemStudy.reportPdfUrl` already has a working
  manual UI (`SiteDetail.jsx`) — don't touch that. What's missing is
  auto-populating it at ingest confirm and surfacing it on the per-asset Arc
  Flash tab. **Watch the semantics trap the doc calls out**: the existing
  field expects a real URL rendered as `<a href>`; `ingest.fileKey` is an
  internal storage key, not a URL. Resolve it to a servable URL at write
  time (or use a separate field) — don't just copy the raw key in, or you'll
  break the existing "Open" link.
- **W4**: audit the golden-set corpus (`server/scripts/neta_synthetic_test_reports.json`)
  for its own completeness — at least one sample's ground truth already
  under-counts what's actually in its own text (3 of 8 gases). Fix the
  corpus itself before trusting any "100% recall" number on later work,
  since this is a prerequisite gate on W2, not an independent later step.

## Part 3 — flag for me, don't build solo

Per the doc's decision-gates section, these need a quick confirm from me
before code gets written:

- **W1** (native-PDF ingestion + structure-aware chunking): the cost/design
  posture (always-native-PDF vs. today's deterministic-first-then-vision
  design) is a real spend/quota tradeoff, not a pure engineering call. Also
  needs a concrete structural-boundary-detection design before
  implementation starts — "cut at structural boundaries" isn't
  specific enough to build from yet.
- **W2** (per-field capture safety-net pass): the catch-all-field design
  (where it lives, whether it's ever surfaced to a user, when a named
  column is required instead) needs a short design decision, not an
  ad-hoc call mid-implementation.

Bring me a short options list for each, same pattern as the A2 Half 2
decision last session — don't pick silently.

## Explicitly out of scope this session — already gated on my own call

- **W5** — the original AFX true multi-scenario schema/read-path redesign.
  Biggest item in the whole program; needs my own sequencing decision.
- **W3's `DocumentAsset` many-to-many addition** for plain-uploaded one-lines
  (as opposed to the near-term ingest-linked fix in Part 2, which IS in
  scope). Smaller than full EDMS Phase 2 but still new schema.
- **EDMS Phase 2** broadly (the full tap-to-link-a-symbol-to-an-asset
  system) — already flagged in earlier sessions as too big to sequence
  solo.

## If there's time left over

- **W8**: the fallback-masks-capture hunt (F1-F7) was scoped to arc-flash
  only. The same pattern is known to exist in the general test-report
  pipeline (`commitTestReport.ts`, `extractor.py`, DGA/PF evaluation, Doble
  import, nameplate path) but nobody's run the equivalent systematic hunt
  there yet. Sequence after W2, not before — no point flagging things W2
  is about to fix anyway.
- **Coverage gap in the existing hunt**: `arcFlashPermit.ts` — the code that
  gates whether energized work can proceed — was never checked in the F1-F7
  hunt. Arguably the highest-stakes file in the whole system and it's
  sitting in "not yet checked," not "clean." A single fable agent pass on
  just this file would close that gap cheaply.

## Hard constraints (carry forward, non-negotiable)

No live AI/Gemini calls unless I'm present and explicitly want a spot-check.
No money/billing changes. No UI work without a visual review pass with me.
Verify via windows-shell, not the bash sandbox. Targeted `git add <files>`
only, never `-A`. Every ingest code-path change eval-gated against the
golden corpus. Migrations additive-only; if one ships, rebuild both
`server-migrate` and `server` together, not just `server`. PowerShell `>`
redirection writes UTF-16LE, not UTF-8 — don't let that corrupt a file.
`main` is linear-history only — rebase/squash, never `git merge --no-ff`.

## Recap requirement

Append a dated section to the `servicecycle-a2-and-backlog-2026-07-05`
memory (or start fresh if it's grown too long) covering: what shipped from
Phase 0/Part 2, what got flagged back to me from Part 3 and what I decided,
and any new findings from Part "if there's time left over." Update
`MEMORY.md`'s index line to match.

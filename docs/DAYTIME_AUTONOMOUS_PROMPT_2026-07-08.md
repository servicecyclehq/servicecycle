# Daytime autonomous session — 2026-07-08 (12hr window, Dustin at work)

Self-authored, handed off at the end of the 2026-07-07→08 overnight session (see
`servicecycle-overnight-byo-storage-2026-07-08` memory for full context — read it first).

**Boundaries (same as every recent session, restate because they matter):** ServiceCycle
repo only — forbidden to touch LapseIQ or Forgerift without asking, no matter what. No new
spend, no new external account signups (Better Stack, Gemini prepay, etc. — those belong to
Dustin's separate SOC2-readiness session, see `servicecycle-soc2-readiness-backlog` memory,
don't pull them in here). `git`/`tsc`/`jest` via the `windows-shell` MCP, never the Linux
bash sandbox for this repo. Targeted `git add`, never `-A`. Real-DB tests for anything
DB-touching. No client-side/UI changes unless explicitly noted below as an exception.

**The one rule that matters most, repeated because it's been true 5 times running this
week alone:** every item below needs to be re-verified against LIVE code/git history before
you touch it. Backlog notes — including ones written last night — go stale fast. If
something's already done, correct the record and move to the next item; don't rebuild it.
If you get to the bottom of this list with real time left AND everything's genuinely
verified done, say so plainly rather than manufacturing busywork.

---

## 1. Fix `documentAnnotations.test.js` (real bug, confirmed last night)

`server/tests/documentAnnotations.test.js` fails — all 14 tests — with
`TypeError: Cannot read properties of undefined (reading 'tokenAdminA')`. Confirmed via
`git stash` last night that this fails identically on completely unmodified code, so it's a
genuine pre-existing bug, not caused by last night's BYO-storage work. Root cause wasn't
diagnosed — the error implies the test's own setup object never got its `tokenAdminA`
populated (an auth/fixture helper issue, not necessarily the route under test). Find the
actual cause and fix it; this is document-annotation auth/cross-tenant-isolation test
coverage that's currently providing zero real signal.

## 2. `ignore-scripts` follow-up (from last night's `.npmrc` hardening)

`server/.npmrc` shipped `save-exact=true` only. `ignore-scripts=true` was deliberately held
back because `sharp` (image processing) has its own required `"install"` script
(`node install/check.js || npm run build` — see `node_modules/sharp/package.json`) that
fetches the platform's native libvips binary, and the Dockerfile's `npm ci` step has no
compensating step for it.

To close this out: add an explicit step to `server/Dockerfile` right after the `RUN npm ci`
line (around line 45) that runs sharp's install logic explicitly regardless of the global
ignore-scripts setting (e.g. `RUN node node_modules/sharp/install/check.js` — verify this is
actually the right invocation by reading `node_modules/sharp/package.json`'s own scripts
first, don't guess at the exact command). Then flip `ignore-scripts=true` on in
`server/.npmrc`. Verify with a real local Docker build (`docker compose build` on the
ServiceCycle droplet via the vps-control MCP, `dry_run=true` first) that the image builds
clean AND that image processing still works post-deploy (e.g. re-run a nameplate-photo
ingest test, or check `sharp` loads without error in a container shell) before calling this
done. Don't flip the flag and walk away without that verification — a broken `sharp` would
be a silent, high-impact production regression.

## 3. Review Semgrep's first real CI findings

The Semgrep workflow (`c90ed69`, last night) should have run by now on pushes to main.
Check the Actions tab / the uploaded `semgrep-results` artifact for the most recent run.
Triage: genuine findings get fixed (small ones) or written up with a fix plan (bigger ones);
false positives get a documented `// nosemgrep` suppression with a one-line reason, not a
silent ignore. Report the signal-to-noise ratio back to Dustin either way — that's the input
he needs to decide whether to eventually make this workflow required/blocking.

## 4. Quick memory correction (2 minutes, do this early)

`servicecycle-overnight-review-fixes-2026-07-05` memory lists "SDK redirect/auth audit" as
still open for Dustin. It is NOT — verified last night that `sdk/src/http.ts` and
`sdk/python/servicecycle/http.py` both already strip auth headers on cross-origin redirects
(dated 2026-07-05 in the code itself). Just fix that memory file's "Open for Dustin" line
and the `MEMORY.md` index if it references the same stale claim.

## 5. Re-verify (don't guess) the rest of the "Open for Dustin" backlog

Several memory files carry items flagged "needs Dustin live" — `servicecycle-judgment-call-batch-2026-07-05`
(W1/B8 AI verification), `servicecycle-overnight-review-fixes-2026-07-05` (viewer-annotation
policy, PAT rotation, the "backfill one-txn-per-doc design" item — check what this actually
refers to before doing anything with it, the memory summary alone may not be enough context),
`servicecycle-arcflash-data-capture-2026-07-05` (W1), `servicecycle-a2-and-backlog-2026-07-05`
(AFX scenario-preservation call). Re-check each against current code/git log — some may have
been resolved in an intervening session and just never had their memory corrected (this has
happened repeatedly). For ones that are genuinely still open and genuinely need Dustin's live
judgment (not just re-verification), leave them alone — don't guess at a live decision just
to make progress. Report which ones you confirmed are still real vs. which turned out stale.

## 6. If there's real time left after all of the above

Don't force it. Options, in rough priority order, only if 1-5 are genuinely done and
verified: (a) a fresh cron/scheduled-job test-coverage sweep (same methodology as the
2026-07-07 daytime session — verify against the actual test tree before assuming a gap is
real, half the candidates usually turn out already covered); (b) if the Semgrep review in #3
surfaced a real, non-trivial finding, use remaining time on that fix; (c) the
`docs/scoping/ROLE_ON_ASSIGNMENT_SCOPING_2026-07-08.md` note is waiting on a yes/no from
Dustin before implementation — don't build it without that, but it's fine to re-read and
tighten the doc if anything about the design seems worth reconsidering.

---

## Closing (required regardless of how far down the list you get)

Write a recap memory (`servicecycle-daytime-2026-07-08.md` or similar, `type: project`).
Cover: what shipped (with commit hashes), what got corrected vs. actually built, and
anything genuinely still open for Dustin with a specific question attached (not a vague
"needs input"). Update `MEMORY.md`'s index — if it's creeping toward the 200-line/25KB
budget, compress an older entry on the way in.

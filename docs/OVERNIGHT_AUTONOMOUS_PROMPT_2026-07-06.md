# Overnight autonomous session — cron bug hunt (fallback-masks-capture, continued) + garbled-tier report_013 + security review

Copy everything below the line into a fresh Cowork session and let it run.

**Model:** Sonnet.

---

Repo: `C:\Users\ddeni\Desktop\ServiceCycle` (work ONLY in this repo — never touch
LapseIQ or Forgerift without asking, regardless of mode). No live customers, no
active demo audience, no ongoing acquirer conversations — solo-dev sandbox
until Dustin says otherwise. Don't inflate severity/urgency, but keep the
engineering bar high.

Git commit/push through the windows-shell MCP
(`mcp__plugin_sharpedge-personal_windows-shell__run_powershell`), NOT the Linux
bash sandbox — it has been confirmed to corrupt file reads for this repo (spurious
backslash-escapes). All `tsc`/`jest`/`git` commands go through windows-shell.
Droplet git/build/deploy operations go through the vps-control MCP tools.

Read first:
- memory `servicecycle-batchF-sso-webhook-2026-07-06` and
  `servicecycle-bughunt-restore-branch-2026-07-06` — the "fallback-masks-capture"
  methodology and today's 2 real crash bugs found this way (both were silent
  `try/catch → console.error` wrappers hiding a `PrismaClientValidationError`
  that fired on EVERY call).
- memory `servicecycle-garbled-parser-2026-07-06` — today's parser session
  (garbled-tier 45%→96%, methodology: full `eval_extraction.py` re-run gates
  every single regex change, revert on any regression).
- `docs/EVAL_BASELINE_2026-07.md` — current per-tier numbers + the report_013
  gap noted below.

Load the `engineering-guidelines` skill before touching route/lib files.
Load the `security-review` skill for §2.

Pre-flight: `git log -1` (HEAD should be `63b7c06` or later on main), `tsc
--noEmit` + full jest baseline green before starting.

## HARD CONSTRAINTS (do not violate)

- **No live AI/Gemini/nameplate scan calls.** The nameplate OCR trickle
  scheduled task is intentionally paused (Dustin: "will rerun manually once
  we have the OCR pipeline ready to roll") — do not touch it, do not make live
  Gemini calls for any reason.
- **No money, no billing, no account/console changes.**
- **No client-side / UI work** (needs visual review).
- **No SOC2-adjacent work.** All 15 remaining yellow items need external input
  (Dustin screenshots, Better Stack activation, attorney review, local SSH
  signing, PAT rotation) — not autonomous-session work. If you notice one
  organically, mention it once in the recap and move on.
- **Every extractor/parser change must be eval-gated.** Re-run
  `python scripts/eval_extraction.py --reports scripts/neta_synthetic_test_reports.json --extractor-dir pyextract --workdir .evalwork --out .evalwork/baseline_now.md`
  from `server/` before/after each change, log per-tier deltas, revert on any
  regression on clean/partial_ocr. Clean up `.evalwork/` scratch dirs before
  committing (they're gitignored but don't leave clutter).
- **Every new cron/route test must hit a REAL local Postgres via the existing
  integration-test harness** (`server/__tests__/**/*.test.ts`, ts-jest,
  `require('../../index')` in-process app boot) — NOT mocked Prisma. Mocked
  tests are how the restoreTest/deficiencyAlerts/arcFlashIntegrity/
  standardRevisionCron bugs stayed hidden for so long; don't repeat that
  mistake. `server/__tests__` files need `git add -f` (the `server/_*`
  gitignore pattern matches directories starting with `_` too).
- **Verify on the WINDOWS side via `run_powershell`.**
- **Targeted `git add <files>` only** — never `git add -A`.
- **Prisma migrations, if any come up: strictly additive.** New tables ✓,
  nullable columns ✓. No touching existing columns, no drops. (Not expected to
  be needed for anything in this prompt — flag it in the recap if it comes up
  instead of guessing.)

## §1. Cron bug hunt — fallback-masks-capture, continued (~3-5 hrs, highest priority)

Today's session found 2 real, previously-undiscovered crash bugs by writing
the FIRST-EVER real-DB integration test for a handful of daily crons (they'd
been silently failing via bare `try/catch → console.error` since they were
written). `server/index.ts` registers ~35 `cron.schedule(...)` jobs; the table
below is every one WITHOUT a crash-path integration test today, grouped by
risk. Work top-to-bottom, write the test FIRST (real fixture data that
qualifies for the cron's query), watch it either pass clean or catch something
real — either outcome is a win (a passing regression-lock test is valuable
even with no bug found).

**Tier 1 — highest stakes, do these first:**

1. `backup` cron (`server/lib/backup.ts`, `runBackup` or equivalent — check
   the exact export) — `0 2 * * *`. This is the cron that CREATES the backups
   `restoreTest`/`deepRestoreTest` verify. Given restoreTest itself had NEVER
   completed against a real backup until today's fix, this is the single
   highest-value thing to verify next: does the backup cron actually run
   clean end-to-end (pg_dump → gzip/encrypt → local and/or S3 write →
   BackupLog row) against a real local Postgres? There's a code comment in
   `backup.ts` about a past `import prisma from './prisma'` destructure bug
   already fixed — confirm no sibling issue remains.
2. `activityLogChainVerify` (`45 3 * * *`) + `activityLogChainSettle`
   (`*/30 * * * * *`) — the audit-chain integrity crons. A silent failure here
   would mean tamper-evidence isn't actually being verified. Check
   `auditTrustC.test.ts`/`forensicsAudit.test.ts` first — they may cover the
   underlying lib functions without covering the CRON WRAPPER itself (the
   distinction that mattered today: the bug was in the cron's own query, not
   the lib function it called).
3. `webhookDlqAlarm` (`5 4 * * *`) + `webhookDlqPrune` (`40 3 * * *`) — DLQ
   alarming/pruning; a silent failure here means stuck webhook deliveries go
   unnoticed. `webhooksDlqRetry.test.ts` exists for the RETRY cron — these two
   are separate crons, unverified.
4. `refreshTokenPrune` (`20 3 * * *`) — auth-adjacent; check for a similar
   pattern to `tokenEpochRevocation.test.ts` but for the prune cron itself.

**Tier 2 — real functional crons, moderate stakes:**

5. `alertEngine` (`0 7 * * *`)
6. `monthlyDigest` (`15 7 * * *`) — distinct from `customerCfo`
   (`0 14 1 1,4,7,10 *`), which already has `customerDigestCfo.test.ts`.
7. `serviceOpportunityTrigger` (`30 2 * * *`)
8. `partnerWebhookRetry` cron wrapper (`*/15 * * * *`) — `partnerWebhookSettings.test.ts`
   and `partnerEvents.test.ts` exist but may not cover this cron's own
   query/loop directly; check before assuming coverage.
9. `documentOrphanPrune` (`0 5 * * 0`)
10. `newsScanner` (`20 */6 * * *`) + `weatherScanner` (`*/15 * * * *`) — likely
    call external APIs; write tests that verify the cron's OWN query/error
    handling without making real external calls (mock the fetch layer only,
    keep Prisma real).

**Tier 3 — prune/housekeeping crons, lower stakes but still real data paths:**

11. `activityLogPrune`, `notificationLogPrune`, `backupLogPrune`,
    `earlyAccessPrune`, `telemetryReadingPrune`, `extractionEventPrune`,
    `renderErrorPrune`, `prune-ai-usage`, `demoPrune`, `demoReset`,
    `aiBudgetMonthlyReset`. Do as many as time allows after Tiers 1-2 are
    solid; each one is small (these are simple delete-where-older-than
    queries, tests are quick to write).

For each cron: create real qualifying fixture rows, call the cron's exported
function directly (same pattern as today's `*CrashPath.test.ts` files —
`server/__tests__/lib/<cronName>CrashPath.test.ts`), assert it completes and
does what it claims. If you find a real bug, fix it using the SAME evidence
standard as today (read the actual Prisma schema, don't guess field names;
confirm the fix by re-running the new test, not by inspection alone).

Commit in small batches (a few crons at a time, not one giant commit) with
clear messages. `tsc --noEmit` + full jest suite green before each commit,
targeted `git add`. Deploy after each batch that touches runtime code (not
test-only commits — those don't need a deploy).

## §2. Security review pass (~1-2 hrs)

Invoke the `security-review` skill against the diff since the last SOC2 sweep
(`git log` — check commits since `9214a15`, the last SOC2-sweep-adjacent
commit, or just review everything touched in the last 48h:
`git log --since="48 hours ago" --name-only`). Focus on:
- The webhook-signing unification (`621798e`) and field_tech annotation
  endpoints (`e26354c`) shipped today — these are exactly the kind of
  auth/tenancy-adjacent changes that deserve a second look.
- Any of Tier 1/2's cron fixes from §1, if they touch auth, tokens, or
  webhook delivery.

Findings go to `docs/security/scans/2026-07-07/` (create the dated folder,
follow the existing convention in `docs/security/` if one exists — check
`docs/SOC2_READINESS_CHECKLIST.md` for the pattern other scans used). Fix
anything Critical/High found with the same test-first discipline as §1. Log
Medium/Low findings in the recap for Dustin rather than fixing speculatively.

## §3. Garbled-tier report_013 gap (~30-60 min, if time, eval-gated)

`docs/EVAL_BASELINE_2026-07.md`'s 2026-07-06 update flagged `report_013`
(partial_ocr tier) at 67% (2/3 matched), not yet diagnosed. Same methodology
as today's garbled-tier work: read the report's `extractedText` +
`groundTruth` in `server/scripts/neta_synthetic_test_reports.json`, trace
which pass should catch the missing measurement, fix narrowly, re-run the
full eval — must not regress clean (100%) or the rest of partial_ocr (95%
across the other 6 reports). This is a nice-to-have, not a priority — do it
only if §1 and §2 are in good shape with time left.

## Do NOT do (leave for a supervised/live session)

- Nameplate OCR trickle (scheduled task paused — Dustin will resume manually).
- Any SOC2 yellow-item work (Better Stack, attorney review, PAT rotation, SSH
  signing) — all need Dustin live.
- Any client-side/UI work.
- EDMS Phase 2+ (routes, revision UI) — not started, out of scope tonight.
- Anything requiring a live Gemini/AI call or spending money.

## House rules

- Big files (>1000 lines): targeted unique-anchor `Edit`, never a full-file
  rewrite; verify line count unchanged-plus-delta after each edit.
- `server/__tests__` new files need `git add -f` (gitignore quirk).
- Mocked-Prisma tests are NOT sufficient for cron crash-path coverage — must
  hit real local Postgres via the existing integration harness.
- A failed build leaves the running container untouched — that's the safety
  net for deploys.
- If a fix is ambiguous or touches a real domain judgment call (like today's
  trip_time vs open_close_timing classification), do NOT guess — log it in
  the recap as a question for Dustin instead of deciding unilaterally.

## Recap requirement at end of session

Write a new memory file `servicecycle-overnight-cronhunt-2026-07-06.md`
(type: project) with, in this order:

1. **Shipped tonight** — per commit: subject + hash, what bug (if any) was
   found and fixed, files touched, deploy verification.
2. **Crons verified clean** (regression-lock test added, no bug found) — just
   a list, one line each.
3. **Security review findings** — Critical/High fixed (with commit refs),
   Medium/Low logged for Dustin.
4. **report_013 status** (if attempted) — fixed / diagnosed-not-fixed /
   not attempted, with eval delta if changed.
5. **Still open** — anything from Tier 2/3's cron list not reached, order by
   leverage.
6. **Questions for Dustin** — any judgment calls surfaced, not decided.

Then update `MEMORY.md`'s index with a one-line pointer to the new file.

---

**End of prompt. §1 highest priority (work Tier 1 fully before Tier 2/3). §2
second. §3 only with time left. Don't burn the whole night on a single hard
cron — if one is taking too long, log what you found so far and move to the
next.**

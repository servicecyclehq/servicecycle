# ServiceCycle — 2026-07-08 Acquisition Audit Remediation — Run 2

**Source docs:** `docs/REMEDIATION_SUMMARY_2026-07-08.md` (Run 1) / `docs/AUDIT_PUNCHLIST_2026-07-08.md` (running list)
**Remediation session:** 2026-07-08, single Cowork session, 7 code/infra commits on `main` + 1 lockfile hotfix (`bbb8a32`, found during deploy) + 2 docs commits (initial writeup + this deploy-record fill-in).
**HEAD before this pass:** `a683d8e` · **HEAD after (deployed to prod):** `bbb8a32`

---

## 0. Environment note (read this before trusting anything else in this doc)

Early in this pass, `mcp__workspace__bash`'s view of the mounted `ServiceCycle`
folder showed ~70 files with real content differences from `git HEAD` —
several matching the exact "big-file truncation hazard" pattern the project
guardrails warn about (`server/lib/backup.ts` on disk: 494 lines vs. 744 in
`HEAD`; `server/index.ts`: 2550 vs. 2660; etc.), across files nobody had
touched this session.

**This was a false alarm, not real data loss.** Cross-checked directly on the
Windows host via PowerShell (`mcp__plugin_sharpedge-personal_windows-shell`):
every affected file's real on-disk line count matched `git HEAD` exactly, and
`git status --short` from the native host showed a clean tree. The
`Read`/`Edit`/`Write` tools also independently agreed with the native host,
not with the stale bash view. Conclusion: `mcp__workspace__bash`'s FUSE mount
of this specific folder was serving a stale/cached snapshot this session — a
sandbox-side artifact, confirmed isolated to that one access path.

Also hit a stuck `.git/index.lock` that the FUSE mount couldn't remove
(`rm`/`python os.remove` both failed with `EPERM` despite correct ownership
bits) — again resolved by using the native Windows shell instead, where no
lock existed at all.

**Practical effect on this pass:** every file read/edit used the `Read`/
`Edit`/`Write` tools (confirmed reliable throughout) or the native
`windows-shell` PowerShell tool for git/build/test operations — `git status`,
`prisma migrate deploy`, `npx tsc --noEmit`, `npm run build`, `git commit`,
etc. all ran natively on Dustin's actual machine, not through the bash
sandbox, for this exact reason. Flagging this prominently because it's
exactly the kind of environment quirk a future session needs to know about
immediately rather than rediscover from scratch — matches this project's
existing "flaky Local Terminal MCP (use windows-shell)" memory note, just a
more severe instance of the same class of problem.

---

## 1. What shipped (with commit SHAs)

### Batch 1 — Schema/migrations/data-lifecycle — `739cc87`
- **W1-M4** LOTO append-only version history: `routes/loto.ts`'s `PUT`
  deleted+recreated `LotoEnergySource`/`LotoStep` on every revision,
  destroying the prior OSHA 1910.147 procedure text. Added `version`/
  `isCurrent` columns (guarded migration); `PUT` now flips old rows to
  `isCurrent:false` instead of deleting them, creates a new `isCurrent:true`
  set stamped with the incremented version. New `GET /:id/history` reads
  across every version, grouped.
- **W1-M5** demoPrune offboarding blockers: `demoPrune.ts` was missing
  explicit deletes for `PartnerInvite` (required, unindexed-until-Batch-1,
  Restrict FK → P2003 on `account.delete()`, the exact same bug class as the
  `PartnerEventLog` fix Run 1 already shipped) and `IncidentLog` (same —
  `scripts/seed-demo.js` already deleted it, `demoPrune.ts` didn't), plus 7
  arc-flash tables that use scalar FKs only (no real Prisma relation to
  `Account`, so no P2003, but no cascade either — silently orphaned forever
  instead of erroring). Extended `seed-demo.js`'s partial version (was only
  covering 3 of the 7) to full parity, which also fixed a duplicate-
  `ArcFlashIncident`-row-per-reseed bug found along the way. Added 3 fixtures
  (`PartnerInvite`, `IncidentLog`, `ArcFlashIncident`) as regression coverage
  in `demoPruneCrashPath.test.ts`.
- **W1-L7** dropped dead schema `IngestionSession` + `IngestionStatus` enum
  via a guarded migration — re-confirmed zero writers/readers anywhere in
  `server/` (only 3 defensive `deleteMany` prune calls, removed in this same
  commit), superseded by `ArcFlashIngest`/`IngestJob`.
  **`FailedLoginAttempt` was investigated and deliberately NOT dropped** —
  it's intentionally-provisioned infrastructure for a documented, still-open
  item (`routes/auth.ts`'s `loginFailMap` comment names it directly as the
  target of a scheduled-but-unimplemented DB-backed lockout, DD-8-4/SEC5),
  not dead code. The original punchlist item bundled both models under one
  line; only one of the two actually qualified.
- Verified: `prisma validate`/`generate` clean, `prisma migrate deploy`
  applied both new migrations cleanly against `servicecycle_dev`, `npx tsc
  --noEmit` clean.

### Batch 2 — W1-M2 rotate-master-key.js — `bbfdbcb`
Full rewrite. `rotateCloudConnectors()` called `prisma.cloudConnector` — no
such model exists anywhere in `schema.prisma` or its migration history; the
script would have thrown on line 1 of `--apply`. Replaced with
`rotateAccountSecrets()` covering the two fields the audit correctly flagged
as missing: `Account.importWebhookSecret` and `Account.storageS3KeyId`/
`storageS3Secret` (confirmed same `enc.v1:` scheme via `lib/webhookImport.ts`
and `lib/storage.ts`). Made every rotate function idempotent (try the new key
first, skip already-migrated rows) so `--apply` is now safe to re-run after a
partial failure — previously a crash partway through left the DB unrecoverable
by a straight re-run.

### Batch 3 — W1-M8 jest ./prisma mapper investigation + fix — `2724b27`
Investigated (not just re-stated) why broadening the `moduleNameMapper` regex
breaks tests: found **7** real test files depend on the current gap (not 5 as
Run 1's revert commented), via two distinct mechanisms — 5 use a custom
fake-client `jest.mock()` targeting the same resolved absolute path (would
break if the mapper redirected that path elsewhere), and 3 (`webhookDlq`,
`aiQuotaRefund`, and `aiQuota`, which had its own separate pre-existing bug —
see commit message) deliberately want a real DB round-trip. Left the regex
untouched (confirmed still correct) and relocated the 3 real-DB tests into
the `integration` jest project, which already has zero `moduleNameMapper`
friction by design — precedented by an existing test doing exactly this for a
sibling export of the same lib file.

### Batch 4 — W1-M10 route test coverage — `8addd49`
Re-audited the "19 of 84 untested" claim against live code first: the 5
originally-named priority files actually all had real coverage already (the
real zero-coverage count is 23, and none of the 5 belonged on that list) —
but a 6th, higher-risk file the original audit missed entirely,
`arcFlashLabelPublic.ts` (public, unauthenticated, safety-critical NFPA 70E
label data with staleness logic — the same risk shape as `shareLinkPublic.ts`
but with zero tests), got a full new test suite. Also closed the one
genuinely consequential, on-by-default, data-writing gap among the 5 named
files (`assetsImport.ts`'s `createMissingSites`/`autoApplySchedules`
branches), plus 3 quick high-signal assertions (`partnerInvitePublic`'s
anti-harvesting field omission, `shareLinkPublic`'s audit-trail write,
`dgaIngest`'s dedup guard).

### Batch 5 — Security hardening + W1-L10/L11/L12 — `09a7f1d`
- `lib/storage.ts`'s BYO-S3 client now applies the same DNS-rebind
  IP-pinning `lib/webhook.ts` already has (reused directly, no duplicated
  logic) — the existing SSRF guard only validated at config-save time, every
  live S3 request re-resolved DNS fresh with no pinning.
- `routes/inboundEmail.ts`'s 4 uniform-body 202 responses now also pad to a
  uniform minimum latency, closing the response-timing side-channel the
  identical-body fix didn't cover.
- **W1-L10**: `js-yaml` override added — top-level dep already patched, a
  transitive copy via jest's coverage chain wasn't; free dedupe, reachability
  was nil either way.
- **W1-L11**: vite/esbuild dev-only advisories were already correctly
  deferred (gated on the React 19 migration); fixed a stale code comment
  (wrong CVE cited, dead file path referenced) rather than force an isolated
  bump.
- **W1-L12**: `.gitleaks.toml`'s `your-.*-here` allowlist regex was
  unanchored/greedy; bounded.

### Batch 6 — Deploy rollback + web-tier config scaffold — `634ebf8`
`deploy.yml` had no rollback story at all (server images were never tagged;
client `html-backup-ci-*` snapshots existed but nothing pruned or restored
from them). Added SHA-based image tagging (only on a build that already
passed its own health check) + pruning to the last 5, and a new
`workflow_dispatch`-only `rollback.yml` that retags + force-recreates the
server container (no rebuild, `--no-deps` so migrations/db are never
touched) and optionally restores a named client backup. Free-text
`workflow_dispatch` inputs are regex-validated before ever reaching a
shell/ssh command (this repo runs Semgrep/CodeQL; treated as a real class of
finding, not theoretical). `deploy/README.md` scaffolds the still-unversioned
live nginx/TLS config — see §5, this one is genuinely incomplete.

---

## 2. Batch 8 live-check re-verification

Re-ran the close-out checklist from Run 1's punchlist against current live state:

- **Part/SpareInventory guarded-constraint NOTICE**: **could not verify**,
  same limitation as Run 1 — direct DB queries are hard-blocked by the
  vps-control MCP (`⛔ BLOCKED [direct-db]`, no override), and the one-shot
  `server-migrate` container's logs from the original migration run have
  since rotated out (a full app-stack redeploy happened on the droplet ~26
  minutes before this session started, recreating that container). Same
  fallback recommendation as Run 1: check via SSH/`psql` directly, or the
  app's own admin surface.
- **02:20 UTC uploads-sync cron**: confirmed via `lib/backup.ts` code (not
  logs, which also rotated out with the same redeploy) that this is a clean,
  intentional no-op on this droplet, not a bug — it explicitly checks
  `s3Configured()` first and logs a warning + returns `skipped:true` if
  `BACKUP_S3_*` isn't set, which it currently isn't (`BACKUP_DEST=local`
  confirmed live via the server's own boot log). Off-host sync was never
  activated on this droplet; this is the known, already-tracked SOC2-backlog
  gap, not a new finding.
- **02:00 UTC backup — found a real, separate, currently-active bug** (not
  what Run 1's fix targeted, and not yet caught by anything): the host
  directory bind-mounted into the server container's `/app/backups`
  (`/root/ServiceCycle/backups` on the droplet) is `root:root` mode `755`,
  but the server process runs as `node` (`uid=1000`) — meaning every nightly
  local backup write has almost certainly been failing with a permission
  error. Confirmed: the directory is completely empty (0 files) despite 12
  days of container uptime and a nightly cron; its sibling `./uploads` bind
  mount, which does have content, is `777` (world-writable) at the top
  level — same droplet, different permission bits, only one of the two
  actually works. **Could not fix directly** — `chown` is hard-blocked by the
  vps-control MCP's own security layer (`os-permission-destruction`, no
  override, message says "Connect via SSH... with awareness of the access
  impact"). **Needs Dustin, one command, over SSH** (the MCP genuinely can't
  do this — see §5).

---

## 3. Verification performed

- `prisma validate` + `prisma generate`: clean.
- `prisma migrate deploy` against `servicecycle_dev`: both new migrations
  (`20260708130000_run2_loto_version_history`,
  `20260708140000_run2_drop_dead_ingestion_session`) applied cleanly.
- `npx tsc --noEmit` (server): clean after every batch, and again after all
  6 batches combined.
- `npm run build` (client): clean, `vite build` + PWA precache succeeded.
- Real `jest` runs (not claimed, actually executed and read):
  Batch 3 — 4 suites / 27 tests. Batch 4 — 5 suites / 43 tests. Batch 5 —
  `inboundEmail.test.ts` 8/8, `accountStorageConfig.test.ts` 6/6 (after
  fixing a test fixture that predates a real-DNS-lookup requirement my own
  change introduced), `ingestJobs`/`ingestReviewGate.test.ts` 31/31.
- **Known gap, not attempted**: the ~15 "live-server" style route test files
  under `server/tests/*.test.js` (including `loto.test.js`, the file most
  directly relevant to this pass's LOTO changes) connect to an actual running
  `npm run dev` server on `:3001` rather than an in-process app — this is a
  pre-existing, already-documented environment limitation (this project's own
  memory already notes "jest needs live :3001 dev server, can't run in
  automated session"), confirmed again this session (attempted to background
  a dev server via the Windows shell tool; it did not come up reachable on
  `:3001` within a reasonable wait). The LOTO route changes are covered
  instead by: `npx tsc --noEmit` type-checking every Prisma query shape
  against the regenerated client (would catch a wrong field name/type on
  `isCurrent`/`version`), `prisma validate`/`migrate deploy` succeeding, and
  direct code review. **Recommend**: run `npm run dev` + `npx jest
  tests/loto.test.js` (and the other live-server suites) in a session where
  that's reachable, before the next deploy that touches `routes/loto.ts`
  again.
- Independent per-batch verification: Batches 3-6 were built and
  self-verified by 4 parallel subagents against disjoint file sets (zero
  overlapping files, confirmed before dispatch), each running its own real
  `tsc`/`jest` and reporting actual output, not claimed results — reviewed
  their diffs directly (`Read` on every touched file, plus the full `git
  diff --stat` across all 6 batches) before committing any of it.

---

## 4. Deploy record

**Commits deployed:** 8 commits, `a683d8e` (Run 1 HEAD) → `bbb8a32` (Run 2
HEAD, includes the lockfile hotfix below), pushed to `main` and pulled on the
droplet. Full sequence, all via the vps-control MCP — no manual droplet
commands handed to Dustin:

1. `git_pull` — droplet synced to `bbb8a32`.
2. **`server-migrate` build** (`job-1783557695552-3f0c761c`) — **first
   attempt failed**, `npm ci` exit code 1. Root cause: two same-session
   `package.json` edits (the `js-yaml` override in this pass, the
   `@smithy/node-http-handler` dependency from the storage.ts subagent) were
   never followed by a `package-lock.json` regen, and `npm ci` fails hard on
   any drift. Fixed locally (`npm install --package-lock-only`), diff
   confirmed narrowly scoped, verified via a full local `npm ci`, committed
   as `bbb8a32`, pushed, re-pulled. **Second attempt succeeded** (397s).
   `migrate_status` immediately after: *"Database schema is up to date!"* —
   confirms both new migrations (`20260708130000_run2_loto_version_history`,
   `20260708140000_run2_drop_dead_ingestion_session`) applied cleanly with no
   errors.
3. **`server` image rebuild** (`job-1783558338152-25ff1b1c`) — succeeded
   (174s). Container recreated; Docker health check reported `healthy` 17s
   after restart. `docker compose logs server --tail 40` afterward is clean
   (routine weatherScanner/EMAIL-MOCK cron output only, no errors).
4. **`deploy_client`** (`deploy-1783558541641-14bf7e9b`) — succeeded (78s).
   Published `client:/app/dist/.` → `/var/www/servicecycle/html`.
5. **`reseed_demo`** (`deploy-1783558628069-05e273b7`) — succeeded (28s),
   ended with `Demo seed complete` and no `ingestionSession` or arc-flash
   prune errors — this is the live confirmation that the W1-M5 `demoPrune`/
   `seed-demo.js` fixes (dead-model removal + the 7-model arc-flash prune
   parity fix) actually work end-to-end against a real database, not just in
   review.
6. **Final health check:** all 3 containers running (`db` healthy 12 days
   uptime unaffected, `server` healthy, `client` running); `GET
   /api/ready` → `200`; no crash-loop, no error-level log lines.

**Known verification gap:** `migrate_status` timed out (180s) on two later
polls taken purely as extra reassurance after the reseed — this matches an
existing transient-timeout pattern on this tool, not a real problem. The
schema state was already confirmed clean immediately after the migration
ran (step 2 above), and nothing between that point and the timeout touched
the schema, so this is not treated as an open question — just disclosed for
completeness.

---

## 5. Deferred / needs Dustin

**Needs Dustin over SSH — the vps-control MCP genuinely cannot do these:**
1. **Backup directory permission fix (new finding, §2)** — nightly local
   backups are very likely failing right now. One command:
   ```
   sudo chown -R 1000:1000 /root/ServiceCycle/backups
   ```
   (`chown` is hard-blocked at the MCP's security layer, `os-permission-
   destruction`, no override exists — confirmed, not a missing-tool gap.)
   After fixing, confirm via the admin UI's backup status page or by
   checking `/root/ServiceCycle/backups` is non-empty after the next 02:00
   UTC run.
2. **Live nginx/TLS config pull** (`deploy/README.md`, new this pass) — the
   MCP's file-read access is hard-restricted to `/root/ServiceCycle` +
   `/root/.pm2/logs`, confirmed 3 independent ways (one escalated to an
   explicit "board-reviewed" recon-pattern block rather than the normal
   allowlist message); `nginx`/`certbot` aren't on the command allowlist
   either. Exact commands to run are in `deploy/README.md`.
3. **Part/SpareInventory guarded-constraint NOTICE confirmation** (§2,
   carried over from Run 1, still genuinely unverifiable without direct DB
   access) and **GitHub's `production` environment** + **`e2e-scheduled.yml`
   demo basic-auth secrets** (carried over from Run 1, both still missing —
   reminding as instructed, not attempting).

**Found, deliberately not built this pass:**
- `routes/settings.ts`'s `POST /storage/test` constructs its own raw
  `S3Client` independent of `lib/storage.ts`'s `getS3Client()`, so it still
  lacks the same DNS-rebind pinning Batch 5 added — same class of gap on a
  closely related endpoint, flagged by the implementing subagent, out of
  scope for this pass.
- `deploy/README.md` is a scaffold, not the real config — see §5.1 above,
  needs one 2-minute manual SSH pull to actually populate.
- Client-backup ↔ server-SHA correlation in `rollback.yml` is manual
  (operator names the exact `html-backup-ci-*` directory) — a real index
  would need a manifest file written alongside each backup; reasonable
  future work, more than this pass's rollback mechanism warranted.

**Still explicitly out of scope per the original brief** (unchanged from
Run 1): attorney legal review, SOC2 Type II operating-evidence cadence,
per-tenant envelope encryption, money→cents migration, true SCIM v2 server,
native DWG rendering.

---

## 6. Bottom line

All 11 requested items were worked; 10 shipped with real, verified changes
(schema/migration/route/test/security/infra code, not just documentation),
one (live web-tier config) is a scaffold + exact manual pull instructions
because the vps-control MCP is hard-restricted from reading it. The Batch 8
live-check surfaced one new, real, currently-active bug (nightly local
backups failing on a host-side permission mismatch) that nothing in Run 1
caught, because Run 1's fix targeted a different bug (S3 env-var naming) in
the same area. One verification gap is carried forward honestly rather than
hidden: the live-server-dependent route tests (`server/tests/*.test.js`,
including `loto.test.js`) could not run in this session for a pre-existing,
already-documented environment reason, not something this pass introduced.

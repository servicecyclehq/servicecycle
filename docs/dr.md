# Disaster Recovery

**Referenced by:** `server/lib/backup.ts:67` (`warnIfLocalDest()` boot warning) and linked from
`docs/DEPLOY_RUNBOOK.md`. Written 2026-07-08 as part of the acquisition-audit remediation pass
(`docs/ACQUISITION_AUDIT_2026-07-08.md`) — this file didn't exist before, despite being referenced
by name in the codebase.

**Scope:** the single-droplet, single-instance self-hosted deployment described in
`docs/DEPLOY_RUNBOOK.md`. There is no multi-region, multi-instance, or managed-DB story today —
one DigitalOcean droplet is the entire production footprint.

---

## 1. What's actually backed up

| Data | Backed up? | Mechanism | Where |
|---|---|---|---|
| PostgreSQL (all application data) | **Yes** | Nightly `pg_dump --format=custom` (`server/lib/backup.ts`, `runBackup()`), gzip-equivalent internal compression, AES-256-GCM encrypted by default | `./backups` bind mount, optionally also S3-compatible bucket |
| `./uploads` (customer PDFs, photos, nameplate scans, drawings) | **Partial — code exists, not yet scheduled** | `runUploadsSync()` in `server/lib/backup.ts` (added 2026-07-08), delta-syncs the local uploads directory to the same S3 bucket used for DB backups under a distinct `uploads-sync/` prefix | S3 bucket only (no local "backup copy" — the live `./uploads` bind mount IS the primary copy) |
| Droplet-level (OS, Docker state, `.env`) | **Manual only** | DigitalOcean droplet snapshots — an operator action, not automated by this repo (`DEPLOY_RUNBOOK.md` §11 "You should set up soon after go-live") | DigitalOcean |
| `MASTER_KEY` (encrypts backups, TOTP secrets, some stored credentials) | **Manual, off-box, by design** | Operator responsibility at provisioning time (`DEPLOY_RUNBOOK.md` §3/§4) — losing it makes encrypted data permanently unrecoverable, so it deliberately isn't stored anywhere this repo automates | Wherever the operator puts it (password manager, etc.) |

### Honesty check on the uploads-sync gap

Before 2026-07-08, `./uploads` had **zero** automated off-host copy — the audit's own words: "droplet
loss = permanent document loss; file RPO is effectively infinite." `runUploadsSync()` closes the
*mechanism* gap (the function is implemented, reuses the same `BACKUP_S3_*` credentials/client as
the DB backup, and does a real delta sync with a persisted state file so re-runs are cheap) but it is
**not yet wired to run automatically**. Every `cron.schedule(...)` call in this codebase lives in one
place (`server/index.ts`, inside the block that first takes a Postgres advisory lock so scheduled jobs
run on exactly one instance) — deliberately centralized so the single-instance guard stays authoritative.
Wiring this in is a one-line addition there:

```js
const { runUploadsSync } = require('./lib/backup'); // add to the existing runBackup import
// next to the existing 02:00 backup cron:
cron.schedule('30 2 * * *', () => runOnce('uploadsSync', () => runUploadsSync('cron')), { timezone: 'UTC' });
```

**Until that line is added, this table's "Partial" row is still functionally a gap in production.**
Don't treat this file as saying the gap is closed — it says the code to close it exists and is ready.

---

## 2. RPO / RTO — the honest numbers

| | Target | Reality today |
|---|---|---|
| **RPO (Recovery Point Objective)** — how much data could you lose | ~24h for the database (nightly `pg_dump` at 02:00 server time) | **True for Postgres once `BACKUP_DEST` is actually `s3`/`both` with correctly-named env vars** (see §4 below — this was silently broken until 2026-07-08). For `./uploads`, RPO is currently **unbounded** until the uploads-sync cron above is wired in — a droplet loss before that line lands means every document since the last manual snapshot is gone. |
| **RTO (Recovery Time Objective)** — how long to be back up | ~1–2h (rebuild droplet + restore latest dump + redeploy) | Realistic for a from-scratch rebuild given `docker compose up --build` + a documented restore procedure (§3). **Never actually rehearsed end-to-end on a fresh droplet** — the weekly/monthly restore-test crons (§3) validate that a backup *can* be restored, not that a full droplet rebuild-and-recover completes in any specific time. Treat the 1–2h figure as a design target, not a measured SLA. |

**Single point of failure:** one droplet, one Postgres instance, no read replica, no standby. This is
appropriate for the current pre-revenue/solo-operator stage (see `servicecycle-no-live-stakeholders`
in ops memory — no live customers as of this writing) and is a known, deliberate trade-off, not an
oversight. It should be revisited before any real customer's data lives on this instance with an SLA
attached.

---

## 3. Restore procedure

**Don't duplicate the step-by-step here — the canonical, maintained version lives in
`docs/DEPLOY_RUNBOOK.md`** (§5 "Deploy", §6 "Seed demo data", §9 "Operational notes", §11 "Production
hardening checklist"). This section is the DR-specific index into that runbook plus the pieces that
aren't there yet.

### 3.1 Automated integrity checks (already running, not a manual restore)

Two crons in `server/index.ts` continuously prove the backup pipeline actually works, rather than
trusting a green "backup succeeded" log line:

- **Weekly TOC check** (`restoreTest` cron, Sundays) — `server/lib/restoreTest.ts` `runRestoreTest()`
  downloads the most recent backup (local or S3, whichever `BACKUP_DEST` points at), decrypts it if
  encrypted, and runs `pg_restore --list` against it. This proves the file isn't truncated or corrupt
  and has the expected table-of-contents shape — a real structural check, not just "the file exists."
- **Monthly deep restore** (`deepRestoreTest` cron, 1st of the month) — `runDeepRestoreTest()` actually
  restores the latest backup into a sidecar Postgres (`PG_TEST_DB_URL`) and compares row counts on
  `asset`, `workOrder`, `account`, `user`, and `activityLog` against the live database. This is the
  only job that proves a backup is *recoverable*, not merely well-formed. **Requires `PG_TEST_DB_URL`
  to be configured** — skips gracefully (not silently) if it isn't.

Both crons alert via the same failure-reporting path as a failed backup (BetterStack event +
Healthchecks.io ping — see `docs/observability.md`) when they don't pass.

### 3.2 Manual full restore (rebuild-from-scratch scenario)

1. Provision a new droplet and follow `docs/DEPLOY_RUNBOOK.md` §1–§4 (Docker install, hardening,
   `.env` with the **same `MASTER_KEY`** as the lost droplet — this is the one value that cannot be
   regenerated; without it, encrypted backups are permanently unreadable).
2. Copy the most recent backup file off wherever it landed (S3 bucket `backups/` prefix, or the
   `./backups` directory if you have an off-box copy of it — see the RPO caveat in §2 about whether
   an off-host copy actually existed for the backup you're restoring).
3. If the file is `.sql.gz.enc` (encrypted, the default): `node server/scripts/decrypt-backup.js
   <file>.sql.gz.enc` (requires `MASTER_KEY` in the environment or `server/.env`).
4. Restore into a running Postgres:
   ```bash
   pg_restore --no-owner --no-acl -d "$DATABASE_URL" <decrypted-file>
   ```
   **Do not pipe through `gunzip` first.** Backups since the 2026-05-22 `pg_dump --format=custom`
   change are *not* gzip-wrapped — `pg_dump`'s custom format applies its own internal compression.
   `pg_restore` reads the custom-format file directly. (`decrypt-backup.js`'s own printed hint at the
   end of a decrypt run still says `gunzip -c ... | pg_restore` — that's stale for any backup taken
   after that change; use the command above instead. Flagged for a follow-up fix to that script's
   output text; not corrected in this pass since `decrypt-backup.js` is outside this remediation's
   scope.)
5. `docker compose up -d --build` — `server-migrate` re-applies any migrations newer than the restored
   dump; the API waits on its success before starting.
6. If `./uploads` also needs restoring (once the sync cron in §1 is wired in): download the
   `uploads-sync/` prefix from the same S3 bucket and lay it back down at the `./uploads` bind mount
   path before starting the `server` container.
7. Verify: `curl -fsS https://<domain>/api/ready` (real DB check), then spot-check a handful of assets
   / documents in the UI.

### 3.3 What this procedure has never been tested against

Being honest rather than aspirational, per the audit: this exact end-to-end sequence (new droplet →
restore → verify) has **not** been rehearsed on a truly fresh droplet as a timed drill. The weekly/
monthly crons in §3.1 validate the backup artifact itself continuously and are real, dated evidence —
but they restore into a *sidecar* Postgres, not a full droplet rebuild. Run the full sequence at least
once as a tabletop/live drill before treating the RTO figure in §2 as anything more than a design
target, and log the result as dated evidence (same pattern as `docs/security/BC_PLAYBOOKS.md`).

---

## 4. Known gaps (as of 2026-07-08 — don't let this list go stale)

- **Uploads off-host sync not yet scheduled** — see §1. Code exists; the cron registration line in
  `server/index.ts` does not yet.
- **Env-var name drift, fixed this pass but re-verify on the live droplet:** `docker-compose.yml` and
  `docker-compose.ghcr.yml` previously forwarded `STORAGE_S3_ACCESS_KEY_ID` / `BACKUP_S3_ACCESS_KEY_ID`
  (and the `_SECRET_ACCESS_KEY` variants) into the container's environment, but the code
  (`server/lib/storage.ts`, `server/lib/backup.ts`) has always read `STORAGE_S3_KEY_ID` /
  `STORAGE_S3_SECRET` / `BACKUP_S3_KEY_ID` / `BACKUP_S3_SECRET`. Compose `environment:` blocks are
  whitelists, so a droplet `.env` using the code's real variable names silently never reached the
  container — off-host backup could have been configured correctly on disk and still not actually be
  running. **Fixed in both compose files as part of this remediation pass (2026-07-08).** Confirm on
  the live droplet with a container `printenv | grep -E 'STORAGE_S3|BACKUP_S3'` and check recent
  `BackupLog` rows show a non-null `storageKey` under the `backups/` S3 prefix, not just a local path —
  the audit flagged that this specific verification had not been done against the live box.
- **`BACKUP_DEST=both` + broken/unconfigured S3 used to report false-green** — fixed in this pass
  (`server/lib/backup.ts`): a `both`-mode backup where the S3 leg fails or isn't configured now writes
  a `BackupLog` failure row and sends the existing admin-alert email, instead of a bare console warning
  with a `status: 'success'` row.
- **No live droplet-rebuild timing drill** — see §3.3.
- **`MASTER_KEY` backup is entirely a manual operator responsibility** — by design (see §1), but worth
  restating: if it's lost, encrypted backups (the default) are permanently unrecoverable. There is no
  automated escrow of this key anywhere in this repo, intentionally.
- **Single instance, no standby** — see §2.

Cross-reference: `docs/observability.md` for how backup/restore failures actually get surfaced to a
human today (short version: BetterStack + Healthchecks.io, both wired in code, activation status is
tracked separately in `docs/security/MONITORING_MATRIX.md`).

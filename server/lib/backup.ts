'use strict';

/**
 * backup.js
 * ---------
 * PostgreSQL backup: pg_dump → gzip → local filesystem and/or S3-compatible upload.
 *
 * Destination is controlled by BACKUP_DEST (default: 'local'):
 *   local  — save gzip to BACKUP_LOCAL_PATH (default: ./backups). Works out of
 *             the box with zero config. In Docker, mount that path as a volume so
 *             the file survives container restarts/upgrades.
 *   s3     — upload to S3-compatible storage only (no local copy kept).
 *   both   — save locally AND upload to S3 (recommended for offsite redundancy).
 *
 * Required env vars:
 *   DATABASE_URL            — already present for Prisma
 *
 * Optional env vars:
 *   BACKUP_DEST             — 'local' (default) | 's3' | 'both'
 *   BACKUP_LOCAL_PATH       — path to write backups (default: ./backups)
 *   BACKUP_RETENTION_DAYS   — delete backups older than N days (default: 30)
 *
 * S3 vars (only needed when BACKUP_DEST is 's3' or 'both'):
 *   BACKUP_S3_BUCKET        — bucket name
 *   BACKUP_S3_REGION        — e.g. us-east-1
 *   BACKUP_S3_KEY_ID        — access key ID
 *   BACKUP_S3_SECRET        — secret access key
 *   BACKUP_S3_ENDPOINT      — optional; set for non-AWS (Backblaze, Wasabi, MinIO, etc.)
 */

const { execFile }   = require('child_process');
const { promisify }  = require('util');
const path           = require('path');
const fs             = require('fs');
const fsp            = require('fs/promises');
const { createGzip } = require('zlib');

// lib/prisma exports the client directly (`module.exports = prisma`); a
// destructured import resolves to undefined and silently fails every
// Prisma call here. Backups recorded ZERO BackupLog rows for the entire
// life of this file before this fix was applied.
import prisma from './prisma';
const { sendEmail } = require('./email');
const { encryptBackup } = require('./backupCrypto');

const execFileAsync = promisify(execFile);

// ── Config helpers ────────────────────────────────────────────────────────────

function getDestination() {
  const d = (process.env.BACKUP_DEST || 'local').toLowerCase();
  return d; // 'local' | 's3' | 'both'
}

/**
 * C6 (audit Critical, 2026-05-22): startup warning when BACKUP_DEST is
 * 'local' or unset. With a local-only destination, a droplet-destroy =
 * 100% data loss -- the only "backup" is on the same host that just died.
 * Fires on every boot so an operator who skipped the install.sh prompt
 * sees it in their logs / Better Stack until they configure S3.
 *
 * Demo droplet is unaffected: it sets BACKUP_DEST=s3 (R2 vendor stack
 * wired in v0.38.3).
 */
function warnIfLocalDest() {
  if (getDestination() === 'local') {
    console.warn('[startup] BACKUP_DEST=local — your backups will be lost if the host fails. Set BACKUP_DEST=s3 + BACKUP_S3_* in .env to enable off-host backups. See docs/dr.md.');
  }
}

function getLocalPath() {
  return path.resolve(process.env.BACKUP_LOCAL_PATH || path.join(__dirname, '..', 'backups'));
}

function getRetentionDays() {
  return parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);
}

function s3Configured() {
  return !!(
    process.env.BACKUP_S3_BUCKET &&
    process.env.BACKUP_S3_KEY_ID &&
    process.env.BACKUP_S3_SECRET
  );
}

function isConfigured() {
  const dest = getDestination();
  if (dest === 'local' || dest === 'both') return true;   // local always works
  if (dest === 's3') return s3Configured();
  return false;
}

// ── S3 client (lazy singleton) ────────────────────────────────────────────────

let _s3 = null;
function getS3() {
  if (_s3) return _s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  const cfg: any = {
    region:      process.env.BACKUP_S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId:     process.env.BACKUP_S3_KEY_ID,
      secretAccessKey: process.env.BACKUP_S3_SECRET,
    },
  };
  if (process.env.BACKUP_S3_ENDPOINT) {
    cfg.endpoint       = process.env.BACKUP_S3_ENDPOINT;
    cfg.forcePathStyle = true;  // required for most non-AWS providers
  }
  _s3 = new S3Client(cfg);
  return _s3;
}

// ── pg_dump ───────────────────────────────────────────────────────────────────

function parseDatabaseUrl(url) {
  const u = new URL(url);
  return {
    PGHOST:     u.hostname,
    PGPORT:     u.port || '5432',
    PGUSER:     decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, ''),
  };
}

async function runPgDump() {
  // H9 (audit High, 2026-05-22): switched from --format=plain via
  // execFileAsync (512MB maxBuffer ceiling -- SILENT truncation at db
  // sizes > ~400MB) to --format=custom streamed via child_process.spawn
  // stdout pipe into a tmp file. The custom format also:
  //   - is significantly smaller than plain (pg_dump applies internal
  //     compression)
  //   - supports `pg_restore -j 4` parallel restore (see docs/dr.md)
  //   - includes the index definitions inline (no separate SQL to apply)
  // We return the Buffer of the tmp file contents to preserve the caller
  // contract (saveToLocal / S3 upload expect a Buffer). On large dumps
  // we still load the file into memory at the end; the win is that
  // pg_dump no longer truncates on the way in, and we can switch the
  // caller to stream-to-S3 in a follow-up without changing the dump.
  const { spawn } = require('child_process');
  const path      = require('path');
  const os        = require('os');
  const fsp       = require('fs/promises');
  const pgEnv     = parseDatabaseUrl(process.env.DATABASE_URL);
  const tmpDir    = await fsp.mkdtemp(path.join(os.tmpdir(), 'servicecycle-pgdump-'));
  const tmpFile   = path.join(tmpDir, 'dump.pgcustom');

  const PG_DUMP_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

  await new Promise<void>((resolve, reject) => {
    const args = ['--no-owner', '--no-acl', '--format=custom', '--compress=6', '--encoding=UTF8', '--schema=public', '-f', tmpFile, pgEnv.PGDATABASE];
    const proc = spawn('pg_dump', args, {
      env: { ...process.env, ...pgEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // R7: kill pg_dump if it hangs beyond the timeout
    const killTimer = setTimeout(() => {
      console.error('[backup] pg_dump exceeded 20-minute timeout — killing process');
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000); // force kill after 5s
    }, PG_DUMP_TIMEOUT_MS);

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
    proc.on('error', (err) => { clearTimeout(killTimer); reject(err); });
    proc.on('close', code => {
      clearTimeout(killTimer);
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited with code ${code}: ${stderr.slice(0, 500)}`));
    });
  });

  try {
    const buf = await fsp.readFile(tmpFile);
    return buf;
  } finally {
    // Cleanup -- best effort
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Gzip ──────────────────────────────────────────────────────────────────────

async function gzipBuffer(buf) {
  return new Promise((resolve, reject) => {
    const gz     = createGzip({ level: 9 });
    const chunks = [];
    gz.on('data',  c  => chunks.push(c));
    gz.on('end',   () => resolve(Buffer.concat(chunks)));
    gz.on('error', reject);
    gz.end(buf);
  });
}

// ── Local filesystem destination ──────────────────────────────────────────────

async function saveToLocal(buf, filename) {
  const preferredDir = getLocalPath();
  const fallbackDir  = path.join(require('os').tmpdir(), 'servicecycle-backups');

  // Try the configured (or default) path first. If we get EACCES — which
  // happens when the Node process runs as UID 1000 but /root/ServiceCycle is
  // owned by root (common on the demo droplet) — fall back to /tmp so the
  // process doesn't crash. Backups in /tmp are NOT persistent across reboots,
  // so we log a warning. The fix is to set BACKUP_LOCAL_PATH to a directory
  // the Node user owns, or to use BACKUP_DEST=s3.
  async function tryWrite(dir: string): Promise<string> {
    // Tight permissions on the directory and the dump itself — these gz files
    // contain the entire database and should never be world-readable on a
    // multi-user host. 0o700 dir / 0o600 file = owner only. Effectively no-op
    // on Windows (NTFS DACLs aren't honored by mode), but the right call on
    // every Linux/Mac deployment.
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dir, filename);
    await fsp.writeFile(filePath, buf, { mode: 0o600 });
    // mkdir + writeFile mode are honored ONLY at create time, not when the
    // path already exists. chmod covers the upgrade case where an operator
    // already had a permissive backups dir from a previous deploy.
    try { await fsp.chmod(dir, 0o700); }      catch (_) { /* Windows etc. */ }
    try { await fsp.chmod(filePath, 0o600); } catch (_) { /* same */ }
    return filePath;
  }

  try {
    return await tryWrite(preferredDir);
  } catch (err: any) {
    if (err.code === 'EACCES') {
      console.warn(
        `[backup] EACCES on ${preferredDir} — falling back to ${fallbackDir}. ` +
        'WARNING: /tmp is NOT persistent across reboots. Set BACKUP_LOCAL_PATH to a ' +
        'directory owned by the Node process user, or use BACKUP_DEST=s3.'
      );
      try {
        require('./betterStack').logEvent('backup_tmp_fallback', {
          accountId: 'system',
          originalPath: preferredDir,
          tmpPath: fallbackDir,
        });
      } catch (_) { /* non-fatal */ }
      return await tryWrite(fallbackDir);
    }
    throw err; // re-throw non-permission errors
  }
}


// SRE-10: extracted helper so pruneLocalBackups can apply the same
// retention logic to both the configured path and the /tmp fallback.
async function _pruneDir(dir: string): Promise<number> {
  try {
    const files = await fsp.readdir(dir);
    const cutoff = Date.now() - getRetentionDays() * 86_400_000;
    let pruned = 0;
    for (const f of files) {
      if (!f.endsWith('.sql.gz') && !f.endsWith('.sql.gz.enc')) continue;
      const stat = await fsp.stat(path.join(dir, f));
      if (stat.mtimeMs < cutoff) {
        await fsp.unlink(path.join(dir, f));
        pruned++;
      }
    }
    return pruned;
  } catch {
    return 0;
  }
}

async function pruneLocalBackups() {
  const localPath = getLocalPath();
  let pruned = await _pruneDir(localPath);

  // Also prune the fallback tmp path if it exists (SRE-10)
  const fallbackPath = '/tmp/servicecycle-backups';
  if (fallbackPath !== localPath && fs.existsSync(fallbackPath)) {
    pruned += await _pruneDir(fallbackPath);
  }
  return pruned;
}

// ── S3 destination ────────────────────────────────────────────────────────────

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

async function uploadWithTimeout(command): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    await getS3().send(command, { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function uploadToS3(buf, key) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await uploadWithTimeout(new PutObjectCommand({
    Bucket:      process.env.BACKUP_S3_BUCKET,
    Key:         key,
    Body:        buf,
    ContentType: 'application/gzip',
    Metadata:    { 'backup-tool': 'servicecycle', 'backup-created': new Date().toISOString() },
  }));
  return key;
}

async function pruneS3Backups() {
  const { ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  const bucket = process.env.BACKUP_S3_BUCKET;
  const cutoff = new Date(Date.now() - getRetentionDays() * 86_400_000);
  let token, toDelete = [];

  do {
    const res = await getS3().send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: 'backups/', ContinuationToken: token,
    }));
    for (const obj of res.Contents || []) {
      if (obj.LastModified < cutoff) toDelete.push({ Key: obj.Key });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  if (!toDelete.length) return 0;
  // Chunk into batches of 1000 (AWS S3 DeleteObjects limit) (SRE-8)
  const chunkSize = 1000;
  for (let i = 0; i < toDelete.length; i += chunkSize) {
    const chunk = toDelete.slice(i, i + chunkSize);
    await getS3().send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: chunk, Quiet: true },
    }));
  }
  return toDelete.length;
}

// ── Off-host uploads sync (documents/photos) ──────────────────────────────────
// 2026-07-08 acquisition audit (DevOps Medium — "uploaded documents have zero
// automated off-host backup"): everything above this point only ever dumped
// Postgres. `./uploads` (every customer PDF/photo/nameplate scan) had NO
// off-host copy at all -- droplet loss meant permanent, unrecoverable
// document loss, independent of how healthy the DB backup was. This reuses
// the SAME S3 bucket/credentials/client as the DB backup above (BACKUP_S3_*,
// getS3()/uploadWithTimeout()) under a distinct 'uploads-sync/' key prefix so
// it never collides with the 'backups/' prefix pg_dump uses in that bucket --
// no new credential surface, no new client.
//
// Delta sync, not a full re-upload every night: a small local JSON state
// file (size+mtime per relative path, stored under BACKUP_LOCAL_PATH so it
// never lands inside the documents directory it's tracking) lets each run
// skip files that haven't changed since the last successful sync. First run
// uploads everything that exists locally; every run after that costs roughly
// what changed that day. S3 PutObject is an overwrite, so a file re-uploaded
// after a crash mid-sync is harmless (idempotent).
//
// NOTE (deployment wiring): unlike runBackup(), this function is not yet
// called by anything. ALL cron.schedule(...) registration in this codebase
// lives in one place — server/index.ts, inside the block that first takes a
// Postgres advisory lock so scheduled jobs run on exactly one instance (see
// CRON_ADVISORY_LOCK_KEY / runOnce there). That file is intentionally NOT
// touched by this change (owned by a parallel workstream editing the same
// region for the sibling once-per-account backup-cron bug). Registering a
// cron here instead, at module-load time, would bypass that advisory-lock
// single-instance guard entirely -- exactly the failure mode the engineering
// guidelines warn about (duplicate/overlapping scheduled runs). The single
// line needed to wire this in is a `const { runUploadsSync } = require(...)`
// alongside the existing `runBackup` import and one
// `cron.schedule('30 2 * * *', () => runOnce('uploadsSync', () => runUploadsSync('cron')), { timezone: 'UTC' })`
// call next to the existing 02:00 backup cron in index.ts.

function getUploadsLocalPath() {
  // Mirrors lib/storage.ts's getLocalPath() (not imported directly, to avoid
  // a cross-module coupling neither file currently has); same env var, same
  // default-relative-to-lib/ resolution, so this always points at the exact
  // directory documents are actually written to.
  return path.resolve(process.env.STORAGE_LOCAL_PATH || path.join(__dirname, '..', 'uploads'));
}

function getUploadsSyncStatePath() {
  return path.join(getLocalPath(), '.uploads-sync-state.json');
}

async function loadUploadsSyncState(): Promise<Record<string, string>> {
  try {
    const raw = await fsp.readFile(getUploadsSyncStatePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {}; // first run, or state file missing/corrupt — re-sync everything
  }
}

async function saveUploadsSyncState(state: Record<string, string>): Promise<void> {
  try {
    await fsp.mkdir(getLocalPath(), { recursive: true });
    await fsp.writeFile(getUploadsSyncStatePath(), JSON.stringify(state), 'utf8');
  } catch (err: any) {
    console.warn('[uploads-sync] could not persist sync state (next run will re-check every file):', err.message);
  }
}

async function walkUploadFiles(dir: string, base: string = dir): Promise<string[]> {
  let out: string[] = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out; // uploads dir doesn't exist locally (e.g. STORAGE_DEST=s3 already) — nothing to sync
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(await walkUploadFiles(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

/**
 * Sync every local file under the documents storage directory to the backup
 * S3 bucket (key prefix 'uploads-sync/'), skipping files whose size+mtime
 * signature hasn't changed since the last successful sync. No-ops cleanly
 * (returns { success: true, skipped: true }) when S3 isn't configured or the
 * account already stores documents in S3 directly (STORAGE_DEST=s3), since
 * in that case there is no local copy to sync in the first place.
 */
async function runUploadsSync(triggeredBy: 'cron' | 'manual' = 'cron') {
  const pfx = '[uploads-sync]';

  if (!s3Configured()) {
    const msg = 'BACKUP_S3_* not configured — skipping off-host uploads sync (documents have no off-host copy).';
    console.warn(pfx, msg);
    return { success: false, error: msg, skipped: true };
  }

  const localRoot = getUploadsLocalPath();
  const files = await walkUploadFiles(localRoot);

  if (files.length === 0) {
    console.log(`${pfx} no local files under ${localRoot} — nothing to sync.`);
    return { success: true, uploaded: 0, unchanged: 0, failed: 0, total: 0 };
  }

  const state = await loadUploadsSyncState();
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  let uploaded = 0, unchanged = 0, failed = 0;
  const errors: string[] = [];

  for (const relPath of files) {
    const abs = path.join(localRoot, relPath);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      continue; // vanished between listing and stat (rare race) — picked up next run
    }
    const sig = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    if (state[relPath] === sig) {
      unchanged++;
      continue;
    }
    try {
      const buf = await fsp.readFile(abs);
      const key = `uploads-sync/${relPath.split(path.sep).join('/')}`;
      await uploadWithTimeout(new PutObjectCommand({
        Bucket:      process.env.BACKUP_S3_BUCKET,
        Key:         key,
        Body:        buf,
        Metadata:    { 'backup-tool': 'servicecycle', 'sync-source': 'uploads' },
      }));
      state[relPath] = sig;
      uploaded++;
    } catch (err: any) {
      failed++;
      errors.push(`${relPath}: ${err.message}`);
      console.error(`${pfx} failed to sync ${relPath}:`, err.message);
    }
  }

  await saveUploadsSyncState(state);

  console.log(`${pfx} done — uploaded ${uploaded}, unchanged ${unchanged}, failed ${failed} (of ${files.length} local files).`);

  if (failed > 0) {
    const msg = `${failed} of ${files.length} document(s) failed to sync off-host: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? '…' : ''}`;
    // BetterStack event only (not an admin email per-account): unlike a DB
    // backup, this is one global infra-level sync, not scoped to a single
    // account, so there's no single "the admins for this failure" set to
    // notify without either picking an arbitrary account or emailing every
    // tenant admin about an operational issue that isn't theirs. The
    // BetterStack event is the same "make failures observable, don't swallow
    // them" bar backup_failed already applies, on the channel actually built
    // for cross-account operational alerts.
    try {
      require('./betterStack').logEvent('uploads_sync_partial_failure', {
        failed, uploaded, total: files.length, sample: errors.slice(0, 5), triggeredBy,
      });
    } catch (bsErr: any) {
      console.warn(`${pfx} Could not send betterStack uploads_sync_partial_failure event:`, bsErr.message);
    }
    return { success: false, uploaded, unchanged, failed, total: files.length, error: msg };
  }

  return { success: true, uploaded, unchanged, failed, total: files.length };
}

// ── Failure email ─────────────────────────────────────────────────────────────

async function sendFailureEmail(accountId, error) {
  try {
    const admins = await prisma.user.findMany({
      where:  { accountId, role: 'admin', isActive: true },
      select: { email: true, name: true },
    });
    for (const admin of admins) {
      await sendEmail({
        to:      admin.email,
        subject: '⚠️ ServiceCycle backup failed',
        html: `
          <p>Hi ${admin.name || 'Admin'},</p>
          <p>The automated database backup for your ServiceCycle instance failed.</p>
          <p><strong>Error:</strong> ${error}</p>
          <p>Check Settings → Backups for details, or review server logs.</p>
          <p style="color:#6b7280;font-size:12px;margin-top:24px">ServiceCycle automated message</p>
        `,
      });
    }
  } catch (e) {
    console.error('[backup] Failed to send failure email:', e.message);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run a full backup cycle.
 *
 * Destination logic (BACKUP_DEST):
 *   'local' (default) — write gzip to BACKUP_LOCAL_PATH. Works with zero config.
 *                        In Docker: mount the path as a host volume.
 *   's3'              — upload to S3-compatible bucket only.
 *   'both'            — write locally AND upload to S3.
 *
 * @param {string} accountId
 * @param {'cron'|'manual'} triggeredBy
 * @returns {{ success, filename, sizeBytes, storageKey, localPath, dest, error }}
 */
async function runBackup(accountId, triggeredBy = 'cron') {
  const dest = getDestination();

  // S5-FN-11 (v0.74.0): per-account log prefix for grep-ability. Hoisted
  // above every use (2026-07-08 audit, DevOps High #6): this was previously
  // declared further down, after the s3-misconfig early-return below, which
  // referenced it via `${pfx}` first -- a temporal-dead-zone ReferenceError
  // masked by an @ts-ignore. In practice that meant the 's3' + unconfigured
  // path threw before ever reaching its own console.warn or its `return`,
  // so the caller's cron loop saw an uncaught rejection instead of the
  // intended `{ success: false, error }` result.
  const pfx = `[backup][${accountId.slice(0,8)}]`;

  if (dest === 's3' && !s3Configured()) {
    const msg = 'BACKUP_DEST is set to "s3" but S3 credentials are not configured.';
    console.warn(pfx, msg);
    return { success: false, error: msg };
  }

  const ts        = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  const willEncrypt = process.env.BACKUP_ENCRYPT !== 'false';
  // .enc suffix on encrypted files so operators can spot at a glance whether
  // a backup is plaintext or wrapped. The decrypt-backup CLI strips this
  // suffix and writes the plain .sql.gz alongside.
  const filename  = willEncrypt ? `servicecycle-backup-${ts}.sql.gz.enc` : `servicecycle-backup-${ts}.sql.gz`;
  const s3Key     = `backups/${filename}`;

  console.log(`${pfx} Starting backup (dest: ${dest}) → ${filename}`);

  let gzBuf, localPath, storageKey;

  try {
    // ── 1. Dump ─────────────────────────────────────────────────────────────
    console.log(`${pfx} Running pg_dump…`);
    const dumpBuf = await runPgDump();
    console.log(`${pfx} pg_dump — ${(dumpBuf.length / 1024 / 1024).toFixed(1)} MB raw`);

    // ── 2. pg_dump --format=custom already applies internal compression
    // (--compress=6 above). A second gzip pass would double-compress and
    // inflate the file size. Assign directly without re-compressing.
    gzBuf = dumpBuf;
    console.log(`${pfx} Dump size → ${(gzBuf.length / 1024 / 1024).toFixed(1)} MB`);

    // ── 2b. Encrypt (default ON when MASTER_KEY is set, which is required
    // for the server to boot anyway). The on-disk format is:
    //   [LBKE0001 magic][iv 12][authTag 16][ciphertext]
    // Restore via `node scripts/decrypt-backup.js <enc> <out.gz>` — see
    // docs/operator-playbook.md. Set BACKUP_ENCRYPT=false to skip
    // encryption (e.g., for an offline-tool restore exercise).
    if (willEncrypt) {
      const encBuf = encryptBackup(gzBuf);
      console.log(`${pfx} Encrypted → ${(encBuf.length / 1024 / 1024).toFixed(1)} MB`);
      gzBuf = encBuf;
    } else {
      console.warn(`${pfx} BACKUP_ENCRYPT=false — writing UNENCRYPTED backup. Anyone with disk access can read the entire DB.`);
    }

    // ── 3a. Write to local filesystem ────────────────────────────────────────
    if (dest === 'local' || dest === 'both') {
      localPath = await saveToLocal(gzBuf, filename);
      console.log(`${pfx} Saved locally → ${localPath}`);
      const pruned = await pruneLocalBackups();
      if (pruned > 0) console.log(`${pfx} Pruned ${pruned} old local backup(s)`);
    }

    // ── 3b. Upload to S3 ─────────────────────────────────────────────────────
    // 2026-07-08 audit (DevOps High #6): BACKUP_DEST=both promises BOTH a
    // local copy AND an off-host copy. Previously, an unconfigured or failing
    // S3 upload here only logged a console.warn and fell through to the
    // SUCCESS BackupLog write below -- a false-green heartbeat with the
    // off-host copy silently absent (the ransomware-recovery control this
    // mode exists for). `s3PartialFailure` tracks that condition so step 4
    // below can record and alert on it instead of swallowing it.
    let s3PartialFailure: string | null = null;
    if (dest === 's3' || dest === 'both') {
      if (s3Configured()) {
        try {
          storageKey = await uploadToS3(gzBuf, s3Key);
          console.log(`${pfx} Uploaded to S3 →`, storageKey);
          const pruned = await pruneS3Backups();
          if (pruned > 0) console.log(`${pfx} Pruned ${pruned} old S3 backup(s)`);
        } catch (s3Err: any) {
          if (dest === 'both') {
            // Local copy already written above -- don't let an S3 hiccup
            // throw into the outer catch, which would mark the ENTIRE run
            // 'failure' and discard a perfectly good local backup. Record it
            // as a partial failure instead (below) so it's still visible.
            s3PartialFailure = s3Err.message || String(s3Err);
            console.error(`${pfx} S3 upload failed (local copy kept, off-host copy MISSING this run):`, s3PartialFailure);
          } else {
            throw s3Err; // dest === 's3': no local fallback -- this IS a full failure
          }
        }
      } else if (dest === 'both') {
        s3PartialFailure = 'BACKUP_DEST=both but S3 credentials are not configured — off-host copy was NOT written (local copy only).';
        console.warn(`${pfx} ${s3PartialFailure}`);
      } else {
        console.warn(`${pfx} S3 not configured — skipping S3 upload (local copy kept)`);
      }
    }

    // ── 4. Log result ────────────────────────────────────────────────────────
    if (s3PartialFailure) {
      // Genuine partial failure: the DB dump itself succeeded (local copy on
      // disk), but the off-host redundancy BACKUP_DEST=both is supposed to
      // guarantee did not happen. Logged as 'failure' (not a silent third
      // status the admin dashboard's success/failure counts wouldn't tally --
      // routes/backup.ts only buckets 'success'|'failure') with an error
      // message that makes the partial nature explicit, plus the same
      // failure-alerting paths (BetterStack event + admin email) a full
      // backup failure already gets. No new notification mechanism.
      const partialMsg = `PARTIAL FAILURE — local backup succeeded; off-host (S3) copy did NOT: ${s3PartialFailure}`;
      await prisma.backupLog.create({
        data: {
          accountId,
          status:      'failure',
          filename,
          sizeBytes:   gzBuf.length,
          storageKey:  localPath || filename,
          error:       partialMsg.slice(0, 2000),
          triggeredBy,
        },
      });
      try {
        require('./betterStack').logEvent('backup_partial_failure', {
          accountId, filename, error: s3PartialFailure.slice(0, 500), triggeredBy,
        });
      } catch (bsErr: any) {
        console.warn(`${pfx} Could not send betterStack backup_partial_failure event:`, bsErr.message);
      }
      await sendFailureEmail(accountId, partialMsg);
      console.log(`${pfx} Done (partial — local ok, off-host copy missing).`);
      return { success: false, partial: true, filename, sizeBytes: gzBuf.length, storageKey, localPath, dest, error: s3PartialFailure };
    }

    await prisma.backupLog.create({
      data: {
        accountId,
        status:      'success',
        filename,
        sizeBytes:   gzBuf.length,
        storageKey:  storageKey || localPath || filename,
        triggeredBy,
      },
    });

    console.log(`${pfx} Done.`);
    return { success: true, filename, sizeBytes: gzBuf.length, storageKey, localPath, dest };

  } catch (err) {
    const msg = err.message || String(err);
    console.error(`${pfx} FAILED:`, msg);

    try {
      await prisma.backupLog.create({
        data: { accountId, status: 'failure', filename, error: msg.slice(0, 2000), triggeredBy },
      });
    } catch (dbErr) {
      console.error(`${pfx} Could not write failure log:`, dbErr.message);
    }

    try {
      require('./betterStack').logEvent('backup_failed', {
        accountId,
        filename,
        error: msg.slice(0, 500),
        triggeredBy,
      });
    } catch (bsErr) {
      console.warn(`${pfx} Could not send betterStack backup_failed event:`, bsErr.message);
    }
    await sendFailureEmail(accountId, msg);
    return { success: false, error: msg, filename };
  }
}

/**
 * Returns a summary of current backup configuration for the status API.
 */
function getBackupConfig() {
  const dest = getDestination();
  return {
    dest,
    localConfigured:   dest === 'local' || dest === 'both',
    localPath:         (dest === 'local' || dest === 'both') ? getLocalPath() : null,
    s3Configured:      s3Configured(),
    retentionDays:     getRetentionDays(),
  };
}

module.exports = { runBackup, isConfigured, getBackupConfig,
  warnIfLocalDest, runUploadsSync,
};

export {};

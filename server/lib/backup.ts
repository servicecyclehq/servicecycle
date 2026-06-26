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
    const args = ['--no-owner', '--no-acl', '--format=custom', '--compress=6', '--encoding=UTF8', '-f', tmpFile, pgEnv.PGDATABASE];
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
      return await tryWrite(fallbackDir);
    }
    throw err; // re-throw non-permission errors
  }
}

async function pruneLocalBackups() {
  const dir = getLocalPath();
  try {
    const files = await fsp.readdir(dir);
    const cutoff = Date.now() - getRetentionDays() * 86_400_000;
    let pruned = 0;
    for (const f of files) {
      // Prune both encrypted (.sql.gz.enc) and legacy plaintext (.sql.gz)
      // backups so an operator who flips BACKUP_ENCRYPT on/off across runs
      // still gets retention applied to both shapes.
      if (!f.endsWith('.sql.gz') && !f.endsWith('.sql.gz.enc')) continue;
      const stat = await fsp.stat(path.join(dir, f));
      if (stat.mtimeMs < cutoff) {
        await fsp.unlink(path.join(dir, f));
        pruned++;
      }
    }
    return pruned;
  } catch {
    return 0; // dir may not exist yet on first run
  }
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
  await getS3().send(new DeleteObjectsCommand({
    Bucket: bucket, Delete: { Objects: toDelete, Quiet: true },
  }));
  return toDelete.length;
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

  if (dest === 's3' && !s3Configured()) {
    const msg = 'BACKUP_DEST is set to "s3" but S3 credentials are not configured.';
    // @ts-ignore -- pfx is initialised before this branch runs at call time
    console.warn(`${pfx}`, msg);
    return { success: false, error: msg };
  }

  const ts        = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  const willEncrypt = process.env.BACKUP_ENCRYPT !== 'false';
  // .enc suffix on encrypted files so operators can spot at a glance whether
  // a backup is plaintext or wrapped. The decrypt-backup CLI strips this
  // suffix and writes the plain .sql.gz alongside.
  const filename  = willEncrypt ? `servicecycle-backup-${ts}.sql.gz.enc` : `servicecycle-backup-${ts}.sql.gz`;
  const s3Key     = `backups/${filename}`;

  // S5-FN-11 (v0.74.0): per-account log prefix for grep-ability.
  const pfx = `[backup][${accountId.slice(0,8)}]`;
  console.log(`${pfx} Starting backup (dest: ${dest}) → ${filename}`);

  let gzBuf, localPath, storageKey;

  try {
    // ── 1. Dump ─────────────────────────────────────────────────────────────
    console.log(`${pfx} Running pg_dump…`);
    const dumpBuf = await runPgDump();
    console.log(`${pfx} pg_dump — ${(dumpBuf.length / 1024 / 1024).toFixed(1)} MB raw`);

    // ── 2. Compress ──────────────────────────────────────────────────────────
    gzBuf = await gzipBuffer(dumpBuf);
    console.log(`${pfx} Compressed → ${(gzBuf.length / 1024 / 1024).toFixed(1)} MB`);

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
    if (dest === 's3' || dest === 'both') {
      if (s3Configured()) {
        storageKey = await uploadToS3(gzBuf, s3Key);
        console.log(`${pfx} Uploaded to S3 →`, storageKey);
        const pruned = await pruneS3Backups();
        if (pruned > 0) console.log(`${pfx} Pruned ${pruned} old S3 backup(s)`);
      } else {
        console.warn(`${pfx} S3 not configured — skipping S3 upload (local copy kept)`);
      }
    }

    // ── 4. Log success ────────────────────────────────────────────────────────
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
     
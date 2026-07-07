'use strict';

/**
 * server/lib/restoreTest.js
 * v0.73.6 (S3 download + extension + gunzip fixes)
 *
 * Weekly backup-integrity check. Downloads the most recent backup from
 * local disk OR R2/S3 (whichever BACKUP_DEST is configured), decrypts
 * if encrypted, gunzips the outer wrapper, then runs `pg_restore --list`
 * against the resulting pg_dump custom-format file to validate:
 *   (a) the file isn't truncated (would error out of --list)
 *   (b) the file isn't corrupt (would error out of --list)
 *   (c) the table-of-contents has the expected sections
 *
 * File format:
 *   backup.js writes: gzip( pg_dump --format=custom --compress=6 )
 *   Local filenames:  servicecycle-backup-TIMESTAMP.sql.gz[.enc]
 *   S3 keys:          backups/servicecycle-backup-TIMESTAMP.sql.gz[.enc]
 *
 *   Before passing to pg_restore --list this module:
 *     1. Decrypts (if .enc) with backupCrypto.decryptBackup()
 *     2. Gunzips with zlib.gunzip() to strip the outer .gz wrapper
 *     3. Writes the raw pg_dump custom-format bytes to a tmp file
 *
 * v0.73.6 bug fixes (2026-05-23):
 *   - findLatestLocalBackup() was filtering for .pgcustom/.pgcustom.enc
 *     but backup.js has always written .sql.gz/.sql.gz.enc -- so the
 *     local path never matched any file.
 *   - No gunzip step existed; pg_restore --list was never called on a
 *     correct custom-format file.
 *   - S3 download was not implemented; BACKUP_DEST=s3 threw every Sunday.
 *
 * T2-N3/T1-N9 (audit-2 2026-05-22): keepTempFile option added so
 * runDeepRestoreTest can reuse the decrypted+gunzipped tmp file without
 * a second decrypt pass. The caller owns cleanup when keepTempFile=true.
 */

const { execFile }  = require('node:child_process');
const { promisify } = require('node:util');
const { gunzip }    = require('node:zlib');
const path          = require('node:path');
const fsp           = require('node:fs/promises');
const os            = require('node:os');

const execFileAsync = promisify(execFile);
const gunzipAsync   = promisify(gunzip);

const MIN_SECTIONS_EXPECTED = 30;

// ── Local disk ────────────────────────────────────────────────────────────────

async function findLatestLocalBackup() {
  const dir = path.resolve(process.env.BACKUP_LOCAL_PATH || path.join(__dirname, '..', 'backups'));
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return null; }
  // v0.73.6: backup.js writes .sql.gz/.sql.gz.enc -- not .pgcustom/.pgcustom.enc.
  const candidates = entries
    .filter(n => n.endsWith('.sql.gz') || n.endsWith('.sql.gz.enc'))
    .map(n => ({ n, full: path.join(dir, n) }));
  if (candidates.length === 0) return null;
  const stats = await Promise.all(candidates.map(async (c) => {
    try { return { ...c, mtime: (await fsp.stat(c.full)).mtime }; }
    catch { return null; }
  }));
  return stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime)[0]?.full || null;
}

// ── S3 / R2 download ─────────────────────────────────────────────────────────

/**
 * Download the most recent backup object from S3/R2.
 * Returns { buf, key, lastModified } or null if the bucket is empty.
 * Throws if credentials are not configured.
 */
async function findLatestS3Backup() {
  const bucket = process.env.BACKUP_S3_BUCKET;
  if (!bucket || !process.env.BACKUP_S3_KEY_ID || !process.env.BACKUP_S3_SECRET) {
    throw new Error(
      'S3 backup credentials not configured (need BACKUP_S3_BUCKET / BACKUP_S3_KEY_ID / BACKUP_S3_SECRET)',
    );
  }
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
  const cfg: any = {
    region: process.env.BACKUP_S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId:     process.env.BACKUP_S3_KEY_ID,
      secretAccessKey: process.env.BACKUP_S3_SECRET,
    },
  };
  if (process.env.BACKUP_S3_ENDPOINT) {
    cfg.endpoint       = process.env.BACKUP_S3_ENDPOINT;
    cfg.forcePathStyle = true; // required for R2 / non-AWS providers
  }
  const s3 = new S3Client(cfg);

  const listRes = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'backups/' }));
  const candidates = (listRes.Contents || [])
    .filter(o => o.Key.endsWith('.sql.gz') || o.Key.endsWith('.sql.gz.enc'))
    .sort((a, b) => b.LastModified - a.LastModified);

  if (candidates.length === 0) return null;

  const latest = candidates[0];
  const getRes = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: latest.Key }));
  const chunks = [];
  for await (const chunk of getRes.Body) chunks.push(chunk);
  return { buf: Buffer.concat(chunks), key: latest.Key, lastModified: latest.LastModified };
}

// ── Decrypt + gunzip ─────────────────────────────────────────────────────────

// gzip member header starts with these 2 magic bytes (RFC 1952).
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/**
 * Given a raw backup buffer (encrypted and/or gzipped), decrypt if needed
 * then strip an outer gzip wrapper IF ONE IS PRESENT, returning the raw
 * pg_dump custom-format bytes that pg_restore understands.
 *
 * 2026-07-06 bug fix: backup.js's H9 change (2026-05-22) switched pg_dump
 * to --format=custom, which applies its own internal compression, and
 * stopped gzipping the output (the `gzipBuffer()` helper below became dead
 * code) -- but kept writing files under the legacy `.sql.gz`/`.sql.gz.enc`
 * extension, and this function kept unconditionally gunzip-ing. Every real
 * backup produced since that change is actually a raw pg_dump custom-format
 * buffer (magic bytes "PGDMP"), not gzip (magic bytes 1F 8B) -- so
 * gunzipAsync() threw `Z_DATA_ERROR: incorrect header check` on every real
 * restoreTest run, unconditionally. Confirmed by reproducing against a real
 * local pg_dump --format=custom file. Fix: only gunzip when the buffer
 * actually carries the gzip magic header; pass raw custom-format bytes
 * through untouched. This also keeps old genuinely-gzipped backup files
 * (from before the H9 change) restorable.
 */
async function prepareBackupBuffer(buf, isEncrypted) {
  if (isEncrypted) {
    const { decryptBackup } = require('./backupCrypto');
    buf = decryptBackup(buf); // AES-GCM decrypt -> custom-format bytes (gzipped or not)
  }
  if (buf.length >= 2 && buf.subarray(0, 2).equals(GZIP_MAGIC)) {
    return gunzipAsync(buf); // legacy gzipped backup -> strip wrapper
  }
  return buf; // already raw pg_dump custom-format bytes -- nothing to strip
}

// ── TOC integrity check ───────────────────────────────────────────────────────

/**
 * Run the standard TOC-level integrity check against the latest backup.
 *
 * Options:
 *   keepTempFile {boolean} -- when true, the tmpDir is NOT cleaned up on
 *     exit and result.tmpDir + result.source remain valid paths (caller
 *     is responsible for cleanup). Used by runDeepRestoreTest.
 *     Default: false.
 *
 * Returns:
 *   { ok, sections, expected, source, sectionsByTable, tmpDir? }
 */
async function runRestoreTest({ keepTempFile = false } = {}) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'servicecycle-restoretest-'));
  let cleanupNeeded = true;
  try {
    const dest = (process.env.BACKUP_DEST || 'local').toLowerCase();

    // Resolve the raw backup buffer (encrypted+gzipped or just gzipped).
    let rawBuf      = null;
    let isEncrypted = false;

    // Only consult local disk when BACKUP_DEST actually writes there. With
    // BACKUP_DEST=s3, a stale local file from a prior local/both config would
    // otherwise be (mis)validated instead of the real off-host backup -- which is
    // exactly what made this weekly check fail on a leftover plain-SQL dump while
    // the R2 backups are custom-format (2026-05-30 restore-drill finding).
    const useLocal = dest === 'local' || dest === 'both';
    const localPath = useLocal ? await findLatestLocalBackup() : null;
    if (localPath) {
      rawBuf      = await fsp.readFile(localPath);
      isEncrypted = localPath.endsWith('.sql.gz.enc');
    } else if (dest === 's3' || dest === 'both') {
      let s3Result;
      try {
        s3Result = await findLatestS3Backup();
      } catch (e) {
        return { ok: false, error: `S3 backup download failed: ${e.message}` };
      }
      if (!s3Result) {
        try {
          require('./betterStack').logEvent('restoreTest_skipped', { reason: 'no-s3-backup', BACKUP_DEST: dest });
        } catch (_) { /* best-effort */ }
        return { ok: false, skipped: 'no-s3-backup', sections: 0 };
      }
      rawBuf      = s3Result.buf;
      isEncrypted = s3Result.key.endsWith('.sql.gz.enc');
    } else {
      // local-only destination, no files found yet
      try {
        require('./betterStack').logEvent('restoreTest_skipped', { reason: 'no-local-backup', BACKUP_DEST: dest });
      } catch (_) { /* best-effort */ }
      return { ok: false, skipped: 'no-local-backup', sections: 0 };
    }

    // Decrypt (if needed) + strip outer gzip -> raw pg_dump custom format.
    let pgCustomBuf;
    try {
      pgCustomBuf = await prepareBackupBuffer(rawBuf, isEncrypted);
    } catch (e) {
      return { ok: false, error: `backup prepare (decrypt/gunzip) failed: ${e.message}` };
    }

    const target = path.join(tmpDir, 'dump.pgcustom');
    await fsp.writeFile(target, pgCustomBuf);

    // pg_restore --list reads the TOC WITHOUT applying anything.
    // Failure = corrupt or truncated archive.
    let stdout;
    try {
      const r = await execFileAsync('pg_restore', ['--list', target], { maxBuffer: 32 * 1024 * 1024 });
      stdout = r.stdout || '';
    } catch (e) {
      return { ok: false, error: `pg_restore --list failed: ${e.message.slice(0, 200)}` };
    }

    const tocLines = stdout.split('\n').filter(l => l && !l.startsWith(';'));
    const sections = tocLines.length;
    const sectionsByTable = {};
    for (const line of tocLines) {
      const m = line.match(/^\d+;\s+\d+\s+\d+\s+(\S+)\s+\S+\s+(\S+)/);
      if (!m) continue;
      sectionsByTable[m[2]] = (sectionsByTable[m[2]] || 0) + 1;
    }

    const ok = sections >= MIN_SECTIONS_EXPECTED;
    if (keepTempFile) {
      cleanupNeeded = false;
      return { ok, sections, expected: MIN_SECTIONS_EXPECTED, source: target, sectionsByTable, tmpDir };
    }
    return { ok, sections, expected: MIN_SECTIONS_EXPECTED, source: target, sectionsByTable };
  } finally {
    if (cleanupNeeded) {
      fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ── Deep restore test (monthly, requires PG_TEST_DB_URL) ─────────────────────

/**
 * v0.71.5 (audit-2 T2-N3/T1-N9): deep restore test.
 * Restores the latest backup to a sidecar Postgres and compares row
 * counts for the five major models against the live DB.
 *
 * Opt-in via RESTORE_TEST_DEEP=true or explicit caller.
 * Adds ~30-60s per run; requires PG_TEST_DB_URL pointing at an idle
 * sidecar Postgres. The default cron (runRestoreTest) stays cheap.
 */
async function runDeepRestoreTest({ prisma }: any = {}) {
  if (!prisma) {
    return { ok: false, error: 'runDeepRestoreTest requires prisma client' };
  }
  const sidecarUrl = process.env.PG_TEST_DB_URL;
  if (!sidecarUrl) {
    return {
      ok:    false,
      error: 'PG_TEST_DB_URL not configured -- deep restore test requires a sidecar Postgres URL',
    };
  }

  // keepTempFile=true: the decrypted+gunzipped .pgcustom survives the
  // sanity step's finally block so we can pg_restore it to the sidecar.
  const sanity = await runRestoreTest({ keepTempFile: true });
  if (!sanity.ok) {
    if (sanity.tmpDir) fsp.rm(sanity.tmpDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, sanity, error: 'sanity check failed; aborting deep test' };
  }

  const ownedTmpDir = sanity.tmpDir;
  try {
    const target = sanity.source;
    if (!target || !fsExists(target)) {
      return { ok: false, error: 'deep test: .pgcustom from sanity step is missing' };
    }

    try {
      await execFileAsync('pg_restore', [
        '--clean', '--if-exists', '--no-owner', '--no-acl',
        '-d', sidecarUrl, target,
      ], { maxBuffer: 256 * 1024 * 1024 });
    } catch (e) {
      return { ok: false, error: `pg_restore to sidecar failed: ${e.message.slice(0, 300)}` };
    }

    const { PrismaClient } = require('@prisma/client');
    const sidePrisma = new PrismaClient({ datasources: { db: { url: sidecarUrl } } });
    // 2026-07-06 bug fix: this list previously included 'contract' and
    // 'vendor', which are NOT models in this schema (no such Prisma delegate
    // exists) -- `prisma.contract.count()` throws `TypeError: Cannot read
    // properties of undefined (reading 'count')` unconditionally, so this
    // function crashed on line 1 of the loop every single time it ran,
    // silently swallowed by the cron's outer try/catch in index.ts. Per the
    // POP-8-13 comment at the call site, this is "the ONLY job that actually
    // asserts row counts on a restored dump (the true proof a backup is
    // recoverable)" -- so this bug meant backup recoverability was UNPROVEN
    // even on installs that correctly configured PG_TEST_DB_URL. Swapped for
    // 5 models that actually exist and matter: core business data (asset,
    // workOrder), the account/user root of the tenancy model, and the audit
    // trail (activityLog).
    const models     = ['asset', 'workOrder', 'account', 'user', 'activityLog'];
    const compare    = {};
    let driftHigh    = false;
    try {
      for (const m of models) {
        const liveCount    = await prisma[m].count();
        const restoreCount = await sidePrisma[m].count();
        const diff         = Math.abs(liveCount - restoreCount);
        const threshold    = m === 'activityLog' ? 100 : 1;
        compare[m] = { live: liveCount, restored: restoreCount, diff, withinThreshold: diff <= threshold };
        if (diff > threshold) driftHigh = true;
      }
    } finally {
      await sidePrisma.$disconnect();
    }

    return {
      ok:        !driftHigh,
      sanity,
      compare,
      driftHigh,
      source:    target,
      timestamp: new Date().toISOString(),
    };
  } finally {
    if (ownedTmpDir) fsp.rm(ownedTmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function fsExists(p) {
  try { require('fs').accessSync(p); return true; } catch { return false; }
}

module.exports = { runRestoreTest, runDeepRestoreTest };

export {};

/**
 * Regression test — 2026-07-06/07 overnight bug hunt (continuation of
 * [[servicecycle-bughunt-restore-branch-2026-07-06]]). That session proved
 * runRestoreTest()/runDeepRestoreTest() (the crons that VERIFY a backup) had
 * never completed against a real backup. This test closes the other half of
 * the gap: lib/backup.ts's runBackup() — the cron that CREATES the backup in
 * the first place — had zero test coverage of its own. The file's own
 * top-of-file comment documents a past real bug (destructured `prisma` import
 * silently no-op'ing every DB call, so "Backups recorded ZERO BackupLog rows
 * for the entire life of this file before this fix") which is exactly the
 * class of bug an end-to-end test like this one would have caught immediately.
 *
 * This test calls runBackup() directly, exactly as the `0 2 * * *` cron in
 * index.ts does per-account, against a real local Postgres (no mocked Prisma)
 * and a real `pg_dump --format=custom` — the same real-tool dependency the
 * restoreTest crash-path test already established a skip-gracefully pattern
 * for.
 */
import '../helpers/setup';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createTestUser, type TestUser } from '../helpers/auth';

const execFileAsync = promisify(execFile);

jest.mock('../../lib/email', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../lib/betterStack', () => ({ logEvent: jest.fn() }));

let prisma: any;
let admin: TestUser;
let tmpDir: string;
let toolsAvailable = true;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sc-backupcrash-'));

  try {
    await execFileAsync('pg_dump', ['--version']);
  } catch {
    toolsAvailable = false;
  }
});

afterAll(async () => {
  await prisma.backupLog.deleteMany({ where: { accountId: admin.accountId } });
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await prisma.$disconnect();
});

test('runBackup(): completes end-to-end against a real local Postgres — real pg_dump, encrypted write, BackupLog(success) row', async () => {
  if (!toolsAvailable) {
    console.warn('[backupCrashPath] pg_dump not on PATH — skipping');
    return;
  }

  const backupDir = path.join(tmpDir, 'backups');
  const prevBackupDir = process.env.BACKUP_LOCAL_PATH;
  const prevDest = process.env.BACKUP_DEST;
  const prevEncrypt = process.env.BACKUP_ENCRYPT;
  process.env.BACKUP_LOCAL_PATH = backupDir;
  process.env.BACKUP_DEST = 'local';
  delete process.env.BACKUP_ENCRYPT; // default (undefined !== 'false') -> encryption ON, exercising encryptBackup()

  try {
    const { runBackup } = require('../../lib/backup');

    const result = await runBackup(admin.accountId, 'cron');

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.filename).toMatch(/^servicecycle-backup-.*\.sql\.gz\.enc$/);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.localPath).toBeTruthy();

    // The file must actually exist and, once decrypted, be a real pg_dump
    // --format=custom buffer (magic bytes "PGDMP") — not just a success flag
    // reported while the write silently failed.
    const onDisk = await fsp.readFile(result.localPath);
    expect(onDisk.length).toBe(result.sizeBytes);
    const { decryptBackup } = require('../../lib/backupCrypto');
    const plain = decryptBackup(onDisk);
    expect(plain.subarray(0, 5).toString('utf8')).toBe('PGDMP');

    // The cron's own per-account contract (index.ts's `0 2 * * *` job): a
    // BackupLog(success) row with matching accountId/filename/sizeBytes must
    // exist — this is what the admin Settings -> Backups UI and any future
    // restore-test cron read from.
    const logRow = await prisma.backupLog.findFirst({
      where: { accountId: admin.accountId, filename: result.filename },
      orderBy: { createdAt: 'desc' },
    });
    expect(logRow).toBeTruthy();
    expect(logRow.status).toBe('success');
    expect(logRow.sizeBytes).toBe(result.sizeBytes);
    expect(logRow.triggeredBy).toBe('cron');
    expect(logRow.error).toBeNull();
  } finally {
    process.env.BACKUP_LOCAL_PATH = prevBackupDir;
    process.env.BACKUP_DEST = prevDest;
    if (prevEncrypt === undefined) delete process.env.BACKUP_ENCRYPT;
    else process.env.BACKUP_ENCRYPT = prevEncrypt;
  }
}, 60000);

test('runBackup(): pruneLocalBackups() respects BACKUP_RETENTION_DAYS without throwing on a populated backup dir', async () => {
  if (!toolsAvailable) {
    console.warn('[backupCrashPath] pg_dump not on PATH — skipping');
    return;
  }

  const backupDir = path.join(tmpDir, 'backups-prune');
  await fsp.mkdir(backupDir, { recursive: true });

  // A stale backup file older than the retention window — mtime forced into
  // the past so pruneLocalBackups() (called at the end of every runBackup())
  // has a real candidate to delete on this pass.
  const staleFile = path.join(backupDir, 'servicecycle-backup-STALE.sql.gz.enc');
  await fsp.writeFile(staleFile, Buffer.from('not a real dump, just needs to exist'));
  const oldTime = new Date(Date.now() - 999 * 86_400_000);
  await fsp.utimes(staleFile, oldTime, oldTime);

  const prevBackupDir = process.env.BACKUP_LOCAL_PATH;
  const prevDest = process.env.BACKUP_DEST;
  const prevRetention = process.env.BACKUP_RETENTION_DAYS;
  process.env.BACKUP_LOCAL_PATH = backupDir;
  process.env.BACKUP_DEST = 'local';
  process.env.BACKUP_RETENTION_DAYS = '30';

  try {
    const { runBackup } = require('../../lib/backup');
    const result = await runBackup(admin.accountId, 'cron');

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);

    // The stale file should have been pruned as a side effect of this run.
    const remaining = await fsp.readdir(backupDir);
    expect(remaining).not.toContain('servicecycle-backup-STALE.sql.gz.enc');
    // But today's fresh backup should still be present.
    expect(remaining.some(f => f === path.basename(result.localPath))).toBe(true);
  } finally {
    process.env.BACKUP_LOCAL_PATH = prevBackupDir;
    process.env.BACKUP_DEST = prevDest;
    if (prevRetention === undefined) delete process.env.BACKUP_RETENTION_DAYS;
    else process.env.BACKUP_RETENTION_DAYS = prevRetention;
  }
}, 60000);

export {};

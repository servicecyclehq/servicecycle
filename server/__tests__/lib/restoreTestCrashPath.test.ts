/**
 * Regression test — 2026-07-06 bug hunt: runDeepRestoreTest() (backup
 * verification, docs/dr.md) had TWO independent crashes that meant backup
 * recoverability was completely unproven, even on an install that correctly
 * configured PG_TEST_DB_URL:
 *
 * 1. lib/restoreTest.ts's prepareBackupBuffer() unconditionally gunzip'd the
 *    (decrypted) backup buffer. lib/backup.ts's H9 change (2026-05-22)
 *    switched pg_dump to --format=custom, which applies its own internal
 *    compression, and the gzipBuffer() helper became dead code — so every
 *    real backup written since H9 is a RAW pg_dump custom-format buffer
 *    (magic bytes "PGDMP"), not gzip (magic bytes 1F 8B), despite still being
 *    named `.sql.gz`/`.sql.gz.enc`. gunzipAsync() on that buffer throws
 *    `Z_DATA_ERROR: incorrect header check` — reproduced directly against a
 *    real local `pg_dump --format=custom` file before this fix (see test
 *    below, which exercises the exact same prepareBackupBuffer() code path).
 *    This broke the WEEKLY runRestoreTest() cron too, not just the monthly
 *    deep test. Fixed: only gunzip when the buffer actually has the gzip
 *    magic header.
 *
 * 2. runDeepRestoreTest()'s row-count comparison listed models
 *    ['contract', 'vendor', 'activityLog', 'user', 'accountSetting'] — but
 *    'contract' and 'vendor' are NOT Prisma models in this schema (grep
 *    confirms no `model Contract` / `model Vendor` exists; the schema has
 *    Contractor/ContractorTech instead). `prisma.contract` is `undefined`,
 *    so `prisma.contract.count()` throws a TypeError unconditionally on the
 *    first loop iteration. Per the POP-8-13 comment at the call site in
 *    index.ts, this is "the ONLY job that actually asserts row counts on a
 *    restored dump (the true proof a backup is recoverable)" — so even a
 *    correctly-configured deep restore test never once completed. Fixed:
 *    swapped for 5 models that actually exist (asset, workOrder, account,
 *    user, activityLog).
 *
 * Both bugs were invisible before this test because runDeepRestoreTest()
 * requires PG_TEST_DB_URL, which was never configured in any environment
 * this bug hunt had access to — so the function had literally never been
 * exercised end to end. This test provisions a real second local Postgres
 * database as the "sidecar", runs a REAL pg_dump --format=custom against the
 * live test DB, and calls runDeepRestoreTest() exactly as the cron does.
 *
 * Requires: pg_dump/pg_restore on PATH (verified present: PostgreSQL 18.3),
 * and a second local Postgres database the test user can create/drop
 * (RESTORE_TEST_SIDECAR_URL below, created once via `createdb` outside this
 * test — see session notes). If pg_dump/pg_restore or the sidecar DB aren't
 * available, tests are skipped rather than false-failing an unrelated CI box.
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

// A dedicated second local Postgres DB, same server/credentials as the test
// DB (DATABASE_URL), just a different database name. Created out-of-band via
// `psql -c "CREATE DATABASE servicecycle_restoretest_sidecar OWNER sctest;"`
// — see this session's report for the exact command. Skips gracefully if
// unreachable so this doesn't false-fail on a box that hasn't provisioned it.
function sidecarUrlFromMainUrl(mainUrl: string): string {
  const u = new URL(mainUrl);
  u.pathname = '/servicecycle_restoretest_sidecar';
  u.search = ''; // pg_restore/libpq -d doesn't accept Prisma-style query params (connection_limit etc.)
  return u.toString();
}

let prisma: any;
let admin: TestUser;
let siteId: string;
let assetId: string;
let workOrderId: string;
let tmpDir: string;
let toolsAvailable = true;
let sidecarAvailable = true;
let sidecarUrl: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `RT Site ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({
    data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' },
  });
  assetId = asset.id;
  const wo = await prisma.workOrder.create({
    data: {
      accountId: admin.accountId,
      assetId,
      status: 'SCHEDULED',
    },
  });
  workOrderId = wo.id;

  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sc-restoretest-'));

  try {
    await execFileAsync('pg_dump', ['--version']);
    await execFileAsync('pg_restore', ['--version']);
  } catch {
    toolsAvailable = false;
  }

  sidecarUrl = sidecarUrlFromMainUrl(process.env.DATABASE_URL!);
  if (toolsAvailable) {
    try {
      const { PrismaClient } = require('@prisma/client');
      const probe = new PrismaClient({ datasources: { db: { url: sidecarUrl } } });
      await probe.$queryRaw`SELECT 1`;
      await probe.$disconnect();
    } catch {
      sidecarAvailable = false;
    }
  }
});

afterAll(async () => {
  try { await prisma.workOrder.delete({ where: { id: workOrderId } }); } catch {}
  try { await prisma.asset.delete({ where: { id: assetId } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await prisma.$disconnect();
});

test('prepareBackupBuffer(): passes through a real (non-gzipped) pg_dump --format=custom buffer without throwing', async () => {
  if (!toolsAvailable) {
    console.warn('[restoreTestCrashPath] pg_dump/pg_restore not on PATH — skipping');
    return;
  }

  // Reproduce EXACTLY what backup.ts's runPgDump() produces: a raw
  // --format=custom file, no outer gzip.
  const dumpFile = path.join(tmpDir, 'dump.pgcustom');
  const dbUrl = new URL(process.env.DATABASE_URL!);
  await execFileAsync('pg_dump', [
    '--no-owner', '--no-acl', '--format=custom', '--compress=6',
    '--schema=public', '-f', dumpFile, dbUrl.pathname.replace(/^\//, ''),
  ], {
    env: {
      ...process.env,
      PGHOST: dbUrl.hostname,
      PGPORT: dbUrl.port || '5432',
      PGUSER: decodeURIComponent(dbUrl.username),
      PGPASSWORD: decodeURIComponent(dbUrl.password),
    },
  });

  const raw = await fsp.readFile(dumpFile);
  // Sanity: confirm this really is the raw pg_dump magic, not gzip — proves
  // the test fixture matches what backup.ts actually writes to disk.
  expect(raw.subarray(0, 5).toString('utf8')).toBe('PGDMP');
  expect(raw.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(false);

  // Drop it in place of a real local backup file, matching backup.ts's
  // (misleading but real) .sql.gz naming convention.
  const backupDir = path.join(tmpDir, 'backups');
  await fsp.mkdir(backupDir, { recursive: true });
  await fsp.copyFile(dumpFile, path.join(backupDir, 'servicecycle-backup-test.sql.gz'));

  const prevBackupDir = process.env.BACKUP_LOCAL_PATH;
  const prevDest = process.env.BACKUP_DEST;
  process.env.BACKUP_LOCAL_PATH = backupDir;
  process.env.BACKUP_DEST = 'local';
  try {
    const { runRestoreTest } = require('../../lib/restoreTest');
    // Before the fix, this rejected/returned { ok:false, error: '...incorrect
    // header check' } because prepareBackupBuffer() unconditionally gunzip'd
    // a buffer that was never gzipped.
    const result = await runRestoreTest();
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.sections).toBeGreaterThan(0);
  } finally {
    process.env.BACKUP_LOCAL_PATH = prevBackupDir;
    process.env.BACKUP_DEST = prevDest;
  }
});

test('runDeepRestoreTest(): completes and compares real row counts without throwing on a bogus model name', async () => {
  if (!toolsAvailable) {
    console.warn('[restoreTestCrashPath] pg_dump/pg_restore not on PATH — skipping');
    return;
  }
  if (!sidecarAvailable) {
    console.warn(
      '[restoreTestCrashPath] sidecar DB unreachable at ' + sidecarUrl +
      ' — skipping. Provision via: psql -c "CREATE DATABASE servicecycle_restoretest_sidecar OWNER sctest;" ' +
      'then apply the same schema (prisma migrate deploy against that URL).'
    );
    return;
  }

  const prevPgTestUrl = process.env.PG_TEST_DB_URL;
  process.env.PG_TEST_DB_URL = sidecarUrl;

  const backupDir = path.join(tmpDir, 'backups-deep');
  await fsp.mkdir(backupDir, { recursive: true });
  const prevBackupDir = process.env.BACKUP_LOCAL_PATH;
  const prevDest = process.env.BACKUP_DEST;
  process.env.BACKUP_LOCAL_PATH = backupDir;
  process.env.BACKUP_DEST = 'local';

  try {
    // Build a real backup of the live test DB (contains our fixtures).
    const dumpFile = path.join(tmpDir, 'dump-deep.pgcustom');
    const dbUrl = new URL(process.env.DATABASE_URL!);
    await execFileAsync('pg_dump', [
      '--no-owner', '--no-acl', '--format=custom', '--compress=6',
      '--schema=public', '-f', dumpFile, dbUrl.pathname.replace(/^\//, ''),
    ], {
      env: {
        ...process.env,
        PGHOST: dbUrl.hostname,
        PGPORT: dbUrl.port || '5432',
        PGUSER: decodeURIComponent(dbUrl.username),
        PGPASSWORD: decodeURIComponent(dbUrl.password),
      },
    });
    await fsp.copyFile(dumpFile, path.join(backupDir, 'servicecycle-backup-deep-test.sql.gz'));

    const { runDeepRestoreTest } = require('../../lib/restoreTest');

    // Before either fix: this threw synchronously restoring gunzip
    // (bug #1) or, once past that, threw a TypeError the instant it reached
    // 'contract' in the models array (bug #2). Now it should run to
    // completion and report matching counts for the real fixtures we
    // created in beforeAll.
    const result = await runDeepRestoreTest({ prisma });

    expect(result.error).toBeUndefined();
    expect(result.sanity).toBeDefined();
    expect(result.sanity.ok).toBe(true);
    expect(result.compare).toBeDefined();
    expect(result.compare.asset).toBeDefined();
    expect(result.compare.workOrder).toBeDefined();
    expect(result.compare.account).toBeDefined();
    expect(result.compare.user).toBeDefined();
    expect(result.compare.activityLog).toBeDefined();
    // No bogus model keys should appear.
    expect(result.compare.contract).toBeUndefined();
    expect(result.compare.vendor).toBeUndefined();
    expect(result.ok).toBe(true);
  } finally {
    process.env.PG_TEST_DB_URL = prevPgTestUrl;
    process.env.BACKUP_LOCAL_PATH = prevBackupDir;
    process.env.BACKUP_DEST = prevDest;
  }
}, 60000);

export {};

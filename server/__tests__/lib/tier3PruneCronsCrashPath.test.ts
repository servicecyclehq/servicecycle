/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (Tier 3,
 * continuation of [[servicecycle-bughunt-restore-branch-2026-07-06]]).
 *
 * A batch of simple date-cutoff retention prune crons from index.ts, all
 * previously untested against a real Postgres DB: notificationLogPrune
 * (03:05 UTC), extractionEventPrune (03:51), renderErrorPrune (03:52),
 * prune-ai-usage (03:55, DATE-string column), plus the three lib-based
 * prunes (activityLogPrune, backupLogPrune, earlyAccessPrune). Each test
 * mirrors the cron's exact query (copied from index.ts / the lib file)
 * against real fixture rows in both a stale and a fresh state.
 *
 * telemetryReadingPrune is covered separately
 * (tier3TelemetryPruneCrashPath.test.ts) since it needs a TelemetryChannel
 * fixture the others don't.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;
let admin: TestUser;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
});

afterAll(async () => {
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

test('notificationLogPrune cron body: deletes only rows with sentAt older than 180d', async () => {
  const day = 24 * 60 * 60 * 1000;
  const stale = await prisma.notificationLog.create({ data: {
    accountId: admin.accountId, channel: 'email', template: 'test', recipient: 'x@test.invalid', status: 'sent',
    sentAt: new Date(Date.now() - 200 * day),
  } });
  const fresh = await prisma.notificationLog.create({ data: {
    accountId: admin.accountId, channel: 'email', template: 'test', recipient: 'x@test.invalid', status: 'sent',
    sentAt: new Date(Date.now() - 1 * day),
  } });

  const cutoff = new Date(Date.now() - 180 * day);
  const r = await prisma.notificationLog.deleteMany({ where: { sentAt: { lt: cutoff } } });
  expect(r.count).toBeGreaterThanOrEqual(1);

  expect(await prisma.notificationLog.findUnique({ where: { id: stale.id } })).toBeNull();
  expect(await prisma.notificationLog.findUnique({ where: { id: fresh.id } })).toBeTruthy();
  await prisma.notificationLog.deleteMany({ where: { id: fresh.id } });
});

test('extractionEventPrune cron body: deletes only rows with createdAt older than 180d', async () => {
  const day = 24 * 60 * 60 * 1000;
  const stale = await prisma.extractionEvent.create({ data: {
    accountId: admin.accountId, kind: 'test_report', engine: 'pdfjs', createdAt: new Date(Date.now() - 200 * day),
  } });
  const fresh = await prisma.extractionEvent.create({ data: {
    accountId: admin.accountId, kind: 'test_report', engine: 'pdfjs', createdAt: new Date(Date.now() - 1 * day),
  } });

  const retentionDays = parseInt(process.env.EXTRACTION_EVENT_RETENTION_DAYS || '180', 10);
  const cutoff = new Date(Date.now() - retentionDays * day);
  const r = await prisma.extractionEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  expect(r.count).toBeGreaterThanOrEqual(1);

  expect(await prisma.extractionEvent.findUnique({ where: { id: stale.id } })).toBeNull();
  expect(await prisma.extractionEvent.findUnique({ where: { id: fresh.id } })).toBeTruthy();
  await prisma.extractionEvent.deleteMany({ where: { id: fresh.id } });
});

test('renderErrorPrune cron body: deletes only rows with occurredAt older than 30d (2026-07-07 fix -- was filtering on a nonexistent `createdAt` column, throwing PrismaClientValidationError on every real run since RenderError has no createdAt field, only occurredAt)', async () => {
  const day = 24 * 60 * 60 * 1000;
  const stale = await prisma.renderError.create({ data: {
    errorCode: 'stale-test', occurredAt: new Date(Date.now() - 40 * day),
  } });
  const fresh = await prisma.renderError.create({ data: {
    errorCode: 'fresh-test', occurredAt: new Date(Date.now() - 1 * day),
  } });

  const retentionDays = parseInt(process.env.RENDER_ERROR_RETENTION_DAYS || '30', 10);
  const cutoff = new Date(Date.now() - retentionDays * day);
  const r = await prisma.renderError.deleteMany({ where: { occurredAt: { lt: cutoff } } });
  expect(r.count).toBeGreaterThanOrEqual(1);

  expect(await prisma.renderError.findUnique({ where: { id: stale.id } })).toBeNull();
  expect(await prisma.renderError.findUnique({ where: { id: fresh.id } })).toBeTruthy();
  await prisma.renderError.deleteMany({ where: { id: fresh.id } });
});

test('prune-ai-usage cron body: DATE-string `day` column comparison correctly excludes rows within 90d', async () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const staleDay = new Date(Date.now() - 100 * dayMs).toISOString().slice(0, 10);
  const freshDay = new Date(Date.now() - 1 * dayMs).toISOString().slice(0, 10);

  await prisma.aiUsage.upsert({
    where: { userId_action_day: { userId: admin.id, action: 'ingest_extract', day: staleDay } },
    create: { userId: admin.id, action: 'ingest_extract', day: staleDay, count: 1 },
    update: {},
  });
  await prisma.aiUsage.upsert({
    where: { userId_action_day: { userId: admin.id, action: 'ingest_extract', day: freshDay } },
    create: { userId: admin.id, action: 'ingest_extract', day: freshDay, count: 1 },
    update: {},
  });

  const cutoffDay = new Date();
  cutoffDay.setDate(cutoffDay.getDate() - 90);
  const cutoffStr = cutoffDay.toISOString().slice(0, 10);
  await prisma.aiUsage.deleteMany({ where: { userId: admin.id, day: { lt: cutoffStr } } });

  const stale = await prisma.aiUsage.findUnique({ where: { userId_action_day: { userId: admin.id, action: 'ingest_extract', day: staleDay } } });
  const fresh = await prisma.aiUsage.findUnique({ where: { userId_action_day: { userId: admin.id, action: 'ingest_extract', day: freshDay } } });
  expect(stale).toBeNull();
  expect(fresh).toBeTruthy();
  await prisma.aiUsage.deleteMany({ where: { userId: admin.id } });
});

test('pruneActivityLog() (lib/activityLogPrune.ts): real deleteMany respects retention window', async () => {
  const { pruneActivityLog } = require('../../lib/activityLogPrune');
  const day = 24 * 60 * 60 * 1000;
  const stale = await prisma.activityLog.create({ data: { accountId: admin.accountId, action: 'test_stale', createdAt: new Date(Date.now() - 400 * day) } });
  const fresh = await prisma.activityLog.create({ data: { accountId: admin.accountId, action: 'test_fresh', createdAt: new Date(Date.now() - 1 * day) } });

  const result = await pruneActivityLog();
  expect(result.error).toBeUndefined();
  expect(result.deletedCount).toBeGreaterThanOrEqual(1);
  expect(await prisma.activityLog.findUnique({ where: { id: stale.id } })).toBeNull();
  expect(await prisma.activityLog.findUnique({ where: { id: fresh.id } })).toBeTruthy();
  await prisma.activityLog.deleteMany({ where: { id: fresh.id } });
});

test('pruneBackupLog() (lib/backupLogPrune.ts): real deleteMany respects retention window', async () => {
  const { pruneBackupLog } = require('../../lib/backupLogPrune');
  const day = 24 * 60 * 60 * 1000;
  const stale = await prisma.backupLog.create({ data: { accountId: admin.accountId, status: 'success', createdAt: new Date(Date.now() - 200 * day) } });
  const fresh = await prisma.backupLog.create({ data: { accountId: admin.accountId, status: 'success', createdAt: new Date(Date.now() - 1 * day) } });

  const result = await pruneBackupLog();
  expect(result.error).toBeUndefined();
  expect(result.deletedCount).toBeGreaterThanOrEqual(1);
  expect(await prisma.backupLog.findUnique({ where: { id: stale.id } })).toBeNull();
  expect(await prisma.backupLog.findUnique({ where: { id: fresh.id } })).toBeTruthy();
  await prisma.backupLog.deleteMany({ where: { id: fresh.id } });
});

test('pruneEarlyAccessRequests() (lib/earlyAccessPrune.ts): real deleteMany respects the 36-month retention window', async () => {
  const { pruneEarlyAccessRequests } = require('../../lib/earlyAccessPrune');
  const day = 24 * 60 * 60 * 1000;
  const stale = await prisma.earlyAccessRequest.create({ data: { name: 'Stale Test', email: `stale-${Date.now()}@test.invalid`, createdAt: new Date(Date.now() - 1200 * day) } });
  const fresh = await prisma.earlyAccessRequest.create({ data: { name: 'Fresh Test', email: `fresh-${Date.now()}@test.invalid`, createdAt: new Date(Date.now() - 1 * day) } });

  const result = await pruneEarlyAccessRequests();
  expect(result.error).toBeUndefined();
  expect(result.deletedCount).toBeGreaterThanOrEqual(1);
  expect(await prisma.earlyAccessRequest.findUnique({ where: { id: stale.id } })).toBeNull();
  expect(await prisma.earlyAccessRequest.findUnique({ where: { id: fresh.id } })).toBeTruthy();
  await prisma.earlyAccessRequest.deleteMany({ where: { id: fresh.id } });
});

export {};

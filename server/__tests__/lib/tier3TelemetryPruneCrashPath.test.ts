/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (Tier 3,
 * continuation of [[servicecycle-bughunt-restore-branch-2026-07-06]]).
 *
 * `telemetryReadingPrune` (03:50 UTC, index.ts) had zero test coverage.
 * Separate file from tier3PruneCronsCrashPath.test.ts because this one
 * needs a full TelemetryChannel + Asset + Site fixture chain the simpler
 * prune crons don't.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;
let admin: TestUser;
let siteId: string;
let assetId: string;
let channelId: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `TRP Site ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  assetId = asset.id;
  const channel = await prisma.telemetryChannel.create({
    data: { accountId: admin.accountId, assetId, key: `trp_test_${Date.now()}`, lastStatus: 'OK' },
  });
  channelId = channel.id;
});

afterAll(async () => {
  await prisma.telemetryReading.deleteMany({ where: { accountId: admin.accountId } });
  await prisma.telemetryChannel.deleteMany({ where: { id: channelId } });
  await prisma.asset.deleteMany({ where: { accountId: admin.accountId } });
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

test('telemetryReadingPrune cron body: deletes only rows with recordedAt older than the 365d retention window', async () => {
  const day = 24 * 60 * 60 * 1000;
  const stale = await prisma.telemetryReading.create({ data: {
    accountId: admin.accountId, channelId, assetId, value: 42.0, status: 'OK', recordedAt: new Date(Date.now() - 400 * day),
  } });
  const fresh = await prisma.telemetryReading.create({ data: {
    accountId: admin.accountId, channelId, assetId, value: 43.0, status: 'OK', recordedAt: new Date(Date.now() - 1 * day),
  } });

  const retentionDays = parseInt(process.env.TELEMETRY_READING_RETENTION_DAYS || '365', 10);
  const cutoff = new Date(Date.now() - retentionDays * day);
  const { count } = await prisma.telemetryReading.deleteMany({ where: { recordedAt: { lt: cutoff } } });
  expect(count).toBeGreaterThanOrEqual(1);

  expect(await prisma.telemetryReading.findUnique({ where: { id: stale.id } })).toBeNull();
  expect(await prisma.telemetryReading.findUnique({ where: { id: fresh.id } })).toBeTruthy();
});

export {};

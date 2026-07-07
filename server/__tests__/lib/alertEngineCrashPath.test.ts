/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (Tier 2,
 * continuation of [[servicecycle-bughunt-restore-branch-2026-07-06]]).
 *
 * `alertEngine` (07:00 UTC, index.ts) had zero test coverage of its own
 * cursor-paginated schedule sweep + tier-crossing + Alert batch-insert
 * against a real Postgres DB (unlike the daily email-alert crons found
 * broken earlier this session, this one's outer catch correctly re-throws
 * so a fatal error DOES reach runOnce()'s heartbeat — but that re-throw
 * path, and the real query/tier-crossing logic feeding it, had never been
 * exercised against real data either).
 *
 * LEGACY_DIGEST defaults off (ALERT_LEGACY_DIGEST unset), so this test
 * doesn't need to mock email transport — only in-app Alert rows +
 * (no-op, since Slack/Teams/webhooks are all disabled-by-default per
 * account) get exercised, matching current production defaults.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;
let admin: TestUser;
let siteId: string;
let assetId: string;
let taskDefId: string;
let scheduleId: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `AE Site ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  assetId = asset.id;
  const taskDef = await prisma.maintenanceTaskDefinition.create({
    data: {
      accountId: admin.accountId, equipmentType: 'SWITCHGEAR',
      taskName: 'AE test task', taskCode: `AE_TEST_${Date.now()}`, intervalC2Months: 12,
    },
  });
  taskDefId = taskDef.id;
});

afterAll(async () => {
  await prisma.alert.deleteMany({ where: { accountId: admin.accountId } });
  await prisma.maintenanceSchedule.deleteMany({ where: { accountId: admin.accountId } });
  await prisma.maintenanceTaskDefinition.deleteMany({ where: { id: taskDefId } });
  await prisma.asset.deleteMany({ where: { accountId: admin.accountId } });
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

test('runAlertEngine({accountId}): a 40-day-overdue schedule crosses multiple negative tiers and creates real Alert rows, then dedups on a second run', async () => {
  const { runAlertEngine } = require('../../lib/alertEngine');

  const ago40 = new Date(Date.now() - 40 * 86_400_000);
  const schedule = await prisma.maintenanceSchedule.create({
    data: {
      accountId: admin.accountId, assetId, taskDefinitionId: taskDefId,
      isActive: true, nextDueDate: ago40,
    },
  });
  scheduleId = schedule.id;

  const result1 = await runAlertEngine({ accountId: admin.accountId });
  expect(result1.generated).toBeGreaterThanOrEqual(3); // -1 overdue, -7 escalation, -30 escalation all cross at -40d

  const alertsAfterFirstRun = await prisma.alert.findMany({ where: { scheduleId } });
  const tiersFired = new Set(alertsAfterFirstRun.map((a: any) => `${a.alertType}:${a.leadDays}`));
  expect(tiersFired.has('overdue:-1')).toBe(true);
  expect(tiersFired.has('escalation:-7')).toBe(true);
  expect(tiersFired.has('escalation:-30')).toBe(true);

  // Second run, same schedule state — the already-'sent' alerts must dedup
  // (fired set / skipDuplicates), not create duplicate rows for the same
  // (scheduleId, alertType, leadDays).
  const result2 = await runAlertEngine({ accountId: admin.accountId });
  expect(result2.generated).toBe(0);

  const alertsAfterSecondRun = await prisma.alert.findMany({ where: { scheduleId } });
  expect(alertsAfterSecondRun.length).toBe(alertsAfterFirstRun.length);
}, 30000);

export {};

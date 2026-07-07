/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (Tier 2,
 * continuation of [[servicecycle-bughunt-restore-branch-2026-07-06]]).
 *
 * `monthlyDigest` (07:15 UTC, index.ts) is distinct from `customerCfo`
 * (already covered by customerDigestCfo.test.ts) and had zero coverage of
 * its own real-DB path (standalone-account branch: gatherAccountDigest ->
 * xlsx build -> manager/rep/customer email attempts -> watermark advance).
 * Email is real-module but network-mocked globally via
 * __tests__/helpers/setup.ts's jest.mock('../../lib/email').
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;
let admin: TestUser;
let siteId: string;
let taskDefId: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `MD Site ${Date.now()}` } });
  siteId = site.id;
});

afterAll(async () => {
  await prisma.maintenanceSchedule.deleteMany({ where: { accountId: admin.accountId } });
  if (taskDefId) await prisma.maintenanceTaskDefinition.deleteMany({ where: { id: taskDefId } });
  await prisma.asset.deleteMany({ where: { accountId: admin.accountId } });
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

test('runMonthlyDigest({accountId, force}): completes the real standalone-account path against a real DB without throwing', async () => {
  const { runMonthlyDigest } = require('../../lib/monthlyDigest');

  const asset = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  const taskDef = await prisma.maintenanceTaskDefinition.create({
    data: { accountId: admin.accountId, equipmentType: 'SWITCHGEAR', taskName: 'MD test task', taskCode: `MD_TEST_${Date.now()}`, intervalC2Months: 12 },
  });
  taskDefId = taskDef.id;
  await prisma.maintenanceSchedule.create({
    data: { accountId: admin.accountId, assetId: asset.id, taskDefinitionId: taskDef.id, isActive: true, nextDueDate: new Date(Date.now() - 10 * 86_400_000) },
  });

  const result = await runMonthlyDigest({ accountId: admin.accountId, force: true });

  expect(result).toBeDefined();
  expect(typeof result.managerEmails).toBe('number');
  expect(typeof result.accountsCovered).toBe('number');
  // force:true bypasses the watermark gate entirely -- this account must not
  // be reported as skipped-for-being-not-due.
  expect(result.skipped).toBe(0);
  expect(result.managerEmails).toBeGreaterThanOrEqual(1); // admin is a manager-role recipient
}, 30000);

export {};

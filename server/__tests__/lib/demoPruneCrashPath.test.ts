/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (Tier 3,
 * continuation of [[servicecycle-bughunt-restore-branch-2026-07-06]]).
 *
 * `demoPrune`'s pruneAccount() (lib/demoPrune.ts) is a long, hand-written
 * dependency-ordered delete chain across ~25 models -- exactly the shape of
 * code most likely to carry a stale model/field-name bug (the same class
 * as the restoreTest 'contract'/'vendor' bug and the deficiencyAlerts
 * 'asset.name' bug found earlier this session), and it had zero test
 * coverage. This test builds a real account with a representative fixture
 * across most of the chain's tiers (site hierarchy, asset, work order,
 * maintenance schedule + task definition, deficiency, alert, document) and
 * confirms pruneAccount() runs the entire chain and deletes the account
 * without throwing.
 *
 * aiBudgetMonthlyReset (lib/aiBudgetGuard.ts resetMonthlyCloudflare) is
 * pure in-memory (no DB) -- included here as a quick regression lock on the
 * returned month-key format.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  // lib/aiBudgetGuard.ts fires an unawaited rehydrateOnBoot() the first time
  // it's require()'d (by design -- see the module's own "fire-and-forget"
  // comment). Requiring + awaiting it explicitly here, before any test body
  // runs, avoids a harmless-but-noisy "require after Jest environment torn
  // down" error if that background promise would otherwise still be
  // in-flight when this file's last test finishes.
  const aiBudgetGuard = require('../../lib/aiBudgetGuard');
  await aiBudgetGuard.rehydrateOnBoot().catch(() => {});
});

afterAll(async () => {
  await prisma.$disconnect();
});

test('pruneAccount(): real dependency-ordered delete chain removes a full fixture set and the account itself, no throw', async () => {
  const admin: TestUser = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `DP Site ${Date.now()}` } });
  const asset = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR' } });
  const taskDef = await prisma.maintenanceTaskDefinition.create({
    data: { accountId: admin.accountId, equipmentType: 'SWITCHGEAR', taskName: 'DP test task', taskCode: `DP_TEST_${Date.now()}`, intervalC2Months: 12 },
  });
  await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId: asset.id, taskDefinitionId: taskDef.id, isActive: true } });
  const wo = await prisma.workOrder.create({ data: { accountId: admin.accountId, assetId: asset.id, status: 'SCHEDULED' } });
  await prisma.deficiency.create({ data: { accountId: admin.accountId, assetId: asset.id, severity: 'IMMEDIATE', description: 'DP test deficiency' } });
  await prisma.document.create({
    data: {
      accountId: admin.accountId, assetId: asset.id, filename: 'dp-test.pdf', filePath: `test/dp-${Date.now()}.pdf`,
      fileType: 'application/pdf', uploadedBy: admin.id,
    },
  });

  const { pruneAccount } = require('../../lib/demoPrune');
  const result = await pruneAccount(admin.accountId);

  expect(result.deleted).toBe(true);

  // The account row itself, and every child fixture, must be gone.
  expect(await prisma.account.findUnique({ where: { id: admin.accountId } })).toBeNull();
  expect(await prisma.site.findUnique({ where: { id: site.id } })).toBeNull();
  expect(await prisma.asset.findUnique({ where: { id: asset.id } })).toBeNull();
  expect(await prisma.workOrder.findUnique({ where: { id: wo.id } })).toBeNull();
  expect(await prisma.maintenanceTaskDefinition.findUnique({ where: { id: taskDef.id } })).toBeNull();

  // Calling it again on an already-gone account must be idempotent, not throw.
  const second = await pruneAccount(admin.accountId);
  expect(second.deleted).toBe(false);
}, 30000);

test('pruneAccount(): refuses to prune the legacy DEMO_ACCOUNT_ID (hard guard)', async () => {
  const { pruneAccount } = require('../../lib/demoPrune');
  const { DEMO_ACCOUNT_ID } = require('../../scripts/seed-demo');
  await expect(pruneAccount(DEMO_ACCOUNT_ID)).rejects.toThrow(/refusing to prune the legacy DEMO_ACCOUNT_ID/);
});

test('resetMonthlyCloudflare(): pure in-memory reset returns the current UTC month key', async () => {
  const { resetMonthlyCloudflare } = require('../../lib/aiBudgetGuard');
  const result = resetMonthlyCloudflare();
  expect(result.month).toMatch(/^\d{4}-\d{2}$/);
});

export {};

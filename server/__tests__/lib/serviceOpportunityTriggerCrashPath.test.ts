/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (Tier 2,
 * continuation of [[servicecycle-bughunt-restore-branch-2026-07-06]]).
 *
 * `serviceOpportunityTrigger` (02:30 UTC, index.ts) had zero test coverage
 * and, unlike every sibling alerting cron (qemwAlerts/deficiencyAlerts/
 * arcFlashIntegrity/standardRevisionCron), its logic lived INLINE in
 * index.ts's cron.schedule() callback rather than in an independently
 * testable lib module — the one structural outlier among the daily alert
 * crons. Extracted (2026-07-07, this commit) to
 * lib/serviceOpportunityTrigger.ts as a pure, behavior-preserving move so a
 * real-DB test can require() and call it directly, matching the pattern
 * every other alert cron in this session already uses.
 *
 * Exercises both trigger paths (IMMEDIATE deficiency open 30+ days; C3
 * conditionOverride schedule) plus the open-quote dedup guard, against
 * real fixture rows.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;
let admin: TestUser;
let siteId: string;
const cleanupAssetIds: string[] = [];
let taskDefId: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `SOT Site ${Date.now()}` } });
  siteId = site.id;
  const taskDef = await prisma.maintenanceTaskDefinition.create({
    data: {
      accountId: admin.accountId,
      equipmentType: 'SWITCHGEAR',
      taskName: 'SOT test task',
      taskCode: `SOT_TEST_${Date.now()}`,
      intervalC2Months: 12,
    },
  });
  taskDefId = taskDef.id;
});

afterAll(async () => {
  await prisma.quoteRequest.deleteMany({ where: { accountId: admin.accountId } });
  await prisma.maintenanceSchedule.deleteMany({ where: { accountId: admin.accountId } });
  await prisma.deficiency.deleteMany({ where: { accountId: admin.accountId } });
  await prisma.maintenanceTaskDefinition.deleteMany({ where: { id: taskDefId } });
  for (const id of cleanupAssetIds) {
    try { await prisma.asset.delete({ where: { id } }); } catch {}
  }
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

test('runServiceOpportunityTrigger(): creates quotes for an escalated IMMEDIATE deficiency and a C3 schedule, skips an asset that already has an open quote', async () => {
  const { runServiceOpportunityTrigger } = require('../../lib/serviceOpportunityTrigger');

  const ago40 = new Date(Date.now() - 40 * 86_400_000);

  // Asset A: qualifies via an escalated IMMEDIATE deficiency (open 40 days).
  const assetA = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  cleanupAssetIds.push(assetA.id);
  await prisma.deficiency.create({
    data: {
      accountId: admin.accountId, assetId: assetA.id,
      severity: 'IMMEDIATE', description: 'Test escalated deficiency',
      createdAt: ago40,
    },
  });

  // Asset B: qualifies via an active C3 conditionOverride schedule.
  const assetB = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  cleanupAssetIds.push(assetB.id);
  await prisma.maintenanceSchedule.create({
    data: {
      accountId: admin.accountId, assetId: assetB.id, taskDefinitionId: taskDefId,
      conditionOverride: 'C3', isActive: true,
    },
  });

  // Asset C: has BOTH an escalated deficiency AND an already-open quote —
  // must be skipped (dedup), not double-quoted.
  const assetC = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  cleanupAssetIds.push(assetC.id);
  await prisma.deficiency.create({
    data: {
      accountId: admin.accountId, assetId: assetC.id,
      severity: 'IMMEDIATE', description: 'Already has an open quote',
      createdAt: ago40,
    },
  });
  await prisma.quoteRequest.create({
    data: {
      accountId: admin.accountId, assetId: assetC.id, requestedById: admin.id,
      driver: 'planned_replacement', timeline: 'next_budget_cycle', status: 'requested',
    },
  });

  const result = await runServiceOpportunityTrigger();

  expect(result.created).toBeGreaterThanOrEqual(2); // A + B
  expect(result.skipped).toBeGreaterThanOrEqual(1);  // C

  const quotes = await prisma.quoteRequest.findMany({
    where: { accountId: admin.accountId, assetId: { in: [assetA.id, assetB.id, assetC.id] } },
  });
  const quoteByAsset = new Map(quotes.map((q: any) => [q.assetId, q]));

  expect((quoteByAsset.get(assetA.id) as any)?.driver).toBe('suspected_failing');
  expect((quoteByAsset.get(assetB.id) as any)?.driver).toBe('failed_inspection');
  // Asset C should still only have exactly the ONE pre-existing quote — no
  // second row created by this run.
  const assetCQuotes = quotes.filter((q: any) => q.assetId === assetC.id);
  expect(assetCQuotes.length).toBe(1);
  expect(assetCQuotes[0].driver).toBe('planned_replacement');
}, 30000);

export {};

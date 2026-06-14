/**
 * Compliance scoping reconcile: out-of-service assets are excluded from the
 * per-standard summary (matching buildComplianceGap), so an out-of-service
 * asset's overdue schedule no longer drags the rate down in one report builder
 * but not another.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildStandardsSummary } = require('../../lib/complianceReport');

let prisma: any;
let mgr: TestUser;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  mgr = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: mgr.accountId, name: `Sc ${Date.now()}` } });
  const td = await prisma.maintenanceTaskDefinition.create({
    data: { accountId: mgr.accountId, equipmentType: 'SWITCHGEAR', taskName: 'Visual', taskCode: `SC_${Date.now()}`, intervalC2Months: 12 },
  });
  const inSvc = await prisma.asset.create({ data: { accountId: mgr.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: `IN-${Date.now()}`, inService: true } });
  const outSvc = await prisma.asset.create({ data: { accountId: mgr.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: `OUT-${Date.now()}`, inService: false } });
  // in-service: current (due in future, baselined)
  await prisma.maintenanceSchedule.create({ data: { accountId: mgr.accountId, assetId: inSvc.id, taskDefinitionId: td.id, isActive: true, lastCompletedDate: new Date(Date.now() - 30 * DAY), nextDueDate: new Date(Date.now() + 300 * DAY) } });
  // out-of-service: overdue (would drag the rate down if counted)
  await prisma.maintenanceSchedule.create({ data: { accountId: mgr.accountId, assetId: outSvc.id, taskDefinitionId: td.id, isActive: true, lastCompletedDate: new Date(Date.now() - 400 * DAY), nextDueDate: new Date(Date.now() - 30 * DAY) } });
});

afterAll(async () => {
  const acc = mgr.accountId;
  try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: mgr.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('per-standard summary excludes out-of-service assets', () => {
  test('only the in-service current schedule counts; the out-of-service overdue one is excluded', async () => {
    const out = await buildStandardsSummary(prisma, mgr.accountId);
    expect(out.length).toBe(1); // single account-defined bucket
    expect(out[0].assetCount).toBe(1);
    expect(out[0].currentCount).toBe(1);
    expect(out[0].overdueCount).toBe(0);
  });
});

export {};
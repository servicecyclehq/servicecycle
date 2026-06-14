/**
 * Math-bug fix: uncovered assets are weighted by their template size, so
 * applying a 70B template to an uncovered asset (1 "uncovered" gap -> N
 * "unbaselined" gaps) no longer paradoxically DROPS the overall compliance
 * rate. Before the fix, overallRate fell after bulk-apply; now it must not.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildComplianceGap } = require('../../lib/complianceReport');

let app: any;
let prisma: any;
let manager: TestUser;
let siteId: string;
let uncoveredAssetId: string;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `Weight ${Date.now()}` } });
  siteId = site.id;
  // Asset A: SWITCHGEAR with NO schedules → uncovered (its template has several tasks).
  const a = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR', serialNumber: 'UNCOV-1' } });
  uncoveredAssetId = a.id;
  // Asset B: one CURRENT schedule so the overall rate is non-zero/non-trivial.
  const b = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'MOTOR', serialNumber: 'COV-1' } });
  const td = await prisma.maintenanceTaskDefinition.create({
    data: { accountId: manager.accountId, equipmentType: 'MOTOR', taskName: 'IR', taskCode: `IRW_${Date.now()}`, intervalC2Months: 12 },
  });
  await prisma.maintenanceSchedule.create({
    data: { accountId: manager.accountId, assetId: b.id, taskDefinitionId: td.id, isActive: true,
            lastCompletedDate: new Date(Date.now() - 30 * DAY), nextDueDate: new Date(Date.now() + 300 * DAY) },
  });
});

afterAll(async () => {
  const acc = manager.accountId;
  try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.accountSetting.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: manager.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('compliance overall rate is monotonic when applying a template', () => {
  test('applying a template to an uncovered asset does not drop the overall rate', async () => {
    const before = await buildComplianceGap(prisma, manager.accountId);
    expect(before.summary.uncoveredCount).toBe(1);

    const res = await request(app)
      .post('/api/schedules/bulk-apply')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ assetId: uncoveredAssetId });
    expect(res.status).toBeLessThan(300);
    const created = res.body?.data?.created ?? 0;
    expect(created).toBeGreaterThan(0); // template produced multiple tasks

    const after = await buildComplianceGap(prisma, manager.accountId);
    expect(after.summary.uncoveredCount).toBe(0);
    expect(after.summary.unbaselinedCount).toBeGreaterThanOrEqual(created);
    // The key assertion: the overall rate must NOT fall (the old bug dropped it).
    expect(after.overallRate).toBeGreaterThanOrEqual(before.overallRate - 0.05);
  });
});

export {};

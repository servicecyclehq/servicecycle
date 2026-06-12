/**
 * NFPA 70B §9.3.1 — auto-Condition-3 on two missed cycles. Covers the pure
 * detector (missedCyclesFor) and the full policy pass: flag set + governing
 * tightened + schedule interval cascaded, then cleared once maintenance catches
 * up (without clobbering the human condition axes).
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { missedCyclesFor, applyMissedCyclePolicy } = require('../../lib/missedCyclePolicy');

let prisma: any;
let manager: TestUser;
let siteId: string;
let assetId: string;
let taskDefId: string;
let scheduleId: string;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `MissedCyc ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({
    data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR' }, // all axes default C2
  });
  assetId = asset.id;
  const td = await prisma.maintenanceTaskDefinition.create({
    data: { accountId: manager.accountId, equipmentType: 'SWITCHGEAR', taskName: 'IR scan', taskCode: `IR_${Date.now()}`, intervalC2Months: 12, intervalC3Months: 3 },
  });
  taskDefId = td.id;
  const sched = await prisma.maintenanceSchedule.create({
    data: {
      accountId: manager.accountId, assetId, taskDefinitionId: taskDefId, isActive: true,
      lastCompletedDate: new Date(Date.now() - 800 * DAY), // ~26 months → 2 missed 12-mo cycles
      nextDueDate: new Date(Date.now() - 430 * DAY),
    },
  });
  scheduleId = sched.id;
});

afterAll(async () => {
  const acc = manager.accountId;
  try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: manager.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('missedCyclesFor (pure)', () => {
  const td = { intervalC2Months: 12 };
  test('two full cycles missed → 2', () => {
    expect(missedCyclesFor({ lastCompletedDate: new Date(Date.now() - 800 * DAY) }, td)).toBeGreaterThanOrEqual(2);
  });
  test('one cycle missed → 1', () => {
    expect(missedCyclesFor({ lastCompletedDate: new Date(Date.now() - 400 * DAY) }, td)).toBe(1);
  });
  test('within cycle → 0', () => {
    expect(missedCyclesFor({ lastCompletedDate: new Date(Date.now() - 120 * DAY) }, td)).toBe(0);
  });
  test('never completed → 0 (unbaselined, not missed)', () => {
    expect(missedCyclesFor({ lastCompletedDate: null }, td)).toBe(0);
  });
});

describe('applyMissedCyclePolicy', () => {
  test('sets auto-C3, tightens governing + schedule interval', async () => {
    const r = await applyMissedCyclePolicy(prisma, manager.accountId);
    expect(r.c3Set).toBe(1);

    const a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a.autoConditionC3).toBe(true);
    expect(a.governingCondition).toBe('C3');
    // Human axes untouched.
    expect(a.conditionPhysical).toBe('C2');

    // Schedule nextDueDate recomputed to the C3 (3-month) interval off last completion.
    const sch = await prisma.maintenanceSchedule.findUnique({ where: { id: scheduleId } });
    const expected = new Date(sch.lastCompletedDate); expected.setMonth(expected.getMonth() + 3);
    expect(Math.abs(new Date(sch.nextDueDate).getTime() - expected.getTime())).toBeLessThan(3 * DAY);
  });

  test('is idempotent — a second run makes no further changes', async () => {
    const r = await applyMissedCyclePolicy(prisma, manager.accountId);
    expect(r.c3Set).toBe(0);
    expect(r.c3Cleared).toBe(0);
  });

  test('clears auto-C3 once maintenance catches up', async () => {
    await prisma.maintenanceSchedule.update({ where: { id: scheduleId }, data: { lastCompletedDate: new Date() } });
    const r = await applyMissedCyclePolicy(prisma, manager.accountId);
    expect(r.c3Cleared).toBe(1);
    const a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a.autoConditionC3).toBe(false);
    expect(a.governingCondition).toBe('C2'); // back to worst of the (all-C2) human axes
  });
});

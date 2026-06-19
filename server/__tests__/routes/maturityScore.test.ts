/**
 * B1 — NFPA 70B program-maturity score. Verifies the maturity headline is the
 * same number as Path-to-100 (overallRate), the gap decomposes EXACTLY into the
 * four 70B dimensions (sum of pointsLost === 100 - score), the level mapping is
 * correct, and the customer-facing /api/compliance/maturity route returns it.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildComplianceGap } = require('../../lib/complianceReport');
const { buildMaturityScore, summarizeMaturity, levelForScore } = require('../../lib/maturityScore');

let app: any;
let prisma: any;
let manager: TestUser;
let siteId: string;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `Mat ${Date.now()}` } });
  siteId = site.id;

  // Uncovered asset (no schedules) → coverage gap.
  await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR', serialNumber: 'MAT-UNCOV' } });

  // Covered asset with a current + an overdue + an unbaselined schedule.
  const b = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'MOTOR', serialNumber: 'MAT-COV' } });
  const mk = async (suffix: string) => prisma.maintenanceTaskDefinition.create({
    data: { accountId: manager.accountId, equipmentType: 'MOTOR', taskName: `T-${suffix}`, taskCode: `MAT_${suffix}_${Date.now()}`, intervalC2Months: 12 },
  });
  const tdCur = await mk('cur');
  const tdOvr = await mk('ovr');
  const tdUnb = await mk('unb');
  await prisma.maintenanceSchedule.create({ data: { accountId: manager.accountId, assetId: b.id, taskDefinitionId: tdCur.id, isActive: true, lastCompletedDate: new Date(Date.now() - 30 * DAY), nextDueDate: new Date(Date.now() + 300 * DAY) } });
  await prisma.maintenanceSchedule.create({ data: { accountId: manager.accountId, assetId: b.id, taskDefinitionId: tdOvr.id, isActive: true, lastCompletedDate: new Date(Date.now() - 400 * DAY), nextDueDate: new Date(Date.now() - 30 * DAY) } });
  await prisma.maintenanceSchedule.create({ data: { accountId: manager.accountId, assetId: b.id, taskDefinitionId: tdUnb.id, isActive: true, nextDueDate: null } });
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

describe('B1 maturity score', () => {
  test('score equals path-to-100 overallRate and gap decomposes exactly', async () => {
    const gap = await buildComplianceGap(prisma, manager.accountId, { limit: Number.MAX_SAFE_INTEGER });
    const m = await buildMaturityScore(prisma, manager.accountId, {});

    expect(m.score).toBeCloseTo(gap.overallRate, 1);

    // Four named dimensions, in order.
    expect(m.dimensions.map((d: any) => d.key)).toEqual(['coverage', 'timeliness', 'baselining', 'program_docs']);

    // Sum of points lost across dimensions == the gap to 100 (within rounding).
    const totalLost = m.dimensions.reduce((acc: number, d: any) => acc + d.pointsLost, 0);
    expect(totalLost).toBeCloseTo(100 - m.score, 0);

    // We seeded an overdue, an unbaselined, and an uncovered asset → each costs points.
    const byKey = Object.fromEntries(m.dimensions.map((d: any) => [d.key, d]));
    expect(byKey.coverage.pointsLost).toBeGreaterThan(0);
    expect(byKey.timeliness.pointsLost).toBeGreaterThan(0);
    expect(byKey.baselining.pointsLost).toBeGreaterThan(0);
    expect(byKey.coverage.count).toBe(1);
    expect(byKey.timeliness.count).toBe(1);
    expect(byKey.baselining.count).toBe(1);

    // Biggest lever is one of the gapped dimensions.
    expect(m.biggestLever).toBeTruthy();
    expect(['coverage', 'timeliness', 'baselining', 'program_docs']).toContain(m.biggestLever.key);
  });

  test('level mapping matches the score band', async () => {
    const m = await buildMaturityScore(prisma, manager.accountId, {});
    const lvl = levelForScore(m.score);
    expect(m.level).toBe(lvl.level);
    expect(m.levelLabel).toBe(lvl.label);
    if (m.nextLevel) {
      expect(m.nextLevel.level).toBe(m.level + 1);
      expect(m.nextLevel.pointsToNext).toBeGreaterThanOrEqual(0);
    }
  });

  test('summarizeMaturity over a prebuilt gap agrees with buildMaturityScore', async () => {
    const gap = await buildComplianceGap(prisma, manager.accountId, { limit: Number.MAX_SAFE_INTEGER });
    const s = summarizeMaturity(gap, {});
    const m = await buildMaturityScore(prisma, manager.accountId, {});
    expect(s.score).toBe(m.score);
    expect(s.level).toBe(m.level);
  });

  test('GET /api/compliance/maturity returns the payload to an authenticated user', async () => {
    const res = await request(app).get('/api/compliance/maturity').set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(typeof d.score).toBe('number');
    expect(d.level).toBeGreaterThanOrEqual(1);
    expect(d.level).toBeLessThanOrEqual(5);
    expect(Array.isArray(d.dimensions)).toBe(true);
    expect(typeof d.disclaimer).toBe('string');
  });

  test('site-scoped maturity excludes the account-level EMP dimension subscore', async () => {
    const res = await request(app).get(`/api/compliance/maturity?siteId=${siteId}`).set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const empDim = res.body.data.dimensions.find((d: any) => d.key === 'program_docs');
    expect(empDim.subScore).toBeNull();
    expect(empDim.count).toBe(0);
  });
});

export {};

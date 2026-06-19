/**
 * B2 — contractor-only portfolio rank + talking points. Verifies the ranking
 * library (percentiles, composite rank, discussion points), the oem_admin-only
 * /api/fleet/portfolio-rank route scoped to the partner org, the HARD WALL
 * (non-oem roles are 403 — never customer-facing), and per-account talking
 * points used to enrich the quote-request event.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildPortfolioRank, buildAccountTalkingPoints } = require('../../lib/portfolioRank');

let app: any;
let prisma: any;
let oem: TestUser;
let strong: TestUser;   // healthy account
let weak: TestUser;     // overdue + uncovered account
let outsider: TestUser; // different/no partner org — must not appear
let partnerOrgId: string;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  oem = await createTestUser('oem_admin');
  strong = await createTestUser('manager');
  weak = await createTestUser('manager');
  outsider = await createTestUser('manager');

  const org = await prisma.partnerOrganization.create({ data: { name: `Book ${Date.now()}` } });
  partnerOrgId = org.id;
  for (const u of [oem, strong, weak]) {
    await prisma.account.update({ where: { id: u.accountId }, data: { partnerOrgId } });
  }

  // STRONG account: a current schedule, a completed WO, no overdue/uncovered.
  const sSite = await prisma.site.create({ data: { accountId: strong.accountId, name: 'Strong' } });
  const sAsset = await prisma.asset.create({ data: { accountId: strong.accountId, siteId: sSite.id, equipmentType: 'MOTOR', serialNumber: 'S1', conditionScore: 1 } });
  const sTd = await prisma.maintenanceTaskDefinition.create({ data: { accountId: strong.accountId, equipmentType: 'MOTOR', taskName: 'IR', taskCode: `S_${Date.now()}`, intervalC2Months: 12 } });
  await prisma.maintenanceSchedule.create({ data: { accountId: strong.accountId, assetId: sAsset.id, taskDefinitionId: sTd.id, isActive: true, lastCompletedDate: new Date(Date.now() - 30 * DAY), nextDueDate: new Date(Date.now() + 300 * DAY) } });
  await prisma.workOrder.create({ data: { accountId: strong.accountId, assetId: sAsset.id, status: 'COMPLETE', completedDate: new Date(Date.now() - 20 * DAY) } });

  // WEAK account: an overdue schedule, an uncovered asset, an open immediate deficiency, poor condition.
  const wSite = await prisma.site.create({ data: { accountId: weak.accountId, name: 'Weak' } });
  const wAsset = await prisma.asset.create({ data: { accountId: weak.accountId, siteId: wSite.id, equipmentType: 'MOTOR', serialNumber: 'W1', conditionScore: 5, governingCondition: 'C3' } });
  await prisma.asset.create({ data: { accountId: weak.accountId, siteId: wSite.id, equipmentType: 'SWITCHGEAR', serialNumber: 'W2' } }); // uncovered
  const wTd = await prisma.maintenanceTaskDefinition.create({ data: { accountId: weak.accountId, equipmentType: 'MOTOR', taskName: 'IR', taskCode: `W_${Date.now()}`, intervalC2Months: 12 } });
  await prisma.maintenanceSchedule.create({ data: { accountId: weak.accountId, assetId: wAsset.id, taskDefinitionId: wTd.id, isActive: true, lastCompletedDate: new Date(Date.now() - 400 * DAY), nextDueDate: new Date(Date.now() - 30 * DAY) } });
  await prisma.deficiency.create({ data: { accountId: weak.accountId, assetId: wAsset.id, severity: 'IMMEDIATE', description: 'open immediate' } });
  await prisma.workOrder.create({ data: { accountId: weak.accountId, assetId: wAsset.id, status: 'SCHEDULED', scheduledDate: new Date() } });
});

afterAll(async () => {
  for (const u of [oem, strong, weak, outsider]) {
    const acc = u.accountId;
    try { await prisma.account.update({ where: { id: acc }, data: { partnerOrgId: null } }); } catch {}
    try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  try { await prisma.partnerOrganization.delete({ where: { id: partnerOrgId } }); } catch {}
  await prisma.$disconnect();
});

describe('B2 portfolio rank library', () => {
  test('ranks the strong account above the weak one with talking points', async () => {
    const rows = await buildPortfolioRank(prisma, [strong.accountId, weak.accountId], {});
    expect(rows.length).toBe(2);
    const sRow = rows.find((r: any) => r.accountId === strong.accountId);
    const wRow = rows.find((r: any) => r.accountId === weak.accountId);
    // Strong account ranks better (lower rank number, higher percentile).
    expect(sRow.rank).toBeLessThan(wRow.rank);
    expect(sRow.portfolioPercentile).toBeGreaterThanOrEqual(wRow.portfolioPercentile);
    // Weak account surfaces lead-severity discussion points (overdue / maturity).
    const weakLeads = wRow.discussionPoints.filter((p: any) => p.severity === 'lead');
    expect(weakLeads.length).toBeGreaterThanOrEqual(1);
    // Every row carries a rank-of and at least one discussion point.
    for (const r of rows) {
      expect(r.rankOf).toBe(2);
      expect(r.discussionPoints.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('buildAccountTalkingPoints resolves the account within its own book', async () => {
    const tp = await buildAccountTalkingPoints(prisma, weak.accountId);
    expect(tp).toBeTruthy();
    expect(tp.accountId).toBe(weak.accountId);
    expect(tp.rankOf).toBeGreaterThanOrEqual(2); // book has at least strong+weak (+oem)
    expect(Array.isArray(tp.discussionPoints)).toBe(true);
  });
});

describe('B2 portfolio-rank route (HARD WALL: oem_admin only)', () => {
  test('oem_admin gets the ranked book scoped to its partner org', async () => {
    const res = await request(app).get('/api/fleet/portfolio-rank').set('Authorization', `Bearer ${oem.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.accounts.map((a: any) => a.accountId);
    expect(ids).toEqual(expect.arrayContaining([strong.accountId, weak.accountId]));
    // The outsider (no partner org) must never appear.
    expect(ids).not.toContain(outsider.accountId);
    // Ranked rows carry percentiles + discussion points.
    const w = res.body.accounts.find((a: any) => a.accountId === weak.accountId);
    expect(w.percentiles).toBeTruthy();
    expect(w.discussionPoints.length).toBeGreaterThanOrEqual(1);
  });

  test('a customer-role (manager) user is forbidden — never customer-facing', async () => {
    const res = await request(app).get('/api/fleet/portfolio-rank').set('Authorization', `Bearer ${weak.token}`);
    expect(res.status).toBe(403);
  });
});

export {};

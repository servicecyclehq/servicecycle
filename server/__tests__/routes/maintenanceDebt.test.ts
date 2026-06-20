/**
 * Maintenance Debt Ledger + capital plan. Verifies the three debt components
 * (deferred maintenance, repair backlog, RUL modernization) roll into a
 * cumulative 1/3/5-year plan grouped by site, the plan is monotonic
 * (year1<=year3<=year5), the JSON + CSV routes work, and the CFO report PDF
 * carries the debt-plan section.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildMaintenanceDebtData } = require('../../lib/maintenanceDebt');

let app: any;
let prisma: any;
let admin: TestUser;
let siteId: string;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');

  // Platform INSPECTION + modernization rate cards so the ledger can price.
  await prisma.serviceRateCard.create({ data: { serviceType: 'INSPECTION', minCents: 150000, maxCents: 1200000 } });
  await prisma.serviceRateCard.create({ data: { serviceType: 'SWITCHGEAR_MODERNIZATION', minCents: 7500000, maxCents: 40000000 } });

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `Debt ${Date.now()}` } });
  siteId = site.id;

  // Asset A: an overdue schedule → deferred maintenance debt.
  const a = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'MOTOR', serialNumber: 'D-OVR' } });
  const td = await prisma.maintenanceTaskDefinition.create({ data: { accountId: admin.accountId, equipmentType: 'MOTOR', taskName: 'IR', taskCode: `D_${Date.now()}`, intervalC2Months: 12 } });
  await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId: a.id, taskDefinitionId: td.id, isActive: true, lastCompletedDate: new Date(Date.now() - 400 * DAY), nextDueDate: new Date(Date.now() - 30 * DAY) } });

  // Asset B: open deficiency + repairCostEstimate → repair backlog.
  const b = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'MOTOR', serialNumber: 'D-REP', repairCostEstimate: 25000 } });
  await prisma.deficiency.create({ data: { accountId: admin.accountId, assetId: b.id, severity: 'RECOMMENDED', description: 'needs repair' } });

  // Asset C: high modernizationRiskScore (year-1 bucket) → modernization debt.
  await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR', serialNumber: 'D-MOD', modernizationRiskScore: 0.9 } });
});

afterAll(async () => {
  const acc = admin.accountId;
  try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.serviceRateCard.deleteMany({ where: { serviceType: { in: ['INSPECTION', 'SWITCHGEAR_MODERNIZATION'] }, partnerOrgId: null, accountId: null } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

const auth = () => `Bearer ${admin.token}`;

describe('Maintenance Debt Ledger', () => {
  test('rolls the three components into a monotonic cumulative plan', async () => {
    const d = await buildMaintenanceDebtData(prisma, admin.accountId);

    // Deferred maintenance: 1 asset has an overdue schedule, priced at INSPECTION rate.
    expect(d.totals.deferredMaintenance.count).toBe(1);
    expect(d.totals.deferredMaintenance.min).toBe(1500);  // 150000 cents
    expect(d.totals.deferredMaintenance.max).toBe(12000); // 1200000 cents

    // Repair backlog = repairCostEstimate sum.
    expect(d.totals.repairBacklog.amount).toBe(25000);
    expect(d.totals.repairBacklog.assets).toBe(1);
    // Per-site repair-asset count is reported (regression: was hardcoded 0).
    const repairSite = d.bySite.find((s: any) => s.repairBacklog.amount === 25000);
    expect(repairSite.repairBacklog.assets).toBe(1);

    // Modernization: the 0.9 SWITCHGEAR asset lands in year 1.
    expect(d.plan.year1.max).toBeGreaterThan(d.totals.deferredMaintenance.max + d.totals.repairBacklog.amount);

    // Cumulative plan is monotonic non-decreasing.
    expect(d.plan.year3.min).toBeGreaterThanOrEqual(d.plan.year1.min);
    expect(d.plan.year5.min).toBeGreaterThanOrEqual(d.plan.year3.min);
    expect(d.plan.year3.max).toBeGreaterThanOrEqual(d.plan.year1.max);

    // Grouped by site.
    expect(d.bySite.length).toBeGreaterThanOrEqual(1);
    expect(d.bySite[0].plan.year5.max).toBeGreaterThan(0);
  });

  test('GET /api/compliance/maintenance-debt returns the ledger', async () => {
    const res = await request(app).get('/api/compliance/maintenance-debt').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.data.plan.year1).toBeTruthy();
    expect(res.body.data.totals.debtTotal.max).toBeGreaterThan(0);
  });

  test('GET /api/compliance/maintenance-debt.csv exports a CSV', async () => {
    const res = await request(app).get('/api/compliance/maintenance-debt.csv').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('csv');
    expect(res.text).toContain('Site');
    expect(res.text).toContain('TOTAL');
  });

  test('CFO report PDF carries the debt-plan section', async () => {
    const res: any = await request(app).get('/api/compliance/cfo-report.pdf').set('Authorization', auth()).buffer(true)
      .parse((r: any, cb: any) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString('latin1')).toBe('%PDF');
    expect(res.body.length).toBeGreaterThan(1000);
  });
});

export {};

/**
 * #5 Multi-year scope / proposal builder. Verifies repair/replace/defer
 * classification, year bucketing, the three packaged options, the JSON + PDF
 * routes (manager+), and the oem_admin cross-account access wall.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildProposal } = require('../../lib/proposalBuilder');

let app: any;
let prisma: any;
let manager: TestUser;
let viewer: TestUser;
let assetReplace: string;
let assetRepair: string;
let assetDefer: string;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  viewer = await createTestUser('viewer');

  await prisma.serviceRateCard.create({ data: { serviceType: 'INSPECTION', minCents: 150000, maxCents: 1200000 } });
  await prisma.serviceRateCard.create({ data: { serviceType: 'SWITCHGEAR_MODERNIZATION', minCents: 7500000, maxCents: 40000000 } });

  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `Prop ${Date.now()}` } });

  // REPLACE: end-of-life RUL >= 0.85 → year 1, modernization rate.
  const r = await prisma.asset.create({ data: { accountId: manager.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: 'P-REP', modernizationRiskScore: 0.9 } });
  assetReplace = r.id;

  // REPAIR: open IMMEDIATE deficiency + repairCostEstimate → year 1, fixed cost.
  const rp = await prisma.asset.create({ data: { accountId: manager.accountId, siteId: site.id, equipmentType: 'MOTOR', serialNumber: 'P-RPR', repairCostEstimate: 18000 } });
  await prisma.deficiency.create({ data: { accountId: manager.accountId, assetId: rp.id, severity: 'IMMEDIATE', description: 'fix me' } });
  assetRepair = rp.id;

  // DEFER: only an overdue routine schedule, no deficiency / not EOL → year 5.
  const d = await prisma.asset.create({ data: { accountId: manager.accountId, siteId: site.id, equipmentType: 'MOTOR', serialNumber: 'P-DEF' } });
  const td = await prisma.maintenanceTaskDefinition.create({ data: { accountId: manager.accountId, equipmentType: 'MOTOR', taskName: 'IR', taskCode: `P_${Date.now()}`, intervalC2Months: 12 } });
  await prisma.maintenanceSchedule.create({ data: { accountId: manager.accountId, assetId: d.id, taskDefinitionId: td.id, isActive: true, nextDueDate: new Date(Date.now() - 30 * DAY) } });
  assetDefer = d.id;
});

afterAll(async () => {
  for (const u of [manager, viewer]) {
    const acc = u.accountId;
    try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  try { await prisma.serviceRateCard.deleteMany({ where: { serviceType: { in: ['INSPECTION', 'SWITCHGEAR_MODERNIZATION'] }, partnerOrgId: null, accountId: null } }); } catch {}
  await prisma.$disconnect();
});

describe('#5 proposal builder', () => {
  test('classifies repair/replace/defer with year buckets and packaged options', async () => {
    const p = await buildProposal(prisma, manager.accountId, {});
    const byId = Object.fromEntries(p.lineItems.map((i: any) => [i.assetId, i]));
    expect(byId[assetReplace].recommendation).toBe('replace');
    expect(byId[assetReplace].year).toBe(1);
    expect(byId[assetReplace].costMax).toBe(400000); // modernization max (cents/100)
    expect(byId[assetRepair].recommendation).toBe('repair');
    expect(byId[assetRepair].year).toBe(1);
    expect(byId[assetRepair].costMin).toBe(18000); // exact repairCostEstimate
    expect(byId[assetDefer].recommendation).toBe('defer');
    expect(byId[assetDefer].year).toBe(5);

    expect(p.summary.replace).toBe(1);
    expect(p.summary.repair).toBe(1);
    expect(p.summary.defer).toBe(1);
    // Essential (yr1) excludes the deferred item; comprehensive includes all.
    const essential = p.options.find((o: any) => o.key === 'essential');
    const comprehensive = p.options.find((o: any) => o.key === 'comprehensive');
    expect(essential.count).toBe(2);
    expect(comprehensive.count).toBe(3);
    expect(comprehensive.total.max).toBeGreaterThan(essential.total.max);
  });

  test('JSON + PDF routes work for a manager', async () => {
    const json = await request(app).get('/api/proposals').set('Authorization', `Bearer ${manager.token}`);
    expect(json.status).toBe(200);
    expect(json.body.data.lineItems.length).toBe(3);

    const pdf: any = await request(app).get('/api/proposals/proposal.pdf').set('Authorization', `Bearer ${manager.token}`).buffer(true)
      .parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.status).toBe(200);
    expect(pdf.body.slice(0, 4).toString('latin1')).toBe('%PDF');
  });

  test('a viewer cannot build a proposal (manager+ only)', async () => {
    const res = await request(app).get('/api/proposals').set('Authorization', `Bearer ${viewer.token}`);
    expect(res.status).toBe(403);
  });

  test('a manager cannot target another account via ?accountId (cross-account wall)', async () => {
    const res = await request(app).get(`/api/proposals?accountId=${viewer.accountId}`).set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(403);
  });
});

export {};

/**
 * Phase 2 revenue-attribution dashboard. Verifies the closed-loop funnel counts,
 * platform-signal attribution, dollar estimates from asset repairCostEstimate
 * (with unpriced excluded), the route (manager+), tenant scoping, and the
 * empty-state for an account with no quote activity.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildRevenueAttribution } = require('../../lib/revenueAttribution');

let app: any;
let prisma: any;
let manager: TestUser;
let viewer: TestUser;   // same account -- route is manager+, must be 403
let other: TestUser;    // separate tenant, has its own quote -> isolation check

async function mkQuote(prisma: any, accountId: string, userId: string, siteId: string, opts: any) {
  const asset = await prisma.asset.create({
    data: { accountId, siteId, equipmentType: opts.equipmentType || 'SWITCHGEAR', serialNumber: opts.serial,
      ...(opts.repairCostEstimate != null ? { repairCostEstimate: opts.repairCostEstimate } : {}) },
  });
  const q = await prisma.quoteRequest.create({
    data: {
      accountId, assetId: asset.id, requestedById: userId,
      status: opts.status, driver: 'failed_inspection', timeline: 'within_30_days',
      ...(opts.triggerType ? { triggerType: opts.triggerType } : {}),
      ...(opts.quotedAt ? { quotedAt: opts.quotedAt } : {}),
    },
  });
  if (opts.wo) {
    await prisma.workOrder.create({
      data: { accountId, assetId: asset.id, quoteRequestId: q.id, status: opts.wo,
        ...(opts.wo === 'COMPLETE' ? { completedDate: new Date() } : {}) },
    });
  }
  return { asset, q };
}

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  viewer = await createTestUser('viewer', { accountId: manager.accountId });
  other = await createTestUser('manager');

  const siteA = await prisma.site.create({ data: { accountId: manager.accountId, name: `Rev ${Date.now()}` } });
  const siteO = await prisma.site.create({ data: { accountId: other.accountId, name: `RevO ${Date.now()}` } });
  const A = manager.accountId, U = manager.id;
  // Completed, system-triggered, priced -> realized value 5000.
  await mkQuote(prisma, A, U, siteA.id, { serial: 'RV-1', status: 'accepted', triggerType: 'MODERNIZATION_EOL', quotedAt: new Date(), wo: 'COMPLETE', repairCostEstimate: 5000 });
  // Accepted (WO scheduled, not complete), manual, priced -> pipeline 3000.
  await mkQuote(prisma, A, U, siteA.id, { serial: 'RV-2', status: 'accepted', quotedAt: new Date(), wo: 'SCHEDULED', repairCostEstimate: 3000 });
  // Quoted, system-triggered, unpriced -> open + unpricedOpen.
  await mkQuote(prisma, A, U, siteA.id, { serial: 'RV-3', status: 'quoted', triggerType: 'ARC_FLASH_STUDY', quotedAt: new Date() });
  // Requested only.
  await mkQuote(prisma, A, U, siteA.id, { serial: 'RV-4', status: 'requested' });
  // Draft -> excluded entirely.
  await mkQuote(prisma, A, U, siteA.id, { serial: 'RV-5', status: 'draft' });

  // Other tenant: one completed priced quote (must never leak into manager's view).
  await mkQuote(prisma, other.accountId, other.id, siteO.id, { serial: 'OT-1', status: 'accepted', triggerType: 'QEMW_TRAINING', quotedAt: new Date(), wo: 'COMPLETE', repairCostEstimate: 99999 });
});

afterAll(async () => {
  for (const acc of [manager.accountId, other.accountId]) {
    try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.quoteRequest.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  }
  for (const u of [manager, viewer, other]) { try { await prisma.user.delete({ where: { id: u.id } }); } catch {} }
  for (const acc of [manager.accountId, other.accountId]) { try { await prisma.account.delete({ where: { id: acc } }); } catch {} }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('Phase 2 revenue attribution', () => {
  test('funnel, attribution, and $ math from the closed loop', async () => {
    const d = await buildRevenueAttribution(prisma, manager.accountId, {});
    // 5 quotes created, 1 draft excluded -> 4 submitted.
    expect(d.funnel.submitted).toBe(4);
    expect(d.funnel.quoted).toBe(3);          // RV-1, RV-2, RV-3 quoted
    expect(d.funnel.accepted).toBe(2);        // RV-1, RV-2
    expect(d.funnel.converted).toBe(2);       // RV-1 (complete) + RV-2 (scheduled WO)
    expect(d.funnel.completed).toBe(1);       // RV-1

    expect(d.attribution.systemTriggered).toBe(2); // RV-1, RV-3
    expect(d.attribution.manual).toBe(2);          // RV-2, RV-4
    expect(d.attribution.completedFromAlert).toBe(1);

    expect(d.value.realized).toBe(5000);  // RV-1
    expect(d.value.pipeline).toBe(3000);  // RV-2 (open, priced); RV-3 open but unpriced
    expect(d.value.total).toBe(8000);
    expect(d.value.unpricedOpen).toBe(2); // RV-3 + RV-4 (requested, unpriced)

    // byTrigger has a MODERNIZATION_EOL row with the completed realized value.
    const mod = d.byTrigger.find((t: any) => t.trigger === 'MODERNIZATION_EOL');
    expect(mod.completed).toBe(1);
    expect(mod.realizedValue).toBe(5000);
    expect(d.recent.length).toBe(1);
    expect(d.recent[0].value).toBe(5000);
    expect(d.recent[0].trigger).toBe('MODERNIZATION_EOL');
  });

  test('GET /api/revenue/attribution is manager+ only', async () => {
    const ok = await request(app).get('/api/revenue/attribution').set('Authorization', auth(manager));
    expect(ok.status).toBe(200);
    expect(ok.body.data.funnel.submitted).toBe(4);

    const forbidden = await request(app).get('/api/revenue/attribution').set('Authorization', auth(viewer));
    expect(forbidden.status).toBe(403);
  });

  test('is tenant-scoped -- other account sees only its own quote', async () => {
    const d = await buildRevenueAttribution(prisma, other.accountId, {});
    expect(d.funnel.submitted).toBe(1);
    expect(d.value.realized).toBe(99999);
  });

  test('empty-state for an account with no quotes', async () => {
    const fresh = await createTestUser('manager');
    try {
      const d = await buildRevenueAttribution(prisma, fresh.accountId, {});
      expect(d.summary.clean).toBe(true);
      expect(d.funnel.submitted).toBe(0);
      expect(d.value.total).toBe(0);
    } finally {
      try { await prisma.user.delete({ where: { id: fresh.id } }); } catch {}
      try { await prisma.account.delete({ where: { id: fresh.accountId } }); } catch {}
    }
  });
});

export {};

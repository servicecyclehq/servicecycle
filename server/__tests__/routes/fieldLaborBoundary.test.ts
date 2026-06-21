/**
 * Field-labor (field_tech / subcontractor) PERMISSION BOUNDARY.
 *
 * This is the crux of the field-labor role: prove that a sub
 *   (1) CANNOT see pricing — rate cards, quotes, proposals, revenue, compliance;
 *   (2) CANNOT see other customers' / the full customer list — the account-wide
 *       assets / sites / contractors / work-orders / users lists, and not even
 *       another account's asset card;
 *   (3) CAN see and act on ONLY their own assigned work, through /api/field;
 *   (4) does not regress any other role (a viewer is unaffected by the gate).
 *
 * The principal (manager) assigns work; the sub sees only what they're assigned.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;

let manager: TestUser;     // principal — sees all $
let sub: TestUser;         // field_tech — assigned-jobs-only
let viewer: TestUser;      // control — gate must not touch other roles
let otherAdmin: TestUser;  // a DIFFERENT customer/account

let siteId: string;
let assignedAssetId: string;    // asset on the sub's assigned WO
let unassignedAssetId: string;  // same account, NOT assigned to the sub
let otherAssetId: string;       // a different customer's asset
let assignedWoId: string;       // WO assigned to the sub
let unassignedWoId: string;     // WO in the account, not the sub's

beforeAll(async () => {
  app    = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;

  manager = await createTestUser('manager');
  sub     = await createTestUser('field_tech', { accountId: manager.accountId });
  viewer  = await createTestUser('viewer', { accountId: manager.accountId });
  otherAdmin = await createTestUser('admin'); // fresh, separate account

  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `FL Site ${Date.now()}` } });
  siteId = site.id;

  const a1 = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  const a2 = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'PANELBOARD' } });
  assignedAssetId = a1.id;
  unassignedAssetId = a2.id;

  const otherSite = await prisma.site.create({ data: { accountId: otherAdmin.accountId, name: `Other Site ${Date.now()}` } });
  const oa = await prisma.asset.create({ data: { accountId: otherAdmin.accountId, siteId: otherSite.id, equipmentType: 'GENERATOR' } });
  otherAssetId = oa.id;

  // One WO assigned to the sub, one not.
  const wo1 = await prisma.workOrder.create({
    data: { accountId: manager.accountId, assetId: assignedAssetId, status: 'IN_PROGRESS', assignedUserId: sub.id },
  });
  const wo2 = await prisma.workOrder.create({
    data: { accountId: manager.accountId, assetId: unassignedAssetId, status: 'SCHEDULED' },
  });
  assignedWoId = wo1.id;
  unassignedWoId = wo2.id;
});

afterAll(async () => {
  for (const acc of [manager.accountId, otherAdmin.accountId]) {
    try { await prisma.testMeasurement.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

const bearer = (u: TestUser) => ['Authorization', `Bearer ${u.token}`] as [string, string];

// ── (1) + (2) DEFAULT-DENY: a sub is 403'd off every pricing + customer-list route
describe('field_tech is default-denied off pricing and the full customer list', () => {
  const denied: Array<[string, string]> = [
    ['get',  '/api/rate-cards'],          // pricing — rate cards
    ['get',  '/api/quote-requests'],      // pricing — quotes (NOTE: this route has no role gate of its own)
    ['get',  '/api/proposals'],           // pricing — proposals
    ['get',  '/api/revenue/attribution'], // revenue $
    ['get',  '/api/compliance/summary'],  // compliance posture / debt
    ['get',  '/api/assets'],              // full customer asset list
    ['get',  '/api/sites'],               // full site list
    ['get',  '/api/contractors'],         // full contractor list
    ['get',  '/api/work-orders'],         // the whole work-order board
    ['get',  '/api/deficiencies'],        // account-wide findings
    ['get',  '/api/users'],               // user list
    ['get',  '/api/dashboard'],           // account dashboard
    ['get',  '/api/reports'],             // reports hub
  ];

  for (const [method, path] of denied) {
    test(`${method.toUpperCase()} ${path} → 403 field_role_scope`, async () => {
      const res = await (request(app) as any)[method](path).set(...bearer(sub));
      expect(res.status).toBe(403);
      expect(res.body?.error).toBe('field_role_scope');
    });
  }

  test('a sub cannot write to the global (manager) measurement route either', async () => {
    const res = await request(app)
      .post(`/api/work-orders/${assignedWoId}/measurements`)
      .set(...bearer(sub))
      .send({ measurementType: 'insulation_resistance', asFoundValue: 68 });
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('field_role_scope');
  });

  test('a sub cannot reach the assignment endpoint (it lives under /api/work-orders)', async () => {
    const res = await request(app)
      .put(`/api/work-orders/${assignedWoId}/assignment`)
      .set(...bearer(sub))
      .send({ userId: sub.id });
    expect(res.status).toBe(403);
  });
});

// ── (4) the gate is field_tech-specific — other roles are untouched
describe('the boundary does not regress other roles', () => {
  test('a viewer still reads the account asset list (200, not 403)', async () => {
    const res = await request(app).get('/api/assets').set(...bearer(viewer));
    expect(res.status).toBe(200);
  });
  test('a viewer still reaches the account-wide field summary', async () => {
    const res = await request(app).get('/api/field/summary').set(...bearer(viewer));
    expect(res.status).toBe(200);
  });
});

// ── session essentials remain reachable
describe('field_tech keeps session essentials', () => {
  test('GET /api/auth/me → 200', async () => {
    const res = await request(app).get('/api/auth/me').set(...bearer(sub));
    expect(res.status).toBe(200);
  });
});

// ── (3) the scoped surface: a sub sees ONLY their assigned work
describe('field_tech sees only assigned work through /api/field', () => {
  test('GET /api/field/assignments lists exactly the assigned WO', async () => {
    const res = await request(app).get('/api/field/assignments').set(...bearer(sub));
    expect(res.status).toBe(200);
    const ids = (res.body?.data?.assignments || []).map((a: any) => a.id);
    expect(ids).toContain(assignedWoId);
    expect(ids).not.toContain(unassignedWoId);
  });

  test('GET /api/field/summary returns only the assigned WO, no pricing fields', async () => {
    const res = await request(app).get('/api/field/summary').set(...bearer(sub));
    expect(res.status).toBe(200);
    const woIds = (res.body?.data?.openWorkOrders || []).map((w: any) => w.asset?.id);
    // The sub's summary asset set is clamped to their assignment.
    expect(woIds).toContain(assignedAssetId);
    expect(woIds).not.toContain(unassignedAssetId);
    // No pricing anywhere in the payload.
    const blob = JSON.stringify(res.body);
    expect(blob).not.toMatch(/repairCostEstimate|rateCard|unitPrice|amount|price/i);
  });

  test('GET /api/field/asset/:id — assigned asset 200, unassigned 404, other customer 404', async () => {
    const ok = await request(app).get(`/api/field/asset/${assignedAssetId}`).set(...bearer(sub));
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toMatch(/repairCostEstimate/i);

    const blocked = await request(app).get(`/api/field/asset/${unassignedAssetId}`).set(...bearer(sub));
    expect(blocked.status).toBe(404);

    const cross = await request(app).get(`/api/field/asset/${otherAssetId}`).set(...bearer(sub));
    expect(cross.status).toBe(404);
  });

  test('a sub records a measurement on the assigned WO, but not on an unassigned one', async () => {
    const ok = await request(app)
      .post(`/api/field/work-orders/${assignedWoId}/measurements`)
      .set(...bearer(sub))
      .send({ measurementType: 'insulation_resistance', asFoundValue: 68, asFoundUnit: 'MΩ', passFail: 'pass' });
    expect(ok.status).toBe(201);
    expect(ok.body?.data?.measurement?.passFail).toBe('GREEN'); // 'pass' → GREEN

    const blocked = await request(app)
      .post(`/api/field/work-orders/${unassignedWoId}/measurements`)
      .set(...bearer(sub))
      .send({ measurementType: 'insulation_resistance', asFoundValue: 68 });
    expect(blocked.status).toBe(404);
  });

  test('a sub reports a deficiency on the assigned asset, but not an unassigned one', async () => {
    const ok = await request(app)
      .post('/api/field/deficiencies')
      .set(...bearer(sub))
      .send({ assetId: assignedAssetId, severity: 'RECOMMENDED', description: 'Loose lug noted' });
    expect(ok.status).toBe(201);

    const blocked = await request(app)
      .post('/api/field/deficiencies')
      .set(...bearer(sub))
      .send({ assetId: unassignedAssetId, severity: 'RECOMMENDED', description: 'nope' });
    expect(blocked.status).toBe(404);
  });

  test('a sub completes their assigned work order', async () => {
    const res = await request(app)
      .post(`/api/field/work-orders/${assignedWoId}/complete`)
      .set(...bearer(sub))
      .send({ asLeftCondition: 'C2' });
    expect(res.status).toBe(200);
    expect(res.body?.data?.workOrder?.status).toBe('COMPLETE');
  });
});

// ── the principal assigns; cross-account assignment is refused
describe('the principal (manager) assigns work', () => {
  test('manager assigns the unassigned WO to the sub, then unassigns', async () => {
    const assign = await request(app)
      .put(`/api/work-orders/${unassignedWoId}/assignment`)
      .set(...bearer(manager))
      .send({ userId: sub.id });
    expect(assign.status).toBe(200);
    expect(assign.body?.data?.workOrder?.assignedUserId).toBe(sub.id);

    const unassign = await request(app)
      .put(`/api/work-orders/${unassignedWoId}/assignment`)
      .set(...bearer(manager))
      .send({ userId: null });
    expect(unassign.status).toBe(200);
    expect(unassign.body?.data?.workOrder?.assignedUserId).toBeNull();
  });

  test('manager cannot assign a WO to a user on a different account', async () => {
    const res = await request(app)
      .put(`/api/work-orders/${assignedWoId}/assignment`)
      .set(...bearer(manager))
      .send({ userId: otherAdmin.id });
    expect(res.status).toBe(404);
  });
});

export {};

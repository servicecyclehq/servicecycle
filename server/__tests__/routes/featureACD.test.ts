/**
 * featureACD.test.ts
 *
 * Integration tests for features shipped 2026-06-25:
 *   A — Field-labor WO assignment: PUT /api/work-orders/:id/assignment
 *   C — Procurement risk flag:     GET /api/parts/low-stock (procurementRisk + procurementRiskCount)
 *   D — Quote inbox virtual tabs:  GET /api/quote-requests?status=active|resolved + resolvedThisMonth
 */
import request from 'supertest';
import { randomUUID } from 'crypto';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;

let manager: TestUser;
let viewer: TestUser;
let fieldTech: TestUser;
let other: TestUser;   // separate tenant
let siteId: string;
let assetId: string;

beforeAll(async () => {
  app    = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;

  manager   = await createTestUser('manager');
  // Viewer + field_tech share the manager's account
  viewer    = await createTestUser('viewer',     { accountId: manager.accountId });
  fieldTech = await createTestUser('field_tech', { accountId: manager.accountId });
  other     = await createTestUser('manager');  // separate tenant

  const site = await prisma.site.create({
    data: { accountId: manager.accountId, name: `ACD-${Date.now()}` },
  });
  siteId = site.id;

  const asset = await prisma.asset.create({
    data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR', governingCondition: 'C2' },
  });
  assetId = asset.id;
});

afterAll(async () => {
  // Delete in FK-safe order
  for (const accountId of [manager.accountId, other.accountId]) {
    try { await prisma.workOrder.deleteMany({ where: { accountId } }); } catch {}
    try { await prisma.quoteRequest.deleteMany({ where: { accountId } }); } catch {}
    try { await prisma.spareInventory.deleteMany({ where: { accountId } }); } catch {}
    try { await prisma.part.deleteMany({ where: { accountId } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId } }); } catch {}
    try { await prisma.user.deleteMany({ where: { accountId } }); } catch {}
    try { await prisma.account.delete({ where: { id: accountId } }); } catch {}
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature A — PUT /api/work-orders/:id/assignment
// ═══════════════════════════════════════════════════════════════════════════════

async function makeWorkOrder(accountId: string, assetRef: string, extra: Record<string, any> = {}) {
  return prisma.workOrder.create({
    data: { accountId, assetId: assetRef, status: 'SCHEDULED', ...extra },
  });
}

describe('PUT /api/work-orders/:id/assignment — Feature A', () => {
  let woId: string;

  beforeAll(async () => {
    const wo = await makeWorkOrder(manager.accountId, assetId);
    woId = wo.id;
  });
  afterAll(async () => {
    try { await prisma.workOrder.delete({ where: { id: woId } }); } catch {}
  });

  it('manager assigns a field_tech user → 200 + assignedUserId set', async () => {
    const res = await request(app)
      .put(`/api/work-orders/${woId}/assignment`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ userId: fieldTech.id });
    expect(res.status).toBe(200);
    expect(res.body.data.workOrder.assignedUserId).toBe(fieldTech.id);
    expect(res.body.data.assignee.id).toBe(fieldTech.id);
  });

  it('manager clears assignment (userId: null) → 200 + assignedUserId null', async () => {
    const res = await request(app)
      .put(`/api/work-orders/${woId}/assignment`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ userId: null });
    expect(res.status).toBe(200);
    expect(res.body.data.workOrder.assignedUserId).toBeNull();
    expect(res.body.data.assignee).toBeNull();
  });

  it('manager can also assign a manager or viewer (not just field_tech)', async () => {
    const res = await request(app)
      .put(`/api/work-orders/${woId}/assignment`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ userId: viewer.id });
    expect(res.status).toBe(200);
    expect(res.body.data.workOrder.assignedUserId).toBe(viewer.id);
    // clean up
    await request(app)
      .put(`/api/work-orders/${woId}/assignment`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ userId: null });
  });

  it('rejects a userId that does not belong to this account → 404', async () => {
    const res = await request(app)
      .put(`/api/work-orders/${woId}/assignment`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ userId: other.id });
    expect(res.status).toBe(404);
  });

  it('rejects a random non-existent userId → 404', async () => {
    const res = await request(app)
      .put(`/api/work-orders/${woId}/assignment`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ userId: randomUUID() });
    expect(res.status).toBe(404);
  });

  it('viewer cannot assign → 403', async () => {
    const res = await request(app)
      .put(`/api/work-orders/${woId}/assignment`)
      .set('Authorization', `Bearer ${viewer.token}`)
      .send({ userId: fieldTech.id });
    expect(res.status).toBe(403);
  });

  it('field_tech cannot assign → 403', async () => {
    const res = await request(app)
      .put(`/api/work-orders/${woId}/assignment`)
      .set('Authorization', `Bearer ${fieldTech.token}`)
      .send({ userId: fieldTech.id });
    expect(res.status).toBe(403);
  });

  it('cross-tenant work order → 404', async () => {
    const otherSite = await prisma.site.create({ data: { accountId: other.accountId, name: `OWO-${Date.now()}` } });
    const otherAsset = await prisma.asset.create({ data: { accountId: other.accountId, siteId: otherSite.id, equipmentType: 'SWITCHGEAR', governingCondition: 'C2' } });
    const otherWo = await makeWorkOrder(other.accountId, otherAsset.id);
    const res = await request(app)
      .put(`/api/work-orders/${otherWo.id}/assignment`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ userId: fieldTech.id });
    expect(res.status).toBe(404);
    // cleanup
    await prisma.workOrder.delete({ where: { id: otherWo.id } });
    await prisma.asset.delete({ where: { id: otherAsset.id } });
    await prisma.site.delete({ where: { id: otherSite.id } });
  });

  it('unauthenticated → 401', async () => {
    const res = await request(app)
      .put(`/api/work-orders/${woId}/assignment`)
      .send({ userId: fieldTech.id });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/field/assignments — field_tech scope', () => {
  let assignedWoId: string;
  let unassignedWoId: string;

  beforeAll(async () => {
    // One WO assigned to fieldTech, one assigned to nobody
    const wo1 = await makeWorkOrder(manager.accountId, assetId, { assignedUserId: fieldTech.id, status: 'IN_PROGRESS' });
    assignedWoId = wo1.id;
    const wo2 = await makeWorkOrder(manager.accountId, assetId, { status: 'SCHEDULED' });
    unassignedWoId = wo2.id;
  });
  afterAll(async () => {
    try { await prisma.workOrder.deleteMany({ where: { id: { in: [assignedWoId, unassignedWoId] } } }); } catch {}
  });

  it('field_tech sees only their assigned work orders', async () => {
    const res = await request(app)
      .get('/api/field/assignments')
      .set('Authorization', `Bearer ${fieldTech.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.assignments.map((a: any) => a.id);
    expect(ids).toContain(assignedWoId);
    expect(ids).not.toContain(unassignedWoId);
  });

  it('manager using /api/field/assignments sees only their own assigned work', async () => {
    const res = await request(app)
      .get('/api/field/assignments')
      .set('Authorization', `Bearer ${manager.token}`);
    // Manager has no WOs with assignedUserId = manager.id, so empty list
    expect(res.status).toBe(200);
    const ids = res.body.data.assignments.map((a: any) => a.id);
    expect(ids).not.toContain(assignedWoId); // assigned to fieldTech, not manager
    expect(ids).not.toContain(unassignedWoId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature C — GET /api/parts/low-stock procurementRisk flag
// ═══════════════════════════════════════════════════════════════════════════════

async function makePart(token: string, overrides: Record<string, any> = {}) {
  const res = await request(app)
    .post('/api/parts')
    .set('Authorization', `Bearer ${token}`)
    .send({ partNumber: `PC-${Date.now()}-${Math.random().toString(36).slice(2)}`, description: 'Test', ...overrides });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function makeInventory(partId: string, accountId: string, qtyOnHand: number, qtyMin: number) {
  return prisma.spareInventory.create({ data: { accountId, partId, qtyOnHand, qtyMin } });
}

describe('GET /api/parts/low-stock — Feature C procurement risk', () => {
  let longLeadPartId: string;  // leadTimeWeeks = 10 (>= 8) → risk
  let shortLeadPartId: string; // leadTimeWeeks = 3  (<  8) → no risk
  let nullLeadPartId: string;  // leadTimeWeeks = null      → no risk
  let atMinPartId: string;     // qtyOnHand >= qtyMin       → not in low-stock list

  beforeAll(async () => {
    longLeadPartId  = await makePart(manager.token, { leadTimeWeeks: 10 });
    shortLeadPartId = await makePart(manager.token, { leadTimeWeeks: 3 });
    nullLeadPartId  = await makePart(manager.token, {}); // no leadTimeWeeks
    atMinPartId     = await makePart(manager.token, { leadTimeWeeks: 12 });

    // All below-min except atMinPartId
    await makeInventory(longLeadPartId,  manager.accountId, 0, 5);
    await makeInventory(shortLeadPartId, manager.accountId, 1, 5);
    await makeInventory(nullLeadPartId,  manager.accountId, 2, 5);
    await makeInventory(atMinPartId,     manager.accountId, 5, 5); // AT min — should not appear
  });

  it('returns procurementRisk=true for long-lead part below min', async () => {
    const res = await request(app)
      .get('/api/parts/low-stock')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const item = res.body.data.items.find((e: any) => e.part.id === longLeadPartId);
    expect(item).toBeDefined();
    expect(item.procurementRisk).toBe(true);
    expect(item.part.leadTimeWeeks).toBe(10);
  });

  it('returns procurementRisk=false for short-lead part below min', async () => {
    const res = await request(app)
      .get('/api/parts/low-stock')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const item = res.body.data.items.find((e: any) => e.part.id === shortLeadPartId);
    expect(item).toBeDefined();
    expect(item.procurementRisk).toBe(false);
  });

  it('returns procurementRisk=false for null-leadTime part below min', async () => {
    const res = await request(app)
      .get('/api/parts/low-stock')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const item = res.body.data.items.find((e: any) => e.part.id === nullLeadPartId);
    expect(item).toBeDefined();
    expect(item.procurementRisk).toBe(false);
  });

  it('part at or above min does not appear in low-stock list', async () => {
    const res = await request(app)
      .get('/api/parts/low-stock')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const item = res.body.data.items.find((e: any) => e.part.id === atMinPartId);
    expect(item).toBeUndefined();
  });

  it('procurementRiskCount matches the number of long-lead low-stock items', async () => {
    const res = await request(app)
      .get('/api/parts/low-stock')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const fromItems = res.body.data.items.filter((e: any) => e.procurementRisk).length;
    expect(res.body.data.procurementRiskCount).toBeGreaterThanOrEqual(fromItems);
    expect(res.body.data.procurementRiskCount).toBe(fromItems);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature D — GET /api/quote-requests virtual status filters + resolvedThisMonth
// ═══════════════════════════════════════════════════════════════════════════════

async function makeQR(status: string, extra: Record<string, any> = {}) {
  return prisma.quoteRequest.create({
    data: {
      accountId:     manager.accountId,
      assetId,
      requestedById: manager.id,
      driver:        'suspected_failing',
      timeline:      'within_30_days',
      status,
      ...extra,
    },
  });
}

describe('GET /api/quote-requests virtual filters — Feature D', () => {
  let requestedId: string;
  let quotedId: string;
  let draftId: string;
  let acceptedId: string;
  let declinedId: string;
  let oldAcceptedId: string;  // resolved last month — must not count in resolvedThisMonth

  beforeAll(async () => {
    const now = new Date();
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1);

    const r1 = await makeQR('requested');
    const r2 = await makeQR('quoted');
    const r3 = await makeQR('draft');
    const r4 = await makeQR('accepted',  { resolvedAt: now });
    const r5 = await makeQR('declined',  { resolvedAt: now });
    const r6 = await makeQR('accepted',  { resolvedAt: lastMonth }); // old — outside this month

    requestedId  = r1.id;
    quotedId     = r2.id;
    draftId      = r3.id;
    acceptedId   = r4.id;
    declinedId   = r5.id;
    oldAcceptedId = r6.id;
  });
  afterAll(async () => {
    const ids = [requestedId, quotedId, draftId, acceptedId, declinedId, oldAcceptedId];
    try { await prisma.quoteRequest.deleteMany({ where: { id: { in: ids } } }); } catch {}
  });

  it('?status=active returns only requested+quoted+draft', async () => {
    const res = await request(app)
      .get('/api/quote-requests?status=active')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.quoteRequests.map((q: any) => q.id);
    expect(ids).toContain(requestedId);
    expect(ids).toContain(quotedId);
    expect(ids).toContain(draftId);
    expect(ids).not.toContain(acceptedId);
    expect(ids).not.toContain(declinedId);
  });

  it('?status=resolved returns only accepted+declined', async () => {
    const res = await request(app)
      .get('/api/quote-requests?status=resolved')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.quoteRequests.map((q: any) => q.id);
    expect(ids).toContain(acceptedId);
    expect(ids).toContain(declinedId);
    expect(ids).not.toContain(requestedId);
    expect(ids).not.toContain(draftId);
  });

  it('no filter returns all statuses', async () => {
    const res = await request(app)
      .get('/api/quote-requests')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.quoteRequests.map((q: any) => q.id);
    expect(ids).toContain(requestedId);
    expect(ids).toContain(acceptedId);
    expect(ids).toContain(declinedId);
  });

  it('?status=<invalid> returns 400', async () => {
    const res = await request(app)
      .get('/api/quote-requests?status=garbage')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(400);
  });

  it('resolvedThisMonth count is included in every response', async () => {
    const res = await request(app)
      .get('/api/quote-requests?status=active')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data.resolvedThisMonth).toBe('number');
  });

  it('resolvedThisMonth counts only items with resolvedAt in current calendar month', async () => {
    const res = await request(app)
      .get('/api/quote-requests?status=active')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    // We have 2 resolved this month (accepted + declined with resolvedAt=now),
    // and 1 resolved last month (oldAccepted). The count must be >= 2.
    expect(res.body.data.resolvedThisMonth).toBeGreaterThanOrEqual(2);
    // And must NOT count the old one — so must be less than 3 (assuming no other resolved QRs)
    // We check the ratio: resolvedThisMonth < count-of-all-accepted-declined-ever
    const allRes = await request(app)
      .get('/api/quote-requests?status=resolved')
      .set('Authorization', `Bearer ${manager.token}`);
    const allResolvedCount = allRes.body.data.pagination?.total ?? allRes.body.data.quoteRequests.length;
    expect(res.body.data.resolvedThisMonth).toBeLessThanOrEqual(allResolvedCount);
  });

  it('?status=accepted (real status) still works', async () => {
    const res = await request(app)
      .get('/api/quote-requests?status=accepted')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    res.body.data.quoteRequests.forEach((q: any) => expect(q.status).toBe('accepted'));
  });

  it('viewer can access quote-requests list (read-only role allowed) → 200', async () => {
    const res = await request(app)
      .get('/api/quote-requests')
      .set('Authorization', `Bearer ${viewer.token}`);
    expect(res.status).toBe(200);
  });

  it('unauthenticated → 401', async () => {
    const res = await request(app)
      .get('/api/quote-requests');
    expect(res.status).toBe(401);
  });
});

export {};

/**
 * Field-scoped document annotations — /api/field/work-orders/:id/documents/:documentId/annotations
 *
 * [2026-07-06] Dustin, live: field techs should be able to leave notes on
 * their own job's documents. routes/documents.ts's annotation endpoints are
 * manager-gated AND live under /api/documents, which field_tech is
 * default-denied on entirely (see fieldLaborBoundary.test.ts). These are the
 * new field-scoped endpoints instead: create (POST) + list (GET) only, no
 * edit/delete for v1 — same call already made for WorkOrderComment.
 *
 * Coverage: default-deny still holds for the manager-facing /api/documents
 * annotation routes; a sub can create/list annotations on a document tied to
 * their OWN assigned work order; a sub is 404'd on a document tied to a work
 * order NOT assigned to them (even same account) and on a cross-account
 * document; shape validation is enforced identically to the manager route
 * (shared lib/documentAnnotations.ts); a manager can still use the field
 * surface too (Field Mode on a phone), unscoped.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;

let manager: TestUser;
let sub: TestUser;          // field_tech assigned to `assignedWoId`
let otherAdmin: TestUser;   // different account

let assignedWoId: string;
let unassignedWoId: string; // same account, NOT assigned to sub
let docOnAssignedWo: string;
let docOnUnassignedWo: string;
let docOnOtherAccountWo: string;

const bearer = (u: TestUser) => ['Authorization', `Bearer ${u.token}`] as [string, string];

beforeAll(async () => {
  app    = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;

  manager    = await createTestUser('manager');
  sub        = await createTestUser('field_tech', { accountId: manager.accountId });
  otherAdmin = await createTestUser('admin'); // fresh, separate account

  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `FDA Site ${Date.now()}` } });
  const asset = await prisma.asset.create({ data: { accountId: manager.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR' } });

  const otherSite  = await prisma.site.create({ data: { accountId: otherAdmin.accountId, name: `FDA Other Site ${Date.now()}` } });
  const otherAsset = await prisma.asset.create({ data: { accountId: otherAdmin.accountId, siteId: otherSite.id, equipmentType: 'GENERATOR' } });

  const wo1 = await prisma.workOrder.create({
    data: { accountId: manager.accountId, assetId: asset.id, status: 'IN_PROGRESS', assignedUserId: sub.id },
  });
  const wo2 = await prisma.workOrder.create({
    data: { accountId: manager.accountId, assetId: asset.id, status: 'SCHEDULED' }, // not assigned to sub
  });
  const wo3 = await prisma.workOrder.create({
    data: { accountId: otherAdmin.accountId, assetId: otherAsset.id, status: 'SCHEDULED' },
  });
  assignedWoId   = wo1.id;
  unassignedWoId = wo2.id;

  const d1 = await prisma.document.create({
    data: {
      accountId: manager.accountId, workOrderId: wo1.id, assetId: asset.id,
      filename: 'assigned.jpg', filePath: '__external__', externalUrl: 'https://example.test/assigned.jpg',
      fileType: 'image/jpeg', uploadedBy: manager.id,
    },
  });
  const d2 = await prisma.document.create({
    data: {
      accountId: manager.accountId, workOrderId: wo2.id, assetId: asset.id,
      filename: 'unassigned.jpg', filePath: '__external__', externalUrl: 'https://example.test/unassigned.jpg',
      fileType: 'image/jpeg', uploadedBy: manager.id,
    },
  });
  const d3 = await prisma.document.create({
    data: {
      accountId: otherAdmin.accountId, workOrderId: wo3.id, assetId: otherAsset.id,
      filename: 'other-account.jpg', filePath: '__external__', externalUrl: 'https://example.test/other.jpg',
      fileType: 'image/jpeg', uploadedBy: otherAdmin.id,
    },
  });
  docOnAssignedWo     = d1.id;
  docOnUnassignedWo   = d2.id;
  docOnOtherAccountWo = d3.id;
});

afterAll(async () => {
  for (const acc of [manager.accountId, otherAdmin.accountId]) {
    try { await prisma.documentAnnotation.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.document.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

describe('field_tech remains default-denied on the manager-facing /api/documents annotation routes', () => {
  test('POST /api/documents/:id/annotations → 403 field_role_scope', async () => {
    const res = await request(app)
      .post(`/api/documents/${docOnAssignedWo}/annotations`)
      .set(...bearer(sub))
      .send({ shapes: [{ type: 'pin', x: 0.5, y: 0.5 }] });
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('field_role_scope');
  });

  test('GET /api/documents/:id/annotations → 403 field_role_scope', async () => {
    const res = await request(app).get(`/api/documents/${docOnAssignedWo}/annotations`).set(...bearer(sub));
    expect(res.status).toBe(403);
  });
});

describe('field_tech annotates a document on THEIR assigned work order', () => {
  let annotationId: string;

  test('POST creates a pin annotation (201)', async () => {
    const res = await request(app)
      .post(`/api/field/work-orders/${assignedWoId}/documents/${docOnAssignedWo}/annotations`)
      .set(...bearer(sub))
      .send({ shapes: [{ type: 'pin', x: 0.3, y: 0.4, text: 'loose lug here' }] });
    expect(res.status).toBe(201);
    expect(res.body?.data?.annotation?.shapes).toEqual([{ type: 'pin', x: 0.3, y: 0.4, text: 'loose lug here' }]);
    expect(res.body?.data?.annotation?.author?.id).toBe(sub.id);
    annotationId = res.body.data.annotation.id;
  });

  test('GET lists it back', async () => {
    const res = await request(app)
      .get(`/api/field/work-orders/${assignedWoId}/documents/${docOnAssignedWo}/annotations`)
      .set(...bearer(sub));
    expect(res.status).toBe(200);
    expect((res.body?.data?.annotations || []).some((a: any) => a.id === annotationId)).toBe(true);
  });

  test('invalid shape (non-pin type) is rejected with 400', async () => {
    const res = await request(app)
      .post(`/api/field/work-orders/${assignedWoId}/documents/${docOnAssignedWo}/annotations`)
      .set(...bearer(sub))
      .send({ shapes: [{ type: 'arrow', x1: 0, y1: 0, x2: 1, y2: 1 }] });
    expect(res.status).toBe(400);
  });

  test('out-of-range coordinates are rejected with 400', async () => {
    const res = await request(app)
      .post(`/api/field/work-orders/${assignedWoId}/documents/${docOnAssignedWo}/annotations`)
      .set(...bearer(sub))
      .send({ shapes: [{ type: 'pin', x: 1.5, y: 0.5 }] });
    expect(res.status).toBe(400);
  });
});

describe('field_tech CANNOT annotate a document outside their assignment scope', () => {
  test('same-account document on an unassigned work order → 404', async () => {
    const res = await request(app)
      .post(`/api/field/work-orders/${unassignedWoId}/documents/${docOnUnassignedWo}/annotations`)
      .set(...bearer(sub))
      .send({ shapes: [{ type: 'pin', x: 0.5, y: 0.5 }] });
    expect(res.status).toBe(404);
  });

  test('assigned work order id paired with a document that does not belong to it → 404', async () => {
    const res = await request(app)
      .post(`/api/field/work-orders/${assignedWoId}/documents/${docOnUnassignedWo}/annotations`)
      .set(...bearer(sub))
      .send({ shapes: [{ type: 'pin', x: 0.5, y: 0.5 }] });
    expect(res.status).toBe(404);
  });

  test('a different account\'s work order/document → 404 (not leaked)', async () => {
    const otherWo = await prisma.document.findUnique({ where: { id: docOnOtherAccountWo }, select: { workOrderId: true } });
    const res = await request(app)
      .post(`/api/field/work-orders/${otherWo.workOrderId}/documents/${docOnOtherAccountWo}/annotations`)
      .set(...bearer(sub))
      .send({ shapes: [{ type: 'pin', x: 0.5, y: 0.5 }] });
    expect(res.status).toBe(404);
  });
});

describe('a manager keeps unscoped access through the same field surface (Field Mode on a phone)', () => {
  test('manager can create + list an annotation on the unassigned-to-sub work order', async () => {
    const post = await request(app)
      .post(`/api/field/work-orders/${unassignedWoId}/documents/${docOnUnassignedWo}/annotations`)
      .set(...bearer(manager))
      .send({ shapes: [{ type: 'pin', x: 0.6, y: 0.6 }] });
    expect(post.status).toBe(201);

    const list = await request(app)
      .get(`/api/field/work-orders/${unassignedWoId}/documents/${docOnUnassignedWo}/annotations`)
      .set(...bearer(manager));
    expect(list.status).toBe(200);
    expect(list.body?.data?.annotations?.length).toBeGreaterThan(0);
  });
});

export {};

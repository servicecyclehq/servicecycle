/**
 * Tests for the document layer + Revenue Intelligence routes added in the
 * 2026-06 document/one-line work:
 *   - GET  /api/admin/opportunities      (super_admin only, cross-tenant feed)
 *   - GET/PUT /api/admin/rate-sheet       (super_admin only)
 *   - GET  /api/documents                 (account-wide searchable library)
 *   - POST /api/documents/link            (provenance write -> read round-trip)
 *
 * Mirrors the supertest + helpers/auth pattern used across server/__tests__.
 */

import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
const toDelete: Array<{ model: string; id: string }> = [];

beforeAll(async () => {
  app    = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
});

afterAll(async () => {
  for (const { model, id } of toDelete.reverse()) {
    try { await (prisma as any)[model].delete({ where: { id } }); } catch {}
  }
  await prisma.$disconnect();
});

let superAdmin: TestUser;
let manager: TestUser;

beforeAll(async () => {
  superAdmin = await createTestUser('super_admin');
  manager    = await createTestUser('manager');
  toDelete.push({ model: 'user', id: superAdmin.id });
  toDelete.push({ model: 'account', id: superAdmin.accountId });
  toDelete.push({ model: 'user', id: manager.id });
  toDelete.push({ model: 'account', id: manager.accountId });
});

// ── Revenue Intelligence gate ─────────────────────────────────────────────────

describe('GET /api/admin/opportunities', () => {
  test('super_admin → 200 with feed shape', async () => {
    const res = await request(app)
      .get('/api/admin/opportunities')
      .set('Authorization', `Bearer ${superAdmin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.rateSheetStatus).toBe('string');
    expect(Array.isArray(res.body.data.studyOpportunities)).toBe(true);
    expect(res.body.data.summary).toBeDefined();
  });

  test('manager (non super_admin) → 403', async () => {
    const res = await request(app)
      .get('/api/admin/opportunities')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(403);
  });
});

// ── Rate sheet ────────────────────────────────────────────────────────────────

describe('/api/admin/rate-sheet', () => {
  test('super_admin GET → 200 with status', async () => {
    const res = await request(app)
      .get('/api/admin/rate-sheet')
      .set('Authorization', `Bearer ${superAdmin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('status');
  });

  test('manager GET → 403', async () => {
    const res = await request(app)
      .get('/api/admin/rate-sheet')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(403);
  });

  test('super_admin PUT updates a cents field → 200', async () => {
    const res = await request(app)
      .put('/api/admin/rate-sheet')
      .set('Authorization', `Bearer ${superAdmin.token}`)
      .send({ arcFlashStudyPerPanelCents: 13579 });
    expect(res.status).toBe(200);
    expect(res.body.data.arcFlashStudyPerPanelCents).toBe(13579);
  });

  test('PUT rejects a negative cents value → 400', async () => {
    const res = await request(app)
      .put('/api/admin/rate-sheet')
      .set('Authorization', `Bearer ${superAdmin.token}`)
      .send({ pmServiceHourlyRateCents: -5 });
    expect(res.status).toBe(400);
  });
});

// ── Document library + provenance round-trip ──────────────────────────────────

describe('/api/documents', () => {
  test('account user GET → 200 with array', async () => {
    const res = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('link doc with provenance persists and surfaces in the library', async () => {
    const created = await request(app)
      .post('/api/documents/link')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({
        url: 'https://example.com/oneline.pdf',
        filename: `Test One-Line ${Date.now()}`,
        docType: 'wiring_diagram',
        provenance: 'engineered',
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    toDelete.push({ model: 'document', id });

    const list = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${manager.token}`);
    const found = list.body.data.find((d: any) => d.id === id);
    expect(found).toBeDefined();
    expect(found.provenance).toBe('engineered');
    expect(found.external).toBe(true);
  });

  test('uploaded provenance defaults to unverified when omitted', async () => {
    const created = await request(app)
      .post('/api/documents/link')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ url: 'https://example.com/x.pdf', filename: `No Prov ${Date.now()}` });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    toDelete.push({ model: 'document', id });
    const row = await prisma.document.findUnique({ where: { id }, select: { provenance: true } });
    expect(row.provenance).toBe('unverified');
  });
});

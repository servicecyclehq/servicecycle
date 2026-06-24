/**
 * quoteRequestsRoleGate.test.ts
 *
 * Regression for H1: consultant (external read-only) and cross-account roles
 * must be blocked (403) from POST /api/quote-requests and POST /:id/send.
 * viewer (internal read-only) must be allowed through both routes.
 *
 * These are the exact findings addressed in commit d59695a.
 */

import request from 'supertest';
import { randomUUID } from 'crypto';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;

// ── Fixtures ────────────────────────────────────────────────────────────────

let consultant: TestUser;
let viewer: TestUser;
let viewerSiteId: string;
let viewerAssetId: string;
let viewerDraftId: string;   // created during the send-path test setup

const toDelete: Array<{ model: string; id: string }> = [];

beforeAll(async () => {
  app    = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;

  // Consultant lives in its own isolated account
  consultant = await createTestUser('consultant');
  toDelete.push({ model: 'user', id: consultant.id });
  toDelete.push({ model: 'account', id: consultant.accountId });

  // Viewer lives in their own account with a real asset they can quote
  viewer = await createTestUser('viewer');
  toDelete.push({ model: 'user', id: viewer.id });

  // Create a site + asset in the viewer's account so the POST body is valid
  const site = await prisma.site.create({
    data: { accountId: viewer.accountId, name: 'Test Site H1' },
  });
  viewerSiteId = site.id;
  toDelete.push({ model: 'site', id: site.id });

  const asset = await prisma.asset.create({
    data: {
      accountId:     viewer.accountId,
      siteId:        site.id,
      equipmentType: 'switchgear',
      manufacturer:  'H1 Test Mfr',
    },
  });
  viewerAssetId = asset.id;
  toDelete.push({ model: 'asset', id: asset.id });

  // Pre-create a draft quote request owned by the viewer (for the /send test)
  const draft = await prisma.quoteRequest.create({
    data: {
      accountId:   viewer.accountId,
      assetId:     viewerAssetId,
      requestedById: viewer.id,
      driver:      'suspected_failing',
      timeline:    'within_30_days',
      status:      'draft',
    },
  });
  viewerDraftId = draft.id;
  toDelete.push({ model: 'quoteRequest', id: draft.id });

  toDelete.push({ model: 'account', id: viewer.accountId });
});

afterAll(async () => {
  for (const { model, id } of toDelete.reverse()) {
    try { await (prisma as any)[model].delete({ where: { id } }); } catch {}
  }
  await prisma.$disconnect();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function bearer(token: string) { return `Bearer ${token}`; }

const validCreateBody = () => ({
  assetId:  viewerAssetId,
  driver:   'suspected_failing',
  timeline: 'within_30_days',
});

// ── POST / — create ──────────────────────────────────────────────────────────

describe('POST /api/quote-requests — create', () => {
  test('consultant → 403 (external read-only role must not write)', async () => {
    const res = await request(app)
      .post('/api/quote-requests')
      .set('Authorization', bearer(consultant.token))
      .send({ assetId: randomUUID(), driver: 'suspected_failing', timeline: 'within_30_days' });
    expect(res.status).toBe(403);
  });

  test('no token → 401', async () => {
    const res = await request(app)
      .post('/api/quote-requests')
      .send({ assetId: randomUUID(), driver: 'suspected_failing', timeline: 'within_30_days' });
    expect(res.status).toBe(401);
  });

  test('viewer → 201 (internal read-only may raise a quote request)', async () => {
    const res = await request(app)
      .post('/api/quote-requests')
      .set('Authorization', bearer(viewer.token))
      .send(validCreateBody());
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('requested');
    // Clean up the quote created by this test
    if (res.body.data?.id) {
      toDelete.push({ model: 'quoteRequest', id: res.body.data.id });
    }
  });
});

// ── POST /:id/send — promote draft ───────────────────────────────────────────

describe('POST /api/quote-requests/:id/send — promote draft', () => {
  test('consultant → 403 on send (middleware rejects before DB lookup)', async () => {
    const res = await request(app)
      .post(`/api/quote-requests/${randomUUID()}/send`)
      .set('Authorization', bearer(consultant.token))
      .send({});
    expect(res.status).toBe(403);
  });

  test('no token → 401 on send', async () => {
    const res = await request(app)
      .post(`/api/quote-requests/${randomUUID()}/send`)
      .send({});
    expect(res.status).toBe(401);
  });

  test('viewer → 200 on send (promotes their own draft)', async () => {
    const res = await request(app)
      .post(`/api/quote-requests/${viewerDraftId}/send`)
      .set('Authorization', bearer(viewer.token))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('requested');
  });
});

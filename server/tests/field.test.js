'use strict';

/**
 * /api/field/* — Field Mode read endpoints (My Day summary + asset card).
 *
 * Live-server suite. Covers: auth required (401), cross-tenant isolation
 * (B cannot read A's asset card), happy-path reads, the all-roles read access
 * the feature is designed for (a viewer CAN load these), and query validation.
 * Read-only — no data is mutated.
 */

const { api, bearer, anon, setupTenants, ALIEN_UUID } = require('./_routeHelpers');

let t;
let assetId;

beforeAll(async () => {
  t = await setupTenants('192.0.2', 160);
  assetId = t.asset?.id;
  expect(assetId).toBeTruthy();
}, 60_000);

describe('auth required', () => {
  test('GET /summary without a token is 401', async () => {
    const res = await api().get('/api/field/summary').set(anon());
    expect(res.status).toBe(401);
  });

  test('GET /asset/:id without a token is 401', async () => {
    const res = await api().get(`/api/field/asset/${assetId}`).set(anon());
    expect(res.status).toBe(401);
  });
});

describe('cross-tenant isolation', () => {
  test("B cannot read A's asset card (404)", async () => {
    const res = await api().get(`/api/field/asset/${assetId}`).set(bearer(t.tokenB));
    expect(res.status).toBe(404);
  });
});

describe('happy-path reads', () => {
  test('admin loads the My Day summary (200) with the four capped lists', async () => {
    const res = await api().get('/api/field/summary').set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    for (const k of ['overdue', 'dueSoon', 'openWorkOrders', 'openDeficiencies']) {
      expect(Array.isArray(res.body.data[k])).toBe(true);
    }
  });

  test('admin loads the asset field card (200)', async () => {
    const res = await api().get(`/api/field/asset/${assetId}`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(res.body.data.asset.id).toBe(assetId);
    expect(Array.isArray(res.body.data.activeSchedules)).toBe(true);
    expect(Array.isArray(res.body.data.openWorkOrders)).toBe(true);
  });

  test('field reads are available to any authenticated role (viewer 200)', async () => {
    const res = await api().get('/api/field/summary').set(bearer(t.tokenViewerA));
    expect(res.status).toBe(200);
  });
});

describe('query validation', () => {
  test('summary with a non-uuid siteId is 400', async () => {
    const res = await api().get('/api/field/summary?siteId=not-a-uuid').set(bearer(t.tokenAdminA));
    expect(res.status).toBe(400);
  });

  test('summary with a well-formed but foreign siteId is 404', async () => {
    const res = await api().get(`/api/field/summary?siteId=${ALIEN_UUID}`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(404);
  });
});

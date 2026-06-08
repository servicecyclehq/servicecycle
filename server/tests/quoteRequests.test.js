'use strict';

/**
 * /api/quote-requests — per-asset service quote requests.
 *
 * Live-server suite. Covers: auth required (401), cross-tenant isolation,
 * happy-path create/read/list/status, validation rejection, and the
 * manager-gated status transition. Also asserts the Area 4 list-shape fix
 * (data.quoteRequests + data.pagination{page,limit,total,pages}).
 */

const { api, bearer, anon, setupTenants } = require('./_routeHelpers');

let t;
let assetId;
let qrIdA;

beforeAll(async () => {
  t = await setupTenants('192.0.2', 60);
  assetId = t.asset?.id;
  expect(assetId).toBeTruthy();

  // Seed one quote request in account A for the read / cross-tenant / status tests.
  const create = await api()
    .post('/api/quote-requests')
    .set(bearer(t.tokenAdminA))
    .send({ assetId, driver: 'suspected_failing', timeline: 'within_30_days' });
  expect(create.status).toBe(201);
  qrIdA = create.body.data.id;
  expect(qrIdA).toBeTruthy();
}, 60_000);

describe('auth required', () => {
  test('GET list without a token is 401', async () => {
    const res = await api().get('/api/quote-requests').set(anon());
    expect(res.status).toBe(401);
  });
});

describe('cross-tenant isolation', () => {
  test("B cannot read A's quote request by id (404)", async () => {
    const res = await api().get(`/api/quote-requests/${qrIdA}`).set(bearer(t.tokenB));
    expect(res.status).toBe(404);
  });

  test("B's list never contains A's quote request", async () => {
    const res = await api().get('/api/quote-requests?limit=200').set(bearer(t.tokenB));
    expect(res.status).toBe(200);
    const ids = (res.body.data.quoteRequests || []).map((q) => q.id);
    expect(ids).not.toContain(qrIdA);
  });

  test("B cannot create a quote request against A's asset (asset 404)", async () => {
    const res = await api()
      .post('/api/quote-requests')
      .set(bearer(t.tokenB))
      .send({ assetId, driver: 'suspected_failing', timeline: 'within_30_days' });
    expect(res.status).toBe(404);
  });

  test("B cannot advance A's quote request status (404)", async () => {
    const res = await api()
      .patch(`/api/quote-requests/${qrIdA}/status`)
      .set(bearer(t.tokenB))
      .send({ status: 'quoted' });
    expect([403, 404]).toContain(res.status);
  });
});

describe('happy-path read + list', () => {
  test('admin reads the quote request by id', async () => {
    const res = await api().get(`/api/quote-requests/${qrIdA}`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(qrIdA);
  });

  test('list returns the canonical paginated shape (Area 4)', async () => {
    const res = await api().get('/api/quote-requests?limit=50').set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.quoteRequests)).toBe(true);
    const p = res.body.data.pagination;
    expect(p).toBeTruthy();
    for (const k of ['page', 'limit', 'total', 'pages']) expect(p).toHaveProperty(k);
  });

  test('per-asset history endpoint returns an array', async () => {
    const res = await api().get(`/api/quote-requests/asset/${assetId}`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('role gating + status transition', () => {
  test('viewer cannot advance status (403 — requireManager)', async () => {
    const res = await api()
      .patch(`/api/quote-requests/${qrIdA}/status`)
      .set(bearer(t.tokenViewerA))
      .send({ status: 'quoted' });
    expect(res.status).toBe(403);
  });

  test('admin advances status to quoted (200)', async () => {
    const res = await api()
      .patch(`/api/quote-requests/${qrIdA}/status`)
      .set(bearer(t.tokenAdminA))
      .send({ status: 'quoted', quoteNotes: 'ballpark $12k' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('quoted');
  });
});

describe('validation rejection', () => {
  test('POST without assetId is 400', async () => {
    const res = await api()
      .post('/api/quote-requests')
      .set(bearer(t.tokenAdminA))
      .send({ driver: 'suspected_failing', timeline: 'within_30_days' });
    expect(res.status).toBe(400);
  });

  test('POST without driver is 400', async () => {
    const res = await api()
      .post('/api/quote-requests')
      .set(bearer(t.tokenAdminA))
      .send({ assetId, timeline: 'within_30_days' });
    expect(res.status).toBe(400);
  });

  test('POST with an invalid driver is 400', async () => {
    const res = await api()
      .post('/api/quote-requests')
      .set(bearer(t.tokenAdminA))
      .send({ assetId, driver: 'meteor_strike', timeline: 'within_30_days' });
    expect(res.status).toBe(400);
  });

  test('PATCH status with an invalid status is 400', async () => {
    const res = await api()
      .patch(`/api/quote-requests/${qrIdA}/status`)
      .set(bearer(t.tokenAdminA))
      .send({ status: 'teleported' });
    expect(res.status).toBe(400);
  });
});

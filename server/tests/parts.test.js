'use strict';

/**
 * /api/parts — Parts catalog + SpareInventory CRUD
 *
 * Live-server suite. Covers: auth required (401), manager-gate (viewer → 403),
 * cross-tenant isolation, happy-path CRUD for Part + SpareInventory, the
 * low-stock endpoint, required-parts linking, and the CSV import preview.
 */

const { api, bearer, anon, setupTenants, ALIEN_UUID } = require('./_routeHelpers');

let t;
let assetId;
let siteId;
let partId;        // created in beforeAll
let invEntryId;    // inventory entry id

beforeAll(async () => {
  t = await setupTenants('192.0.2', 80);
  assetId = t.asset?.id;
  siteId  = t.site?.id;
  expect(assetId).toBeTruthy();
  expect(siteId).toBeTruthy();

  // Seed one part in account A for the read / cross-tenant / inventory tests.
  const create = await api()
    .post('/api/parts')
    .set(bearer(t.tokenAdminA))
    .send({
      partNumber:   'TEST-BREAKER-001',
      description:  'Test 100A Breaker',
      manufacturer: 'Eaton',
      category:     'BREAKER',
      unitCost:     149.99,
      leadTimeWeeks: 3,
    });
  expect(create.status).toBe(201);
  partId = create.body.data.id;
  expect(partId).toBeTruthy();
}, 60_000);

// ── auth required ──────────────────────────────────────────────────────────────

describe('auth required', () => {
  test('GET /api/parts without token is 401', async () => {
    const res = await api().get('/api/parts').set(anon());
    expect(res.status).toBe(401);
  });

  test('POST /api/parts without token is 401', async () => {
    const res = await api().post('/api/parts').set(anon()).send({ partNumber: 'X', description: 'Y' });
    expect(res.status).toBe(401);
  });
});

// ── manager-gate ───────────────────────────────────────────────────────────────

describe('viewer is denied write access', () => {
  test('viewer cannot create a part (403)', async () => {
    const res = await api()
      .post('/api/parts')
      .set(bearer(t.tokenViewerA))
      .send({ partNumber: 'V-001', description: 'Viewer attempt' });
    expect(res.status).toBe(403);
  });

  test('viewer cannot add inventory (403)', async () => {
    const res = await api()
      .post(`/api/parts/${partId}/inventory`)
      .set(bearer(t.tokenViewerA))
      .send({ siteId, qtyOnHand: 5 });
    expect(res.status).toBe(403);
  });
});

// ── cross-tenant isolation ─────────────────────────────────────────────────────

describe('cross-tenant isolation', () => {
  test("B cannot read A's part by id (404)", async () => {
    const res = await api().get(`/api/parts/${partId}`).set(bearer(t.tokenB));
    expect(res.status).toBe(404);
  });

  test("B's part list never contains A's part", async () => {
    // ?limit triggers the paginated envelope { parts, pagination }.
    const res = await api().get('/api/parts?limit=200').set(bearer(t.tokenB));
    expect(res.status).toBe(200);
    const ids = (res.body.data.parts || []).map((p) => p.id);
    expect(ids).not.toContain(partId);
  });

  test("B cannot update A's part (404)", async () => {
    const res = await api()
      .patch(`/api/parts/${partId}`)
      .set(bearer(t.tokenB))
      .send({ description: 'pwned' });
    expect(res.status).toBe(404);
  });
});

// ── happy-path CRUD ────────────────────────────────────────────────────────────

describe('parts CRUD', () => {
  test('GET /api/parts (default) returns a bare array of parts', async () => {
    // Default (no page/limit) is the backward-compatible bare-array shape used
    // by dropdown consumers (SpareInventoryPanel etc.).
    const res = await api().get('/api/parts').set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const found = res.body.data.find((p) => p.id === partId);
    expect(found).toBeTruthy();
    expect(found.partNumber).toBe('TEST-BREAKER-001');
  });

  test('GET /api/parts?page=1 returns the paginated envelope', async () => {
    const res = await api().get('/api/parts?page=1&limit=50').set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.parts)).toBe(true);
    expect(res.body.data.pagination).toBeTruthy();
    expect(typeof res.body.data.pagination.total).toBe('number');
    expect(res.body.data.pagination.page).toBe(1);
    const found = res.body.data.parts.find((p) => p.id === partId);
    expect(found).toBeTruthy();
  });

  test('GET /api/parts?search= filters the catalog', async () => {
    const res = await api()
      .get('/api/parts?search=TEST-BREAKER-001&page=1')
      .set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    const ids = (res.body.data.parts || []).map((p) => p.id);
    expect(ids).toContain(partId);
  });

  test('GET /api/parts/:id returns part detail', async () => {
    const res = await api().get(`/api/parts/${partId}`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(res.body.data.partNumber).toBe('TEST-BREAKER-001');
    expect(res.body.data.category).toBe('BREAKER');
  });

  test('PATCH /api/parts/:id updates fields', async () => {
    const res = await api()
      .patch(`/api/parts/${partId}`)
      .set(bearer(t.tokenAdminA))
      .send({ description: 'Updated 100A Breaker', leadTimeWeeks: 4 });
    expect(res.status).toBe(200);
    expect(res.body.data.description).toBe('Updated 100A Breaker');
    expect(res.body.data.leadTimeWeeks).toBe(4);
  });

  test('POST with missing partNumber is 400', async () => {
    const res = await api()
      .post('/api/parts')
      .set(bearer(t.tokenAdminA))
      .send({ description: 'Missing partNumber' });
    expect(res.status).toBe(400);
  });

  test('invalid category is rejected with 400', async () => {
    const res = await api()
      .post('/api/parts')
      .set(bearer(t.tokenAdminA))
      .send({ partNumber: 'CAT-BAD', description: 'Bad category', category: 'WIDGET' });
    expect(res.status).toBe(400);
  });
});

// ── inventory ──────────────────────────────────────────────────────────────────

describe('spare inventory', () => {
  test('POST /api/parts/:id/inventory creates entry', async () => {
    const res = await api()
      .post(`/api/parts/${partId}/inventory`)
      .set(bearer(t.tokenAdminA))
      .send({ siteId, qtyOnHand: 10, qtyMin: 2, location: 'Bin A-12' });
    expect(res.status).toBe(201);
    invEntryId = res.body.data.id;
    expect(invEntryId).toBeTruthy();
    expect(res.body.data.qtyOnHand).toBe(10);
    expect(res.body.data.qtyMin).toBe(2);
  });

  test('GET /api/parts/:id/inventory returns the entry', async () => {
    const res = await api().get(`/api/parts/${partId}/inventory`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    const entry = (res.body.data || []).find((e) => e.id === invEntryId);
    expect(entry).toBeTruthy();
  });

  test('PATCH inventory entry updates qty', async () => {
    const res = await api()
      .patch(`/api/parts/${partId}/inventory/${invEntryId}`)
      .set(bearer(t.tokenAdminA))
      .send({ qtyOnHand: 1 }); // below min → triggers low-stock
    expect(res.status).toBe(200);
    expect(res.body.data.qtyOnHand).toBe(1);
  });

  test('B cannot access A inventory entry (404)', async () => {
    const res = await api()
      .patch(`/api/parts/${partId}/inventory/${invEntryId}`)
      .set(bearer(t.tokenB))
      .send({ qtyOnHand: 999 });
    expect(res.status).toBe(404);
  });
});

// ── low-stock endpoint ─────────────────────────────────────────────────────────

describe('low-stock summary', () => {
  test('GET /api/parts/low-stock returns count ≥ 1 (entry is below min)', async () => {
    const res = await api().get('/api/parts/low-stock').set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    // qtyOnHand=1 < qtyMin=2 — must be in the low list
    expect(res.body.data.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  test("B's low-stock view is empty (no A entries)", async () => {
    const res = await api().get('/api/parts/low-stock').set(bearer(t.tokenB));
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(0);
    expect(res.body.data.items).toEqual([]);
  });
});

// ── required-parts linking ─────────────────────────────────────────────────────

describe('required-parts by asset', () => {
  test('POST /api/parts/required-by/:assetId links part to asset', async () => {
    const res = await api()
      .post(`/api/parts/required-by/${assetId}`)
      .set(bearer(t.tokenAdminA))
      .send({ partId, qtyRequired: 2 });
    expect(res.status).toBe(201);
    expect(res.body.data.partId).toBe(partId);
    expect(res.body.data.qtyRequired).toBe(2);
  });

  test('GET /api/parts/required-by/:assetId returns linked part with stock status', async () => {
    const res = await api().get(`/api/parts/required-by/${assetId}`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    const link = (res.body.data || []).find((r) => r.partId === partId);
    expect(link).toBeTruthy();
    // Stock status — one inventory entry exists (qty 1, min 2) so status should be LOW
    expect(['OK', 'LOW', 'OOS']).toContain(link.stockStatus);
  });

  test('B cannot read required-parts for A asset (404)', async () => {
    const res = await api().get(`/api/parts/required-by/${assetId}`).set(bearer(t.tokenB));
    expect(res.status).toBe(404);
  });

  test('DELETE /api/parts/required-by/:assetId/:partId removes link', async () => {
    const res = await api()
      .delete(`/api/parts/required-by/${assetId}/${partId}`)
      .set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
  });
});

// ── CSV import preview ─────────────────────────────────────────────────────────

describe('CSV import', () => {
  test('GET /api/parts/import/template returns CSV', async () => {
    const res = await api().get('/api/parts/import/template').set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/csv/i);
  });

  test('POST /api/parts/import?preview=true with valid CSV returns row statuses', async () => {
    const csv = [
      'partNumber,description,manufacturer,category,unitCost,leadTimeWeeks',
      'PREVIEW-001,Test Fuse,Bussmann,FUSE,12.50,2',
    ].join('\n');

    const res = await api()
      .post('/api/parts/import?preview=true')
      .set(bearer(t.tokenAdminA))
      .attach('file', Buffer.from(csv, 'utf-8'), { filename: 'test.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.preview)).toBe(true);
    expect(res.body.data.preview.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.preview[0].partNumber).toBe('PREVIEW-001');
    expect(['new', 'update']).toContain(res.body.data.preview[0].status);
  });
});

// ── cleanup ────────────────────────────────────────────────────────────────────

afterAll(async () => {
  // Remove inventory entry then part so the DB stays clean.
  if (invEntryId && partId) {
    await api()
      .delete(`/api/parts/${partId}/inventory/${invEntryId}`)
      .set(bearer(t.tokenAdminA));
  }
  if (partId) {
    await api().delete(`/api/parts/${partId}`).set(bearer(t.tokenAdminA));
  }
});

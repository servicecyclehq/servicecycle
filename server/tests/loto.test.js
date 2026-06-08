'use strict';

/**
 * /api/assets/:assetId/loto — Lockout/Tagout procedures.
 *
 * Live-server suite (idor.test.js style). Covers: auth required (401),
 * cross-tenant isolation (B cannot touch A's asset/procedures), role gating
 * (viewer cannot create — requireManager), happy-path CRUD, and validation
 * rejection. Asserts the Area 2 RBAC fix (POST/PUT now requireManager).
 */

const { api, bearer, anon, setupTenants, ALIEN_UUID } = require('./_routeHelpers');

let t;            // shared tenant context
let assetId;      // an asset in account A
const createdDraftIds = [];

const validBody = (title) => ({
  title,
  notes: 'created by loto.test.js',
  energySources: [{
    energyType: 'electrical',
    description: 'Main incoming breaker',
    isolationPoint: 'CB-MAIN',
    isolationMethod: 'Rack out and lock',
    verificationMethod: 'Absence-of-voltage test',
  }],
  steps: [{ instruction: 'Notify affected personnel', category: 'shutdown' }],
});

beforeAll(async () => {
  t = await setupTenants('192.0.2', 10);
  assetId = t.asset?.id;
  expect(assetId).toBeTruthy();
}, 60_000);

afterAll(async () => {
  // Best-effort cleanup of drafts we created (active/archived can't be deleted).
  for (const id of createdDraftIds) {
    await api().delete(`/api/assets/${assetId}/loto/${id}`).set(bearer(t.tokenAdminA)).catch(() => {});
  }
});

describe('auth required', () => {
  test('GET list without a token is 401', async () => {
    const res = await api().get(`/api/assets/${assetId}/loto`).set(anon());
    expect(res.status).toBe(401);
  });
});

describe('cross-tenant isolation', () => {
  test("B cannot list A's asset procedures (asset 404)", async () => {
    const res = await api().get(`/api/assets/${assetId}/loto`).set(bearer(t.tokenB));
    expect(res.status).toBe(404);
  });

  test("B cannot create a procedure under A's asset", async () => {
    const res = await api()
      .post(`/api/assets/${assetId}/loto`)
      .set(bearer(t.tokenB))
      .send(validBody('Hostile LOTO'));
    expect([403, 404]).toContain(res.status); // 404 (asset not owned) or 403 (role)
  });
});

describe('role gating (Area 2: requireManager)', () => {
  test('viewer cannot create a procedure (403)', async () => {
    const res = await api()
      .post(`/api/assets/${assetId}/loto`)
      .set(bearer(t.tokenViewerA))
      .send(validBody('Viewer LOTO'));
    expect(res.status).toBe(403);
  });
});

describe('happy-path CRUD', () => {
  test('admin creates a draft, reads it, then deletes it', async () => {
    const create = await api()
      .post(`/api/assets/${assetId}/loto`)
      .set(bearer(t.tokenAdminA))
      .send(validBody('CRUD LOTO'));
    expect(create.status).toBe(201);
    expect(create.body.success).toBe(true);
    const id = create.body.data.id;
    expect(id).toBeTruthy();
    expect(create.body.data.status).toBe('draft');

    const get = await api().get(`/api/assets/${assetId}/loto/${id}`).set(bearer(t.tokenAdminA));
    expect(get.status).toBe(200);
    expect(get.body.data.id).toBe(id);
    expect(get.body.data.energySources.length).toBe(1);

    const del = await api().delete(`/api/assets/${assetId}/loto/${id}`).set(bearer(t.tokenAdminA));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
  });

  test('admin activates a draft (manager-gated status transition)', async () => {
    const create = await api()
      .post(`/api/assets/${assetId}/loto`)
      .set(bearer(t.tokenAdminA))
      .send(validBody('Activate LOTO'));
    expect(create.status).toBe(201);
    const id = create.body.data.id;
    createdDraftIds.push(id);

    const patch = await api()
      .patch(`/api/assets/${assetId}/loto/${id}/status`)
      .set(bearer(t.tokenAdminA))
      .send({ status: 'active' });
    expect(patch.status).toBe(200);
    expect(patch.body.data.status).toBe('active');

    // An active procedure may not be hard-deleted.
    const del = await api().delete(`/api/assets/${assetId}/loto/${id}`).set(bearer(t.tokenAdminA));
    expect(del.status).toBe(409);
  });
});

describe('validation rejection', () => {
  test('POST without a title is 400', async () => {
    const res = await api()
      .post(`/api/assets/${assetId}/loto`)
      .set(bearer(t.tokenAdminA))
      .send({ notes: 'no title', energySources: [], steps: [] });
    expect(res.status).toBe(400);
  });

  test('POST with an invalid energyType is 400', async () => {
    const body = validBody('Bad energy');
    body.energySources[0].energyType = 'plasma';
    const res = await api()
      .post(`/api/assets/${assetId}/loto`)
      .set(bearer(t.tokenAdminA))
      .send(body);
    expect(res.status).toBe(400);
  });

  test('PATCH status with an invalid status is 400', async () => {
    const create = await api()
      .post(`/api/assets/${assetId}/loto`)
      .set(bearer(t.tokenAdminA))
      .send(validBody('Status validation LOTO'));
    const id = create.body.data.id;
    createdDraftIds.push(id);
    const res = await api()
      .patch(`/api/assets/${assetId}/loto/${id}/status`)
      .set(bearer(t.tokenAdminA))
      .send({ status: 'sideways' });
    expect(res.status).toBe(400);
  });
});

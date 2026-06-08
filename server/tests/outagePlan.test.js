'use strict';

/**
 * /api/assets/:assetId/outage-plan — Outage Consolidation Planner.
 *
 * Live-server suite. Covers: auth required (401), cross-tenant isolation,
 * happy-path plan read + consolidated work-order creation, role gating
 * (viewer cannot create the work order — Area 2), validation rejection
 * including the unparseable-date guard (Area 4), and the contractor IDOR
 * fix (Area 1: a cross-account/alien contractorId is rejected, not pinned).
 */

const { api, bearer, anon, setupTenants, ALIEN_UUID } = require('./_routeHelpers');

let t;
let assetId;     // an asset in account A that carries `schedule`
let scheduleId;

beforeAll(async () => {
  t = await setupTenants('192.0.2', 110);
  assetId = t.asset?.id;
  scheduleId = t.schedule?.id;
  expect(assetId).toBeTruthy();
}, 60_000);

describe('auth required', () => {
  test('GET plan without a token is 401', async () => {
    const res = await api().get(`/api/assets/${assetId}/outage-plan`).set(anon());
    expect(res.status).toBe(401);
  });
});

describe('cross-tenant isolation', () => {
  test("B cannot read A's asset outage plan (404)", async () => {
    const res = await api().get(`/api/assets/${assetId}/outage-plan`).set(bearer(t.tokenB));
    expect(res.status).toBe(404);
  });

  test("B cannot create a work order on A's asset", async () => {
    const res = await api()
      .post(`/api/assets/${assetId}/outage-plan/work-order`)
      .set(bearer(t.tokenB))
      .send({ scheduledDate: '2026-09-01T08:00:00.000Z', scheduleIds: [scheduleId || ALIEN_UUID] });
    expect([403, 404, 400]).toContain(res.status);
  });
});

describe('happy-path plan read', () => {
  test('admin reads the consolidated plan (200)', async () => {
    const res = await api().get(`/api/assets/${assetId}/outage-plan`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.rootAsset.id).toBe(assetId);
    expect(res.body.data.savings).toBeTruthy();
    expect(res.body.data).toHaveProperty('allAffectedCount');
  });
});

describe('role gating (Area 2: requireManager)', () => {
  test('viewer cannot create the consolidated work order (403)', async () => {
    const res = await api()
      .post(`/api/assets/${assetId}/outage-plan/work-order`)
      .set(bearer(t.tokenViewerA))
      .send({ scheduledDate: '2026-09-01T08:00:00.000Z', scheduleIds: [scheduleId || ALIEN_UUID] });
    expect(res.status).toBe(403);
  });
});

describe('validation rejection', () => {
  test('POST without scheduledDate is 400', async () => {
    const res = await api()
      .post(`/api/assets/${assetId}/outage-plan/work-order`)
      .set(bearer(t.tokenAdminA))
      .send({ scheduleIds: [scheduleId || ALIEN_UUID] });
    expect(res.status).toBe(400);
  });

  test('POST with an unparseable scheduledDate is 400 (Area 4)', async () => {
    const res = await api()
      .post(`/api/assets/${assetId}/outage-plan/work-order`)
      .set(bearer(t.tokenAdminA))
      .send({ scheduledDate: 'not-a-date', scheduleIds: [scheduleId || ALIEN_UUID] });
    expect(res.status).toBe(400);
  });

  test('POST without scheduleIds is 400', async () => {
    const res = await api()
      .post(`/api/assets/${assetId}/outage-plan/work-order`)
      .set(bearer(t.tokenAdminA))
      .send({ scheduledDate: '2026-09-01T08:00:00.000Z' });
    expect(res.status).toBe(400);
  });
});

describe('contractor IDOR (Area 1)', () => {
  test('an alien contractorId is rejected with 404, not pinned to a new work order', async () => {
    if (!scheduleId) return; // needs a real schedule to reach the contractor check
    const res = await api()
      .post(`/api/assets/${assetId}/outage-plan/work-order`)
      .set(bearer(t.tokenAdminA))
      .send({
        scheduledDate: '2026-09-02T08:00:00.000Z',
        scheduleIds: [scheduleId],
        contractorId: ALIEN_UUID,
      });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('happy-path work-order creation', () => {
  test('admin creates a consolidated work order (201)', async () => {
    if (!scheduleId) return;
    const res = await api()
      .post(`/api/assets/${assetId}/outage-plan/work-order`)
      .set(bearer(t.tokenAdminA))
      .send({ scheduledDate: '2026-09-03T08:00:00.000Z', scheduleIds: [scheduleId], notes: 'outagePlan.test.js' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.status).toBe('SCHEDULED');
  });
});

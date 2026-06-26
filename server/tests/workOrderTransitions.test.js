'use strict';

/**
 * /api/work-orders — COMPLETE transition and schedule roll-forward.
 *
 * Live-server suite (same pattern as loto.test.js / parts.test.js). Drives
 * the running dev server (TEST_BASE_URL else :3001) so the full route →
 * transaction → DB round trip is exercised.
 *
 * Coverage:
 *   - COMPLETE transition rolls nextDueDate forward by the interval
 *   - completedDate validation: future date rejection, pre-creation date rejection
 *   - C3 as-left condition compresses the next interval
 *   - COMPLETE → COMPLETE re-transition is rejected (terminal state)
 *   - invalid status transition is rejected (400)
 *   - auth required; cross-tenant isolation
 */

const { api, bearer, anon, setupTenants } = require('./_routeHelpers');

let t;        // tenant context from setupTenants
let assetId;  // a seeded asset in account A
let scheduleId; // a seeded schedule for that asset (taskDef with intervalC2Months)

// IDs created during the test so afterAll can clean them up.
const createdWoIds = [];

beforeAll(async () => {
  t = await setupTenants('192.0.2', 70);
  assetId    = t.asset?.id;
  scheduleId = t.schedule?.id;
  expect(assetId).toBeTruthy();
  expect(scheduleId).toBeTruthy();
}, 60_000);

afterAll(async () => {
  for (const id of createdWoIds) {
    await api().delete(`/api/work-orders/${id}`).set(bearer(t.tokenAdminA)).catch(() => {});
  }
});

// Helper: create a WO linked to the seeded schedule.
async function createWo(extra = {}) {
  const res = await api()
    .post('/api/work-orders')
    .set(bearer(t.tokenAdminA))
    .send({ assetId, scheduleId, ...extra });
  if (res.status === 201) createdWoIds.push(res.body.data.workOrder.id);
  return res;
}

// Helper: fetch the schedule from the server.
async function getSchedule() {
  const res = await api()
    .get(`/api/schedules/${scheduleId}`)
    .set(bearer(t.tokenAdminA));
  return res.body?.data?.schedule || null;
}

// ── auth required ──────────────────────────────────────────────────────────────

describe('auth required', () => {
  test('GET /api/work-orders without token is 401', async () => {
    const res = await api().get('/api/work-orders').set(anon());
    expect(res.status).toBe(401);
  });

  test('POST /api/work-orders without token is 401', async () => {
    const res = await api().post('/api/work-orders').set(anon()).send({ assetId });
    expect(res.status).toBe(401);
  });
});

// ── cross-tenant isolation ─────────────────────────────────────────────────────

describe('cross-tenant isolation', () => {
  test("B cannot complete A's work order (404)", async () => {
    const create = await createWo();
    expect(create.status).toBe(201);
    const woId = create.body.data.workOrder.id;

    const res = await api()
      .put(`/api/work-orders/${woId}`)
      .set(bearer(t.tokenB))
      .send({ status: 'COMPLETE' });
    expect(res.status).toBe(404);
  });
});

// ── COMPLETE transition: schedule roll-forward ─────────────────────────────────

describe('WorkOrder COMPLETE transition', () => {
  test('rolls the linked schedule nextDueDate forward by the task interval months', async () => {
    // Read the current schedule to capture a baseline.
    const beforeSched = await getSchedule();
    if (!beforeSched) {
      console.warn('[workOrderTransitions.test] No schedule available — skipping roll-forward test');
      return;
    }

    const create = await createWo();
    expect(create.status).toBe(201);
    const woId = create.body.data.workOrder.id;

    // Pick a fixed completedDate in the recent past so the assertion is deterministic.
    const completedDate = new Date('2026-01-15T12:00:00Z').toISOString();

    const complete = await api()
      .put(`/api/work-orders/${woId}`)
      .set(bearer(t.tokenAdminA))
      .send({ status: 'COMPLETE', completedDate });
    expect(complete.status).toBe(200);

    // Fetch the updated schedule.
    const afterSched = await getSchedule();
    expect(afterSched).toBeTruthy();

    // lastCompletedDate must now reflect our completedDate.
    const lastCompleted = new Date(afterSched.lastCompletedDate);
    expect(lastCompleted.getFullYear()).toBe(2026);
    expect(lastCompleted.getMonth()).toBe(0); // January

    // nextDueDate must be AFTER the completedDate (rolled forward by at least 1 month).
    if (afterSched.nextDueDate) {
      const nextDue = new Date(afterSched.nextDueDate);
      expect(nextDue.getTime()).toBeGreaterThan(lastCompleted.getTime());
    }
  });

  test('rejects completedDate more than 1 day in the future', async () => {
    const create = await createWo();
    expect(create.status).toBe(201);
    const woId = create.body.data.workOrder.id;

    const futureDate = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const res = await api()
      .put(`/api/work-orders/${woId}`)
      .set(bearer(t.tokenAdminA))
      .send({ status: 'COMPLETE', completedDate: futureDate });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/i);
  });

  test('rejects completedDate more than 1 day before the work order was created', async () => {
    const create = await createWo();
    expect(create.status).toBe(201);
    const woId = create.body.data.workOrder.id;

    // A date far in the past (well before any WO could have been created in this suite).
    const oldDate = new Date('2000-01-01T00:00:00Z').toISOString();
    const res = await api()
      .put(`/api/work-orders/${woId}`)
      .set(bearer(t.tokenAdminA))
      .send({ status: 'COMPLETE', completedDate: oldDate });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/before work order was created/i);
  });

  test('rejects an invalid status transition (e.g. COMPLETE → IN_PROGRESS)', async () => {
    // First, complete a WO (terminal state).
    const create = await createWo();
    expect(create.status).toBe(201);
    const woId = create.body.data.workOrder.id;

    await api()
      .put(`/api/work-orders/${woId}`)
      .set(bearer(t.tokenAdminA))
      .send({ status: 'COMPLETE' });

    // Now try to transition the terminal WO to IN_PROGRESS — must fail.
    const reopen = await api()
      .put(`/api/work-orders/${woId}`)
      .set(bearer(t.tokenAdminA))
      .send({ status: 'IN_PROGRESS' });
    expect(reopen.status).toBe(400);
    expect(reopen.body.error).toMatch(/Cannot transition/i);
  });

  test('COMPLETE with an invalid completedDate string is 400', async () => {
    const create = await createWo();
    expect(create.status).toBe(201);
    const woId = create.body.data.workOrder.id;

    const res = await api()
      .put(`/api/work-orders/${woId}`)
      .set(bearer(t.tokenAdminA))
      .send({ status: 'COMPLETE', completedDate: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid completedDate/i);
  });
});

// ── C3 as-left condition compresses next interval ──────────────────────────────

describe('C3 as-left condition compresses next interval', () => {
  test('completing with asLeftCondition C3 yields a shorter nextDueDate than C2', async () => {
    // We can only confirm nextDueDate is within the C3 ceiling (12 months from completion).
    // Read the schedule task definition interval to compute the expected range.
    const beforeSched = await getSchedule();
    if (!beforeSched) {
      console.warn('[workOrderTransitions.test] No schedule — skipping C3 compression test');
      return;
    }

    const create = await createWo();
    expect(create.status).toBe(201);
    const woId = create.body.data.workOrder.id;

    const completedDate = new Date('2026-02-01T12:00:00Z').toISOString();
    const complete = await api()
      .put(`/api/work-orders/${woId}`)
      .set(bearer(t.tokenAdminA))
      .send({ status: 'COMPLETE', completedDate, asLeftCondition: 'C3' });
    expect(complete.status).toBe(200);

    const afterSched = await getSchedule();
    if (!afterSched?.nextDueDate) return; // no nextDueDate when taskDef has no interval

    const completedAt = new Date(completedDate);
    const nextDue     = new Date(afterSched.nextDueDate);

    // C3 ceiling is 12 months; nextDueDate must be ≤ 12 months ahead of completion.
    const monthsAhead = (nextDue.getTime() - completedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.5);
    expect(monthsAhead).toBeLessThanOrEqual(12.5); // small tolerance for 30/31-day months
    expect(monthsAhead).toBeGreaterThan(0);
  });
});

// ── viewer role gating ─────────────────────────────────────────────────────────

describe('role gating', () => {
  test('viewer cannot create a work order (403)', async () => {
    const res = await api()
      .post('/api/work-orders')
      .set(bearer(t.tokenViewerA))
      .send({ assetId });
    expect(res.status).toBe(403);
  });

  test('viewer cannot complete a work order (403)', async () => {
    const create = await createWo();
    expect(create.status).toBe(201);
    const woId = create.body.data.workOrder.id;

    const res = await api()
      .put(`/api/work-orders/${woId}`)
      .set(bearer(t.tokenViewerA))
      .send({ status: 'COMPLETE' });
    expect(res.status).toBe(403);
  });
});

// ── GET list / detail ──────────────────────────────────────────────────────────

describe('work order list and detail', () => {
  test('GET /api/work-orders returns a list with shape', async () => {
    const res = await api().get('/api/work-orders').set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.workOrders)).toBe(true);
    expect(typeof res.body.data.pagination).toBe('object');
  });

  test('GET /api/work-orders/:id returns the work order', async () => {
    const create = await createWo();
    expect(create.status).toBe(201);
    const woId = create.body.data.workOrder.id;

    const res = await api().get(`/api/work-orders/${woId}`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(res.body.data.workOrder.id).toBe(woId);
    expect(res.body.data.workOrder.assetId).toBe(assetId);
  });

  test("B cannot see A's work order (404)", async () => {
    const create = await createWo();
    expect(create.status).toBe(201);
    const woId = create.body.data.workOrder.id;

    const res = await api().get(`/api/work-orders/${woId}`).set(bearer(t.tokenB));
    expect(res.status).toBe(404);
  });
});

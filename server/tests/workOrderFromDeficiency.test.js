'use strict';

/**
 * Create-work-order-from-deficiency (2026-07-03): POST /api/work-orders accepts
 * an optional deficiencyId that links an existing OPEN, unlinked finding on the
 * SAME asset to the new job. This suite guards the contract:
 *
 *   - the link is claimed ATOMICALLY (workOrder.create + deficiency.updateMany
 *     both run inside the same prisma.$transaction callback)
 *   - cross-tenant deficiencyId -> 404 (no work order created)
 *   - already-linked deficiency -> 400 (no work order created)
 *   - wrong-asset / already-resolved deficiency -> 400
 *   - a concurrent link between pre-check and claim (updateMany count 0)
 *     surfaces as the same 400 instead of a half-linked job
 *   - the work_order_created activity log carries the deficiencyId
 *
 * Mounts the router on a throwaway express app with a stub auth middleware -
 * fully in-memory, no live server / DB (same pattern as
 * disasterEventsRegionalScope.test.js: jest.config's moduleNameMapper points
 * the route's '../lib/prisma' at the global stub; we override that mapped
 * module with a fake client).
 */

// Valid-format UUIDs (UuidStr in lib/validate is format-checked, not v4-strict).
const ASSET_1      = '00000000-0000-4000-8000-0000000000a1';
const ASSET_2      = '00000000-0000-4000-8000-0000000000a2';
const D_OPEN       = '00000000-0000-4000-8000-00000000d001';
const D_FOREIGN    = '00000000-0000-4000-8000-00000000d002';
const D_LINKED     = '00000000-0000-4000-8000-00000000d003';
const D_OTHERASSET = '00000000-0000-4000-8000-00000000d004';
const D_RESOLVED   = '00000000-0000-4000-8000-00000000d005';
const D_RACE       = '00000000-0000-4000-8000-00000000d006';

jest.mock('../lib/prisma', () => {
  const state = {
    deficiencies: new Map(),
    createdWorkOrders: [],
    inTx: false,
    createdInTx: null,
    claimedInTx: null,
    raceIds: new Set(), // ids whose in-transaction claim loses the race
    woSeq: 0,
  };

  const assets = [
    { id: '00000000-0000-4000-8000-0000000000a1', accountId: 'acct-a' },
    { id: '00000000-0000-4000-8000-0000000000a2', accountId: 'acct-a' },
  ];

  const client = {
    asset: {
      findFirst: async ({ where }) =>
        assets.find((a) => a.id === where.id && a.accountId === where.accountId) || null,
    },
    deficiency: {
      findFirst: async ({ where }) => {
        const d = state.deficiencies.get(where.id);
        return d && d.accountId === where.accountId ? { ...d } : null;
      },
      updateMany: async ({ where, data }) => {
        state.claimedInTx = state.inTx;
        const d = state.deficiencies.get(where.id);
        if (!d) return { count: 0 };
        if (d.accountId !== where.accountId) return { count: 0 };
        if ('workOrderId' in where && d.workOrderId !== where.workOrderId) return { count: 0 };
        if (state.raceIds.has(d.id)) return { count: 0 }; // simulated concurrent claim
        Object.assign(d, data);
        return { count: 1 };
      },
    },
    workOrder: {
      create: async ({ data }) => {
        state.createdInTx = state.inTx;
        const wo = { id: `wo-new-${++state.woSeq}`, status: 'SCHEDULED', ...data };
        state.createdWorkOrders.push(wo);
        return wo;
      },
    },
    blackoutWindow: { findFirst: async () => null },
    $transaction: async (fn) => {
      state.inTx = true;
      try {
        return await fn(client);
      } finally {
        state.inTx = false;
      }
    },
  };

  globalThis.__wofdState = state;
  client.default = client;
  return client;
});

// Pass-through gates: role enforcement is covered elsewhere.
jest.mock('../middleware/roles', () => ({
  requireManager: (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));
jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));
jest.mock('../lib/maintenanceInterval', () => ({
  recomputeScheduleDates: jest.fn(),
  worstCondition: jest.fn(),
}));
jest.mock('../lib/assetAlertNotifier', () => ({
  notifyConditionDegradation: jest.fn(async () => {}),
}));
jest.mock('@prisma/client', () => ({ Prisma: { DbNull: null } }));

const express = require('express');
const request = require('supertest');
const { writeLog } = require('../lib/activityLog');

const state = () => globalThis.__wofdState;

let app;
beforeAll(() => {
  const router = require('../routes/workOrders');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 'user-a', accountId: 'acct-a', role: 'manager', name: 'Mgr', email: 'mgr@a.test' };
    next();
  });
  app.use('/api/work-orders', router);
});

beforeEach(() => {
  const s = state();
  s.deficiencies.clear();
  s.deficiencies.set(D_OPEN,       { id: D_OPEN,       accountId: 'acct-a', assetId: ASSET_1, severity: 'IMMEDIATE',   workOrderId: null,          resolvedAt: null });
  s.deficiencies.set(D_FOREIGN,    { id: D_FOREIGN,    accountId: 'acct-b', assetId: ASSET_1, severity: 'IMMEDIATE',   workOrderId: null,          resolvedAt: null });
  s.deficiencies.set(D_LINKED,     { id: D_LINKED,     accountId: 'acct-a', assetId: ASSET_1, severity: 'RECOMMENDED', workOrderId: 'wo-existing', resolvedAt: null });
  s.deficiencies.set(D_OTHERASSET, { id: D_OTHERASSET, accountId: 'acct-a', assetId: ASSET_2, severity: 'RECOMMENDED', workOrderId: null,          resolvedAt: null });
  s.deficiencies.set(D_RESOLVED,   { id: D_RESOLVED,   accountId: 'acct-a', assetId: ASSET_1, severity: 'ADVISORY',    workOrderId: null,          resolvedAt: new Date('2026-06-01') });
  s.deficiencies.set(D_RACE,       { id: D_RACE,       accountId: 'acct-a', assetId: ASSET_1, severity: 'IMMEDIATE',   workOrderId: null,          resolvedAt: null });
  s.createdWorkOrders.length = 0;
  s.inTx = false;
  s.createdInTx = null;
  s.claimedInTx = null;
  s.raceIds.clear();
  writeLog.mockClear();
});

const post = (body) => request(app).post('/api/work-orders').send(body);

describe('POST /api/work-orders with deficiencyId - happy path', () => {
  test('creates the job, links the finding, and does BOTH inside the transaction', async () => {
    const res = await post({ assetId: ASSET_1, deficiencyId: D_OPEN });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const woId = res.body.data.workOrder.id;
    expect(woId).toBeTruthy();
    // Linkage actually landed on the finding, pointing at the NEW job.
    expect(state().deficiencies.get(D_OPEN).workOrderId).toBe(woId);
    // Atomicity: create AND claim both executed inside $transaction.
    expect(state().createdInTx).toBe(true);
    expect(state().claimedInTx).toBe(true);
  });

  test('work_order_created activity log carries the deficiencyId', async () => {
    const res = await post({ assetId: ASSET_1, deficiencyId: D_OPEN });
    expect(res.status).toBe(201);
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'work_order_created',
      accountId: 'acct-a',
      details: expect.objectContaining({ deficiencyId: D_OPEN }),
    }));
  });

  test('plain create (no deficiencyId) still works; log carries deficiencyId null', async () => {
    const res = await post({ assetId: ASSET_1 });
    expect(res.status).toBe(201);
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'work_order_created',
      details: expect.objectContaining({ deficiencyId: null }),
    }));
  });
});

describe('POST /api/work-orders with deficiencyId - rejections', () => {
  test('cross-tenant deficiencyId -> 404, no work order created', async () => {
    const res = await post({ assetId: ASSET_1, deficiencyId: D_FOREIGN });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Deficiency not found');
    expect(state().createdWorkOrders).toHaveLength(0);
    // The foreign tenant's finding is untouched.
    expect(state().deficiencies.get(D_FOREIGN).workOrderId).toBeNull();
  });

  test('already-linked deficiency -> 400, no work order created', async () => {
    const res = await post({ assetId: ASSET_1, deficiencyId: D_LINKED });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Deficiency is already linked to a work order');
    expect(state().createdWorkOrders).toHaveLength(0);
    expect(state().deficiencies.get(D_LINKED).workOrderId).toBe('wo-existing');
  });

  test('deficiency on a different asset -> 400', async () => {
    const res = await post({ assetId: ASSET_1, deficiencyId: D_OTHERASSET });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Deficiency does not belong to this asset');
    expect(state().createdWorkOrders).toHaveLength(0);
  });

  test('already-resolved deficiency -> 400', async () => {
    const res = await post({ assetId: ASSET_1, deficiencyId: D_RESOLVED });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Deficiency is already resolved');
    expect(state().createdWorkOrders).toHaveLength(0);
  });

  test('concurrent link between pre-check and claim -> same 400, no half-linked job', async () => {
    state().raceIds.add(D_RACE); // the in-transaction guarded claim loses
    const res = await post({ assetId: ASSET_1, deficiencyId: D_RACE });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Deficiency is already linked to a work order');
    // The claim was attempted inside the transaction (so the real DB would
    // roll the create back with it).
    expect(state().claimedInTx).toBe(true);
    // No activity log for a job that rolled back.
    expect(writeLog).not.toHaveBeenCalled();
  });
});

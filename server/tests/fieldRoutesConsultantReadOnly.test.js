'use strict';

/**
 * RBAC regression (2026-07-03 acquisition scan, Scan 3):
 * the consultant role passed every /api/field WRITE account-wide -- it could
 * complete work orders, log deficiencies, record measurements and create
 * ProtectiveDevice rows despite being read-only-with-attribution by design
 * (middleware/roles.ts header + the in-app banner promise). Every mutating
 * field endpoint is now gated with requireRole(['admin','manager','viewer',
 * 'field_tech']); GETs and POST /voice/parse (parse-only, persists nothing)
 * stay open so legitimate consultant read flows keep working.
 *
 * In-memory express + fake prisma; the REAL middleware/roles is used so the
 * 403s below are the genuine gate, not a mock.
 */

const WO_ID    = '11111111-1111-4111-8111-111111111111';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID  = '33333333-3333-4333-8333-333333333333';

jest.mock('../lib/prisma', () => {
  const WO    = '11111111-1111-4111-8111-111111111111';
  const ASSET = '22222222-2222-4222-8222-222222222222';
  const TASK  = '33333333-3333-4333-8333-333333333333';

  const wo   = { id: WO, accountId: 'acct-a', status: 'SCHEDULED', assetId: ASSET, assignedUserId: 'tech-1' };
  const task = { id: TASK, accountId: 'acct-a', status: 'open', siteId: 'site-a', assetId: null, ingestBusId: null, busName: 'MCC-1', assignedUserId: 'tech-1' };

  globalThis.__fieldWrites = [];
  const record = (table) => async ({ data }) => {
    globalThis.__fieldWrites.push({ table, data });
    return { id: `${table}-new`, createdAt: new Date(), ...data };
  };

  const client = {
    workOrder: {
      findFirst: async ({ where }) =>
        (where.id === wo.id
          && (where.accountId === undefined || where.accountId === wo.accountId)
          && (where.assignedUserId === undefined || where.assignedUserId === wo.assignedUserId))
          ? { ...wo } : null,
      findMany: async ({ where }) =>
        (where && where.assignedUserId && where.assignedUserId !== wo.assignedUserId) ? [] : [{ ...wo }],
      update: async ({ where, data }) => {
        globalThis.__fieldWrites.push({ table: 'workOrder.update', data });
        return { id: where.id, status: data.status, completedDate: data.completedDate, asLeftCondition: data.asLeftCondition || null };
      },
    },
    asset: {
      findFirst: async ({ where }) =>
        (where.id === ASSET && where.accountId === 'acct-a') ? { id: ASSET } : null,
      findMany: async () => [],
    },
    testMeasurement: { create: record('testMeasurement') },
    deficiency: { create: record('deficiency'), findMany: async () => [] },
    maintenanceSchedule: { findMany: async () => [] },
    site: { findFirst: async ({ where }) => (where.accountId === 'acct-a' ? { id: where.id } : null) },
    arcFlashCollectionTask: {
      findFirst: async ({ where }) =>
        (where.id === task.id
          && where.accountId === task.accountId
          && (where.assignedUserId === undefined || where.assignedUserId === task.assignedUserId))
          ? { ...task } : null,
      update: async ({ data }) => ({ ...task, ...data }),
    },
    protectiveDevice: { create: record('protectiveDevice') },
    document: { findMany: async () => [] },
  };
  client.default = client;
  return client;
});

// Heavy/parse libs are irrelevant to the gate under test.
jest.mock('../lib/voiceCapture', () => ({
  parseVoiceReading: jest.fn(() => ({ assetHint: null })),
  hintTokens: jest.fn(() => []),
}));
jest.mock('../lib/arcFlashDevice', () => ({ regapIngestBusAfterDevice: jest.fn() }));
jest.mock('../lib/storage', () => ({ downloadFile: jest.fn() }));
jest.mock('../lib/docCrypto', () => ({ decrypt: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));

const express = require('express');
const request = require('supertest');

let currentUser;
let app;
beforeAll(() => {
  const router = require('../routes/fieldRoutes');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/field', router);
});

beforeEach(() => {
  currentUser = { id: 'user-c', accountId: 'acct-a', role: 'consultant' };
  globalThis.__fieldWrites.length = 0;
});

const MUTATIONS = [
  ['measurements', () => request(app).post(`/api/field/work-orders/${WO_ID}/measurements`).send({ measurementType: 'insulation_resistance', asFoundValue: 550 })],
  ['complete',     () => request(app).post(`/api/field/work-orders/${WO_ID}/complete`).send({})],
  ['deficiencies', () => request(app).post('/api/field/deficiencies').send({ assetId: ASSET_ID, severity: 'ADVISORY', description: 'x' })],
  ['collect',      () => request(app).post(`/api/field/arc-flash/tasks/${TASK_ID}/collect`).send({ device: { label: 'CB-1' } })],
];

describe('consultant is blocked from every mutating /api/field endpoint', () => {
  test.each(MUTATIONS)('consultant POST %s -> 403, nothing written', async (_name, fire) => {
    const res = await fire();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'You do not have permission to perform this action' });
    expect(globalThis.__fieldWrites).toHaveLength(0);
  });

  test('cross-account read-only roles are blocked too (oem_admin -> 403)', async () => {
    currentUser = { id: 'user-o', accountId: 'acct-a', role: 'oem_admin' };
    const res = await request(app).post(`/api/field/work-orders/${WO_ID}/complete`).send({});
    expect(res.status).toBe(403);
    expect(globalThis.__fieldWrites).toHaveLength(0);
  });
});

describe('consultant read flows keep working', () => {
  test('GET /summary -> 200', async () => {
    const res = await request(app).get('/api/field/summary');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('GET /assignments -> 200', async () => {
    const res = await request(app).get('/api/field/assignments');
    expect(res.status).toBe(200);
  });

  test('POST /voice/parse (parse-only, no persistence) -> 200', async () => {
    const res = await request(app).post('/api/field/voice/parse').send({ transcript: 'megger five fifty' });
    expect(res.status).toBe(200);
    expect(globalThis.__fieldWrites).toHaveLength(0);
  });
});

describe('legitimate writers still pass the gate', () => {
  test('field_tech completes an ASSIGNED work order -> 200', async () => {
    currentUser = { id: 'tech-1', accountId: 'acct-a', role: 'field_tech' };
    const res = await request(app).post(`/api/field/work-orders/${WO_ID}/complete`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.workOrder.status).toBe('COMPLETE');
  });

  test('manager records a measurement -> 201', async () => {
    currentUser = { id: 'mgr-1', accountId: 'acct-a', role: 'manager' };
    const res = await request(app).post(`/api/field/work-orders/${WO_ID}/measurements`)
      .send({ measurementType: 'insulation_resistance', asFoundValue: 550, passFail: 'pass' });
    expect(res.status).toBe(201);
    expect(globalThis.__fieldWrites.some((w) => w.table === 'testMeasurement')).toBe(true);
  });

  test('viewer reports a deficiency -> 201 (all-internal-roles design kept)', async () => {
    currentUser = { id: 'view-1', accountId: 'acct-a', role: 'viewer' };
    const res = await request(app).post('/api/field/deficiencies')
      .send({ assetId: ASSET_ID, severity: 'ADVISORY', description: 'rust on enclosure' });
    expect(res.status).toBe(201);
  });

  test('field_tech records an arc-flash collection on an assigned task -> 200', async () => {
    currentUser = { id: 'tech-1', accountId: 'acct-a', role: 'field_tech' };
    const res = await request(app).post(`/api/field/arc-flash/tasks/${TASK_ID}/collect`)
      .send({ device: { label: 'CB-1', deviceType: 'breaker' } });
    expect(res.status).toBe(200);
    expect(globalThis.__fieldWrites.some((w) => w.table === 'protectiveDevice')).toBe(true);
  });
});

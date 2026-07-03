'use strict';

/**
 * arcFlashIngest auth hardening (2026-07-03 acquisition scan, Scan 3):
 *
 *  1. POST /api/arc-flash/devices used to write a client-supplied ingestBusId
 *     with NO ownership check - a cross-tenant FK write. It must 404 on a
 *     foreign bus (same signal as the sibling siteId/assetId checks).
 *  2. POST /api/arc-flash/device-tests: same class of bug for
 *     systemStudyAssetId (and ingestBusId). Must 404 on foreign FKs.
 *  3. /fleet, /report, /audit-bundle, /export had NO role middleware - viewer
 *     and consultant could pull account-wide risk rollups and the full model
 *     CSV. They are now requireManager (matches routes/export.ts GET /account
 *     and the in-file /risk-score / /regulatory-review precedent).
 *
 * Mounts the real router on a throwaway express app with a stub auth
 * middleware - fully in-memory, no live server / DB. jest.config's
 * moduleNameMapper points the route's '../lib/prisma' at the global stub; we
 * override that mapped module with a fake client (same trick as
 * disasterEventsRegionalScope.test.js). The REAL middleware/roles is used so
 * the 403s below are the genuine gate, not a mock.
 */

jest.mock('../lib/prisma', () => {
  // Two tenants: acct-a is the caller; anything acct-b is foreign.
  const rows = {
    site: [{ id: 'site-a', accountId: 'acct-a' }, { id: 'site-b', accountId: 'acct-b' }],
    asset: [{ id: 'asset-a', accountId: 'acct-a' }],
    arcFlashIngestBus: [
      { id: 'bus-own', accountId: 'acct-a' },
      { id: 'bus-foreign', accountId: 'acct-b' },
    ],
    systemStudyAsset: [
      { id: 'ssa-own', accountId: 'acct-a' },
      { id: 'ssa-foreign', accountId: 'acct-b' },
    ],
    protectiveDevice: [{ id: 'pd-own', accountId: 'acct-a' }],
  };
  const findFirst = (table) => async ({ where }) =>
    rows[table].find((r) => r.id === where.id && (where.accountId === undefined || r.accountId === where.accountId)) || null;

  globalThis.__afCreates = [];
  const create = (table) => async ({ data }) => {
    globalThis.__afCreates.push({ table, data });
    return { id: `${table}-new`, createdAt: new Date(), updatedAt: new Date(), ...data };
  };

  const client = {
    site: { findFirst: findFirst('site') },
    asset: { findFirst: findFirst('asset') },
    arcFlashIngestBus: { findFirst: findFirst('arcFlashIngestBus') },
    systemStudyAsset: { findFirst: findFirst('systemStudyAsset'), findMany: async () => [] },
    protectiveDevice: { findFirst: findFirst('protectiveDevice'), create: create('protectiveDevice'), findMany: async () => [] },
    deviceTestRecord: { create: create('deviceTestRecord'), findMany: async () => [] },
    arcFlashIncident: { findMany: async () => [] },
    arcFlashCollectionTask: { count: async () => 0 },
    account: { findUnique: async () => ({ companyName: 'Test Co' }) },
    activityLog: { create: async () => ({}) },
  };
  client.default = client;
  return client;
});

// The route AND the real roles middleware both write activity logs; keep those
// fire-and-forget writes out of the fake DB.
jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));

const express = require('express');
const request = require('supertest');

// Mutable so each test picks its caller; the gates read req.user.role.
let currentUser;

let app;
beforeAll(() => {
  const router = require('../routes/arcFlashIngest');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/arc-flash', router);
});

beforeEach(() => {
  currentUser = { id: 'user-a', accountId: 'acct-a', role: 'manager' };
  globalThis.__afCreates.length = 0;
});

describe('POST /api/arc-flash/devices - ingestBusId tenancy', () => {
  test('foreign ingestBusId -> 404, nothing written', async () => {
    const res = await request(app).post('/api/arc-flash/devices')
      .send({ siteId: 'site-a', label: 'Main CB 52-M1', ingestBusId: 'bus-foreign' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'ingestBusId not found' });
    expect(globalThis.__afCreates).toHaveLength(0);
  });

  test('unknown ingestBusId -> 404, nothing written', async () => {
    const res = await request(app).post('/api/arc-flash/devices')
      .send({ siteId: 'site-a', label: 'Main CB 52-M1', ingestBusId: 'no-such-bus' });
    expect(res.status).toBe(404);
    expect(globalThis.__afCreates).toHaveLength(0);
  });

  test('own ingestBusId -> 201 and the FK is persisted', async () => {
    const res = await request(app).post('/api/arc-flash/devices')
      .send({ siteId: 'site-a', label: 'Main CB 52-M1', ingestBusId: 'bus-own' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const created = globalThis.__afCreates.find((c) => c.table === 'protectiveDevice');
    expect(created).toBeTruthy();
    expect(created.data.ingestBusId).toBe('bus-own');
    expect(created.data.accountId).toBe('acct-a');
  });
});

describe('POST /api/arc-flash/device-tests - systemStudyAssetId / ingestBusId tenancy', () => {
  test('foreign systemStudyAssetId -> 404, nothing written', async () => {
    const res = await request(app).post('/api/arc-flash/device-tests')
      .send({ siteId: 'site-a', systemStudyAssetId: 'ssa-foreign' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'systemStudyAssetId not found' });
    expect(globalThis.__afCreates).toHaveLength(0);
  });

  test('foreign ingestBusId -> 404, nothing written', async () => {
    const res = await request(app).post('/api/arc-flash/device-tests')
      .send({ siteId: 'site-a', ingestBusId: 'bus-foreign' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'ingestBusId not found' });
    expect(globalThis.__afCreates).toHaveLength(0);
  });

  test('own FKs -> 201 and both FKs are persisted', async () => {
    const res = await request(app).post('/api/arc-flash/device-tests')
      .send({ siteId: 'site-a', systemStudyAssetId: 'ssa-own', ingestBusId: 'bus-own', testType: 'trip_test' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const created = globalThis.__afCreates.find((c) => c.table === 'deviceTestRecord');
    expect(created).toBeTruthy();
    expect(created.data.systemStudyAssetId).toBe('ssa-own');
    expect(created.data.ingestBusId).toBe('bus-own');
    expect(created.data.accountId).toBe('acct-a');
  });
});

describe('account-wide reporting/export surfaces are requireManager', () => {
  const GATED = ['/api/arc-flash/fleet', '/api/arc-flash/report', '/api/arc-flash/audit-bundle', '/api/arc-flash/export'];

  test.each(GATED)('viewer -> 403 on %s', async (path) => {
    currentUser = { id: 'user-v', accountId: 'acct-a', role: 'viewer' };
    const res = await request(app).get(path);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Manager or admin access required' });
  });

  test.each(GATED)('consultant -> 403 on %s', async (path) => {
    currentUser = { id: 'user-c', accountId: 'acct-a', role: 'consultant' };
    const res = await request(app).get(path);
    expect(res.status).toBe(403);
  });

  test.each(GATED)('manager -> 200 on %s (gate does not break the report)', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
  });

  test('label PDF endpoint is NOT manager-gated (any authed role, own data)', async () => {
    currentUser = { id: 'user-v', accountId: 'acct-a', role: 'viewer' };
    // Empty systemStudyAsset.findMany in the fake DB -> the route's own
    // "No arc-flash label" 404, which proves the request got PAST any role
    // gate (a 403 would mean we broke the demo label endpoints).
    const res = await request(app).get('/api/arc-flash/asset/asset-a/label.pdf');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'No arc-flash label for this asset.' });
  });
});

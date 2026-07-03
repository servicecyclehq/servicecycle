'use strict';

/**
 * Ownership regression (2026-07-03 acquisition scan, Scan 3):
 * PATCH /api/arc-flash-incidents/:id used to write client-supplied
 * siteId/assetId with NO ownership check (POST validated both) -- a
 * cross-tenant FK write. PATCH must now 400 on a foreign/unknown id, exactly
 * like POST, while clearing a field (null) stays allowed without a lookup.
 *
 * Mounts the real router on a throwaway express app with a stub auth
 * middleware - fully in-memory, no live server / DB (same pattern as
 * arcFlashIngestAuthScope.test.js). The REAL middleware/roles is used.
 */

jest.mock('../lib/prisma', () => {
  const rows = {
    site: [{ id: 'site-a', accountId: 'acct-a' }, { id: 'site-b', accountId: 'acct-b' }],
    asset: [{ id: 'asset-a', accountId: 'acct-a' }, { id: 'asset-b', accountId: 'acct-b' }],
  };
  const incident = {
    id: 'inc-1', accountId: 'acct-a', siteId: null, assetId: null, busName: null,
    incidentType: 'near_miss', occurredAt: null, description: 'existing',
    injury: false, injuryDetail: null, ppeWorn: null, workType: null,
    oshaRecordable: null, correctiveAction: null, reportUrl: null,
    status: 'open', resolvedAt: null, studyStateSnapshot: null,
  };

  globalThis.__afiLookups = [];
  globalThis.__afiUpdates = [];

  const findFirst = (table) => async ({ where }) => {
    globalThis.__afiLookups.push({ table, where });
    return rows[table].find(
      (r) => r.id === where.id && (where.accountId === undefined || r.accountId === where.accountId)
    ) || null;
  };

  const client = {
    site: { findFirst: findFirst('site') },
    asset: { findFirst: findFirst('asset') },
    arcFlashIncident: {
      findFirst: async ({ where }) =>
        (where.id === incident.id && where.accountId === incident.accountId) ? { ...incident } : null,
      update: async ({ where, data }) => {
        globalThis.__afiUpdates.push({ where, data });
        return { ...incident, ...data };
      },
    },
  };
  client.default = client;
  return client;
});

// The route and the real roles middleware both write activity logs;
// keep those fire-and-forget writes out of the fake DB.
jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));

const express = require('express');
const request = require('supertest');

let currentUser;
let app;
beforeAll(() => {
  const router = require('../routes/arcFlashIncidents');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/arc-flash-incidents', router);
});

beforeEach(() => {
  currentUser = { id: 'user-a', accountId: 'acct-a', role: 'manager' };
  globalThis.__afiLookups.length = 0;
  globalThis.__afiUpdates.length = 0;
});

describe('PATCH /api/arc-flash-incidents/:id - siteId/assetId tenancy', () => {
  test('foreign siteId -> 400, nothing written', async () => {
    const res = await request(app).patch('/api/arc-flash-incidents/inc-1').send({ siteId: 'site-b' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'siteId not found' });
    expect(globalThis.__afiUpdates).toHaveLength(0);
  });

  test('foreign assetId -> 400, nothing written', async () => {
    const res = await request(app).patch('/api/arc-flash-incidents/inc-1').send({ assetId: 'asset-b' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'assetId not found' });
    expect(globalThis.__afiUpdates).toHaveLength(0);
  });

  test('unknown ids -> 400, nothing written', async () => {
    const res = await request(app).patch('/api/arc-flash-incidents/inc-1')
      .send({ siteId: 'no-such-site' });
    expect(res.status).toBe(400);
    expect(globalThis.__afiUpdates).toHaveLength(0);
  });

  test('own siteId + assetId -> 200 and the FKs are persisted', async () => {
    const res = await request(app).patch('/api/arc-flash-incidents/inc-1')
      .send({ siteId: 'site-a', assetId: 'asset-a', description: 'updated' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(globalThis.__afiUpdates).toHaveLength(1);
    expect(globalThis.__afiUpdates[0].data.siteId).toBe('site-a');
    expect(globalThis.__afiUpdates[0].data.assetId).toBe('asset-a');
  });

  test('clearing a field (null) skips the ownership lookup and still writes', async () => {
    const res = await request(app).patch('/api/arc-flash-incidents/inc-1').send({ siteId: null });
    expect(res.status).toBe(200);
    expect(globalThis.__afiUpdates).toHaveLength(1);
    expect(globalThis.__afiUpdates[0].data.siteId).toBeNull();
    // No site/asset ownership lookup ran (only the incident findFirst, which
    // is not tracked in __afiLookups).
    expect(globalThis.__afiLookups.filter((l) => l.table === 'site' || l.table === 'asset')).toHaveLength(0);
  });

  test('PATCH stays manager-gated (viewer -> 403)', async () => {
    currentUser = { id: 'user-v', accountId: 'acct-a', role: 'viewer' };
    const res = await request(app).patch('/api/arc-flash-incidents/inc-1').send({ status: 'closed' });
    expect(res.status).toBe(403);
    expect(globalThis.__afiUpdates).toHaveLength(0);
  });
});

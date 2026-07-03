'use strict';

/**
 * Tenant-isolation regression (2026-07-03): GET /api/disaster-events/regional
 * used to run disasterEvent.findMany({ where: { resolvedAt: null } }) with NO
 * account scoping and rely on a hasSites-gated post-filter - so an account
 * with ZERO sites received every tenant's manual declarations. The findMany
 * must now always scope to system broadcasts (accountId null) plus the
 * caller's own declarations, matching the two-bucket scoping in GET /.
 *
 * Mounts the router on a throwaway express app with a stub auth middleware -
 * fully in-memory, no live server / DB. jest.config's moduleNameMapper points
 * the route's '../lib/prisma' at the global stub; we override that mapped
 * module with a fake client (same trick as earlyAccess.test.js).
 */

jest.mock('../lib/prisma', () => {
  // All unresolved. 'ev-foreign' is another tenant's manual declaration - the
  // leak this suite guards against. Filtering honors the where clause the
  // route actually sends (resolvedAt + optional accountId / OR branches).
  const events = [
    { id: 'ev-own', accountId: 'acct-a', eventType: 'manual', severity: 'emergency', title: 'Own declaration', region: 'TX', affectedStates: ['TX'], affectedSiteIds: [], source: 'manual', declaredAt: new Date('2026-07-01T00:00:00Z'), resolvedAt: null },
    { id: 'ev-foreign', accountId: 'acct-b', eventType: 'manual', severity: 'emergency', title: 'Foreign declaration', region: 'FL', affectedStates: ['FL'], affectedSiteIds: [], source: 'manual', declaredAt: new Date('2026-07-02T00:00:00Z'), resolvedAt: null },
    { id: 'ev-system', accountId: null, eventType: 'hurricane', severity: 'warning', title: 'NWS hurricane warning', region: 'FL', affectedStates: ['FL'], affectedSiteIds: ['site-b1', 'site-b2'], source: 'nws', declaredAt: new Date('2026-07-02T12:00:00Z'), resolvedAt: null },
  ];

  const accountOk = (ev, w) => (w.accountId === undefined ? true : ev.accountId === w.accountId);
  const matches = (ev, where) => {
    if (!where) return true;
    if ('resolvedAt' in where && ev.resolvedAt !== where.resolvedAt) return false;
    if (Array.isArray(where.OR) && !where.OR.some((br) => accountOk(ev, br))) return false;
    return accountOk(ev, where);
  };

  globalThis.__deFindManyWheres = [];
  const client = {
    disasterEvent: {
      findMany: async ({ where, take }) => {
        globalThis.__deFindManyWheres.push(where);
        const hit = events.filter((ev) => matches(ev, where));
        return typeof take === 'number' ? hit.slice(0, take) : hit;
      },
    },
    // The requesting account owns ZERO sites - the exact case that leaked.
    site: {
      findMany: async () => [],
      count: async () => 0,
    },
    asset: { count: async () => 0 },
  };
  client.default = client;
  return client;
});

// Pass-through gate: role enforcement is covered in securityAuditFixesA.
jest.mock('../middleware/roles', () => ({
  requireManager: (req, res, next) => next(),
}));

const express = require('express');
const request = require('supertest');

let app;
beforeAll(() => {
  const router = require('../routes/disasterEvents');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 'user-a', accountId: 'acct-a', role: 'manager' };
    next();
  });
  app.use('/api/disaster-events', router);
});

beforeEach(() => { globalThis.__deFindManyWheres.length = 0; });

describe('GET /api/disaster-events/regional - always account-scoped', () => {
  test('zero-site account: other tenants declarations are NOT returned', async () => {
    const res = await request(app).get('/api/disaster-events/regional');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const ids = res.body.data.events.map((e) => e.id);
    expect(ids).not.toContain('ev-foreign'); // the pre-fix leak
    expect(ids).toContain('ev-own');         // own declaration still visible
    expect(ids).toContain('ev-system');      // regional broadcast still visible
  });

  test('findMany where clause itself is scoped (null-account broadcasts + own)', async () => {
    await request(app).get('/api/disaster-events/regional');
    const where = globalThis.__deFindManyWheres[0];
    expect(where).toEqual({
      resolvedAt: null,
      OR: [{ accountId: null }, { accountId: 'acct-a' }],
    });
  });

  test('system events never expose other tenants site ids', async () => {
    const res = await request(app).get('/api/disaster-events/regional');
    const system = res.body.data.events.find((e) => e.id === 'ev-system');
    expect(system).toBeTruthy();
    // Caller owns none of the affected sites, so the global list is stripped.
    expect(system.affectedSiteIds).toEqual([]);
    expect(system.myAffectedSiteCount).toBe(0);
  });
});

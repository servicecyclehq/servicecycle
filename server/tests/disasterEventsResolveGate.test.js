'use strict';

/**
 * Authz regression (2026-07-09 audit): POST /api/disaster-events/:id/resolve
 * gated its tenancy check as `if (event.accountId && event.accountId !==
 * accountId)`, which short-circuits to false whenever event.accountId is
 * null (a system-wide, NWS-detected regional event visible to every
 * affected tenant) -- so the check never ran at all for system events, and
 * ANY manager-role user from ANY account could resolve a shared regional
 * disaster broadcast, hiding it from every other still-affected tenant.
 * The route's own comment said "admins can resolve system events" but the
 * gate was requireManager with no admin-specific branch enforcing that.
 *
 * Fixed: manager can resolve their own account's manual declaration;
 * resolving a system event (accountId===null) now requires req.user.role
 * === 'admin'. This test uses a fake Prisma client (same trick as
 * disasterEventsRegionalScope.test.js) plus a pass-through role gate (real
 * gate enforcement covered by disasterEventsScanAdminGate.test.js's
 * pattern) so we can assert on the route's OWN accountId/role branching,
 * not the requireManager middleware.
 */

jest.mock('../lib/prisma', () => {
  const events = {
    'ev-own': { id: 'ev-own', accountId: 'acct-a', eventType: 'manual', resolvedAt: null },
    'ev-foreign': { id: 'ev-foreign', accountId: 'acct-b', eventType: 'manual', resolvedAt: null },
    'ev-system': { id: 'ev-system', accountId: null, eventType: 'hurricane', resolvedAt: null },
  };

  const client = {
    disasterEvent: {
      findFirst: async ({ where }) => events[where.id] || null,
      update: async ({ where, data }) => {
        events[where.id] = { ...events[where.id], ...data };
        return events[where.id];
      },
    },
  };
  client.default = client;
  return client;
});

// Pass-through gate -- role enforcement for requireManager itself is
// covered elsewhere (disasterEventsScanAdminGate.test.js pattern); this
// suite targets the route's own post-fetch accountId/role branch.
jest.mock('../middleware/roles', () => ({
  requireManager: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));

const express = require('express');
const request = require('supertest');

let currentUser;
let app;
beforeAll(() => {
  const router = require('../routes/disasterEvents');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/disaster-events', router);
});

describe('POST /api/disaster-events/:id/resolve tenancy + role gate', () => {
  test('manager can resolve their own account manual declaration', async () => {
    currentUser = { id: 'u1', accountId: 'acct-a', role: 'manager' };
    const res = await request(app).post('/api/disaster-events/ev-own/resolve');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('manager CANNOT resolve another account manual declaration (403)', async () => {
    currentUser = { id: 'u2', accountId: 'acct-a', role: 'manager' };
    const res = await request(app).post('/api/disaster-events/ev-foreign/resolve');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Not authorised to resolve this event' });
  });

  test('manager CANNOT resolve a system-wide event -- the bug this test guards against (403)', async () => {
    currentUser = { id: 'u3', accountId: 'acct-a', role: 'manager' };
    const res = await request(app).post('/api/disaster-events/ev-system/resolve');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Admin access required to resolve a system-wide event' });
  });

  test('admin CAN resolve a system-wide event', async () => {
    currentUser = { id: 'u4', accountId: 'acct-a', role: 'admin' };
    const res = await request(app).post('/api/disaster-events/ev-system/resolve');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

'use strict';

/**
 * Role-gate regression (2026-07-03 acquisition scan, Scan 3):
 * POST /api/disaster-events/scan documented itself as "admin only" but was
 * gated requireManager. The gate is now requireAdmin, matching the comment
 * (the scan is an account-agnostic system action that hits the NWS API for
 * every tenant's sites; no client code calls it).
 *
 * The REAL middleware/roles is used so the 403s below are the genuine gate
 * (companion to disasterEventsRegionalScope.test.js, which pass-through-mocks
 * the gates to test tenancy).
 */

jest.mock('../lib/weatherScanner', () => ({
  runWeatherScanner: jest.fn(async () => ({ eventsCreated: 0, eventsResolved: 0 })),
}));
// The roles middleware writes permission_denied entries; keep them out of the DB.
jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));

const express = require('express');
const request = require('supertest');
const { runWeatherScanner } = require('../lib/weatherScanner');

let currentUser;
let app;
beforeAll(() => {
  const router = require('../routes/disasterEvents');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/disaster-events', router);
});

beforeEach(() => {
  runWeatherScanner.mockClear();
});

describe('POST /api/disaster-events/scan is admin-only', () => {
  test.each(['manager', 'viewer', 'consultant'])('%s -> 403, scanner never runs', async (role) => {
    currentUser = { id: `user-${role}`, accountId: 'acct-a', role };
    const res = await request(app).post('/api/disaster-events/scan');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Admin access required' });
    expect(runWeatherScanner).not.toHaveBeenCalled();
  });

  test('admin -> 200 and the scanner runs', async () => {
    currentUser = { id: 'user-admin', accountId: 'acct-a', role: 'admin' };
    const res = await request(app).post('/api/disaster-events/scan');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(runWeatherScanner).toHaveBeenCalledTimes(1);
  });
});

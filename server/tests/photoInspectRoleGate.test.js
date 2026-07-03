'use strict';

/**
 * RBAC regression (2026-07-03 acquisition scan, Scan 3):
 * POST /api/assets/photo-inspect had no role gate -- any authenticated viewer
 * (or consultant) could persist a photo into storage and create a Document
 * row. It is now requireManager, matching the sibling document-write routes.
 * Field capture is unaffected: field_tech is default-denied off /api/assets
 * entirely by the lib/fieldRoleScope chokepoint, so it never could call this
 * endpoint. /ocr-nameplate stays ungated (persists nothing).
 *
 * The REAL middleware/roles is used. AI_ENABLED=false turns the aiPreGate
 * into a probe: a 503 ai_disabled response proves the request got PAST the
 * role gate without needing multipart/vision plumbing.
 */

process.env.AI_ENABLED = 'false';

// AI/storage plumbing is irrelevant to the gate under test; the module
// requires these at load.
jest.mock('../lib/aiConsent', () => ({ ensureAiConsent: jest.fn(async () => true) }));
jest.mock('../lib/aiBudgetGuard', () => ({ ensureAiBudget: jest.fn(() => true) }));
jest.mock('../lib/aiQuota', () => ({
  checkAndIncrement: jest.fn(async () => ({ ok: true, count: 0, cap: 3 })),
  refundIncrement: jest.fn(),
}));
jest.mock('../middleware/aiIpLimit', () => ({ aiIpLimiter: (req, res, next) => next() }));
jest.mock('../lib/photoInspect', () => ({ buildInspectContext: jest.fn(), inspectPhoto: jest.fn() }));
jest.mock('../lib/storage', () => ({ uploadFile: jest.fn() }));
jest.mock('../lib/extractionTelemetry', () => ({ recordExtraction: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));

const express = require('express');
const request = require('supertest');

let currentUser;
let app;
beforeAll(() => {
  const router = require('../routes/assetPhotoInspect');
  app = express();
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/assets', router);
});

afterAll(() => { delete process.env.AI_ENABLED; });

describe('POST /api/assets/photo-inspect is manager-gated', () => {
  test.each(['viewer', 'consultant'])('%s -> 403 (never reaches the AI gates)', async (role) => {
    currentUser = { id: `user-${role}`, accountId: 'acct-a', role };
    const res = await request(app).post('/api/assets/photo-inspect');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Manager or admin access required' });
  });

  test.each(['manager', 'admin'])('%s passes the role gate (hits the AI kill-switch -> 503 ai_disabled)', async (role) => {
    currentUser = { id: `user-${role}`, accountId: 'acct-a', role };
    const res = await request(app).post('/api/assets/photo-inspect');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('ai_disabled');
  });
});

describe('POST /api/assets/ocr-nameplate is intentionally NOT role-gated', () => {
  test('viewer reaches the AI gates (503 ai_disabled, not 403)', async () => {
    currentUser = { id: 'user-viewer', accountId: 'acct-a', role: 'viewer' };
    const res = await request(app).post('/api/assets/ocr-nameplate');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('ai_disabled');
  });
});

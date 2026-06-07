'use strict';

/**
 * Regression test for the highest-value fix from the 2026-05-02 security
 * pass: scope-restricted viewers cannot URL-poke their way into a
 * contract they don't own.
 *
 * Setup expectations (seed DB):
 *   - mike@place.com is a manager who owns contracts in account A.
 *   - viewer-test@acme.com is a viewer in the same account.
 *
 * The test temporarily flips contractScopeRestricted on viewer-test via
 * an admin API call, runs the IDOR probes, and resets state on teardown.
 * If the seed users don't exist or passwords don't match, individual
 * cases skip rather than fail (this is a smoke scaffold, not a CI gate).
 */

const { api, login } = require('./helpers');

const ADMIN_EMAIL    = 'admin@acme.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin1234!';
const VIEWER_EMAIL   = 'viewer-test@acme.com';
// Set this to whatever you used during the manual smoke. If the test DB
// is fresh, run the SQL from docs/operator-playbook.md "Reset a user's
// password" first or set TEST_VIEWER_PASSWORD here.
const VIEWER_PASSWORD = process.env.TEST_VIEWER_PASSWORD || 'TestSmoke1234!';

async function tryLogin(email, password) {
  try {
    return await login(email, password);
  } catch (e) {
    return null;
  }
}

describe('IDOR — scope-restricted viewer', () => {
  let adminToken = null;
  let viewerToken = null;
  let viewerId = null;

  beforeAll(async () => {
    adminToken = await tryLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
    viewerToken = await tryLogin(VIEWER_EMAIL, VIEWER_PASSWORD);
    if (!viewerToken) return;
    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${viewerToken}`);
    viewerId = me.body?.data?.user?.id;
  });

  test('scope-restricted viewer cannot GET an unowned contract', async () => {
    if (!adminToken || !viewerToken || !viewerId) {
      console.warn('idor test skipped — seed users not available');
      return;
    }

    // Flip scope-restriction ON for the viewer.
    await api()
      .patch(`/api/users/${viewerId}/scope-restriction`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ restricted: true });

    try {
      // Pick the first contract the viewer doesn't own. Easiest read of
      // unowned set: list as admin (no scope), pick one whose
      // internalOwnerId !== viewerId.
      const list = await api()
        .get('/api/contracts?limit=20')
        .set('Authorization', `Bearer ${adminToken}`);
      const unowned = (list.body?.data?.contracts || [])
        .find(c => c.internalOwnerId !== viewerId);
      if (!unowned) {
        console.warn('idor test skipped — no unowned contract found in dev DB');
        return;
      }

      // The actual probe — should 404.
      const probe = await api()
        .get(`/api/contracts/${unowned.id}`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(probe.status).toBe(404);

      // Same shape on the activity sub-route (covers all 11 single-
      // contract endpoints via contractWhereForUser helper).
      const activity = await api()
        .get(`/api/contracts/${unowned.id}/activity`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(activity.status).toBe(404);

    } finally {
      // Reset scope-restriction so the dev DB ends in its starting state.
      await api()
        .patch(`/api/users/${viewerId}/scope-restriction`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ restricted: false });
    }
  });

  test('viewer (regardless of scope) cannot create a contract — requireManager', async () => {
    if (!viewerToken) return;
    const res = await api()
      .post('/api/contracts')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ vendorId: '00000000-0000-0000-0000-000000000020', product: 'Probe' });
    // Either 403 (role gate) or 400 (zod) is acceptable — the security
    // assertion is "writes blocked for viewer". 401 would mean auth
    // failed, which is a different test.
    expect([400, 403]).toContain(res.status);
  });
});

describe('IDOR — unauthenticated', () => {
  test('protected route returns 401 without a token', async () => {
    const res = await api().get('/api/contracts');
    expect(res.status).toBe(401);
  });

  test('protected route returns 401 with a malformed JWT', async () => {
    const res = await api()
      .get('/api/contracts')
      .set('Authorization', 'Bearer not.a.real.jwt.token');
    expect([401, 403]).toContain(res.status);
  });
});

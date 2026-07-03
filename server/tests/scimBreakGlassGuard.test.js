'use strict';

/**
 * SCIM break-glass guard (2026-07-03 acquisition scan, Scan 3):
 * a SCIM user event matching a local admin used to set ssoManaged:true
 * unconditionally. routes/auth.ts treats role==='admin' && !ssoManaged as the
 * sso_break_glass_login identity and routes/ssoAdmin.ts requires >= 1 such
 * active admin before sso.required can be enabled -- so a misconfigured IdP
 * could strip the account's LAST password-capable admin and lock everyone out
 * of password login. The guard suppresses the flip on the last such admin and
 * writes a warning-grade scim_break_glass_flip_suppressed activity entry.
 *
 * In-memory express + fake prisma; scim signature plumbing is mocked so the
 * suite drives processEvent through the real webhook route.
 */

jest.mock('../lib/prisma', () => {
  globalThis.__scimUserUpdates = [];
  globalThis.__scimUserCounts = [];
  const client = {
    scimEvent: { findUnique: async () => null, upsert: async () => ({}) },
    scimDirectory: {
      findUnique: async ({ where }) =>
        where.polisDirectoryId === 'pd-1' ? { id: 'dir-1', accountId: 'acct-a', isActive: true } : null,
    },
    ssoRoleMapping: { findMany: async () => [] },
    user: {
      findUnique: async ({ where }) => {
        if (where.scimDirectoryId_scimExternalId) return null; // force the email match path
        if (where.email) return globalThis.__scimLocalUser && globalThis.__scimLocalUser.email === where.email
          ? { ...globalThis.__scimLocalUser } : null;
        return null;
      },
      count: async ({ where }) => {
        globalThis.__scimUserCounts.push(where);
        return globalThis.__scimOtherBreakGlassAdmins;
      },
      update: async ({ where, data }) => {
        globalThis.__scimUserUpdates.push({ where, data });
        return { ...globalThis.__scimLocalUser, ...data };
      },
      create: async ({ data }) => ({ id: 'u-new', ...data }),
    },
  };
  client.default = client;
  return client;
});

jest.mock('../lib/ssoConfig', () => ({ getSsoConfig: () => ({ scimWebhookSecret: 'test-secret' }) }));
jest.mock('../lib/scim', () => {
  let n = 0;
  return {
    verifyScimSignature: () => ({ valid: true, t: Date.now() }),
    isFreshTimestamp: () => true,
    computeEventKey: () => `key-${++n}`,
    normalizeScimEvent: (raw) => raw,
    toEventList: (body) => (Array.isArray(body) ? body : [body]),
  };
});
jest.mock('../lib/ssoRoleMap', () => ({ mapClaimsToRole: () => 'viewer' }));
jest.mock('../lib/ssoPkce', () => ({ randomToken: () => 'tok' }));
jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));

const express = require('express');
const request = require('supertest');
const { writeLog } = require('../lib/activityLog');

let app;
beforeAll(() => {
  const router = require('../routes/ssoScim');
  app = express();
  app.use('/api/sso/scim',
    express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }),
    router);
});

beforeEach(() => {
  globalThis.__scimUserUpdates.length = 0;
  globalThis.__scimUserCounts.length = 0;
  globalThis.__scimOtherBreakGlassAdmins = 0;
  globalThis.__scimLocalUser = null;
  writeLog.mockClear();
});

function adminEvent(email) {
  return {
    kind: 'user', type: 'user.updated', active: true,
    scimUserId: 'scim-1', email,
    firstName: 'Root', lastName: 'Admin',
    polisDirectoryId: 'pd-1', raw: {},
  };
}

async function post(ev) {
  return request(app).post('/api/sso/scim/webhook')
    .set('Content-Type', 'application/json')
    .set('BoxyHQ-Signature', 't=1,s=mocked')
    .send(ev);
}

describe('SCIM update matching a local admin - break-glass guard', () => {
  test('LAST password-capable admin: ssoManaged flip is suppressed + warning logged', async () => {
    globalThis.__scimLocalUser = { id: 'u-admin', accountId: 'acct-a', email: 'root@a.test', role: 'admin', ssoManaged: false, isActive: true, scimExternalId: null };
    globalThis.__scimOtherBreakGlassAdmins = 0;

    const res = await post(adminEvent('root@a.test'));
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);

    expect(globalThis.__scimUserUpdates).toHaveLength(1);
    const { data } = globalThis.__scimUserUpdates[0];
    expect(data).not.toHaveProperty('ssoManaged'); // the flip was suppressed
    expect(data.isActive).toBe(true);              // the rest of the update still applies
    expect(data.scimDirectoryId).toBe('dir-1');    // identity linking still applies

    // The count checked exactly the break-glass invariant, excluding this user.
    expect(globalThis.__scimUserCounts).toHaveLength(1);
    expect(globalThis.__scimUserCounts[0]).toEqual({
      accountId: 'acct-a', role: 'admin', isActive: true, ssoManaged: false, id: { not: 'u-admin' },
    });

    const suppressed = writeLog.mock.calls.map((c) => c[0]).find((e) => e.action === 'scim_break_glass_flip_suppressed');
    expect(suppressed).toBeTruthy();
    expect(suppressed.userId).toBe('u-admin');
    expect(suppressed.accountId).toBe('acct-a');
    expect(suppressed.details.reason).toBe('last_password_capable_admin');
  });

  test('another break-glass admin remains: the flip proceeds, no warning', async () => {
    globalThis.__scimLocalUser = { id: 'u-admin', accountId: 'acct-a', email: 'root@a.test', role: 'admin', ssoManaged: false, isActive: true, scimExternalId: null };
    globalThis.__scimOtherBreakGlassAdmins = 1;

    const res = await post(adminEvent('root@a.test'));
    expect(res.status).toBe(200);

    expect(globalThis.__scimUserUpdates).toHaveLength(1);
    expect(globalThis.__scimUserUpdates[0].data.ssoManaged).toBe(true);
    const suppressed = writeLog.mock.calls.map((c) => c[0]).find((e) => e.action === 'scim_break_glass_flip_suppressed');
    expect(suppressed).toBeUndefined();
  });

  test('non-admin user: flip proceeds and the invariant count is never consulted', async () => {
    globalThis.__scimLocalUser = { id: 'u-view', accountId: 'acct-a', email: 'v@a.test', role: 'viewer', ssoManaged: false, isActive: true, scimExternalId: null };

    const res = await post(adminEvent('v@a.test'));
    expect(res.status).toBe(200);
    expect(globalThis.__scimUserUpdates[0].data.ssoManaged).toBe(true);
    expect(globalThis.__scimUserCounts).toHaveLength(0);
  });

  test('already-SSO-managed admin: no guard needed, flip re-applied idempotently', async () => {
    globalThis.__scimLocalUser = { id: 'u-admin', accountId: 'acct-a', email: 'root@a.test', role: 'admin', ssoManaged: true, isActive: true, scimExternalId: 'scim-1' };

    const res = await post(adminEvent('root@a.test'));
    expect(res.status).toBe(200);
    expect(globalThis.__scimUserUpdates[0].data.ssoManaged).toBe(true);
    expect(globalThis.__scimUserCounts).toHaveLength(0);
  });
});

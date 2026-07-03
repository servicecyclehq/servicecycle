'use strict';

/**
 * POST /api/demo/switch-role -- the demo "view as" switcher's hard gates.
 *
 * Fully in-memory (same pattern as disasterEventsRegionalScope.test.js /
 * oemTargetAccountScope.test.js): the router is mounted on a throwaway
 * express app with a stub auth middleware, prisma is a fake keyed off the
 * exact where-clause the route sends, and routes/auth is mocked so token
 * issuance doesn't pull the full auth module (email, limiters, live DB).
 *
 * Gates under test:
 *   1. DEMO_MODE !== 'true'            -> 403
 *   2. caller outside the demo tenant  -> 403 (per-visitor sandboxes too)
 *   3. unknown / missing role keyword  -> 400
 *   4. target = fixed server-side map  -> body-supplied emails are ignored
 *      (arbitrary-target switching impossible by construction)
 *   5. missing / inactive target       -> 404;  2FA-enabled target -> 409
 */

const DEMO_ACCOUNT_ID         = '11111111-1111-4111-8111-111111111111';
const PARTNER_HOME_ACCOUNT_ID = '22222222-0000-4000-8000-000000000000';

// Fake user table + captured where-clauses (Gate-3/4 construction proof).
const seedUsers = [];
jest.mock('../lib/prisma', () => {
  globalThis.__findFirstWheres = [];
  const client = {
    user: {
      findFirst: async ({ where }) => {
        globalThis.__findFirstWheres.push(where);
        const hit = seedUsers.find(
          (u) => u.email === where.email &&
                 u.accountId === where.accountId &&
                 u.isActive === where.isActive
        );
        return hit ? { ...hit } : null;
      },
    },
  };
  client.default = client;
  return client;
});

// Token issuance is routes/auth's job; here we only assert the route calls it
// with the TARGET user's id + accountId (never the caller's, never body input).
const issueTokenPair = jest.fn(async () => ({
  accessToken:    'test-access-token',
  refreshToken:   'test-refresh-token',
  refreshTokenId: 'rt-1',
}));
jest.mock('../routes/auth', () => ({ issueTokenPair }));

const writeLog = jest.fn(async () => {});
jest.mock('../lib/activityLog', () => ({ writeLog }));

const express = require('express');
const request = require('supertest');

const ORIG_DEMO_MODE = process.env.DEMO_MODE;

// Mutable caller identity: each test picks who the calling session is.
let caller;

let app;
beforeAll(() => {
  process.env.DEMO_MODE = 'true';
  const router = require('../routes/demo');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = caller; next(); });
  app.use('/api/demo', router);
});

afterAll(() => {
  process.env.DEMO_MODE = ORIG_DEMO_MODE;
});

beforeEach(() => {
  process.env.DEMO_MODE = 'true';
  caller = { id: 'u-demo-admin', accountId: DEMO_ACCOUNT_ID, email: 'admin@demo.local', role: 'admin' };
  seedUsers.length = 0;
  seedUsers.push(
    { id: 'u-demo-admin',   accountId: DEMO_ACCOUNT_ID,         email: 'admin@demo.local',          name: 'Avery Sandoval', role: 'admin',      isActive: true, twoFactorEnabled: false },
    { id: 'u-demo-manager', accountId: DEMO_ACCOUNT_ID,         email: 'manager@demo.local',        name: 'Marcus Webb',    role: 'manager',    isActive: true, twoFactorEnabled: false },
    { id: 'u-demo-tech',    accountId: DEMO_ACCOUNT_ID,         email: 'tech@demo.local',           name: 'Terry Vance',    role: 'field_tech', isActive: true, twoFactorEnabled: false },
    { id: 'u-apex-sam',     accountId: PARTNER_HOME_ACCOUNT_ID, email: 'sam.carter@apexpower.demo', name: 'Sam Carter',     role: 'oem_admin',  isActive: true, twoFactorEnabled: false },
  );
  globalThis.__findFirstWheres.length = 0;
  issueTokenPair.mockClear();
  writeLog.mockClear();
});

const post = (body) => request(app).post('/api/demo/switch-role').send(body);

describe('Gate 1 - DEMO_MODE required', () => {
  test('403 when DEMO_MODE is not true (no lookup, no tokens)', async () => {
    process.env.DEMO_MODE = 'false';
    const res = await post({ role: 'manager' });
    expect(res.status).toBe(403);
    expect(globalThis.__findFirstWheres).toHaveLength(0);
    expect(issueTokenPair).not.toHaveBeenCalled();
  });
});

describe('Gate 2 - caller must be inside the shared demo tenant', () => {
  test('403 for a non-demo account caller (per-visitor sandbox admin)', async () => {
    caller = { id: 'u-sandbox', accountId: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'visitor@sandbox.test', role: 'admin' };
    const res = await post({ role: 'admin' });
    expect(res.status).toBe(403);
    expect(issueTokenPair).not.toHaveBeenCalled();
  });

  test('partner home-account caller may switch back to a demo role', async () => {
    caller = { id: 'u-apex-sam', accountId: PARTNER_HOME_ACCOUNT_ID, email: 'sam.carter@apexpower.demo', role: 'oem_admin' };
    const res = await post({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('admin@demo.local');
  });
});

describe('Gate 3 - fixed role keywords only', () => {
  test('400 for an unknown role keyword', async () => {
    const res = await post({ role: 'super_admin' });
    expect(res.status).toBe(400);
    expect(issueTokenPair).not.toHaveBeenCalled();
  });

  test('400 when role is missing / not a string', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ role: { admin: true } })).status).toBe(400);
  });
});

describe('Gate 4 - target pinned server-side (arbitrary email impossible)', () => {
  test('body-supplied email/accountId are ignored; lookup uses the fixed map', async () => {
    const res = await post({
      role:      'manager',
      email:     'attacker@evil.test',          // must be ignored
      accountId: 'bbbbbbbb-0000-4000-8000-000000000002', // must be ignored
    });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('manager@demo.local');
    // The prisma where-clause is exactly the pinned pair + isActive.
    expect(globalThis.__findFirstWheres).toHaveLength(1);
    expect(globalThis.__findFirstWheres[0]).toMatchObject({
      email:     'manager@demo.local',
      accountId: DEMO_ACCOUNT_ID,
      isActive:  true,
    });
  });

  test('partner keyword resolves to sam.carter on the Apex home account', async () => {
    const res = await post({ role: 'partner' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('sam.carter@apexpower.demo');
    expect(globalThis.__findFirstWheres[0]).toMatchObject({
      email:     'sam.carter@apexpower.demo',
      accountId: PARTNER_HOME_ACCOUNT_ID,
    });
  });
});

describe('Gate 5 - target state checks', () => {
  test('404 when the seeded target is missing', async () => {
    seedUsers.splice(seedUsers.findIndex((u) => u.email === 'manager@demo.local'), 1);
    const res = await post({ role: 'manager' });
    expect(res.status).toBe(404);
    expect(issueTokenPair).not.toHaveBeenCalled();
  });

  test('404 when the seeded target was deactivated (isActive filter)', async () => {
    seedUsers.find((u) => u.email === 'manager@demo.local').isActive = false;
    const res = await post({ role: 'manager' });
    expect(res.status).toBe(404);
  });

  test('409 when the target enabled 2FA (never bypass a challenge)', async () => {
    seedUsers.find((u) => u.email === 'manager@demo.local').twoFactorEnabled = true;
    const res = await post({ role: 'manager' });
    expect(res.status).toBe(409);
    expect(issueTokenPair).not.toHaveBeenCalled();
  });
});

describe('happy path - login-equivalent session for the target', () => {
  test('issues tokens for the TARGET id/account and audits the switch', async () => {
    const res = await post({ role: 'field_tech' });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBe('test-access-token');
    expect(res.body.data.refreshToken).toBe('test-refresh-token');
    expect(res.body.data.user.email).toBe('tech@demo.local');
    // never leaked in the response
    expect(res.body.data.user.twoFactorEnabled).toBeUndefined();
    expect(res.body.data.user.passwordHash).toBeUndefined();

    expect(issueTokenPair).toHaveBeenCalledWith('u-demo-tech', DEMO_ACCOUNT_ID);

    expect(writeLog).toHaveBeenCalledTimes(1);
    expect(writeLog.mock.calls[0][0]).toMatchObject({
      action:    'demo_role_switched',
      userId:    'u-demo-admin',       // the ACTOR, not the target
      accountId: DEMO_ACCOUNT_ID,
      details:   expect.objectContaining({
        toRole:   'field_tech',
        toEmail:  'tech@demo.local',
        toUserId: 'u-demo-tech',
      }),
    });
  });
});

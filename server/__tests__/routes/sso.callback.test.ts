/**
 * SSO callback: state CSRF (single-use / replay / expired), provisioning,
 * role mapping, and cross-tenant isolation. The Polis client is mocked so the
 * test controls the token + userinfo without a live broker. Integration (real DB).
 */
process.env.SSO_ENABLED = 'true';
process.env.POLIS_BASE_URL = 'http://localhost:5225';
process.env.POLIS_API_KEY = 'test-api-key';
process.env.SCIM_WEBHOOK_SECRET = 'fixture-webhook-secret';
process.env.SSO_CALLBACK_URL = 'http://app.test/api/sso/callback';
process.env.ACCOUNT_FEATURE_SSO = 'true';
process.env.SSO_JIT_PROVISIONING = 'true';

jest.mock('../../lib/ssoPolis', () => ({
  exchangeCodeForToken: jest.fn(),
  fetchUserInfo: jest.fn(),
  getOidcDiscovery: jest.fn(),
  buildAuthorizeUrl: jest.fn(() => 'http://polis/authorize'),
  adminCreateSamlConnection: jest.fn(),
  adminCreateOidcConnection: jest.fn(),
  adminCreateDirectory: jest.fn(),
  adminListConnections: jest.fn(),
  adminListDirectories: jest.fn(),
  adminDeleteConnection: jest.fn(),
  adminDeleteDirectory: jest.fn(),
}));

import request from 'supertest';
import { randomBytes } from 'crypto';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const ssoPolis = require('../../lib/ssoPolis');

let app: any;
let prisma: any;
let adminA: TestUser, adminB: TestUser;
let connA: any;
const createdUserIds: string[] = [];

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  adminA = await createTestUser('admin');
  adminB = await createTestUser('admin');
  connA = await prisma.ssoConnection.create({ data: { accountId: adminA.accountId, protocol: 'saml', polisTenant: `acct_${adminA.accountId}` } });
});

beforeEach(() => {
  ssoPolis.exchangeCodeForToken.mockReset();
  ssoPolis.fetchUserInfo.mockReset();
  ssoPolis.exchangeCodeForToken.mockResolvedValue({ access_token: 'tok', token_type: 'bearer' }); // no id_token
});

afterAll(async () => {
  try { await prisma.ssoHandoff.deleteMany({ where: { accountId: { in: [adminA.accountId, adminB.accountId] } } }); } catch {}
  try { await prisma.ssoLoginState.deleteMany({ where: { accountId: { in: [adminA.accountId, adminB.accountId] } } }); } catch {}
  try { await prisma.ssoRoleMapping.deleteMany({ where: { accountId: adminA.accountId } }); } catch {}
  for (const id of createdUserIds) { try { await prisma.user.delete({ where: { id } }); } catch {} }
  try { await prisma.ssoConnection.deleteMany({ where: { accountId: adminA.accountId } }); } catch {}
  try { await prisma.user.delete({ where: { id: adminA.id } }); } catch {}
  try { await prisma.user.delete({ where: { id: adminB.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: adminA.accountId } }); } catch {}
  try { await prisma.account.delete({ where: { id: adminB.accountId } }); } catch {}
  await prisma.$disconnect();
});

async function makeState(opts: { expired?: boolean } = {}) {
  const state = 's_' + randomBytes(12).toString('hex');
  return prisma.ssoLoginState.create({
    data: {
      state, nonce: 'n_' + randomBytes(8).toString('hex'), codeVerifier: 'v_' + randomBytes(8).toString('hex'),
      accountId: adminA.accountId, connectionId: connA.id, redirectTo: '/dashboard',
      expiresAt: new Date(Date.now() + (opts.expired ? -1000 : 600000)),
    },
  });
}

test('happy path: provisions a JIT user (default viewer) + issues a handoff', async () => {
  const email = `jit-${randomBytes(6).toString('hex')}@a.test`;
  ssoPolis.fetchUserInfo.mockResolvedValue({ id: 'p1', email, firstName: 'Jit', lastName: 'User', requested: { tenant: `acct_${adminA.accountId}` } });
  const st = await makeState();

  const res = await request(app).get('/api/sso/callback').query({ code: 'c', state: st.state });
  expect(res.status).toBe(302);
  expect(res.headers.location).toContain('/sso/callback?code=');

  const user = await prisma.user.findUnique({ where: { email } });
  expect(user).toBeTruthy();
  createdUserIds.push(user.id);
  expect(user.accountId).toBe(adminA.accountId);
  expect(user.role).toBe('viewer');
  expect(user.ssoManaged).toBe(true);
  const handoffs = await prisma.ssoHandoff.findMany({ where: { userId: user.id } });
  expect(handoffs.length).toBe(1);
});

test('role mapping: group -> manager applied to a new SSO user', async () => {
  await prisma.ssoRoleMapping.create({ data: { accountId: adminA.accountId, idpGroup: 'Engineering', role: 'manager' } });
  const email = `eng-${randomBytes(6).toString('hex')}@a.test`;
  ssoPolis.fetchUserInfo.mockResolvedValue({ id: 'p2', email, firstName: 'Eng', lastName: 'Lead', groups: ['Engineering'], requested: { tenant: `acct_${adminA.accountId}` } });
  const st = await makeState();
  await request(app).get('/api/sso/callback').query({ code: 'c', state: st.state });
  const user = await prisma.user.findUnique({ where: { email } });
  createdUserIds.push(user.id);
  expect(user.role).toBe('manager');
});

test('state is single-use: replaying the same state is rejected', async () => {
  const email = `once-${randomBytes(6).toString('hex')}@a.test`;
  ssoPolis.fetchUserInfo.mockResolvedValue({ id: 'p3', email, requested: { tenant: `acct_${adminA.accountId}` } });
  const st = await makeState();
  const first = await request(app).get('/api/sso/callback').query({ code: 'c', state: st.state });
  expect(first.status).toBe(302);
  expect(first.headers.location).toContain('/sso/callback?code=');
  const u = await prisma.user.findUnique({ where: { email } }); if (u) createdUserIds.push(u.id);

  const replay = await request(app).get('/api/sso/callback').query({ code: 'c', state: st.state });
  expect(replay.headers.location).toContain('/login?sso_error=unavailable');
});

test('expired state -> generic redirect', async () => {
  ssoPolis.fetchUserInfo.mockResolvedValue({ id: 'p4', email: 'x@a.test', requested: { tenant: `acct_${adminA.accountId}` } });
  const st = await makeState({ expired: true });
  const res = await request(app).get('/api/sso/callback').query({ code: 'c', state: st.state });
  expect(res.headers.location).toContain('/login?sso_error=unavailable');
});

test('unknown state -> generic redirect', async () => {
  const res = await request(app).get('/api/sso/callback').query({ code: 'c', state: 'nope-not-real' });
  expect(res.headers.location).toContain('/login?sso_error=unavailable');
});

test('CROSS-TENANT: identity that already belongs to account B is blocked', async () => {
  // Pre-create a user with this email in account B.
  const email = `inB-${randomBytes(6).toString('hex')}@a.test`;
  const bUser = await createTestUser('viewer', { accountId: adminB.accountId, email });
  createdUserIds.push(bUser.id);
  ssoPolis.fetchUserInfo.mockResolvedValue({ id: 'pX', email, requested: { tenant: `acct_${adminA.accountId}` } });
  const st = await makeState();

  const res = await request(app).get('/api/sso/callback').query({ code: 'c', state: st.state });
  expect(res.headers.location).toContain('/login?sso_error=unavailable');
  // B's user is untouched and no handoff was issued for them.
  const stillB = await prisma.user.findUnique({ where: { email } });
  expect(stillB.accountId).toBe(adminB.accountId);
  const handoffs = await prisma.ssoHandoff.findMany({ where: { userId: bUser.id } });
  expect(handoffs.length).toBe(0);
});

test('requested.tenant mismatch -> rejected', async () => {
  ssoPolis.fetchUserInfo.mockResolvedValue({ id: 'pM', email: `mm-${randomBytes(5).toString('hex')}@a.test`, requested: { tenant: 'acct_someone_else' } });
  const st = await makeState();
  const res = await request(app).get('/api/sso/callback').query({ code: 'c', state: st.state });
  expect(res.headers.location).toContain('/login?sso_error=unavailable');
});

test('JIT disabled -> unknown user blocked, no account created', async () => {
  process.env.SSO_JIT_PROVISIONING = '';
  const email = `nojit-${randomBytes(6).toString('hex')}@a.test`;
  ssoPolis.fetchUserInfo.mockResolvedValue({ id: 'pNJ', email, requested: { tenant: `acct_${adminA.accountId}` } });
  const st = await makeState();
  const res = await request(app).get('/api/sso/callback').query({ code: 'c', state: st.state });
  expect(res.headers.location).toContain('/login?sso_error=unavailable');
  const u = await prisma.user.findUnique({ where: { email } });
  expect(u).toBeNull();
  process.env.SSO_JIT_PROVISIONING = 'true';
});

export {};

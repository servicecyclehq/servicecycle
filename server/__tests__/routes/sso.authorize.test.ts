/**
 * SSO authorize: email-domain -> account+connection discovery, PKCE/state row
 * creation, redirect to Polis with the correct (account-derived) tenant.
 * Cross-tenant: domain A and domain B resolve only to their own account.
 * Integration (real DB).
 */
process.env.SSO_ENABLED = 'true';
process.env.POLIS_BASE_URL = 'http://localhost:5225';
process.env.POLIS_EXTERNAL_URL = 'http://localhost:5225';
process.env.POLIS_API_KEY = 'test-api-key';
process.env.SCIM_WEBHOOK_SECRET = 'fixture-webhook-secret';
process.env.SSO_CALLBACK_URL = 'http://app.test/api/sso/callback';
process.env.ACCOUNT_FEATURE_SSO = 'true';

import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
const toDelete: Array<{ model: string; id: string }> = [];

let adminA: TestUser, adminB: TestUser;
let connA: any, connB: any;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;

  adminA = await createTestUser('admin');
  adminB = await createTestUser('admin');
  toDelete.push({ model: 'user', id: adminA.id }, { model: 'user', id: adminB.id });

  connA = await prisma.ssoConnection.create({ data: { accountId: adminA.accountId, protocol: 'saml', polisTenant: `acct_${adminA.accountId}`, polisProduct: 'servicecycle' } });
  connB = await prisma.ssoConnection.create({ data: { accountId: adminB.accountId, protocol: 'saml', polisTenant: `acct_${adminB.accountId}`, polisProduct: 'servicecycle' } });
  await prisma.ssoDomain.create({ data: { domain: `tenanta-${Date.now()}.test`, accountId: adminA.accountId, connectionId: connA.id } });
  await prisma.ssoDomain.create({ data: { domain: `tenantb-${Date.now()}.test`, accountId: adminB.accountId, connectionId: connB.id } });
});

afterAll(async () => {
  // cascade: deleting connection removes its domains + login states; account removes the rest
  try { await prisma.ssoLoginState.deleteMany({ where: { accountId: { in: [adminA.accountId, adminB.accountId] } } }); } catch {}
  try { await prisma.ssoConnection.deleteMany({ where: { accountId: { in: [adminA.accountId, adminB.accountId] } } }); } catch {}
  for (const { model, id } of toDelete.reverse()) { try { await (prisma as any)[model].delete({ where: { id } }); } catch {} }
  try { await prisma.account.delete({ where: { id: adminA.accountId } }); } catch {}
  try { await prisma.account.delete({ where: { id: adminB.accountId } }); } catch {}
  await prisma.$disconnect();
});

async function domainFor(accountId: string): Promise<string> {
  const d = await prisma.ssoDomain.findFirst({ where: { accountId } });
  return d.domain;
}

test('known domain -> 302 to Polis with the account-derived tenant + a state row', async () => {
  const domain = await domainFor(adminA.accountId);
  const res = await request(app).get('/api/sso/authorize').query({ email: `user@${domain}`, next: '/assets' });
  expect(res.status).toBe(302);
  expect(res.headers.location).toContain('http://localhost:5225/api/oauth/authorize');
  expect(res.headers.location).toContain(`tenant=${encodeURIComponent(`acct_${adminA.accountId}`)}`);
  expect(res.headers.location).toContain('code_challenge_method=S256');

  const states = await prisma.ssoLoginState.findMany({ where: { accountId: adminA.accountId } });
  expect(states.length).toBeGreaterThanOrEqual(1);
  expect(states[0].connectionId).toBe(connA.id);
  expect(states[0].redirectTo).toBe('/assets');
});

test('unknown domain -> generic redirect (no enumeration)', async () => {
  const res = await request(app).get('/api/sso/authorize').query({ email: 'user@nobody-here.test' });
  expect(res.status).toBe(302);
  expect(res.headers.location).toContain('/login?sso_error=unavailable');
});

test('CROSS-TENANT: domain B resolves only into account B, never A', async () => {
  const domainB = await domainFor(adminB.accountId);
  const res = await request(app).get('/api/sso/authorize').query({ email: `user@${domainB}` });
  expect(res.status).toBe(302);
  expect(res.headers.location).toContain(`tenant=${encodeURIComponent(`acct_${adminB.accountId}`)}`);
  expect(res.headers.location).not.toContain(`acct_${adminA.accountId}`);

  const stateB = await prisma.ssoLoginState.findFirst({ where: { accountId: adminB.accountId }, orderBy: { createdAt: 'desc' } });
  expect(stateB.accountId).toBe(adminB.accountId);
  expect(stateB.connectionId).toBe(connB.id);
});

test('open-redirect guard: external next is dropped to /dashboard', async () => {
  const domain = await domainFor(adminA.accountId);
  await request(app).get('/api/sso/authorize').query({ email: `user@${domain}`, next: 'https://evil.test/x' });
  const st = await prisma.ssoLoginState.findFirst({ where: { accountId: adminA.accountId }, orderBy: { createdAt: 'desc' } });
  expect(st.redirectTo).toBe('/dashboard');
});

export {};

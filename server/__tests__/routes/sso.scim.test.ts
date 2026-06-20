/**
 * SCIM webhook: create/update/deactivate idempotency + replay, mandatory HMAC
 * signature, cross-directory (cross-tenant) isolation, and deactivation killing
 * sessions (tokenEpoch bump). Integration (real DB); no Polis needed (inbound).
 */
process.env.SSO_ENABLED = 'true';
process.env.POLIS_BASE_URL = 'http://localhost:5225';
process.env.POLIS_API_KEY = 'test-api-key';
process.env.SCIM_WEBHOOK_SECRET = 'fixture-webhook-secret';
process.env.SSO_CALLBACK_URL = 'http://app.test/api/sso/callback';
process.env.ACCOUNT_FEATURE_SSO = 'true';
process.env.SCIM_WEBHOOK_TOLERANCE_MS = '0';

import request from 'supertest';
import { createHmac, randomBytes } from 'crypto';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const SECRET = 'fixture-webhook-secret';
let app: any;
let prisma: any;
let adminA: TestUser, adminB: TestUser;
let dirA: any, dirB: any;
const createdEmails: string[] = [];

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  adminA = await createTestUser('admin');
  adminB = await createTestUser('admin');
  dirA = await prisma.scimDirectory.create({ data: { accountId: adminA.accountId, polisDirectoryId: `dirA-${randomBytes(6).toString('hex')}`, polisTenant: `acct_${adminA.accountId}`, type: 'okta-scim-v2' } });
  dirB = await prisma.scimDirectory.create({ data: { accountId: adminB.accountId, polisDirectoryId: `dirB-${randomBytes(6).toString('hex')}`, polisTenant: `acct_${adminB.accountId}`, type: 'okta-scim-v2' } });
});

afterAll(async () => {
  try { await prisma.scimEvent.deleteMany({ where: { directoryId: { in: [dirA.id, dirB.id] } } }); } catch {}
  for (const email of createdEmails) { try { await prisma.user.delete({ where: { email } }); } catch {} }
  try { await prisma.scimDirectory.deleteMany({ where: { accountId: { in: [adminA.accountId, adminB.accountId] } } }); } catch {}
  try { await prisma.user.delete({ where: { id: adminA.id } }); } catch {}
  try { await prisma.user.delete({ where: { id: adminB.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: adminA.accountId } }); } catch {}
  try { await prisma.account.delete({ where: { id: adminB.accountId } }); } catch {}
  await prisma.$disconnect();
});

function sign(body: string): string {
  const t = Date.now();
  const s = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  return `t=${t},s=${s}`;
}
function userEvent(dir: any, event: string, data: any) {
  return { event, tenant: dir.polisTenant, product: 'servicecycle', directory_id: dir.polisDirectoryId, data };
}
async function post(eventObj: any, opts: { badSig?: boolean } = {}) {
  const body = JSON.stringify(eventObj);
  const req = request(app).post('/api/sso/scim/webhook').set('Content-Type', 'application/json');
  req.set('BoxyHQ-Signature', opts.badSig ? 't=1,s=deadbeef' : sign(body));
  return req.send(body);
}
function makeUser(email: string, scimId: string, active = true) {
  return { id: scimId, email, first_name: 'Test', last_name: 'User', active, raw: { externalId: `ext-${scimId}`, userName: email } };
}

test('missing/bad signature -> 401', async () => {
  const email = `sig-${randomBytes(5).toString('hex')}@a.test`;
  const res = await post(userEvent(dirA, 'user.created', makeUser(email, 'u-sig')), { badSig: true });
  expect(res.status).toBe(401);
  expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
});

test('user.created provisions a SCIM-managed user (default viewer)', async () => {
  const email = `new-${randomBytes(6).toString('hex')}@a.test`; createdEmails.push(email);
  const scimId = `u-${randomBytes(5).toString('hex')}`;
  const res = await post(userEvent(dirA, 'user.created', makeUser(email, scimId)));
  expect(res.status).toBe(200);
  expect(res.body.processed).toBe(1);
  const u = await prisma.user.findUnique({ where: { email } });
  expect(u).toBeTruthy();
  expect(u.accountId).toBe(adminA.accountId);
  expect(u.ssoManaged).toBe(true);
  expect(u.scimExternalId).toBe(scimId);
  expect(u.scimDirectoryId).toBe(dirA.id);
  expect(u.role).toBe('viewer');
});

test('IDEMPOTENT + REPLAY: redelivering the same event is a no-op', async () => {
  const email = `idem-${randomBytes(6).toString('hex')}@a.test`; createdEmails.push(email);
  const ev = userEvent(dirA, 'user.created', makeUser(email, `u-${randomBytes(5).toString('hex')}`));
  const r1 = await post(ev);
  expect(r1.body.processed).toBe(1);
  const r2 = await post(ev); // exact same body == replay
  expect(r2.status).toBe(200);
  expect(r2.body.skipped).toBeGreaterThanOrEqual(1);
  const count = await prisma.user.count({ where: { email } });
  expect(count).toBe(1);
});

test('update changes name; deactivate flips isActive + bumps tokenEpoch', async () => {
  const email = `lifecycle-${randomBytes(6).toString('hex')}@a.test`; createdEmails.push(email);
  const scimId = `u-${randomBytes(5).toString('hex')}`;
  await post(userEvent(dirA, 'user.created', makeUser(email, scimId)));
  const before = await prisma.user.findUnique({ where: { email } });

  // update (name)
  await post(userEvent(dirA, 'user.updated', { id: scimId, email, first_name: 'Renamed', last_name: 'Person', active: true, raw: { externalId: `ext-${scimId}` } }));
  const updated = await prisma.user.findUnique({ where: { email } });
  expect(updated.name).toBe('Renamed Person');

  // deactivate (user.updated active:false — the verified Polis behavior)
  await post(userEvent(dirA, 'user.updated', { id: scimId, email, first_name: 'Renamed', last_name: 'Person', active: false, raw: { externalId: `ext-${scimId}` } }));
  const deactivated = await prisma.user.findUnique({ where: { email } });
  expect(deactivated.isActive).toBe(false);
  expect(deactivated.tokenEpoch).toBe(before.tokenEpoch + 1); // sessions killed
});

test('user.deleted also deactivates (soft)', async () => {
  const email = `del-${randomBytes(6).toString('hex')}@a.test`; createdEmails.push(email);
  const scimId = `u-${randomBytes(5).toString('hex')}`;
  await post(userEvent(dirA, 'user.created', makeUser(email, scimId)));
  await post(userEvent(dirA, 'user.deleted', { id: scimId, email, active: false, raw: {} }));
  const u = await prisma.user.findUnique({ where: { email } });
  expect(u.isActive).toBe(false);
});

test('CROSS-DIRECTORY isolation: a dir-A event never mutates an account-B user', async () => {
  const email = `shared-${randomBytes(6).toString('hex')}@a.test`; createdEmails.push(email);
  const bUser = await createTestUser('viewer', { accountId: adminB.accountId, email });
  // Event arrives on directory A claiming the same email.
  const res = await post(userEvent(dirA, 'user.created', makeUser(email, `u-${randomBytes(5).toString('hex')}`)));
  expect(res.status).toBe(200); // handled, but...
  const stillB = await prisma.user.findUnique({ where: { email } });
  expect(stillB.accountId).toBe(adminB.accountId); // untouched
  expect(stillB.ssoManaged).toBe(false);
  expect(stillB.scimDirectoryId).toBeNull();
  await prisma.user.delete({ where: { id: bUser.id } }).catch(() => {});
});

test('unknown directory -> 200 skipped (no user touched)', async () => {
  const email = `unk-${randomBytes(6).toString('hex')}@a.test`;
  const res = await post({ event: 'user.created', tenant: 'acct_x', product: 'servicecycle', directory_id: 'no-such-directory', data: makeUser(email, 'u-x') });
  expect(res.status).toBe(200);
  expect(res.body.skipped).toBeGreaterThanOrEqual(1);
  expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
});

export {};

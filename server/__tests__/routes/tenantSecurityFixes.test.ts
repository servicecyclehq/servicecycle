/**
 * Regression tests for the 2026-06-20 overnight tenant-security fixes:
 *  - fleet /accounts/:id/link cannot claim an account already in another partner org
 *  - fleet /accounts/:id/assign-rep cannot target an account outside the caller's org
 *  - public /api/invite/accept now requires auth, links only the caller's OWN
 *    account (no client-supplied userId), and enforces the invited email
 */
import request from 'supertest';
import crypto from 'crypto';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';
import { createTestPartnerOrg, createTestAccount } from '../helpers/seed';

let app: any;
let prisma: any;
let orgA: any, orgB: any;
let oemA: TestUser;
let invitee: TestUser;     // email matches the invite
let outsider: TestUser;    // logged in, wrong email
let accountInOrgB: any;
let unlinkedAccount: any;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  orgA = await createTestPartnerOrg();
  orgB = await createTestPartnerOrg();
  oemA = await createTestUser('oem_admin', { partnerOrgId: orgA.id });
  invitee = await createTestUser('admin', { email: `invitee-${Date.now()}@test.invalid` });
  outsider = await createTestUser('admin', { email: `outsider-${Date.now()}@test.invalid` });
  accountInOrgB = await createTestAccount(orgB.id);
  unlinkedAccount = await createTestAccount(null);
});

afterAll(async () => {
  const accs = [oemA.accountId, invitee.accountId, outsider.accountId, accountInOrgB?.id, unlinkedAccount?.id].filter(Boolean);
  try { await prisma.partnerInvite.deleteMany({ where: { partnerOrgId: { in: [orgA.id, orgB.id] } } }); } catch {}
  for (const u of [oemA, invitee, outsider]) { try { await prisma.user.delete({ where: { id: u.id } }); } catch {} }
  for (const id of accs) { try { await prisma.account.delete({ where: { id } }); } catch {} }
  try { await prisma.partnerOrganization.delete({ where: { id: orgA.id } }); } catch {}
  try { await prisma.partnerOrganization.delete({ where: { id: orgB.id } }); } catch {}
  await prisma.$disconnect();
});

describe('fleet account link/assign-rep cross-partner guards', () => {
  test('cannot link an account already owned by another partner org (409)', async () => {
    const res = await request(app)
      .post(`/api/fleet/accounts/${accountInOrgB.id}/link`)
      .set('Authorization', `Bearer ${oemA.token}`);
    expect(res.status).toBe(409);
    // orgB's account must be untouched.
    const a = await prisma.account.findUnique({ where: { id: accountInOrgB.id }, select: { partnerOrgId: true } });
    expect(a.partnerOrgId).toBe(orgB.id);
  });

  test('can still link a genuinely unlinked account (200)', async () => {
    const res = await request(app)
      .post(`/api/fleet/accounts/${unlinkedAccount.id}/link`)
      .set('Authorization', `Bearer ${oemA.token}`);
    expect(res.status).toBe(200);
    const a = await prisma.account.findUnique({ where: { id: unlinkedAccount.id }, select: { partnerOrgId: true } });
    expect(a.partnerOrgId).toBe(orgA.id);
  });

  test('cannot assign-rep on an account outside the caller partner org (404)', async () => {
    const res = await request(app)
      .patch(`/api/fleet/accounts/${accountInOrgB.id}/assign-rep`)
      .set('Authorization', `Bearer ${oemA.token}`)
      .send({ repId: oemA.id });
    expect(res.status).toBe(404);
  });
});

describe('public invite accept hardening', () => {
  async function makeInvite(email: string) {
    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const invite = await prisma.partnerInvite.create({
      data: {
        partnerOrgId: orgA.id,
        inviteeEmail: email,
        invitedById: oemA.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    return { raw, invite };
  }

  test('requires authentication (401 without a token)', async () => {
    const { raw } = await makeInvite(invitee.email);
    const res = await request(app).post('/api/invite/accept').send({ token: raw });
    expect(res.status).toBe(401);
  });

  test('rejects a logged-in user whose email is not the invited email (403) and does not link', async () => {
    const { raw } = await makeInvite(invitee.email);
    const res = await request(app).post('/api/invite/accept')
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ token: raw });
    expect(res.status).toBe(403);
    const a = await prisma.account.findUnique({ where: { id: outsider.accountId }, select: { partnerOrgId: true } });
    expect(a.partnerOrgId).toBeNull(); // outsider's account was NOT linked
  });

  test('the invited user (authenticated) links their OWN account — never a body userId', async () => {
    const { raw } = await makeInvite(invitee.email);
    const res = await request(app).post('/api/invite/accept')
      .set('Authorization', `Bearer ${invitee.token}`)
      // attacker-style extra field must be ignored
      .send({ token: raw, userId: outsider.id });
    expect(res.status).toBe(200);
    const mine = await prisma.account.findUnique({ where: { id: invitee.accountId }, select: { partnerOrgId: true } });
    expect(mine.partnerOrgId).toBe(orgA.id);
    const theirs = await prisma.account.findUnique({ where: { id: outsider.accountId }, select: { partnerOrgId: true } });
    expect(theirs.partnerOrgId).toBeNull(); // the supplied userId was ignored
  });
});

export {};

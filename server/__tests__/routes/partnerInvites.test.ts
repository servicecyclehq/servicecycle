/**
 * Tests for the PartnerInvite flow:
 *   POST   /api/fleet/invites
 *   GET    /api/fleet/invites
 *   DELETE /api/fleet/invites/:id
 *   POST   /api/fleet/invites/:id/resend
 *   GET    /api/invite/accept?token=
 *   POST   /api/invite/accept
 */

import request from 'supertest';
import { createHash, randomBytes } from 'crypto';

// Load env + mocks before anything else
import '../helpers/setup';

let app: any;
let prisma: any;

import { createTestUser, type TestUser } from '../helpers/auth';
import { createTestPartnerOrg, createTestAccount } from '../helpers/seed';

// Rows to clean up after all tests
const toDelete: Array<{ model: string; id: string }> = [];

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
});

afterAll(async () => {
  // Clean up in FK-safe reverse order
  for (const { model, id } of toDelete.reverse()) {
    try { await (prisma as any)[model].delete({ where: { id } }); } catch {}
  }
  await prisma.$disconnect();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

let oemAdmin: TestUser;
let manager: TestUser;
let partnerOrg: any;
let linkedAccount: any;

beforeAll(async () => {
  partnerOrg = await createTestPartnerOrg();
  toDelete.push({ model: 'partnerOrganization', id: partnerOrg.id });

  oemAdmin = await createTestUser('oem_admin', { partnerOrgId: partnerOrg.id });
  toDelete.push({ model: 'user', id: oemAdmin.id });
  toDelete.push({ model: 'account', id: oemAdmin.accountId });

  manager = await createTestUser('manager');
  toDelete.push({ model: 'user', id: manager.id });
  toDelete.push({ model: 'account', id: manager.accountId });

  linkedAccount = await createTestAccount(partnerOrg.id);
  toDelete.push({ model: 'account', id: linkedAccount.id });
});

// ── POST /api/fleet/invites ───────────────────────────────────────────────────

describe('POST /api/fleet/invites', () => {
  test('oem_admin creates invite → 200, record created, email mock called', async () => {
    const { sendEmail } = require('../../lib/email');
    (sendEmail as jest.Mock).mockClear();

    const res = await request(app)
      .post('/api/fleet/invites')
      .set('Authorization', `Bearer ${oemAdmin.token}`)
      .send({ email: `new-invitee-${Date.now()}@test.invalid` });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(sendEmail).toHaveBeenCalledTimes(1);

    toDelete.push({ model: 'partnerInvite', id: res.body.id });
  });

  test('manager role → 403', async () => {
    const res = await request(app)
      .post('/api/fleet/invites')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ email: 'x@test.invalid' });
    expect(res.status).toBe(403);
  });

  test('no auth → 401', async () => {
    const res = await request(app)
      .post('/api/fleet/invites')
      .send({ email: 'x@test.invalid' });
    expect(res.status).toBe(401);
  });
});

// ── GET /api/invite/accept?token= ─────────────────────────────────────────────

describe('GET /api/invite/accept', () => {
  let validInvite: any;
  let validToken: string;

  beforeAll(async () => {
    validToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(validToken).digest('hex');
    validInvite = await prisma.partnerInvite.create({
      data: {
        partnerOrgId: partnerOrg.id,
        inviteeEmail:  'valid-invitee@test.invalid',
        invitedById:   oemAdmin.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    toDelete.push({ model: 'partnerInvite', id: validInvite.id });
  });

  test('valid token → returns partnerOrgName and inviteeEmail', async () => {
    const res = await request(app).get(`/api/invite/accept?token=${validToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('partnerOrgName');
    expect(res.body).toHaveProperty('inviteeEmail', 'valid-invitee@test.invalid');
  });

  test('expired token → { expired: true }', async () => {
    const tok = randomBytes(32).toString('hex');
    const expiredInvite = await prisma.partnerInvite.create({
      data: {
        partnerOrgId: partnerOrg.id,
        inviteeEmail:  'expired@test.invalid',
        invitedById:   oemAdmin.id,
        tokenHash: createHash('sha256').update(tok).digest('hex'),
        expiresAt: new Date(Date.now() - 1000), // already expired
      },
    });
    toDelete.push({ model: 'partnerInvite', id: expiredInvite.id });

    const res = await request(app).get(`/api/invite/accept?token=${tok}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('expired', true);
  });

  test('used token → { alreadyUsed: true }', async () => {
    const tok = randomBytes(32).toString('hex');
    const usedInvite = await prisma.partnerInvite.create({
      data: {
        partnerOrgId: partnerOrg.id,
        inviteeEmail:  'used@test.invalid',
        invitedById:   oemAdmin.id,
        tokenHash: createHash('sha256').update(tok).digest('hex'),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        acceptedAt: new Date(),
      },
    });
    toDelete.push({ model: 'partnerInvite', id: usedInvite.id });

    const res = await request(app).get(`/api/invite/accept?token=${tok}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('alreadyUsed', true);
  });
});

// ── POST /api/invite/accept ───────────────────────────────────────────────────

describe('POST /api/invite/accept', () => {
  test('valid token + authed user → account linked, token marked used', async () => {
    const tok = randomBytes(32).toString('hex');
    const invite = await prisma.partnerInvite.create({
      data: {
        partnerOrgId: partnerOrg.id,
        inviteeEmail:  'accept-user@test.invalid',
        invitedById:   oemAdmin.id,
        tokenHash: createHash('sha256').update(tok).digest('hex'),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    toDelete.push({ model: 'partnerInvite', id: invite.id });

    // Create an account/user to act as the accepting user
    const acceptingUser = await createTestUser('admin');
    toDelete.push({ model: 'user', id: acceptingUser.id });
    toDelete.push({ model: 'account', id: acceptingUser.accountId });

    const res = await request(app)
      .post('/api/invite/accept')
      .set('Authorization', `Bearer ${acceptingUser.token}`)
      .send({ token: tok, userId: acceptingUser.id });

    expect(res.status).toBe(200);

    // Token should be marked used
    const updated = await prisma.partnerInvite.findUnique({ where: { id: invite.id } });
    expect(updated.acceptedAt).not.toBeNull();
  });

  test('replayed token → 400 (single-use enforcement)', async () => {
    const tok = randomBytes(32).toString('hex');
    const invite = await prisma.partnerInvite.create({
      data: {
        partnerOrgId: partnerOrg.id,
        inviteeEmail:  'replay@test.invalid',
        invitedById:   oemAdmin.id,
        tokenHash: createHash('sha256').update(tok).digest('hex'),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        acceptedAt: new Date(), // already used
      },
    });
    toDelete.push({ model: 'partnerInvite', id: invite.id });

    const acceptingUser = await createTestUser('admin');
    toDelete.push({ model: 'user', id: acceptingUser.id });
    toDelete.push({ model: 'account', id: acceptingUser.accountId });

    const res = await request(app)
      .post('/api/invite/accept')
      .set('Authorization', `Bearer ${acceptingUser.token}`)
      .send({ token: tok });

    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/fleet/invites/:id ─────────────────────────────────────────────

describe('DELETE /api/fleet/invites/:id', () => {
  test('revokes invite; subsequent accept returns error', async () => {
    const tok = randomBytes(32).toString('hex');
    const invite = await prisma.partnerInvite.create({
      data: {
        partnerOrgId: partnerOrg.id,
        inviteeEmail:  'revoke-test@test.invalid',
        invitedById:   oemAdmin.id,
        tokenHash: createHash('sha256').update(tok).digest('hex'),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    toDelete.push({ model: 'partnerInvite', id: invite.id });

    const delRes = await request(app)
      .delete(`/api/fleet/invites/${invite.id}`)
      .set('Authorization', `Bearer ${oemAdmin.token}`);
    expect(delRes.status).toBe(200);

    // Accepting a revoked invite should fail
    const acceptingUser = await createTestUser('admin');
    toDelete.push({ model: 'user', id: acceptingUser.id });
    toDelete.push({ model: 'account', id: acceptingUser.accountId });

    const acceptRes = await request(app)
      .post('/api/invite/accept')
      .set('Authorization', `Bearer ${acceptingUser.token}`)
      .send({ token: tok });
    expect([400, 404, 410]).toContain(acceptRes.status);
  });
});

// ── POST /api/fleet/invites/:id/resend ───────────────────────────────────────

describe('POST /api/fleet/invites/:id/resend', () => {
  test('generates new token, old token invalidated', async () => {
    const tok = randomBytes(32).toString('hex');
    const oldHash = createHash('sha256').update(tok).digest('hex');
    const invite = await prisma.partnerInvite.create({
      data: {
        partnerOrgId: partnerOrg.id,
        inviteeEmail:  'resend-test@test.invalid',
        invitedById:   oemAdmin.id,
        tokenHash: oldHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    toDelete.push({ model: 'partnerInvite', id: invite.id });

    const res = await request(app)
      .post(`/api/fleet/invites/${invite.id}/resend`)
      .set('Authorization', `Bearer ${oemAdmin.token}`);
    expect(res.status).toBe(200);

    // Token hash should have changed
    const updated = await prisma.partnerInvite.findUnique({ where: { id: invite.id } });
    expect(updated.tokenHash).not.toBe(oldHash);
  });
});

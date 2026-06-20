/**
 * Regression tests — 2026-06-20 deep security audit (batch C: invite/consultant
 * integrity + 2FA replay + refresh-token reuse audit).
 *
 * Covers:
 *  - partnerInvite POST /accept refuses to silently transfer an already-linked account
 *  - consultant POST /:id/restore refuses to create a duplicate active grant
 *  - 2FA /enable records the used step (enable code can't be replayed at login)
 *  - 2FA /verify-login is replay-safe under concurrency (one valid code -> one session)
 *  - auth /refresh reuse-detection writes its audit-log row (was lost to a TDZ ReferenceError)
 */
import request from 'supertest';
import crypto from 'crypto';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { generateSecret } = require('../../lib/totp');
const { authenticator } = require('otplib');
authenticator.options = { step: 30, window: 1 };
const { issuePending2faToken } = require('../../routes/twoFactor');

let app: any;
let prisma: any;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
});
afterAll(async () => { await prisma.$disconnect(); });

describe('partnerInvite POST /accept — no silent transfer of an already-linked account', () => {
  let orgA: any, orgB: any, linkedUser: TestUser;
  beforeAll(async () => {
    orgA = await prisma.partnerOrganization.create({ data: { name: `InvA ${Date.now()}` } });
    orgB = await prisma.partnerOrganization.create({ data: { name: `InvB ${Date.now()}` } });
    // A user on an account already linked to orgB.
    linkedUser = await createTestUser('admin', { email: `linked-${Date.now()}@test.invalid`, partnerOrgId: orgB.id });
  });
  afterAll(async () => {
    try { await prisma.partnerInvite.deleteMany({ where: { partnerOrgId: { in: [orgA.id, orgB.id] } } }); } catch {}
    try { await prisma.user.delete({ where: { id: linkedUser.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: linkedUser.accountId } }); } catch {}
    try { await prisma.partnerOrganization.delete({ where: { id: orgA.id } }); } catch {}
    try { await prisma.partnerOrganization.delete({ where: { id: orgB.id } }); } catch {}
  });

  test('accepting an orgA invite while already linked to orgB → 409, link unchanged', async () => {
    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    await prisma.partnerInvite.create({
      data: { partnerOrgId: orgA.id, inviteeEmail: linkedUser.email, invitedById: linkedUser.id, tokenHash, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    });
    const res = await request(app).post('/api/invite/accept')
      .set('Authorization', `Bearer ${linkedUser.token}`).send({ token: raw });
    expect(res.status).toBe(409);
    const acc = await prisma.account.findUnique({ where: { id: linkedUser.accountId }, select: { partnerOrgId: true } });
    expect(acc.partnerOrgId).toBe(orgB.id); // still orgB — NOT transferred to orgA
  });
});

describe('consultant POST /:id/restore — no duplicate active grant', () => {
  let admin: TestUser, consultantUser: TestUser;
  beforeAll(async () => {
    admin = await createTestUser('admin');
    consultantUser = await createTestUser('consultant', { accountId: admin.accountId, email: `cons-${Date.now()}@test.invalid` });
  });
  afterAll(async () => {
    try { await prisma.consultantAccess.deleteMany({ where: { accountId: admin.accountId } }); } catch {}
    try { await prisma.user.delete({ where: { id: consultantUser.id } }); } catch {}
    try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  });

  test('grant -> revoke -> grant-again -> restore(old) → 409', async () => {
    const grant1 = await request(app).post('/api/consultant-access/grant')
      .set('Authorization', `Bearer ${admin.token}`).send({ email: consultantUser.email });
    expect(grant1.status).toBe(200);
    const recordAId = grant1.body.data.record.id;

    const revoke = await request(app).delete(`/api/consultant-access/${recordAId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(revoke.status).toBe(200);

    const grant2 = await request(app).post('/api/consultant-access/grant')
      .set('Authorization', `Bearer ${admin.token}`).send({ email: consultantUser.email });
    expect(grant2.status).toBe(200); // a new active grant now exists

    const restore = await request(app).post(`/api/consultant-access/${recordAId}/restore`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(restore.status).toBe(409); // would have created a 2nd active grant

    const active = await prisma.consultantAccess.count({ where: { accountId: admin.accountId, consultantId: consultantUser.id, isActive: true } });
    expect(active).toBe(1);
  });
});

describe('2FA /enable records the used step (enable code not replayable)', () => {
  let user: TestUser; let secret: string;
  beforeAll(async () => {
    user = await createTestUser('admin');
    const gen = generateSecret();
    secret = gen.secret;
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: gen.encryptedSecret, twoFactorEnabled: false, twoFactorLastUsedStep: null } });
  });
  afterAll(async () => {
    try { await prisma.user.delete({ where: { id: user.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: user.accountId } }); } catch {}
  });

  test('after /enable, twoFactorLastUsedStep is set', async () => {
    const code = authenticator.generate(secret);
    const res = await request(app).post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${user.token}`).send({ code });
    expect(res.status).toBe(200);
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { twoFactorEnabled: true, twoFactorLastUsedStep: true } });
    expect(row.twoFactorEnabled).toBe(true);
    expect(row.twoFactorLastUsedStep).not.toBeNull();
  });
});

describe('2FA /verify-login is replay-safe under concurrency', () => {
  let user: TestUser; let secret: string;
  beforeAll(async () => {
    user = await createTestUser('admin');
    const gen = generateSecret();
    secret = gen.secret;
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: gen.encryptedSecret, twoFactorEnabled: true, twoFactorLastUsedStep: null } });
  });
  afterAll(async () => {
    try { await prisma.refreshToken.deleteMany({ where: { userId: user.id } }); } catch {}
    try { await prisma.user.delete({ where: { id: user.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: user.accountId } }); } catch {}
  });

  test('two concurrent verify-logins with the same code yield exactly one session', async () => {
    const code = authenticator.generate(secret);
    const twoFactorToken = issuePending2faToken(user.id, null); // null req => no IP/UA bind
    const fire = () => request(app).post('/api/auth/2fa/verify-login').send({ twoFactorToken, code });
    const results = await Promise.all([fire(), fire()]);
    const ok = results.filter(r => r.status === 200);
    expect(ok.length).toBe(1); // exactly one code redemption succeeds
  });
});

describe('auth /refresh reuse-detection writes its audit row (TDZ fix)', () => {
  let user: TestUser;
  beforeAll(async () => { user = await createTestUser('admin', { email: `refresh-${Date.now()}@test.invalid` }); });
  afterAll(async () => {
    try { await prisma.activityLog.deleteMany({ where: { userId: user.id } }); } catch {}
    try { await prisma.refreshToken.deleteMany({ where: { userId: user.id } }); } catch {}
    try { await prisma.user.delete({ where: { id: user.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: user.accountId } }); } catch {}
  });

  test('replaying a revoked refresh token logs refresh_token_revoked_reuse_detected', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: user.email, password: 'TestPassword1!' });
    expect(login.status).toBe(200);
    const firstRefresh = login.body.data.refreshToken;
    expect(firstRefresh).toBeTruthy();

    // Use it once (revokes it, issues a successor).
    const rotate = await request(app).post('/api/auth/refresh').send({ refreshToken: firstRefresh });
    expect(rotate.status).toBe(200);

    // Replay the now-revoked token → reuse detection.
    const replay = await request(app).post('/api/auth/refresh').send({ refreshToken: firstRefresh });
    expect(replay.status).toBe(401);

    // The audit row is written fire-and-forget; poll briefly.
    let found = null;
    for (let i = 0; i < 15 && !found; i++) {
      found = await prisma.activityLog.findFirst({ where: { userId: user.id, action: 'refresh_token_revoked_reuse_detected' } });
      if (!found) await new Promise(r => setTimeout(r, 200));
    }
    expect(found).toBeTruthy();
  });
});

export {};

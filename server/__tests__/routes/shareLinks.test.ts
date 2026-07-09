/**
 * #21 Auditor/insurer share links. Covers create (manager+), the public
 * read-only package (no auth), expiry + revocation rejection, view counting,
 * and tenancy (only the owner can list/revoke).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let viewer: TestUser;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  viewer = await createTestUser('viewer');
});

afterAll(async () => {
  for (const u of [manager, viewer]) {
    const acc = u.accountId;
    try { await prisma.shareLink.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

// The route's activityLog.create() is fire-and-forget (not awaited before the
// response is sent) — poll briefly instead of racing it.
async function waitForLog(accountId: string, action: string): Promise<any> {
  for (let i = 0; i < 30; i++) {
    const row = await prisma.activityLog.findFirst({ where: { accountId, action }, orderBy: { createdAt: 'desc' } });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe('#21 auditor/insurer share links', () => {
  let token: string;
  let linkId: string;

  test('manager creates a time-boxed link', async () => {
    const res = await request(app).post('/api/share-links').set('Authorization', auth(manager)).send({ days: 14, label: 'Acme Insurance' });
    expect(res.status).toBe(201);
    token = res.body.data.token;
    linkId = res.body.data.id;
    expect(res.body.data.path).toBe(`/share/${token}`);
  });

  test('viewer cannot create a link (manager+ only)', async () => {
    const res = await request(app).post('/api/share-links').set('Authorization', auth(viewer)).send({ days: 7 });
    expect(res.status).toBe(403);
  });

  test('public package loads with no auth and is watermarked + read-only', async () => {
    const res = await request(app).get(`/api/public/share/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.readOnly).toBe(true);
    expect(res.body.data.sharedWith).toBe('Acme Insurance');
    expect(typeof res.body.data.overallRate === 'number' || res.body.data.overallRate === null).toBe(true);
    expect(res.body.data.watermark).toContain('ServiceCycle');
  });

  test('public view records a tamper-evident activityLog entry for the owner', async () => {
    const log = await waitForLog(manager.accountId, 'share_link_viewed');
    expect(log).toBeTruthy();
    expect(log.accountId).toBe(manager.accountId);
    expect((log.details as any).shareLinkId).toBe(linkId);
  });

  test('viewing increments the owner view counter', async () => {
    await request(app).get(`/api/public/share/${token}`);
    const list = await request(app).get('/api/share-links').set('Authorization', auth(manager));
    const link = list.body.data.links.find((l: any) => l.id === linkId);
    expect(link.viewCount).toBeGreaterThanOrEqual(1);
    expect(link.active).toBe(true);
  });

  test('a revoked link is no longer available', async () => {
    await request(app).post(`/api/share-links/${linkId}/revoke`).set('Authorization', auth(manager));
    const res = await request(app).get(`/api/public/share/${token}`);
    expect(res.status).toBe(404);
  });

  test('an expired link is rejected', async () => {
    const created = await request(app).post('/api/share-links').set('Authorization', auth(manager)).send({ days: 1 });
    const t = created.body.data.token;
    // force-expire it
    await prisma.shareLink.update({ where: { token: t }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).get(`/api/public/share/${t}`);
    expect(res.status).toBe(404);
  });

  test('unknown token is 404', async () => {
    const res = await request(app).get('/api/public/share/deadbeefdeadbeefdeadbeef');
    expect(res.status).toBe(404);
  });
});

export {};

/**
 * F2 — quote-request draft/save + send:
 *   - POST {draft:true} persists status 'draft' and does NOT notify the
 *     contractor (no QUOTE_REQUEST_CREATED partner event)
 *   - POST /:id/send promotes draft -> requested AND fires the event
 *   - sending a non-draft is rejected
 * F3 — POST /api/disaster-events/declare is manager+ (viewer 403).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';
import { createTestPartnerOrg } from '../helpers/seed';

let app: any;
let prisma: any;
let org: any;
let manager: TestUser;  // customer manager; account linked + sharing on
let viewer: TestUser;   // read-only (for F3)
let assetId: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForEvent(accountId: string, present: boolean, ms = 2500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const row = await prisma.partnerEventLog.findFirst({ where: { accountId, eventType: 'QUOTE_REQUEST_CREATED' } });
    if (present && row) return row;
    if (!present && row) return row; // found one when we expected none
    await sleep(150);
  }
  return null;
}

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  org = await createTestPartnerOrg();
  manager = await createTestUser('manager', { partnerOrgId: org.id });
  viewer = await createTestUser('viewer');
  await prisma.accountSetting.create({ data: { accountId: manager.accountId, key: 'partner_share_quote_requests', value: 'true' } });
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `Q ${Date.now()}` } });
  const a = await prisma.asset.create({ data: { accountId: manager.accountId, siteId: site.id, equipmentType: 'MOTOR', serialNumber: 'QD-1' } });
  assetId = a.id;
});

afterAll(async () => {
  for (const u of [manager, viewer]) {
    const acc = u.accountId;
    try { await prisma.partnerEventLog.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.quoteRequest.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.accountSetting.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  try { await prisma.partnerOrganization.delete({ where: { id: org.id } }); } catch {}
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('F2 quote draft + send', () => {
  let draftId: string;

  test('saving a draft persists status=draft and does NOT notify the contractor', async () => {
    const res = await request(app).post('/api/quote-requests').set('Authorization', auth(manager))
      .send({ assetId, driver: 'suspected_failing', timeline: 'within_30_days', draft: true });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
    draftId = res.body.data.id;
    // No partner event should appear (sharing is ON, so a real send WOULD log one).
    await sleep(600);
    const leaked = await prisma.partnerEventLog.findFirst({ where: { accountId: manager.accountId, eventType: 'QUOTE_REQUEST_CREATED' } });
    expect(leaked).toBeNull();
  });

  test('sending the draft promotes it to requested AND fires the contractor event', async () => {
    const res = await request(app).post(`/api/quote-requests/${draftId}/send`).set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('requested');
    const ev = await waitForEvent(manager.accountId, true);
    expect(ev).toBeTruthy();
  });

  test('sending something that is not a draft is rejected', async () => {
    const res = await request(app).post(`/api/quote-requests/${draftId}/send`).set('Authorization', auth(manager));
    expect(res.status).toBe(400);
  });
});

describe('F3 disaster declare gate', () => {
  test('a viewer cannot declare an emergency (403)', async () => {
    const res = await request(app).post('/api/disaster-events/declare').set('Authorization', auth(viewer)).send({});
    expect(res.status).toBe(403);
  });
  test('a manager is not role-blocked (not 403)', async () => {
    const res = await request(app).post('/api/disaster-events/declare').set('Authorization', auth(manager)).send({});
    expect(res.status).not.toBe(403);
  });
});

export {};

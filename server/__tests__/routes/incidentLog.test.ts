/**
 * #24 Protective-device / incident log. Covers create + list + resolve toggle,
 * openCount accounting, and tenancy isolation (another account cannot see or
 * mutate an asset's incidents).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let other: TestUser;
let siteId: string;
let assetId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  other = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `Incident ${Date.now()}` } });
  siteId = site.id;
  const a = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'CIRCUIT_BREAKER', serialNumber: 'INC-1' } });
  assetId = a.id;
});

afterAll(async () => {
  for (const u of [manager, other]) {
    const acc = u.accountId;
    try { await prisma.incidentLog.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('#24 incident log', () => {
  let incidentId: string;

  test('logs an incident and lists it open', async () => {
    const res = await request(app)
      .post(`/api/assets/${assetId}/incidents`)
      .set('Authorization', auth(manager))
      .send({ type: 'PROTECTIVE_TRIP', occurredAt: '2026-05-01', note: 'tripped on overcurrent' });
    expect(res.status).toBe(201);
    incidentId = res.body.data.incident.id;
    expect(res.body.data.incident.resolvedAt).toBeNull();

    const list = await request(app).get(`/api/assets/${assetId}/incidents`).set('Authorization', auth(manager));
    expect(list.status).toBe(200);
    expect(list.body.data.openCount).toBe(1);
    expect(list.body.data.incidents[0].type).toBe('PROTECTIVE_TRIP');
  });

  test('defaults type to OTHER and occurredAt to now when omitted', async () => {
    const res = await request(app).post(`/api/assets/${assetId}/incidents`).set('Authorization', auth(manager)).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.incident.type).toBe('OTHER');
    expect(res.body.data.incident.occurredAt).toBeTruthy();
  });

  test('resolve toggles openCount down, reopen brings it back', async () => {
    const r1 = await request(app).patch(`/api/assets/${assetId}/incidents/${incidentId}`).set('Authorization', auth(manager)).send({ resolved: true });
    expect(r1.status).toBe(200);
    expect(r1.body.data.incident.resolvedAt).toBeTruthy();

    const list1 = await request(app).get(`/api/assets/${assetId}/incidents`).set('Authorization', auth(manager));
    expect(list1.body.data.openCount).toBe(1); // the OTHER one is still open

    const r2 = await request(app).patch(`/api/assets/${assetId}/incidents/${incidentId}`).set('Authorization', auth(manager)).send({ resolved: false });
    expect(r2.body.data.incident.resolvedAt).toBeNull();
  });

  test('another account cannot list or patch this asset incidents', async () => {
    const list = await request(app).get(`/api/assets/${assetId}/incidents`).set('Authorization', auth(other));
    expect(list.status).toBe(404);
    const patch = await request(app).patch(`/api/assets/${assetId}/incidents/${incidentId}`).set('Authorization', auth(other)).send({ resolved: true });
    expect(patch.status).toBe(404);
  });

  test('invalid occurredAt is rejected', async () => {
    const res = await request(app).post(`/api/assets/${assetId}/incidents`).set('Authorization', auth(manager)).send({ occurredAt: 'not-a-date' });
    expect(res.status).toBe(400);
  });
});

export {};

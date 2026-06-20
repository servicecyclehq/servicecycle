/**
 * Phase 3 #7 bi-directional public API. Covers: read endpoints (work-orders,
 * deficiencies), the write scope gate, the POST work-order write-back that rolls
 * the NFPA 70B schedule forward, Idempotency-Key replay (no duplicate), tenant
 * scoping, and that the api-keys route mints scopes.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { hashApiKey } = require('../../middleware/apiKeyAuth');

let app: any;
let prisma: any;
let admin: TestUser;       // for the api-keys management route (requireAdmin)
let other: TestUser;       // separate tenant
let readKey: string;
let writeKey: string;
let otherWriteKey: string;
let assetId: string;
let scheduleId: string;
let origNextDue: Date;

const DAY = 24 * 60 * 60 * 1000;

async function mintKey(accountId: string, scopes: string[]): Promise<string> {
  const plaintext = `liq_test_${Math.random().toString(36).slice(2)}${Date.now()}`;
  await prisma.apiKey.create({ data: { accountId, name: `k-${scopes.join('-')}`, keyHash: hashApiKey(plaintext), scopes } });
  return plaintext;
}

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  other = await createTestUser('admin');

  readKey = await mintKey(admin.accountId, ['read']);
  writeKey = await mintKey(admin.accountId, ['read', 'write']);
  otherWriteKey = await mintKey(other.accountId, ['read', 'write']);

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `V1 ${Date.now()}` } });
  const asset = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: 'V1-1', governingCondition: 'C2' } });
  assetId = asset.id;
  const td = await prisma.maintenanceTaskDefinition.create({ data: { accountId: admin.accountId, equipmentType: 'SWITCHGEAR', taskName: 'V1 PM', taskCode: `V1_${Date.now()}`, intervalC2Months: 12 } });
  origNextDue = new Date(Date.now() + 30 * DAY);
  const sched = await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId: asset.id, taskDefinitionId: td.id, isActive: true, nextDueDate: origNextDue } });
  scheduleId = sched.id;
  // A deficiency for the read test.
  await prisma.deficiency.create({ data: { accountId: admin.accountId, assetId: asset.id, severity: 'RECOMMENDED', description: 'v1 def' } });
});

afterAll(async () => {
  for (const acc of [admin.accountId, other.accountId]) {
    try { await prisma.apiIdempotencyKey.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.apiKey.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  }
  for (const u of [admin, other]) { try { await prisma.user.delete({ where: { id: u.id } }); } catch {} }
  for (const acc of [admin.accountId, other.accountId]) { try { await prisma.account.delete({ where: { id: acc } }); } catch {} }
  await prisma.$disconnect();
});

const bearer = (k: string) => `Bearer ${k}`;

describe('Phase 3 #7 bi-directional v1 API', () => {
  test('reads work orders and deficiencies with any valid key', async () => {
    const wo = await request(app).get('/api/v1/work-orders').set('Authorization', bearer(readKey));
    expect(wo.status).toBe(200);
    expect(Array.isArray(wo.body.data)).toBe(true);
    expect(wo.headers['api-version']).toBe('1');

    const defs = await request(app).get('/api/v1/deficiencies?status=open').set('Authorization', bearer(readKey));
    expect(defs.status).toBe(200);
    expect(defs.body.data.length).toBeGreaterThanOrEqual(1);
  });

  test('write endpoint rejects a read-only key (403)', async () => {
    const res = await request(app).post('/api/v1/work-orders').set('Authorization', bearer(readKey))
      .send({ assetId, scheduleId, status: 'COMPLETE' });
    expect(res.status).toBe(403);
  });

  test('write-back creates a WO and rolls the schedule forward', async () => {
    const res = await request(app).post('/api/v1/work-orders').set('Authorization', bearer(writeKey))
      .send({ assetId, scheduleId, status: 'COMPLETE', completedDate: new Date().toISOString(), netaDecal: 'GREEN' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('COMPLETE');

    const sched = await prisma.maintenanceSchedule.findUnique({ where: { id: scheduleId } });
    expect(sched.lastCompletedDate).toBeTruthy();
    // 12-month roll pushes nextDueDate well past the original now+30d anchor.
    expect(new Date(sched.nextDueDate).getTime()).toBeGreaterThan(origNextDue.getTime());
  });

  test('Idempotency-Key replays the response and creates no duplicate', async () => {
    const key = `idem-${Date.now()}`;
    const body = { assetId, status: 'COMPLETE', completedDate: new Date().toISOString() };
    const first = await request(app).post('/api/v1/work-orders').set('Authorization', bearer(writeKey)).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    const firstId = first.body.data.id;

    const second = await request(app).post('/api/v1/work-orders').set('Authorization', bearer(writeKey)).set('Idempotency-Key', key).send(body);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(firstId);
    expect(second.headers['idempotent-replay']).toBe('true');

    const count = await prisma.workOrder.count({ where: { accountId: admin.accountId, id: firstId } });
    expect(count).toBe(1);
  });

  test('is tenant-scoped: another account key cannot write to this asset', async () => {
    const res = await request(app).post('/api/v1/work-orders').set('Authorization', bearer(otherWriteKey))
      .send({ assetId, status: 'COMPLETE' });
    expect(res.status).toBe(404); // asset belongs to a different account
  });

  test('api-keys route mints scopes (defaults to read-only)', async () => {
    const withWrite = await request(app).post('/api/settings/api-keys').set('Authorization', `Bearer ${admin.token}`).send({ name: 'integration', scopes: ['read', 'write'] });
    expect(withWrite.status).toBe(201);
    expect(withWrite.body.data.scopes.sort()).toEqual(['read', 'write']);
    expect(withWrite.body.data.key).toMatch(/^liq_/);

    const def = await request(app).post('/api/settings/api-keys').set('Authorization', `Bearer ${admin.token}`).send({ name: 'reader' });
    expect(def.status).toBe(201);
    expect(def.body.data.scopes).toEqual(['read']);
  });
});

export {};

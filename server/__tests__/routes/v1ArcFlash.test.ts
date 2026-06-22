/**
 * Slice 9 — v1 public arc-flash API: API-key auth, the canonical labels list, and
 * the one-line graph. Tenant-scoped.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { hashApiKey } = require('../../middleware/apiKeyAuth');

let app: any;
let prisma: any;
let admin: TestUser;
let readKey: string;
let writeKey: string;
let siteId: string;
let mainId: string;

const bearer = (k: string) => `Bearer ${k}`;
async function mintKey(accountId: string, scopes: string[]): Promise<string> {
  const plaintext = `liq_test_${Math.random().toString(36).slice(2)}${Date.now()}`;
  await prisma.apiKey.create({ data: { accountId, name: `k-${scopes.join('-')}`, keyHash: hashApiKey(plaintext), scopes } });
  return plaintext;
}

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  readKey = await mintKey(admin.accountId, ['read']);
  writeKey = await mintKey(admin.accountId, ['read', 'write']);

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `V1AF ${Date.now()}` } });
  siteId = site.id;
  const main = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  mainId = main.id;
  const mcc = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'MCC', fedFromAssetId: main.id } });
  const study = await prisma.systemStudy.create({ data: { accountId: admin.accountId, siteId, studyType: 'arc_flash', performedDate: new Date(), expiresAt: new Date(Date.now() + 4 * 365 * 864e5), method: 'IEEE 1584-2018' } });
  await prisma.systemStudyAsset.create({ data: { accountId: admin.accountId, studyId: study.id, assetId: main.id, busName: 'SWGR-1A', nominalVoltage: '480V', incidentEnergyCalCm2: 52, labelSeverity: 'danger' } });
  await prisma.systemStudyAsset.create({ data: { accountId: admin.accountId, studyId: study.id, assetId: mcc.id, busName: 'MCC-7', nominalVoltage: '480V', incidentEnergyCalCm2: 8, labelSeverity: 'warning' } });
});

afterAll(async () => {
  const acc = admin.accountId;
  for (const t of ['apiKey', 'protectiveDevice', 'systemStudyAsset', 'systemStudy', 'asset', 'site']) {
    try { await (prisma as any)[t].deleteMany({ where: { accountId: acc } }); } catch {}
  }
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('GET /api/v1/arc-flash/labels', () => {
  test('rejects without an API key', async () => {
    await request(app).get('/api/v1/arc-flash/labels').expect(401);
  });

  test('returns paginated canonical labels for the key tenant', async () => {
    const r = await request(app).get('/api/v1/arc-flash/labels').set('Authorization', bearer(readKey)).expect(200);
    expect(r.body.total).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(r.body.data)).toBe(true);
    expect(r.body.data[0]).toHaveProperty('incidentEnergyCalCm2');
    expect(r.body.data[0]).toHaveProperty('labelSeverity');
  });

  test('severity filter narrows the set', async () => {
    const r = await request(app).get('/api/v1/arc-flash/labels?severity=danger').set('Authorization', bearer(readKey)).expect(200);
    expect(r.body.data.every((d: any) => d.labelSeverity === 'danger')).toBe(true);
  });
});

describe('GET /api/v1/arc-flash/one-line', () => {
  test('requires a siteId', async () => {
    await request(app).get('/api/v1/arc-flash/one-line').set('Authorization', bearer(readKey)).expect(400);
  });

  test('returns the power-path graph with levels + edges', async () => {
    const r = await request(app).get(`/api/v1/arc-flash/one-line?siteId=${siteId}`).set('Authorization', bearer(readKey)).expect(200);
    expect(r.body.nodes.length).toBe(2);
    expect(r.body.edges.length).toBe(1);
    const mcc = r.body.nodes.find((nn: any) => nn.name === 'MCC-7');
    expect(mcc.level).toBe(1);
  });
});

describe('Slice 8 — CMMS closed-loop primitives', () => {
  test('work-order precheck returns canIssue for a valid study', async () => {
    const r = await request(app).get(`/api/v1/arc-flash/work-order-precheck?assetId=${mainId}`).set('Authorization', bearer(readKey)).expect(200);
    expect(r.body.canIssue).toBe(true);
    expect(r.body.hazard).toHaveProperty('incidentEnergyCalCm2');
  });

  test('device write-back requires the write scope', async () => {
    await request(app).post('/api/v1/arc-flash/devices').set('Authorization', bearer(readKey))
      .send({ assetId: mainId, deviceType: 'breaker', sensorRatingA: 800 }).expect(403);
  });

  test('a write key pushes verified device settings back', async () => {
    const r = await request(app).post('/api/v1/arc-flash/devices').set('Authorization', bearer(writeKey))
      .send({ assetId: mainId, deviceType: 'breaker', manufacturer: 'Square D', sensorRatingA: 800, settings: { ltPickupA: 640 } })
      .expect(201);
    expect(r.body.device.source).toBe('import');
    expect(r.body.device.assetId).toBe(mainId);
    expect(r.body.device.settings).toMatchObject({ ltPickupA: 640 });
  });

  test('cannot write to another tenant asset is enforced by 404', async () => {
    await request(app).post('/api/v1/arc-flash/devices').set('Authorization', bearer(writeKey))
      .send({ assetId: '00000000-0000-0000-0000-000000000000', deviceType: 'breaker' }).expect(404);
  });
});

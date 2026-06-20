/**
 * Phase 4 #8 -- continuous condition-monitoring telemetry (v1 API). Covers:
 * channel upsert + write-scope gate, reading ingest + grading, the NFPA 70B
 * Condition-2 escalation on a CRIT breach and auto-clear on return-to-OK,
 * Idempotency-Key replay, externalId dedup, tenant scoping, and manual ack.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { hashApiKey } = require('../../middleware/apiKeyAuth');

let app: any;
let prisma: any;
let admin: TestUser;
let other: TestUser;
let readKey: string;
let writeKey: string;
let otherWriteKey: string;
let assetId: string;

async function mintKey(accountId: string, scopes: string[]): Promise<string> {
  const plaintext = `liq_test_${Math.random().toString(36).slice(2)}${Date.now()}`;
  await prisma.apiKey.create({ data: { accountId, name: `k-${scopes.join('-')}`, keyHash: hashApiKey(plaintext), scopes } });
  return plaintext;
}

const bearer = (k: string) => `Bearer ${k}`;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  other = await createTestUser('admin');
  readKey = await mintKey(admin.accountId, ['read']);
  writeKey = await mintKey(admin.accountId, ['read', 'write']);
  otherWriteKey = await mintKey(other.accountId, ['read', 'write']);

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `TLM ${Date.now()}` } });
  // Axes deliberately C1 so a CRIT telemetry breach shows the C1 -> C2 escalation.
  const asset = await prisma.asset.create({ data: {
    accountId: admin.accountId, siteId: site.id, equipmentType: 'TRANSFORMER_LIQUID', serialNumber: 'TLM-1',
    conditionPhysical: 'C1', conditionCriticality: 'C1', conditionEnvironment: 'C1', governingCondition: 'C1',
  } });
  assetId = asset.id;
});

afterAll(async () => {
  for (const acc of [admin.accountId, other.accountId]) {
    try { await prisma.telemetryNotification.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.telemetryReading.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.telemetryChannel.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.apiIdempotencyKey.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.apiKey.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  }
  for (const u of [admin, other]) { try { await prisma.user.delete({ where: { id: u.id } }); } catch {} }
  for (const acc of [admin.accountId, other.accountId]) { try { await prisma.account.delete({ where: { id: acc } }); } catch {} }
  await prisma.$disconnect();
});

describe('Phase 4 #8 telemetry ingestion', () => {
  test('write-scope gate: read-only key cannot configure a channel (403)', async () => {
    const res = await request(app).post('/api/v1/telemetry/channels').set('Authorization', bearer(readKey))
      .send({ assetId, key: 'winding_temp', warnHigh: 75, critHigh: 90 });
    expect(res.status).toBe(403);
  });

  test('configures a channel with thresholds', async () => {
    const res = await request(app).post('/api/v1/telemetry/channels').set('Authorization', bearer(writeKey))
      .send({ assetId, key: 'winding_temp', label: 'Winding Temperature', unit: 'C', warnHigh: 75, critHigh: 90 });
    expect(res.status).toBe(201);
    expect(res.body.data.key).toBe('winding_temp');
    expect(Number(res.body.data.critHigh)).toBe(90);
    expect(res.headers['api-version']).toBe('1');
  });

  test('an in-band reading is OK and opens no notification', async () => {
    const res = await request(app).post('/api/v1/telemetry/readings').set('Authorization', bearer(writeKey))
      .send({ readings: [{ assetId, channel: 'winding_temp', value: 60, recordedAt: new Date().toISOString() }] });
    expect(res.status).toBe(201);
    expect(res.body.data.results[0].status).toBe('OK');
    expect(res.body.data.breaches).toBe(0);
    const a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a.autoConditionMonitoring).toBe(false);
    expect(a.governingCondition).toBe('C1');
  });

  test('a CRIT reading escalates the asset to Condition 2 and opens a notification', async () => {
    const res = await request(app).post('/api/v1/telemetry/readings').set('Authorization', bearer(writeKey))
      .send({ readings: [{ assetId, channel: 'winding_temp', value: 95, recordedAt: new Date().toISOString() }] });
    expect(res.status).toBe(201);
    expect(res.body.data.results[0].status).toBe('CRIT');
    expect(res.body.data.breaches).toBe(1);

    const a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a.autoConditionMonitoring).toBe(true);
    expect(a.governingCondition).toBe('C2');

    const open = await request(app).get('/api/v1/telemetry/notifications?status=open').set('Authorization', bearer(readKey));
    expect(open.body.data.length).toBe(1);
    expect(open.body.data[0].status).toBe('CRIT');
  });

  test('a return-to-OK reading auto-resolves and clears Condition 2', async () => {
    const res = await request(app).post('/api/v1/telemetry/readings').set('Authorization', bearer(writeKey))
      .send({ readings: [{ assetId, channel: 'winding_temp', value: 55, recordedAt: new Date().toISOString() }] });
    expect(res.status).toBe(201);
    const a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a.autoConditionMonitoring).toBe(false);
    expect(a.governingCondition).toBe('C1');
    const open = await request(app).get('/api/v1/telemetry/notifications?status=open').set('Authorization', bearer(readKey));
    expect(open.body.data.length).toBe(0);
  });

  test('externalId dedups a repeated reading', async () => {
    const body = { readings: [{ assetId, channel: 'winding_temp', value: 61, externalId: 'gw-abc-1', recordedAt: new Date().toISOString() }] };
    const first = await request(app).post('/api/v1/telemetry/readings').set('Authorization', bearer(writeKey)).send(body);
    expect(first.body.data.results[0].duplicate).toBe(false);
    const second = await request(app).post('/api/v1/telemetry/readings').set('Authorization', bearer(writeKey)).send(body);
    expect(second.body.data.results[0].duplicate).toBe(true);
    const cnt = await prisma.telemetryReading.count({ where: { accountId: admin.accountId, externalId: 'gw-abc-1' } });
    expect(cnt).toBe(1);
  });

  test('Idempotency-Key replays the batch response', async () => {
    const key = `idem-tlm-${Date.now()}`;
    const body = { readings: [{ assetId, channel: 'winding_temp', value: 62, recordedAt: new Date().toISOString() }] };
    const first = await request(app).post('/api/v1/telemetry/readings').set('Authorization', bearer(writeKey)).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    const before = await prisma.telemetryReading.count({ where: { accountId: admin.accountId } });
    const second = await request(app).post('/api/v1/telemetry/readings').set('Authorization', bearer(writeKey)).set('Idempotency-Key', key).send(body);
    expect(second.headers['idempotent-replay']).toBe('true');
    const after = await prisma.telemetryReading.count({ where: { accountId: admin.accountId } });
    expect(after).toBe(before); // replay created nothing
  });

  test('tenant-scoped: another account key cannot ingest to this asset', async () => {
    const res = await request(app).post('/api/v1/telemetry/readings').set('Authorization', bearer(otherWriteKey))
      .send({ readings: [{ assetId, channel: 'winding_temp', value: 99 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.accepted).toBe(0);
    expect(res.body.data.results[0].error).toBe('asset_not_found');
  });

  test('manual acknowledge clears a CRIT notification and Condition 2', async () => {
    // Breach again, then acknowledge via the API.
    await request(app).post('/api/v1/telemetry/readings').set('Authorization', bearer(writeKey))
      .send({ readings: [{ assetId, channel: 'winding_temp', value: 92, recordedAt: new Date().toISOString() }] });
    let a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a.autoConditionMonitoring).toBe(true);

    const open = await request(app).get('/api/v1/telemetry/notifications?status=open').set('Authorization', bearer(readKey));
    const id = open.body.data[0].id;
    const ack = await request(app).post(`/api/v1/telemetry/notifications/${id}/acknowledge`).set('Authorization', bearer(writeKey)).send({});
    expect(ack.status).toBe(200);
    expect(ack.body.data.acknowledgedAt).toBeTruthy();

    a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a.autoConditionMonitoring).toBe(false);
    expect(a.governingCondition).toBe('C1');
  });
});

export {};

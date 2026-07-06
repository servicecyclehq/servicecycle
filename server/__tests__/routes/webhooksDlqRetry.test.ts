/**
 * Regression test — 2026-07-06 Batch F: POST /dlq/:id/retry was
 * unconditionally 500ing. The old code reconstructed a synthetic `alertItem`
 * in a stale "contract renewal" shape (.contract/.vendor/.endDate) that
 * predates lib/webhook#buildPayload's current .schedule/.asset shape, then
 * replayed it through deliverWebhook(). buildPayload() reads `asset.id` with
 * no optional chaining, so an alertItem missing `.asset` entirely threw a
 * TypeError on every single call. Zero test coverage existed for this route
 * before the fix — this locks it in.
 *
 * Mocks lib/webhook's validateWebhookUrl + postOnce (network-boundary
 * functions) but keeps the real signPayload/buildPayload/etc — same pattern
 * partnerEvents.test.ts uses for postJsonToValidatedUrl.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

jest.mock('../../lib/webhook', () => ({
  ...jest.requireActual('../../lib/webhook'),
  validateWebhookUrl: jest.fn(),
  postOnce: jest.fn(),
}));

const webhookLib = require('../../lib/webhook');
const { encrypt } = require('../../lib/crypto');

let app: any;
let prisma: any;
let admin: TestUser;
let endpointId: string;
const dlqRowIds: string[] = [];

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      accountId: admin.accountId,
      label: 'Test endpoint',
      url: encrypt('https://example.test/hook'),
      hmacSecret: encrypt('a'.repeat(64)),
      enabled: true,
    },
  });
  endpointId = endpoint.id;
}, 20000);

afterAll(async () => {
  for (const id of dlqRowIds) { try { await prisma.outboundWebhookDLQ.delete({ where: { id } }); } catch {} }
  try { await prisma.outboundWebhookDLQ.deleteMany({ where: { accountId: admin.accountId } }); } catch {}
  try { await prisma.webhookEndpoint.deleteMany({ where: { accountId: admin.accountId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
}, 20000);

beforeEach(() => {
  webhookLib.validateWebhookUrl.mockReset().mockResolvedValue({ valid: true, addresses: ['203.0.113.5'] });
  webhookLib.postOnce.mockReset();
});

async function makeDlqRow(overrides: any = {}) {
  const row = await prisma.outboundWebhookDLQ.create({
    data: {
      accountId: admin.accountId,
      webhookEndpointId: endpointId,
      deliveryId: 'test-delivery-' + Math.random().toString(36).slice(2),
      eventType: 'maintenance.overdue',
      targetUrlMasked: 'https://example.test/…',
      payload: { event: 'maintenance.overdue', alertType: 'overdue', assetId: 'asset-1', asset: 'Test Asset', daysUntil: -3 },
      attemptCount: 4,
      lastError: 'timeout',
      firstFailedAt: new Date(Date.now() - 60000),
      lastAttemptAt: new Date(Date.now() - 30000),
      ...overrides,
    },
  });
  dlqRowIds.push(row.id);
  return row;
}

test('retry replays the exact persisted payload — no reconstruction, no crash', async () => {
  const row = await makeDlqRow();
  webhookLib.postOnce.mockResolvedValue({ ok: true, status: 200 });

  const res = await request(app)
    .post(`/api/webhooks/dlq/${row.id}/retry`)
    .set('Authorization', `Bearer ${admin.token}`);

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);

  // The exact stored payload was sent verbatim, not some reconstructed shape.
  const [callArgs] = (webhookLib.postOnce as jest.Mock).mock.calls[0];
  expect(JSON.parse(callArgs.body)).toEqual(row.payload);

  // Row deleted on success.
  const stillThere = await prisma.outboundWebhookDLQ.findUnique({ where: { id: row.id } });
  expect(stillThere).toBeNull();
});

test('retry failure creates a fresh DLQ row and leaves the original untouched', async () => {
  const row = await makeDlqRow();
  webhookLib.postOnce.mockResolvedValue({ ok: false, status: 503, reason: 'HTTP 503' });

  const res = await request(app)
    .post(`/api/webhooks/dlq/${row.id}/retry`)
    .set('Authorization', `Bearer ${admin.token}`);

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(false);
  expect(res.body.dlqRowId).toBeTruthy();
  expect(res.body.dlqRowId).not.toBe(row.id);
  dlqRowIds.push(res.body.dlqRowId);

  const original = await prisma.outboundWebhookDLQ.findUnique({ where: { id: row.id } });
  expect(original).not.toBeNull(); // untouched — not deleted, not mutated

  const fresh = await prisma.outboundWebhookDLQ.findUnique({ where: { id: res.body.dlqRowId } });
  expect(fresh).not.toBeNull();
  expect(fresh.attemptCount).toBe(row.attemptCount + 1);
  expect(fresh.payload).toEqual(row.payload);
});

test('SSRF-blocked URL -> 400, postOnce never called', async () => {
  const row = await makeDlqRow();
  webhookLib.validateWebhookUrl.mockResolvedValue({ valid: false, reason: 'private-ip' });

  const res = await request(app)
    .post(`/api/webhooks/dlq/${row.id}/retry`)
    .set('Authorization', `Bearer ${admin.token}`);

  expect(res.status).toBe(400);
  expect(webhookLib.postOnce).not.toHaveBeenCalled();
});

test('deleted endpoint (webhookEndpointId null) -> 400, cannot retry', async () => {
  const row = await makeDlqRow({ webhookEndpointId: null });

  const res = await request(app)
    .post(`/api/webhooks/dlq/${row.id}/retry`)
    .set('Authorization', `Bearer ${admin.token}`);

  expect(res.status).toBe(400);
});

test('unknown/foreign row id -> 404', async () => {
  const res = await request(app)
    .post('/api/webhooks/dlq/00000000-0000-0000-0000-000000000000/retry')
    .set('Authorization', `Bearer ${admin.token}`);

  expect(res.status).toBe(404);
});

export {};

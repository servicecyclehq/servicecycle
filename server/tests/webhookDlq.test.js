'use strict';

/**
 * tests/webhookDlq.test.js
 * -------------------------
 * v0.37.4 regression suite for lib/webhookDlq + lib/dlqPrune (the v0.37.1
 * MT-132 outbound-webhook DLQ helpers). Locks in:
 *   - persistFailedDelivery writes a row, never throws
 *   - URL masking strips path + query so a stored row can't leak secrets
 *   - pruneOlderThan deletes rows older than the cutoff and leaves newer rows
 *
 * Hits the live dev Postgres (the OutboundWebhookDLQ migration must be
 * applied). Skips gracefully if the table is missing or the DB is offline.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const prisma = require('../lib/prisma');
const { persistFailedDelivery, pruneOlderThan, maskUrl } = require('../lib/webhookDlq');

const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-dlqtest000001';

let dbReachable = true;
let tableExists = true;

beforeAll(async () => {
  try {
    await prisma.account.upsert({
      where:  { id: TEST_ACCOUNT_ID },
      update: {},
      create: { id: TEST_ACCOUNT_ID, companyName: '__dlq_test_account__', planType: 'licensed' },
    });
  } catch (e) {
    dbReachable = false;
    console.warn('[webhookDlq.test] DB not reachable — skipping. Reason:', e.message);
    return;
  }
  // Probe the table — older deploys may not have run the migration yet.
  try {
    await prisma.outboundWebhookDLQ.findFirst({ where: { accountId: TEST_ACCOUNT_ID } });
  } catch (e) {
    tableExists = false;
    console.warn('[webhookDlq.test] outbound_webhook_dlq table not present — skipping. Reason:', e.message);
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    if (tableExists) {
      await prisma.outboundWebhookDLQ.deleteMany({ where: { accountId: TEST_ACCOUNT_ID } });
    }
    await prisma.account.deleteMany({ where: { id: TEST_ACCOUNT_ID } });
  } finally {
    await prisma.$disconnect();
  }
});

describe('webhookDlq.maskUrl (pure)', () => {
  test('keeps scheme + host, drops path', () => {
    expect(maskUrl('https://hooks.zapier.com/secret/path/here'))
      .toBe('https://hooks.zapier.com/…');
  });
  test('drops query string', () => {
    expect(maskUrl('https://example.com/?token=abc'))
      .toBe('https://example.com/…');
  });
  test('returns sentinel on invalid URL', () => {
    expect(maskUrl('not a url')).toBe('(invalid url)');
    expect(maskUrl(null)).toBe('(invalid url)');
  });
});

const maybeDescribe = (dbReachable && tableExists) ? describe : describe.skip;

maybeDescribe('webhookDlq.persistFailedDelivery', () => {
  test('writes a row with the masked URL + JSON payload', async () => {
    const row = await persistFailedDelivery({
      accountId:     TEST_ACCOUNT_ID,
      deliveryId:    '00000000-0000-0000-0000-deliver000001',
      eventType:     'renewal_alert',
      targetUrl:     'https://hooks.zapier.com/x/y/z?token=secret',
      payload:       { foo: 'bar', n: 1 },
      attemptCount:  4,
      lastError:     'connect ETIMEDOUT',
      lastStatus:    null,
      firstFailedAt: new Date(),
    });
    expect(row).toBeTruthy();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    // Round-trip to confirm what landed.
    const fetched = await prisma.outboundWebhookDLQ.findUnique({ where: { id: row.id } });
    expect(fetched.targetUrlMasked).toBe('https://hooks.zapier.com/…');
    expect(fetched.targetUrlMasked).not.toMatch(/secret/);
    expect(fetched.payload).toEqual({ foo: 'bar', n: 1 });
    expect(fetched.attemptCount).toBe(4);
    expect(fetched.lastError).toBe('connect ETIMEDOUT');
  });

  test('truncates lastError at 1000 chars', async () => {
    const huge = 'x'.repeat(5000);
    const row = await persistFailedDelivery({
      accountId:     TEST_ACCOUNT_ID,
      deliveryId:    '00000000-0000-0000-0000-deliver000002',
      eventType:     'renewal_alert',
      targetUrl:     'https://example.com/hook',
      payload:       {},
      attemptCount:  4,
      lastError:     huge,
      firstFailedAt: new Date(),
    });
    expect(row).toBeTruthy();
    const fetched = await prisma.outboundWebhookDLQ.findUnique({ where: { id: row.id } });
    expect(fetched.lastError.length).toBeLessThanOrEqual(1000);
  });

  test('returns null on persistence error (never throws)', async () => {
    // Force failure by passing a bad accountId (FK violation).
    const row = await persistFailedDelivery({
      accountId:     '00000000-0000-0000-0000-doesnotexist0',
      deliveryId:    '00000000-0000-0000-0000-deliver000003',
      eventType:     'renewal_alert',
      targetUrl:     'https://example.com/hook',
      payload:       {},
      attemptCount:  4,
      lastError:     null,
      firstFailedAt: new Date(),
    });
    expect(row).toBeNull(); // caught + logged, returned null
  });
});

maybeDescribe('webhookDlq.pruneOlderThan', () => {
  test('deletes rows older than the cutoff', async () => {
    // Seed two rows — one ancient, one fresh — then prune to a cutoff that
    // strands only the ancient one.
    const ancient = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    const fresh   = new Date();

    const row1 = await persistFailedDelivery({
      accountId: TEST_ACCOUNT_ID,
      deliveryId: '00000000-0000-0000-0000-prune00ancient',
      eventType: 'renewal_alert',
      targetUrl: 'https://example.com/a',
      payload:   {},
      attemptCount: 4,
      firstFailedAt: ancient,
    });
    // Backdate the createdAt so prune sees it as ancient.
    await prisma.outboundWebhookDLQ.update({
      where: { id: row1.id },
      data:  { createdAt: ancient },
    });

    const row2 = await persistFailedDelivery({
      accountId: TEST_ACCOUNT_ID,
      deliveryId: '00000000-0000-0000-0000-prune000fresh1',
      eventType: 'renewal_alert',
      targetUrl: 'https://example.com/b',
      payload:   {},
      attemptCount: 4,
      firstFailedAt: fresh,
    });

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days
    // v0.38.1: scoped to TEST_ACCOUNT_ID so the test doesn't reach into
    // peer accounts in a shared dev DB. pruneOlderThan(cutoff) without the
    // scope still works in production (the nightly cron uses it globally).
    const deleted = await pruneOlderThan(cutoff, { accountId: TEST_ACCOUNT_ID });
    expect(deleted).toBeGreaterThanOrEqual(1);

    const stillThere = await prisma.outboundWebhookDLQ.findUnique({ where: { id: row2.id } });
    expect(stillThere).not.toBeNull();
    const goneNow = await prisma.outboundWebhookDLQ.findUnique({ where: { id: row1.id } });
    expect(goneNow).toBeNull();
  });
});

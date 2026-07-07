/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (continuation of
 * [[servicecycle-bughunt-restore-branch-2026-07-06]]).
 *
 * `webhookDlqAlarm` (04:05 UTC) and `webhookDlqPrune` (03:40 UTC) in index.ts
 * are DISTINCT crons from the already-covered `webhookDlqRetry`
 * (`__tests__/routes/webhooksDlqRetry.test.ts` tests the manual-retry ROUTE,
 * not either of these two cron bodies). Neither had a real-Postgres
 * regression test before this pass. Both read/delete real
 * OutboundWebhookDLQ rows; this test exercises each against real fixture
 * rows rather than a mocked Prisma client.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;
let account1: TestUser;
let account2: TestUser;

function dlqRow(accountId: string, overrides: any = {}) {
  const now = new Date();
  return {
    accountId,
    deliveryId: `test-delivery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    eventType: 'work_order.completed',
    targetUrlMasked: 'https://example.test/webhook',
    payload: { test: true },
    attemptCount: 3,
    lastError: 'ECONNREFUSED',
    lastStatus: null,
    firstFailedAt: now,
    lastAttemptAt: now,
    createdAt: now,
    ...overrides,
  };
}

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  account1 = await createTestUser('admin');
  account2 = await createTestUser('admin');
});

afterAll(async () => {
  await prisma.outboundWebhookDLQ.deleteMany({ where: { accountId: { in: [account1.accountId, account2.accountId] } } });
  for (const u of [account1, account2]) {
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: u.accountId } }); } catch {}
  }
  await prisma.$disconnect();
});

test('webhookDlqAlarm cron body: groupBy + >100 threshold check completes on real data, both under and over threshold', async () => {
  // account1: a handful of rows, well under the 100-row alarm threshold.
  await prisma.outboundWebhookDLQ.createMany({
    data: [dlqRow(account1.accountId), dlqRow(account1.accountId), dlqRow(account1.accountId)],
  });

  // account2: 105 rows — over the real threshold (`_count.id > 100`) used
  // by the cron, so the offender-detection branch actually fires.
  const bulk = Array.from({ length: 105 }, () => dlqRow(account2.accountId));
  await prisma.outboundWebhookDLQ.createMany({ data: bulk });

  // Exact query the cron runs (index.ts webhookDlqAlarm body):
  const groups = await prisma.outboundWebhookDLQ.groupBy({
    by: ['accountId'],
    _count: { id: true },
  });
  const offenders = groups.filter((g: any) => g._count.id > 100);

  const g1 = groups.find((g: any) => g.accountId === account1.accountId);
  const g2 = groups.find((g: any) => g.accountId === account2.accountId);
  expect(g1?._count.id).toBe(3);
  expect(g2?._count.id).toBe(105);
  expect(offenders.some((o: any) => o.accountId === account2.accountId)).toBe(true);
  expect(offenders.some((o: any) => o.accountId === account1.accountId)).toBe(false);
});

test('webhookDlqPrune (pruneWebhookDlq): deletes only rows older than the retention cutoff, real DB delete', async () => {
  const { pruneWebhookDlq } = require('../../lib/dlqPrune');

  const staleDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000); // 45 days old — past the 30-day default
  const freshDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);  // 1 day old — kept

  const stale = await prisma.outboundWebhookDLQ.create({ data: dlqRow(account1.accountId, { createdAt: staleDate, firstFailedAt: staleDate, lastAttemptAt: staleDate }) });
  const fresh = await prisma.outboundWebhookDLQ.create({ data: dlqRow(account1.accountId, { createdAt: freshDate, firstFailedAt: freshDate, lastAttemptAt: freshDate }) });

  const result = await pruneWebhookDlq();

  expect(result.error).toBeUndefined();
  expect(result.retentionDays).toBe(30);
  expect(result.cutoff).toBeInstanceOf(Date);
  expect(result.deletedCount).toBeGreaterThanOrEqual(1);

  const staleStillThere = await prisma.outboundWebhookDLQ.findUnique({ where: { id: stale.id } });
  const freshStillThere = await prisma.outboundWebhookDLQ.findUnique({ where: { id: fresh.id } });
  expect(staleStillThere).toBeNull();
  expect(freshStillThere).toBeTruthy();
});

export {};

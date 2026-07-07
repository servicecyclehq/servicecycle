/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (Tier 2,
 * continuation of [[servicecycle-bughunt-restore-branch-2026-07-06]]).
 *
 * `partnerWebhookRetry`'s runWebhookRetryCron() (every 15 min, index.ts) DOES
 * have existing coverage (tests/partnerWebhookSigning.test.js) — but that
 * suite mocks prisma.partnerEventLog.findMany/update entirely (a hermetic
 * unit test of the signing logic). It never exercises the cron's REAL
 * Prisma query (the `include: { partnerOrg: {...}, assignedRep: {...} }`
 * shape, the backoff-eligibility filter) against a real schema/relations —
 * exactly the gap class this session's fallback-masks-capture hunt targets.
 * This test hits a real Postgres DB with real PartnerOrganization/
 * PartnerEventLog rows and mocks ONLY the outbound network call
 * (postJsonToValidatedUrl), same boundary the existing unit suite draws.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

jest.mock('../../lib/webhook', () => {
  const actual = jest.requireActual('../../lib/webhook');
  return { ...actual, postJsonToValidatedUrl: jest.fn() };
});

let prisma: any;
let admin: TestUser;
let partnerOrgId: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const org = await prisma.partnerOrganization.create({
    data: { name: `PWR Test Org ${Date.now()}`, webhookUrl: 'https://partner.test.invalid/hook', webhookSecret: 'test-secret-key' },
  });
  partnerOrgId = org.id;
  await prisma.account.update({ where: { id: admin.accountId }, data: { partnerOrgId } });
});

afterAll(async () => {
  await prisma.partnerEventLog.deleteMany({ where: { partnerOrgId } });
  await prisma.account.update({ where: { id: admin.accountId }, data: { partnerOrgId: null } }).catch(() => {});
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  try { await prisma.partnerOrganization.delete({ where: { id: partnerOrgId } }); } catch {}
  await prisma.$disconnect();
});

test('runWebhookRetryCron(): real-DB include/filter query delivers an eligible candidate and records success', async () => {
  const { postJsonToValidatedUrl } = require('../../lib/webhook');
  (postJsonToValidatedUrl as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

  const log = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId, accountId: admin.accountId, eventType: 'TASK_OVERDUE',
      payload: { taskName: 'IR scan' }, webhookAttempts: 0, webhookSentAt: null,
    },
  });

  const { runWebhookRetryCron } = require('../../lib/partnerWebhookRetry');
  const result = await runWebhookRetryCron();

  expect(result.checked).toBeGreaterThanOrEqual(1);
  expect(result.succeeded).toBeGreaterThanOrEqual(1);
  expect(postJsonToValidatedUrl).toHaveBeenCalled();

  const updated = await prisma.partnerEventLog.findUnique({ where: { id: log.id } });
  expect(updated.webhookSentAt).toBeTruthy();
});

test('runWebhookRetryCron(): real-DB backoff filter excludes a candidate still inside its exponential-backoff window', async () => {
  const { postJsonToValidatedUrl } = require('../../lib/webhook');
  (postJsonToValidatedUrl as jest.Mock).mockClear();

  // 1 prior failed attempt, 1 second ago -- backoff for attempt 1 is 5min, so
  // this candidate must NOT be eligible yet.
  const log = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId, accountId: admin.accountId, eventType: 'TASK_OVERDUE',
      payload: { taskName: 'backoff test' }, webhookAttempts: 1,
      webhookLastFailedAt: new Date(Date.now() - 1000), webhookSentAt: null,
    },
  });

  const { runWebhookRetryCron } = require('../../lib/partnerWebhookRetry');
  await runWebhookRetryCron();

  // Not delivered -- still within backoff.
  const unchanged = await prisma.partnerEventLog.findUnique({ where: { id: log.id } });
  expect(unchanged.webhookSentAt).toBeNull();
  expect(unchanged.webhookAttempts).toBe(1);
});

export {};

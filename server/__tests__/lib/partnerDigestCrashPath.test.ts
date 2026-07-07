/**
 * Regression test — 2026-07-06 bug hunt: runPartnerDigestCron() (Partner
 * Flywheel daily 07:00 UTC digest, companion to lib/partnerEvents.ts /
 * lib/partnerWebhookRetry.ts) had zero test coverage. Static read confirmed
 * its Prisma shapes match schema.prisma (PartnerOrganization.digestIntervalDays,
 * PartnerEventLog.digestSentAt/archived/assignedRepId, User.role='oem_admin')
 * and it does NOT use the `{ not: null }` non-nullable-column filter pattern
 * that broke the 4 Batch F crons — the recipient lookups here filter on
 * `role: 'oem_admin', isActive: true` instead.
 *
 * This test exercises the real end-to-end path: a PartnerOrganization with
 * digestIntervalDays=1, an Account linked to it with the
 * partner_share_deficiencies=true AccountSetting, and a PartnerEventLog row
 * older than the digest cutoff with NO assignedRepId (the "unassigned"
 * branch, which queries for all oem_admin users in the org — this is the
 * branch most likely to have a schema mismatch since it's the one extra
 * Prisma call not exercised by the assigned-rep path). RESULT: no bug
 * found — the cron runs clean and marks the record digested. Test kept as a
 * regression lock.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

jest.mock('../../lib/email', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));

const { runPartnerDigestCron } = require('../../lib/partnerDigest');
const { sendEmail } = require('../../lib/email');

let prisma: any;
let partnerOrgId: string;
let oemAdmin: TestUser;
let account: TestUser;
let eventLogId: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;

  const org = await prisma.partnerOrganization.create({
    data: { name: `Test Partner Org ${Date.now()}`, digestIntervalDays: 1 },
  });
  partnerOrgId = org.id;

  // Customer account linked to the partner org, with sharing consent set.
  account = await createTestUser('admin', { partnerOrgId });
  await prisma.accountSetting.create({
    data: { accountId: account.accountId, key: 'partner_share_deficiencies', value: 'true' },
  });

  // oem_admin user IN the partner org (createTestUser puts them on their own
  // fresh account unless we pass accountId — oem_admin users live on the
  // partner-linked account per the app's role model).
  oemAdmin = await createTestUser('oem_admin', { accountId: account.accountId });

  // PartnerEventLog older than the 1-day digest cutoff, unassigned (repId null)
  // so the digest cron's "send to all oem_admins in org" branch runs.
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const log = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId,
      accountId: account.accountId,
      eventType: 'IMMEDIATE_DEFICIENCY',
      payload: { assetName: 'Test Switchgear', description: 'Overheating bus connection' },
      createdAt: twoDaysAgo,
    },
  });
  eventLogId = log.id;
});

afterAll(async () => {
  try { await prisma.partnerEventLog.delete({ where: { id: eventLogId } }); } catch {}
  try { await prisma.user.delete({ where: { id: oemAdmin.id } }); } catch {}
  try { await prisma.accountSetting.deleteMany({ where: { accountId: account.accountId } }); } catch {}
  try { await prisma.user.delete({ where: { id: account.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: account.accountId } }); } catch {}
  try { await prisma.partnerOrganization.delete({ where: { id: partnerOrgId } }); } catch {}
  await prisma.$disconnect();
});

test('runs to completion, emails the unassigned oem_admin, and marks the event log digested', async () => {
  const result = await runPartnerDigestCron();

  expect(result.orgsProcessed).toBeGreaterThanOrEqual(1);
  expect(result.emailsSent).toBeGreaterThanOrEqual(1);
  expect(result.recordsMarked).toBeGreaterThanOrEqual(1);

  const recipientEmails = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(recipientEmails).toContain(oemAdmin.email);

  const updatedLog = await prisma.partnerEventLog.findUnique({ where: { id: eventLogId } });
  expect(updatedLog.digestSentAt).toBeTruthy();
});

export {};

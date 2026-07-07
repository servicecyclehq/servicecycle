/**
 * Regression test — 2026-07-06 bug hunt: runRetentionArchival() (Partner
 * Flywheel nightly retention-archival cron, companion to partnerDigest.ts)
 * had zero test coverage, and archives/mutates real customer data — flagged
 * for extra scrutiny per the bug-hunt brief. Static read confirmed its
 * Prisma shapes match schema.prisma (Account.retentionTier default STANDARD,
 * retentionCustomYears nullable Int, PartnerEventLog.archived/createdAt) and
 * it does not touch User.email at all.
 *
 * This test exercises the real end-to-end path for the two interesting
 * retention tiers: STANDARD (7yr — record older than cutoff should archive)
 * and UTILITY (permanent — record of the same age must NOT be archived,
 * this is the "continue" branch that skips the account entirely). Also
 * checks a STANDARD record newer than the 7yr cutoff is left alone (no
 * false-positive archival). RESULT: no bug found — the cron runs clean
 * and respects tier boundaries correctly. Test kept as a regression lock.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { runRetentionArchival } = require('../../lib/partnerRetentionArchival');

let prisma: any;
let partnerOrgId: string;
let standardAccount: TestUser;
let utilityAccount: TestUser;
let oldStandardLogId: string;
let recentStandardLogId: string;
let oldUtilityLogId: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;

  const org = await prisma.partnerOrganization.create({
    data: { name: `Retention Test Org ${Date.now()}` },
  });
  partnerOrgId = org.id;

  standardAccount = await createTestUser('admin', { partnerOrgId });
  await prisma.account.update({
    where: { id: standardAccount.accountId },
    data: { retentionTier: 'STANDARD' },
  });

  utilityAccount = await createTestUser('admin', { partnerOrgId });
  await prisma.account.update({
    where: { id: utilityAccount.accountId },
    data: { retentionTier: 'UTILITY' },
  });

  const eightYearsAgo = new Date();
  eightYearsAgo.setFullYear(eightYearsAgo.getFullYear() - 8); // older than STANDARD's 7yr cutoff

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1); // well within any tier's cutoff

  const oldStandard = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId,
      accountId: standardAccount.accountId,
      eventType: 'INSPECTION_COMPLETED',
      payload: { assetName: 'Old Standard Asset' },
      archived: false,
      createdAt: eightYearsAgo,
    },
  });
  oldStandardLogId = oldStandard.id;

  const recentStandard = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId,
      accountId: standardAccount.accountId,
      eventType: 'INSPECTION_COMPLETED',
      payload: { assetName: 'Recent Standard Asset' },
      archived: false,
      createdAt: oneYearAgo,
    },
  });
  recentStandardLogId = recentStandard.id;

  const oldUtility = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId,
      accountId: utilityAccount.accountId,
      eventType: 'INSPECTION_COMPLETED',
      payload: { assetName: 'Old Utility Asset' },
      archived: false,
      createdAt: eightYearsAgo,
    },
  });
  oldUtilityLogId = oldUtility.id;
});

afterAll(async () => {
  for (const id of [oldStandardLogId, recentStandardLogId, oldUtilityLogId]) {
    try { await prisma.partnerEventLog.delete({ where: { id } }); } catch {}
  }
  try { await prisma.user.delete({ where: { id: standardAccount.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: standardAccount.accountId } }); } catch {}
  try { await prisma.user.delete({ where: { id: utilityAccount.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: utilityAccount.accountId } }); } catch {}
  try { await prisma.partnerOrganization.delete({ where: { id: partnerOrgId } }); } catch {}
  await prisma.$disconnect();
});

test('runs to completion: archives the 8yr-old STANDARD-tier record, leaves recent STANDARD and UTILITY records alone', async () => {
  const result = await runRetentionArchival();

  expect(result.accountsProcessed).toBeGreaterThanOrEqual(2);
  expect(result.archived).toBeGreaterThanOrEqual(1);

  const oldStandard = await prisma.partnerEventLog.findUnique({ where: { id: oldStandardLogId } });
  expect(oldStandard.archived).toBe(true);

  const recentStandard = await prisma.partnerEventLog.findUnique({ where: { id: recentStandardLogId } });
  expect(recentStandard.archived).toBe(false);

  // UTILITY tier is "never archive" regardless of age -- this is the
  // `continue` branch in runRetentionArchival(); confirms it isn't
  // accidentally falling through to the STANDARD 7yr default.
  const oldUtility = await prisma.partnerEventLog.findUnique({ where: { id: oldUtilityLogId } });
  expect(oldUtility.archived).toBe(false);
});

export {};

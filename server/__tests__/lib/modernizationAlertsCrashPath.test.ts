/**
 * Regression test — 2026-07-06 bug hunt: runModernizationAlerts() (Task 23,
 * daily 09:00 UTC RUL-scoring cron) was the highest-suspicion untested cron
 * in this batch — same vintage/shape as arcFlashIntegrity.ts and
 * deficiencyAlerts.ts, both of which had a `{ not: null }` filter against
 * the non-nullable `User.email` column that crashed unconditionally (see
 * 2026-07-06 Batch F). Static read of this file found it uses
 * `role: { in: ['admin','manager'] }, isActive: true` for its admin lookup
 * (not the buggy email filter), and its `asset.select` / `site.select`
 * shapes all match real schema.prisma columns (verified: Asset.installDate,
 * Asset.endOfSupport, Asset.governingCondition, Asset.modernizationRiskScore,
 * Site.name all exist).
 *
 * This test exercises the function end-to-end against a real asset that
 * clears the 0.70 alert threshold (TRANSFORMER_DRY, base life 20yr, C3
 * condition multiplier 0.50 -> 10yr adjusted life; installDate 8 years ago
 * -> score 0.80) to confirm the scoring write, QuoteRequest creation, and
 * admin email all complete without throwing. RESULT: no bug found — this
 * cron runs clean. Test kept as a regression lock (zero coverage existed
 * before this).
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

jest.mock('../../lib/email', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));

const { runModernizationAlerts } = require('../../lib/modernizationAlerts');
const { sendEmail } = require('../../lib/email');

let prisma: any;
let admin: TestUser;
let siteId: string;
let assetId: string;
const quoteRequestIds: string[] = [];

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `MA Site ${Date.now()}` } });
  siteId = site.id;

  const eightYearsAgo = new Date();
  eightYearsAgo.setFullYear(eightYearsAgo.getFullYear() - 8);

  const asset = await prisma.asset.create({
    data: {
      accountId: admin.accountId,
      siteId,
      equipmentType: 'TRANSFORMER_DRY',
      governingCondition: 'C3',
      installDate: eightYearsAgo,
      manufacturer: 'TestCo',
      model: 'TX-500',
    },
  });
  assetId = asset.id;
});

afterAll(async () => {
  try { await prisma.notificationLog.deleteMany({ where: { accountId: admin.accountId } }); } catch {}
  for (const id of quoteRequestIds) { try { await prisma.quoteRequest.delete({ where: { id } }); } catch {} }
  try { await prisma.asset.delete({ where: { id: assetId } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

test('runs to completion, scores the asset >= 0.70, opens a quote request, and emails the admin', async () => {
  const result = await runModernizationAlerts();

  expect(result.assetsScored).toBeGreaterThanOrEqual(1);
  expect(result.quoteRequests).toBeGreaterThanOrEqual(1);
  expect(result.emailsSent).toBeGreaterThanOrEqual(1);

  const updated = await prisma.asset.findUnique({ where: { id: assetId } });
  expect(updated.modernizationRiskScore).toBeGreaterThanOrEqual(0.70);

  const qr = await prisma.quoteRequest.findFirst({
    where: { accountId: admin.accountId, assetId, triggerType: 'MODERNIZATION_EOL' },
  });
  expect(qr).toBeTruthy();
  if (qr) quoteRequestIds.push(qr.id);

  const recipientEmails = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(recipientEmails).toContain(admin.email);

  const log = await prisma.notificationLog.findFirst({
    where: { accountId: admin.accountId, template: 'modernization_planning_alert' },
  });
  expect(log).toBeTruthy();
  expect(log.status).toBe('sent');
});

test('re-running within the 20h dedup window does not re-email but does not error either', async () => {
  (sendEmail as jest.Mock).mockClear();
  const result = await runModernizationAlerts();
  expect(result.skipped).toBeGreaterThanOrEqual(1);
  const recipientEmails = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(recipientEmails).not.toContain(admin.email);
});

export {};

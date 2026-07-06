/**
 * Regression test — 2026-07-06 Batch F: runDeficiencyAlerts() (and 3 sibling
 * crons — qemwAlerts, arcFlashIntegrity, standardRevisionCron) filtered
 * recipients with `email: { not: null } }` against `User.email`, a
 * required/non-nullable column. Prisma throws `PrismaClientValidationError`
 * UNCONDITIONALLY on a `{ not: null }` filter against a non-nullable field —
 * not a rare edge case, a guaranteed crash the instant the query runs. The
 * cron's outer try/catch in index.ts silently swallowed it, so this ran
 * every day and never once completed successfully when there was a real
 * IMMEDIATE deficiency to alert on. Fixed to `{ not: '' }`. Zero test
 * coverage existed for this function before the fix (see
 * qemwAlertsDedup.test.ts for the sibling fix this mirrors) — this locks it
 * in by actually exercising the recipient-lookup line end to end.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

jest.mock('../../lib/email', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));

const { runDeficiencyAlerts } = require('../../lib/deficiencyAlerts');
const { sendEmail } = require('../../lib/email');

let prisma: any;
let admin: TestUser;
let siteId: string;
let assetId: string;
const deficiencyIds: string[] = [];

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `DA Site ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({
    data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' },
  });
  assetId = asset.id;
});

afterAll(async () => {
  try { await prisma.notificationLog.deleteMany({ where: { accountId: admin.accountId } }); } catch {}
  for (const id of deficiencyIds) { try { await prisma.deficiency.delete({ where: { id } }); } catch {} }
  try { await prisma.asset.delete({ where: { id: assetId } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

beforeEach(() => {
  (sendEmail as jest.Mock).mockClear();
});

test('runs to completion (no PrismaClientValidationError) and emails the admin for a brand-new IMMEDIATE deficiency', async () => {
  const def = await prisma.deficiency.create({
    data: {
      accountId: admin.accountId,
      assetId,
      severity: 'IMMEDIATE',
      description: 'Overheating bus connection observed during walkthrough',
    },
  });
  deficiencyIds.push(def.id);

  // The historical bug threw synchronously inside runDeficiencyAlerts() the
  // instant the recipient-lookup query ran -- this await would have rejected
  // with PrismaClientValidationError before the fix.
  const result = await runDeficiencyAlerts();

  expect(result.accounts).toBeGreaterThanOrEqual(1);
  expect(result.emails).toBeGreaterThanOrEqual(1);

  const recipientEmails = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(recipientEmails).toContain(admin.email);

  const log = await prisma.notificationLog.findFirst({
    where: { accountId: admin.accountId, template: 'deficiency_immediate_new', recipient: admin.email },
  });
  expect(log).toBeTruthy();
  expect(log.status).toBe('sent');
});

test('re-running within the 20h dedup window does not re-notify for the same tier', async () => {
  (sendEmail as jest.Mock).mockClear();
  await runDeficiencyAlerts();
  const recipientEmails = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(recipientEmails).not.toContain(admin.email);
});

export {};

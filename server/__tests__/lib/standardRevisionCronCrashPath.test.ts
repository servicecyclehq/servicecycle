/**
 * Regression test — 2026-07-06 Batch F: runStandardRevisionCron() filtered
 * recipients with `email: { not: null } }` against `User.email`, a required/
 * non-nullable column — Prisma throws `PrismaClientValidationError`
 * UNCONDITIONALLY on that filter shape, so this cron crashed the instant it
 * found a real account with an active schedule governed by a superseded
 * standard. Fixed to `{ not: '' }`. Zero test coverage existed for this
 * function before the fix — this exercises it end to end: a superseded
 * ComplianceStandard with a superseding edition, a task definition under the
 * old standard, and an active schedule referencing that task, on an account
 * whose admin has a real email.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

jest.mock('../../lib/email', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));

const { runStandardRevisionCron } = require('../../lib/standardRevisionCron');
const { sendEmail } = require('../../lib/email');

let prisma: any;
let admin: TestUser;
let siteId: string;
let assetId: string;
let oldStandardId: string;
let newStandardId: string;
let taskDefId: string;
let scheduleId: string;

const TEST_CODE = `TEST-STD-${Date.now()}`;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `SRC Site ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({
    data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' },
  });
  assetId = asset.id;

  const oldStandard = await prisma.complianceStandard.create({
    data: {
      code: TEST_CODE, edition: '2019', publisher: 'NFPA', title: 'Test Standard',
      supersededAt: new Date(), // superseded -- this is what the cron looks for
    },
  });
  oldStandardId = oldStandard.id;

  const newStandard = await prisma.complianceStandard.create({
    data: {
      code: TEST_CODE, edition: '2026', publisher: 'NFPA', title: 'Test Standard',
      effectiveDate: new Date(), keyMandate: 'Test mandate summary',
      // supersededAt left null -- this is the "current" edition the cron resolves.
    },
  });
  newStandardId = newStandard.id;

  const taskDef = await prisma.maintenanceTaskDefinition.create({
    data: {
      accountId: admin.accountId, standardId: oldStandardId,
      equipmentType: 'SWITCHGEAR', taskName: 'SRC test task', taskCode: `SRC_TEST_${Date.now()}`,
      intervalC2Months: 12,
    },
  });
  taskDefId = taskDef.id;

  const schedule = await prisma.maintenanceSchedule.create({
    data: { accountId: admin.accountId, assetId, taskDefinitionId: taskDefId, isActive: true },
  });
  scheduleId = schedule.id;
});

afterAll(async () => {
  try { await prisma.standardRevisionAlert.deleteMany({ where: { accountId: admin.accountId } }); } catch {}
  try { await prisma.notificationLog.deleteMany({ where: { accountId: admin.accountId } }); } catch {}
  try { await prisma.maintenanceSchedule.delete({ where: { id: scheduleId } }); } catch {}
  try { await prisma.maintenanceTaskDefinition.delete({ where: { id: taskDefId } }); } catch {}
  try { await prisma.complianceStandard.delete({ where: { id: oldStandardId } }); } catch {}
  try { await prisma.complianceStandard.delete({ where: { id: newStandardId } }); } catch {}
  try { await prisma.asset.delete({ where: { id: assetId } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

test('runs to completion (no PrismaClientValidationError) and emails the admin for a superseded standard with an active schedule', async () => {
  // The historical bug threw synchronously inside the recipient-lookup query
  // -- this await would have rejected with PrismaClientValidationError
  // before the fix, the moment it reached an account with a real active
  // schedule under the superseded standard.
  const result = await runStandardRevisionCron();

  expect(result.standardsChecked).toBeGreaterThanOrEqual(1);
  expect(result.accountsAlerted).toBeGreaterThanOrEqual(1);
  expect(result.emailsSent).toBeGreaterThanOrEqual(1);

  const recipientEmails = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(recipientEmails).toContain(admin.email);

  const log = await prisma.notificationLog.findFirst({
    where: { accountId: admin.accountId, template: `standard_revision_${oldStandardId}` },
  });
  expect(log).toBeTruthy();
  expect(log.status).toBe('sent');

  const alert = await prisma.standardRevisionAlert.findFirst({
    where: { accountId: admin.accountId, standardId: oldStandardId },
  });
  expect(alert).toBeTruthy();
  expect(alert.newEdition).toBe('2026');
});

test('re-running does not re-notify (dedup on account+standard)', async () => {
  (sendEmail as jest.Mock).mockClear();
  const result = await runStandardRevisionCron();
  expect(result.skipped).toBeGreaterThanOrEqual(1);
  const recipientEmails = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(recipientEmails).not.toContain(admin.email);
});

export {};

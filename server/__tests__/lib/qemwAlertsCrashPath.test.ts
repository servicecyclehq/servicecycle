/**
 * Regression test — 2026-07-07 daytime cron test-coverage audit.
 *
 * `runQemwAlerts` (qemwAlerts, daily 10:00 UTC, index.ts) had zero test
 * coverage despite an in-code comment ("see qemwAlertsDedup.test.ts for the
 * sibling fix this mirrors") implying a test already existed -- no such file
 * exists anywhere in the repo (verified via glob before writing this). The
 * 2026-07-06 session's fix (`email: { not: '' }` instead of `{ not: null }`,
 * which threw PrismaClientValidationError unconditionally on every run) is
 * already live in the code; this locks it in and exercises both halves of
 * the function against a real Postgres DB: cert-expiry alerts and the
 * REQUIRE_QEMW compliance-gap / QuoteRequest path. Email is mocked globally
 * by __tests__/helpers/setup.ts.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { sendEmail } = require('../../lib/email');

let prisma: any;
let admin: TestUser;
let contractorId: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const contractor = await prisma.contractor.create({
    data: { accountId: admin.accountId, name: `QEMW Test Contractor ${Date.now()}` },
  });
  contractorId = contractor.id;
});

afterAll(async () => {
  const acc = admin.accountId;
  try { await prisma.notificationLog.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.quoteRequest.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.contractorTech.deleteMany({ where: { contractorId } }); } catch {}
  try { await prisma.contractor.delete({ where: { id: contractorId } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.accountSetting.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

beforeEach(() => {
  (sendEmail as jest.Mock).mockClear();
});

test('runQemwAlerts(): fires a cert-expiry alert to the tech + admins without a PrismaClientValidationError', async () => {
  const tech = await prisma.contractorTech.create({
    data: {
      contractorId,
      name: 'Test Tech',
      email: 'tech+qemw-expiry@example.test',
      qemwCertNumber: `QEMW-${Date.now()}`,
      qemwExpiresAt: new Date(Date.now() + 14 * 86_400_000), // inside the 14d tier window
    },
  });

  const { runQemwAlerts } = require('../../lib/qemwAlerts');
  const result = await runQemwAlerts();

  expect(result.expiryAlerts).toBeGreaterThanOrEqual(1);
  expect(result.emailsSent).toBeGreaterThanOrEqual(1);

  const recipients = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(recipients).toContain(tech.email);
  expect(recipients).toContain(admin.email);

  const log = await prisma.notificationLog.findFirst({
    where: { accountId: admin.accountId, template: `qemw_expiry_14d_${tech.id}` },
  });
  expect(log).toBeTruthy();
  expect(log.status).toBe('sent');
}, 30000);

test('runQemwAlerts(): re-run within the 5-day dedup window does not double-alert the same tech+tier', async () => {
  (sendEmail as jest.Mock).mockClear();
  const { runQemwAlerts } = require('../../lib/qemwAlerts');
  const result = await runQemwAlerts();
  expect(result.skipped).toBeGreaterThanOrEqual(1);
}, 30000);

test('runQemwAlerts(): REQUIRE_QEMW account with a due schedule and no valid tech opens a compliance-gap QuoteRequest', async () => {
  await prisma.accountSetting.create({
    data: { accountId: admin.accountId, key: 'REQUIRE_QEMW', value: 'true' },
  });
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `QEMW Gap Site ${Date.now()}` } });
  const asset = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR' } });
  const taskDef = await prisma.maintenanceTaskDefinition.create({
    data: { accountId: admin.accountId, equipmentType: 'SWITCHGEAR', taskName: 'QEMW gap task', taskCode: `QEMW_GAP_${Date.now()}`, intervalC2Months: 12 },
  });
  await prisma.maintenanceSchedule.create({
    data: {
      accountId: admin.accountId, assetId: asset.id, taskDefinitionId: taskDef.id, isActive: true,
      nextDueDate: new Date(Date.now() + 30 * 86_400_000), // due within the 90d gap window
    },
  });
  // Note: the tech created in test 1 has a valid (non-expired for 14 more
  // days at insert time, but still current) QEMW cert on this SAME account,
  // so to genuinely exercise the "no valid tech" branch, expire it first.
  await prisma.contractorTech.updateMany({
    where: { contractorId },
    data: { qemwExpiresAt: new Date(Date.now() - 86_400_000) }, // expired yesterday
  });

  (sendEmail as jest.Mock).mockClear();
  const { runQemwAlerts } = require('../../lib/qemwAlerts');
  const result = await runQemwAlerts();

  expect(result.gapAlerts).toBeGreaterThanOrEqual(1);
  expect(result.quoteRequests).toBeGreaterThanOrEqual(1);

  const qr = await prisma.quoteRequest.findFirst({
    where: { accountId: admin.accountId, triggerType: 'QEMW_TRAINING' },
  });
  expect(qr).toBeTruthy();
  expect(qr.status).toBe('requested');

  const recipients = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(recipients).toContain(admin.email);
}, 30000);

export {};

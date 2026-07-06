/**
 * Regression test — 2026-07-06 Batch F: runArcFlashIntegrity()'s getAdmins()
 * helper filtered `email: { not: null } }` against `User.email`, a required/
 * non-nullable column — Prisma throws `PrismaClientValidationError`
 * UNCONDITIONALLY on that filter shape, so every one of this cron's 4 paths
 * crashed the instant it reached a real qualifying row (getAdmins() is
 * called from all 4). Fixed to `{ not: '' }`. Zero test coverage existed for
 * this function before the fix — this exercises Path 3 (IMMEDIATE relay/
 * breaker-calibration deficiency), the simplest of the 4 paths to set up,
 * end to end through the exact recipient-lookup line that used to crash.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

jest.mock('../../lib/email', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));

const { runArcFlashIntegrity } = require('../../lib/arcFlashIntegrity');
const { sendEmail } = require('../../lib/email');

let prisma: any;
let admin: TestUser;
let siteId: string;
let assetId: string;
const deficiencyIds: string[] = [];
const quoteRequestIds: string[] = [];

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `AFI Site ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({
    data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' },
  });
  assetId = asset.id;
});

afterAll(async () => {
  try { await prisma.notificationLog.deleteMany({ where: { accountId: admin.accountId } }); } catch {}
  for (const id of quoteRequestIds) { try { await prisma.quoteRequest.delete({ where: { id } }); } catch {} }
  for (const id of deficiencyIds) { try { await prisma.deficiency.delete({ where: { id } }); } catch {} }
  try { await prisma.asset.delete({ where: { id: assetId } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

test('runs to completion (no PrismaClientValidationError) on an IMMEDIATE relay/breaker-calibration deficiency', async () => {
  const def = await prisma.deficiency.create({
    data: {
      accountId: admin.accountId,
      assetId,
      severity: 'IMMEDIATE',
      description: 'Protection relay settings found out of calibration during inspection (relay_settings)',
    },
  });
  deficiencyIds.push(def.id);

  // The historical bug threw synchronously inside getAdmins() -- this await
  // would have rejected with PrismaClientValidationError before the fix,
  // regardless of which of the cron's 4 paths triggered it.
  const result = await runArcFlashIntegrity();

  expect(result.deficiencyAlerts).toBeGreaterThanOrEqual(1);
  expect(result.emailsSent).toBeGreaterThanOrEqual(1);
  expect(result.quoteRequests).toBeGreaterThanOrEqual(1);

  const recipientEmails = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(recipientEmails).toContain(admin.email);

  const qr = await prisma.quoteRequest.findFirst({
    where: { accountId: admin.accountId, assetId, triggerType: 'ARC_FLASH_STUDY' },
  });
  expect(qr).toBeTruthy();
  if (qr) quoteRequestIds.push(qr.id);

  const log = await prisma.notificationLog.findFirst({
    where: { accountId: admin.accountId, template: 'arc_flash_relay_breaker_deficiency' },
  });
  expect(log).toBeTruthy();
  expect(log.status).toBe('sent');
});

export {};

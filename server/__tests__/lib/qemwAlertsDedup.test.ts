/**
 * Regression test — 2026-07-06 Batch F: runQemwAlerts()'s cert-expiry dedup
 * key was `qemw_expiry_${tier}d` with NO technician identity in it, and the
 * dedup lookup only filtered on (accountId, template). An account with
 * multiple technicians crossing the same tier within the same 5-day window
 * would alert the FIRST tech, then silently skip every OTHER tech at that
 * account+tier as a "duplicate" — they were never notified about their own
 * expiring cert. Fixed by folding tech.id into the template string. Zero
 * test coverage existed for this function before the fix — this locks it in.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

jest.mock('../../lib/email', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));

const { runQemwAlerts } = require('../../lib/qemwAlerts');
const { sendEmail } = require('../../lib/email');

let prisma: any;
let admin: TestUser;
let contractorId: string;
const techIds: string[] = [];

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');

  const contractor = await prisma.contractor.create({
    data: { accountId: admin.accountId, name: 'Test Contractor Co' },
  });
  contractorId = contractor.id;
});

afterAll(async () => {
  try { await prisma.notificationLog.deleteMany({ where: { accountId: admin.accountId } }); } catch {}
  for (const id of techIds) { try { await prisma.contractorTech.delete({ where: { id } }); } catch {} }
  try { await prisma.contractor.delete({ where: { id: contractorId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

beforeEach(() => {
  (sendEmail as jest.Mock).mockClear();
});

async function makeTech(name: string, daysUntilExpiry: number) {
  const tech = await prisma.contractorTech.create({
    data: {
      contractorId,
      name,
      email: `${name.toLowerCase().replace(/\s+/g, '-')}@test.invalid`,
      qemwExpiresAt: new Date(Date.now() + daysUntilExpiry * 86_400_000),
    },
  });
  techIds.push(tech.id);
  return tech;
}

test('two technicians crossing the SAME tier in the same account both get notified (not just the first)', async () => {
  const techA = await makeTech('Tech Alpha', 60);
  const techB = await makeTech('Tech Bravo', 60);

  const result = await runQemwAlerts();

  expect(result.expiryAlerts).toBeGreaterThanOrEqual(2);

  const recipientEmails = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(recipientEmails).toContain(techA.email);
  expect(recipientEmails).toContain(techB.email);

  // Two distinct per-technician NotificationLog rows, not one shared row.
  const logs = await prisma.notificationLog.findMany({
    where: { accountId: admin.accountId, template: { startsWith: 'qemw_expiry_60d' } },
  });
  expect(logs.length).toBe(2);
  const templates = logs.map((l: any) => l.template);
  expect(new Set(templates).size).toBe(2); // distinct templates -> distinct dedup keys per tech
});

test('re-running immediately afterward skips both techs (per-tech dedup still works within the window)', async () => {
  const techC = await makeTech('Tech Charlie', 14);
  const techD = await makeTech('Tech Delta', 14);

  await runQemwAlerts();
  let emails = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(emails).toContain(techC.email);
  expect(emails).toContain(techD.email);

  (sendEmail as jest.Mock).mockClear();
  await runQemwAlerts();

  // Nothing NEW to send for Charlie/Delta specifically on this run (already-sent
  // dedup engages per-tech, same as before the fix — proves the fix didn't
  // just disable dedup entirely).
  emails = (sendEmail as jest.Mock).mock.calls.map((c: any[]) => c[0].to);
  expect(emails).not.toContain(techC.email);
  expect(emails).not.toContain(techD.email);
});

export {};

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

// Regression-lock for the 2026-07-08 acquisition-audit fix: the 5-year
// arc-flash study review was cited as "NFPA 70E Annex D best practice" when
// NFPA 70E (2021+ editions) §130.5 actually makes it a mandatory "shall"
// (reviewed for accuracy at intervals not exceeding 5 years). The underlying
// 5-year trigger LOGIC was already correct and is unchanged here -- this only
// pins the citation/wording that reaches the account's admins by email.
test('Path 0 5-year re-evaluation email cites mandatory NFPA 70E §130.5, not "Annex D best practice"', async () => {
  const performedDate = new Date(Date.now() - 6 * 365 * 86_400_000); // 6 years ago
  const expiresAt = new Date(Date.now() - 1 * 365 * 86_400_000); // expired 1 year ago
  const study = await prisma.systemStudy.create({
    data: {
      accountId: admin.accountId,
      siteId,
      studyType: 'arc_flash',
      performedDate,
      expiresAt,
    },
  });

  try {
    (sendEmail as jest.Mock).mockClear();

    const result = await runArcFlashIntegrity();
    expect(result.perStudyExpired).toBeGreaterThanOrEqual(1);

    // Any account's expired-study email carries the same reworded citation, so
    // find whichever call(s) this run produced for the 5-year-review reason.
    const relevantCalls = (sendEmail as jest.Mock).mock.calls.filter(
      (c: any[]) => typeof c[0]?.subject === 'string' && /5-year re-evaluation/i.test(c[0].subject),
    );
    expect(relevantCalls.length).toBeGreaterThanOrEqual(1);

    for (const call of relevantCalls) {
      const html = call[0].html as string;
      expect(html).toContain('130.5');
      expect(html).toMatch(/mandatory/i);
      expect(html).toMatch(/not exceeding 5 years|not exceed 5 years/i);
      // The OLD citation labeled the whole 5-year review as a parenthetical
      // "(NFPA 70E Annex D best practice)" -- that exact label must be gone.
      // (The reworded text legitimately still says "...not an Annex D best
      // practice" as a contrast, so we assert against the specific old LABEL
      // format, not a blanket absence of the words "Annex D".)
      expect(html).not.toContain('(NFPA 70E Annex D best practice)');
      expect(html).toContain('NFPA 70E §130.5 mandatory review');
    }

    // Scope to the Path-0-specific notes text (not just "130.5" -- the Path 3
    // deficiency test earlier in this file also cites §130.5(G) in its own
    // QuoteRequest, and a loose filter would collide with that unrelated row).
    const qr = await prisma.quoteRequest.findFirst({
      where: { accountId: admin.accountId, triggerType: 'ARC_FLASH_STUDY', notes: { contains: 'Arc flash study 5-year re-evaluation' } },
    });
    if (qr) {
      expect(qr.notes).toContain('§130.5');
      expect(qr.notes).not.toContain('(NFPA 70E Annex D best practice)');
      await prisma.quoteRequest.delete({ where: { id: qr.id } }).catch(() => {});
    }
  } finally {
    await prisma.notificationLog.deleteMany({ where: { accountId: admin.accountId, template: { contains: study.id } } }).catch(() => {});
    await prisma.systemStudy.delete({ where: { id: study.id } }).catch(() => {});
  }
});

export {};

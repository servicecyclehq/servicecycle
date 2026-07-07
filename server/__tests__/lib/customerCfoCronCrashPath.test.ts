/**
 * Regression test — 2026-07-07 daytime cron test-coverage audit.
 *
 * `runCustomerCfoCron` (customerCfo, quarterly 14:00 UTC on 1/4/7/10, index.ts)
 * had zero test coverage despite a comment in monthlyDigestCrashPath.test.ts
 * claiming it was "already covered by customerDigestCfo.test.ts" -- no such
 * file exists anywhere in the repo (verified via glob before writing this).
 * Exercises the real path: AccountSetting opt-in -> digestRecipients ->
 * buildCfoReportData -> pdfkit render -> sendEmail, against a real Postgres DB.
 * Email is mocked globally by __tests__/helpers/setup.ts.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { sendEmail } = require('../../lib/email');

let prisma: any;
let admin: TestUser;
let siteId: string;
let assetId: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `CFO Site ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({
    data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' },
  });
  assetId = asset.id;
  await prisma.accountSetting.create({
    data: { accountId: admin.accountId, key: 'customer_quarterly_cfo', value: 'true' },
  });
});

afterAll(async () => {
  const acc = admin.accountId;
  try { await prisma.accountSetting.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

beforeEach(() => {
  (sendEmail as jest.Mock).mockClear();
});

test('runCustomerCfoCron(): opted-in account gets a PDF-attached email against a real DB', async () => {
  const { runCustomerCfoCron } = require('../../lib/customerDigest');

  const result = await runCustomerCfoCron();

  expect(result.accountsProcessed).toBeGreaterThanOrEqual(1);
  expect(result.emailsSent).toBeGreaterThanOrEqual(1);

  const calls = (sendEmail as jest.Mock).mock.calls.filter((c: any[]) => c[0].to === admin.email);
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const call = calls[0][0];
  expect(call.subject).toMatch(/quarterly compliance/i);
  expect(Array.isArray(call.attachments)).toBe(true);
  expect(call.attachments[0].name).toMatch(/^servicecycle-cfo-report-\d{4}-\d{2}-\d{2}\.pdf$/);
  // pdfkit output starts with the PDF magic bytes once base64-decoded.
  const pdfBytes = Buffer.from(call.attachments[0].content, 'base64');
  expect(pdfBytes.slice(0, 5).toString('ascii')).toBe('%PDF-');
}, 30000);

test('an account without the opt-in setting is not processed', async () => {
  (sendEmail as jest.Mock).mockClear();
  const other = await createTestUser('admin');
  try {
    const { runCustomerCfoCron } = require('../../lib/customerDigest');
    await runCustomerCfoCron();
    const calls = (sendEmail as jest.Mock).mock.calls.filter((c: any[]) => c[0].to === other.email);
    expect(calls.length).toBe(0);
  } finally {
    try { await prisma.user.delete({ where: { id: other.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: other.accountId } }); } catch {}
  }
}, 30000);

export {};

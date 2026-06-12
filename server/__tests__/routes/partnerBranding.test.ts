/**
 * #15 Co-branded customer artifacts. Verifies the shared branding resolver
 * (account → partner org name/color), the coBrandLine helper, hex hardening,
 * and that the leave-behind renderer accepts branding and still emits a PDF.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { getAccountBranding, coBrandLine } = require('../../lib/partnerBranding');
const { renderLeaveBehindPdf } = require('../../lib/leaveBehindPdf');

let prisma: any;
let plain: TestUser;
let branded: TestUser;
let partnerOrgId: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  plain = await createTestUser('manager');
  branded = await createTestUser('manager');
  const org = await prisma.partnerOrganization.create({
    data: { name: 'Acme Electrical', primaryColor: '#0057b8' },
  });
  partnerOrgId = org.id;
  await prisma.account.update({ where: { id: branded.accountId }, data: { partnerOrgId } });
});

afterAll(async () => {
  for (const u of [plain, branded]) {
    try { await prisma.account.update({ where: { id: u.accountId }, data: { partnerOrgId: null } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: u.accountId } }); } catch {}
  }
  try { await prisma.partnerOrganization.delete({ where: { id: partnerOrgId } }); } catch {}
  await prisma.$disconnect();
});

describe('#15 partner branding resolver', () => {
  test('returns name + validated color for a channel account', async () => {
    const b = await getAccountBranding(branded.accountId);
    expect(b).toBeTruthy();
    expect(b.name).toBe('Acme Electrical');
    expect(b.primaryColor).toBe('#0057b8');
  });

  test('returns null for a direct (non-channel) account', async () => {
    const b = await getAccountBranding(plain.accountId);
    expect(b).toBeNull();
  });

  test('coBrandLine reads "Prepared by X · powered by ServiceCycle" / falls back', () => {
    expect(coBrandLine({ name: 'Acme Electrical', primaryColor: null, logoUrl: null }))
      .toBe('Prepared by Acme Electrical · powered by ServiceCycle');
    expect(coBrandLine(null)).toBe('Prepared by ServiceCycle');
  });

  test('malformed primaryColor is dropped (pdfkit never throws)', async () => {
    await prisma.partnerOrganization.update({ where: { id: partnerOrgId }, data: { primaryColor: 'blue' } });
    const b = await getAccountBranding(branded.accountId);
    expect(b.primaryColor).toBeNull();
    await prisma.partnerOrganization.update({ where: { id: partnerOrgId }, data: { primaryColor: '#0057b8' } });
  });

  test('leave-behind renders to a PDF with branding applied', async () => {
    const buf = await renderLeaveBehindPdf({
      workOrder: {
        id: 'wo-test-00000001', scheduledDate: new Date(), completedDate: new Date(),
        asset: { equipmentType: 'SWITCHGEAR', manufacturer: 'Square D', site: { name: 'Plant 2' } },
        account: { companyName: 'Customer Co' }, contractor: { name: 'Acme Electrical' },
      },
      deficiencies: [], openQuoteRequests: [], modernizationAssets: [],
      branding: { name: 'Acme Electrical', primaryColor: '#0057b8', logoUrl: null },
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });
});

export {};

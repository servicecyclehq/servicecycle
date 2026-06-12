/**
 * #9 EMP audit clock + coordinator nag (NFPA 70B 4.2).
 * buildComplianceGap surfaces two program-level gaps on the whole-account view:
 *   - no EMP coordinator named (EMP_COORDINATOR_USER_ID missing/stale)
 *   - EMP review missing / overdue / due-soon (EMP_LAST_REVIEWED_AT, 5-yr max)
 * Site-scoped calls skip them (the EMP is one per account). Each gap folds into
 * the obligation denominator so clearing the list still lands on 100%.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildComplianceGap } = require('../../lib/complianceReport');

let prisma: any;
let admin: TestUser;
let siteId: string;

const DAY = 24 * 60 * 60 * 1000;

async function setSetting(key: string, value: string | null) {
  if (value === null) {
    await prisma.accountSetting.deleteMany({ where: { accountId: admin.accountId, key } });
    return;
  }
  await prisma.accountSetting.upsert({
    where:  { accountId_key: { accountId: admin.accountId, key } },
    update: { value },
    create: { accountId: admin.accountId, key, value },
  });
}

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `EmpGap ${Date.now()}` } });
  siteId = site.id;
});

afterAll(async () => {
  const acc = admin.accountId;
  try { await prisma.accountSetting.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('#9 EMP program gaps in buildComplianceGap', () => {
  test('no settings -> coordinator + review gaps present', async () => {
    await setSetting('EMP_COORDINATOR_USER_ID', null);
    await setSetting('EMP_LAST_REVIEWED_AT', null);
    const gap = await buildComplianceGap(prisma, admin.accountId);
    const kinds = gap.actions.map((a: any) => a.kind);
    expect(kinds).toContain('emp_coordinator');
    expect(kinds).toContain('emp_review');
    expect(gap.summary.empGapCount).toBe(2);
    // program gaps sort to the very top
    expect(['emp_coordinator', 'emp_review']).toContain(gap.actions[0].kind);
  });

  test('coordinator named + reviewed recently -> no EMP gaps', async () => {
    await setSetting('EMP_COORDINATOR_USER_ID', admin.id);
    await setSetting('EMP_LAST_REVIEWED_AT', new Date().toISOString());
    const gap = await buildComplianceGap(prisma, admin.accountId);
    expect(gap.summary.empGapCount).toBe(0);
    expect(gap.actions.map((a: any) => a.kind)).not.toContain('emp_review');
  });

  test('review 5y+1d ago -> overdue review gap', async () => {
    await setSetting('EMP_COORDINATOR_USER_ID', admin.id);
    await setSetting('EMP_LAST_REVIEWED_AT', new Date(Date.now() - (5 * 365 + 2) * DAY).toISOString());
    const gap = await buildComplianceGap(prisma, admin.accountId);
    const review = gap.actions.find((a: any) => a.kind === 'emp_review');
    expect(review).toBeTruthy();
    expect(review.title.toLowerCase()).toContain('overdue');
    expect(gap.summary.empGapCount).toBe(1);
  });

  test('stale coordinator id (user not on account) -> coordinator gap', async () => {
    await setSetting('EMP_COORDINATOR_USER_ID', 'nonexistent-user-id');
    await setSetting('EMP_LAST_REVIEWED_AT', new Date().toISOString());
    const gap = await buildComplianceGap(prisma, admin.accountId);
    expect(gap.actions.map((a: any) => a.kind)).toContain('emp_coordinator');
  });

  test('site-scoped call skips program gaps', async () => {
    await setSetting('EMP_COORDINATOR_USER_ID', null);
    await setSetting('EMP_LAST_REVIEWED_AT', null);
    const gap = await buildComplianceGap(prisma, admin.accountId, { siteId });
    expect(gap.summary.empGapCount).toBe(0);
  });
});

export {};

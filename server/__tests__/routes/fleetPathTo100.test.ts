/**
 * #23 Fleet Path-to-100. The oem_admin endpoint runs buildComplianceGap for
 * every customer in the OEM's book and ranks them worst-first. Verifies scope
 * (same partnerOrg), the ranked payload shape, and oem_admin-only access.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let oem: TestUser;
let customer: TestUser;
let manager: TestUser; // non-oem, must be 403
let partnerOrgId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  oem = await createTestUser('oem_admin');
  customer = await createTestUser('manager');
  manager = await createTestUser('manager');
  const org = await prisma.partnerOrganization.create({ data: { name: `Fleet ${Date.now()}` } });
  partnerOrgId = org.id;
  // Both the OEM account and the customer account sit under the same partner org.
  await prisma.account.update({ where: { id: oem.accountId }, data: { partnerOrgId } });
  await prisma.account.update({ where: { id: customer.accountId }, data: { partnerOrgId } });
  // Give the customer one uncovered asset → overallRate < 100, >=1 action.
  const site = await prisma.site.create({ data: { accountId: customer.accountId, name: 'Plant' } });
  await prisma.asset.create({ data: { accountId: customer.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR' } });
});

afterAll(async () => {
  for (const u of [oem, customer, manager]) {
    const acc = u.accountId;
    try { await prisma.account.update({ where: { id: acc }, data: { partnerOrgId: null } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  try { await prisma.partnerOrganization.delete({ where: { id: partnerOrgId } }); } catch {}
  await prisma.$disconnect();
});

describe('#23 fleet path-to-100', () => {
  test('oem_admin gets the ranked customer list scoped to its partner org', async () => {
    const res = await request(app).get('/api/fleet/path-to-100').set('Authorization', `Bearer ${oem.token}`);
    expect(res.status).toBe(200);
    const cust = res.body.customers.find((c: any) => c.accountId === customer.accountId);
    expect(cust).toBeTruthy();
    expect(cust.overallRate).toBeLessThan(100);
    expect(cust.totalActions).toBeGreaterThanOrEqual(1);
    expect(cust.uncoveredCount).toBeGreaterThanOrEqual(1);
    // the unrelated manager's account must not appear (different/no partner org)
    expect(res.body.customers.find((c: any) => c.accountId === manager.accountId)).toBeFalsy();
    expect(res.body.summary.customerCount).toBeGreaterThanOrEqual(1);
  });

  test('non-oem user is forbidden', async () => {
    const res = await request(app).get('/api/fleet/path-to-100').set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(403);
  });
});

export {};

/**
 * #14 Contractor bulk ingest. An oem_admin can commit a test report INTO a
 * fleet customer account via targetAccountId (validated against the partner
 * org); cross-fleet and non-oem attempts are rejected; GET /api/sites honors
 * the same scoping so the cross-account create-asset flow shows the customer's
 * sites.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let oem: TestUser;
let customer: TestUser;
let outsider: TestUser;
let manager: TestUser;
let custAssetId: string;
let custSiteId: string;
let partnerOrgId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  oem = await createTestUser('oem_admin');
  customer = await createTestUser('manager');
  outsider = await createTestUser('manager');
  manager = await createTestUser('manager');
  const org = await prisma.partnerOrganization.create({ data: { name: `Ingest ${Date.now()}` } });
  partnerOrgId = org.id;
  await prisma.account.update({ where: { id: oem.accountId }, data: { partnerOrgId } });
  await prisma.account.update({ where: { id: customer.accountId }, data: { partnerOrgId } });
  // outsider deliberately NOT in the partner org
  const site = await prisma.site.create({ data: { accountId: customer.accountId, name: 'Cust Plant' } });
  custSiteId = site.id;
  const asset = await prisma.asset.create({ data: { accountId: customer.accountId, siteId: custSiteId, equipmentType: 'SWITCHGEAR', serialNumber: 'CUST-1' } });
  custAssetId = asset.id;
});

afterAll(async () => {
  for (const u of [oem, customer, outsider, manager]) {
    const acc = u.accountId;
    try { await prisma.testMeasurement.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.account.update({ where: { id: acc }, data: { partnerOrgId: null } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  try { await prisma.partnerOrganization.delete({ where: { id: partnerOrgId } }); } catch {}
  await prisma.$disconnect();
});

const bearer = (u: TestUser) => `Bearer ${u.token}`;
const meas = [{ measurementType: 'insulation_resistance', label: 'IR A', phase: 'A', asFoundValue: 1000, asFoundUnit: 'MΩ', passFail: 'GREEN' }];

describe('#14 oem fleet ingest', () => {
  test('oem commits a report into a fleet customer account', async () => {
    const res = await request(app)
      .post('/api/test-reports/import/commit')
      .set('Authorization', bearer(oem))
      .send({ targetAccountId: customer.accountId, assetId: custAssetId, measurements: meas, testDate: '2026-04-01' });
    expect(res.status).toBe(201);
    const wo = await prisma.workOrder.findFirst({ where: { accountId: customer.accountId, assetId: custAssetId } });
    expect(wo).toBeTruthy();
  });

  test('oem cannot commit into an account outside its partner org', async () => {
    const res = await request(app)
      .post('/api/test-reports/import/commit')
      .set('Authorization', bearer(oem))
      .send({ targetAccountId: outsider.accountId, assetId: custAssetId, measurements: meas });
    expect(res.status).toBe(403);
  });

  test('oem without targetAccountId is rejected', async () => {
    const res = await request(app)
      .post('/api/test-reports/import/commit')
      .set('Authorization', bearer(oem))
      .send({ assetId: custAssetId, measurements: meas });
    expect(res.status).toBe(403);
  });

  test('a non-oem cannot hijack via targetAccountId (override ignored)', async () => {
    // manager sends targetAccountId but is not oem → resolves to its OWN
    // account, where the customer asset does not exist → 404.
    const res = await request(app)
      .post('/api/test-reports/import/commit')
      .set('Authorization', bearer(manager))
      .send({ targetAccountId: customer.accountId, assetId: custAssetId, measurements: meas });
    expect(res.status).toBe(404);
  });

  test('GET /api/sites?targetAccountId returns the customer sites for the oem', async () => {
    const res = await request(app)
      .get(`/api/sites?targetAccountId=${customer.accountId}`)
      .set('Authorization', bearer(oem));
    expect(res.status).toBe(200);
    expect(res.body.data.sites.some((s: any) => s.id === custSiteId)).toBe(true);
  });

  test('GET /api/sites?targetAccountId outside the fleet is 403', async () => {
    const res = await request(app)
      .get(`/api/sites?targetAccountId=${outsider.accountId}`)
      .set('Authorization', bearer(oem));
    expect(res.status).toBe(403);
  });
});

export {};

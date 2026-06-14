/**
 * #37 QEMW credential wallet. Covers the roster credential-status classification
 * (valid / expiring / expired / none), the assignment-vs-requirement gap
 * (upcoming NETA-certified jobs vs qualified techs), and tenancy isolation.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let other: TestUser;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  other = await createTestUser('manager');

  const now = Date.now();
  const contractor = await prisma.contractor.create({ data: { accountId: manager.accountId, name: `QEMW Co ${now}` } });

  await prisma.contractorTech.createMany({
    data: [
      { contractorId: contractor.id, name: 'Valid Vic',     qemwCertNumber: 'Q-1', qemwExpiresAt: new Date(now + 200 * 86_400_000), qemwIssuingBody: 'NETA' },
      { contractorId: contractor.id, name: 'Expiring Ed',   qemwCertNumber: 'Q-2', qemwExpiresAt: new Date(now + 30 * 86_400_000),  qemwIssuingBody: 'NETA' },
      { contractorId: contractor.id, name: 'Expired Earl',  qemwCertNumber: 'Q-3', qemwExpiresAt: new Date(now - 10 * 86_400_000),  qemwIssuingBody: 'NETA' },
      { contractorId: contractor.id, name: 'Nocert Nancy' },
    ],
  });

  // One NETA-certified job due inside the default 30-day window.
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `QEMW Site ${now}` } });
  const asset = await prisma.asset.create({ data: { accountId: manager.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: 'QEMW-A' } });
  const def = await prisma.maintenanceTaskDefinition.create({
    data: { accountId: manager.accountId, equipmentType: 'SWITCHGEAR', taskName: 'Relay cal', taskCode: `QEMW_REQ_${now}`, intervalC2Months: 24, requiresNetaCertified: true },
  });
  await prisma.maintenanceSchedule.create({
    data: { accountId: manager.accountId, assetId: asset.id, taskDefinitionId: def.id, isActive: true, nextDueDate: new Date(now + 10 * 86_400_000) },
  });
});

afterAll(async () => {
  for (const u of [manager, other]) {
    const acc = u.accountId;
    try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.contractorTech.deleteMany({ where: { contractor: { accountId: acc } } }); } catch {}
    try { await prisma.contractor.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('#37 QEMW credential wallet', () => {
  test('classifies credential status and computes the coverage gap', async () => {
    const res = await request(app).get('/api/contractors/qemw-wallet').set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    const s = res.body.data.summary;
    expect(s.totalTechs).toBe(4);
    expect(s.qemwValid).toBe(1);
    expect(s.qemwExpiring).toBe(1);
    expect(s.qemwExpired).toBe(1);
    expect(s.qemwNone).toBe(1);
    expect(s.qualifiedTechsAvailable).toBe(2); // valid + expiring, not expired
    expect(s.upcomingCertifiedJobs).toBe(1);
    expect(s.hasCoverageGap).toBe(false); // jobs>0 but 2 qualified techs

    const expiring = res.body.data.techs.find((t: any) => t.name === 'Expiring Ed');
    expect(expiring.qemwStatus).toBe('expiring');
    expect(expiring.qemwDaysUntilExpiry).toBeGreaterThan(0);
    const none = res.body.data.techs.find((t: any) => t.name === 'Nocert Nancy');
    expect(none.qemwStatus).toBe('none');
  });

  test('another account sees an empty roster (tenancy)', async () => {
    const res = await request(app).get('/api/contractors/qemw-wallet').set('Authorization', auth(other));
    expect(res.status).toBe(200);
    expect(res.body.data.summary.totalTechs).toBe(0);
    expect(res.body.data.summary.upcomingCertifiedJobs).toBe(0);
  });

  test('the literal path is not captured by the /:id contractor route', async () => {
    // If /qemw-wallet were captured by GET /:id, this would 404 (no such contractor).
    const res = await request(app).get('/api/contractors/qemw-wallet').set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('techs');
  });
});

export {};

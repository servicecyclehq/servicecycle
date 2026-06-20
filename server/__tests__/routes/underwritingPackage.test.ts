/**
 * Phase 1 #3 insurer underwriting package + break-glass share link. Verifies the
 * assembled packet shape (readiness / risk posture / capital plan / evidence
 * integrity), the authenticated one-click route, the 'underwriting' share-link
 * kind end-to-end (create manager+, public view-only read, tenant isolation),
 * and that the default share kind stays backward-compatible.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildUnderwritingPackage } = require('../../lib/underwritingPackage');

let app: any;
let prisma: any;
let manager: TestUser;
let viewer: TestUser;   // same account -- can read packet, cannot mint links
let other: TestUser;    // separate tenant

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  viewer = await createTestUser('viewer', { accountId: manager.accountId });
  other = await createTestUser('manager');

  // One uncovered asset -> non-trivial readiness + risk posture for the packet.
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `UW ${Date.now()}` } });
  await prisma.asset.create({ data: { accountId: manager.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: 'UW-1' } });
});

afterAll(async () => {
  for (const acc of [manager.accountId, other.accountId]) {
    try { await prisma.shareLink.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  }
  for (const u of [manager, viewer, other]) {
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
  }
  for (const acc of [manager.accountId, other.accountId]) {
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('#3 insurer underwriting package + break-glass link', () => {
  test('assembles the packet from existing builders', async () => {
    const p = await buildUnderwritingPackage(prisma, manager.accountId);
    expect(p.companyName).toBeTruthy();
    expect(p.standard).toBe('NFPA 70B');
    expect(typeof p.readiness.overallRate === 'number' || p.readiness.overallRate === null).toBe(true);
    expect(p.readiness).toHaveProperty('score');
    expect(p.riskPosture).toHaveProperty('bySeverity');
    expect(p.riskPosture.untrackedAssets).toBeGreaterThanOrEqual(1); // the uncovered asset
    expect(p.financial).toHaveProperty('plan');
    expect(p.financial.currency).toBe('USD');
    expect(p.evidenceIntegrity).toHaveProperty('snapshotCount');
    expect(p.evidenceIntegrity.immutable).toBe(true);
  });

  test('GET /api/compliance/underwriting-package is readable by any role', async () => {
    const res = await request(app).get('/api/compliance/underwriting-package').set('Authorization', auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.readiness).toHaveProperty('overallRate');
  });

  test('manager mints an underwriting break-glass link; public view is read-only', async () => {
    const created = await request(app).post('/api/share-links').set('Authorization', auth(manager)).send({ kind: 'underwriting', days: 14, label: 'Acme Mutual' });
    expect(created.status).toBe(201);
    expect(created.body.data.kind).toBe('underwriting');
    const token = created.body.data.token;

    const pub = await request(app).get(`/api/public/share/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.kind).toBe('underwriting');
    expect(pub.body.data.readOnly).toBe(true);
    expect(pub.body.data.sharedWith).toBe('Acme Mutual');
    expect(pub.body.data.readiness).toHaveProperty('overallRate');
    expect(pub.body.data.financial).toHaveProperty('plan');
    expect(pub.body.data.watermark).toContain('ServiceCycle');
  });

  test('viewer cannot mint a link (manager+ only)', async () => {
    const res = await request(app).post('/api/share-links').set('Authorization', auth(viewer)).send({ kind: 'underwriting', days: 7 });
    expect(res.status).toBe(403);
  });

  test('an unknown / unsupported kind falls back to the compliance package', async () => {
    const created = await request(app).post('/api/share-links').set('Authorization', auth(manager)).send({ kind: 'totally_bogus', days: 7 });
    expect(created.status).toBe(201);
    expect(created.body.data.kind).toBe('compliance_package');
    const pub = await request(app).get(`/api/public/share/${created.body.data.token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.kind).toBe('compliance_package');
    expect(pub.body.data).toHaveProperty('topActions'); // the auditor view shape
  });

  test('a separate tenant cannot read this account links', async () => {
    const list = await request(app).get('/api/share-links').set('Authorization', auth(other));
    expect(list.status).toBe(200);
    expect(list.body.data.links.length).toBe(0);
  });
});

export {};

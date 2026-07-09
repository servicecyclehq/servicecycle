/**
 * Slice 3.5c arc-flash public label portal — GET /api/public/arc-flash-label/:token.
 * Public (unauthenticated), rate-limited (publicTokenLookupLimiter) token lookup
 * that resolves NFPA 70E 130.5(H) label data for a worker scanning a QR/NFC label
 * before energized electrical work. Covers: valid non-stale token -> current
 * label data, a superseded study hard-flagging the label stale with a warning,
 * unknown/invalid token 404s, and cross-tenant data isolation. Structurally
 * mirrors shareLinkPublic.ts / shareLinks.test.ts (public token-lookup pattern).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let other: TestUser;

let siteId: string;
let assetId: string;
let studyId: string;
let token: string;

let otherSiteId: string;
let otherAssetId: string;
let otherStudyId: string;
let otherToken: string;

const auth = (u: TestUser) => `Bearer ${u.token}`;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  other = await createTestUser('manager');

  // ── Account A fixtures ──────────────────────────────────────────────────
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `AFL-A ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR', serialNumber: `AFL-A-${Date.now()}` } });
  assetId = asset.id;

  const study = await request(app)
    .post(`/api/sites/${siteId}/studies`)
    .set('Authorization', auth(manager))
    .send({ studyType: 'arc_flash', performedDate: '2024-01-15', peName: 'Jane PE', method: 'IEEE 1584-2018' });
  expect(study.status).toBe(201);
  studyId = study.body.data.study.id;

  const bind = await request(app)
    .post(`/api/sites/studies/${studyId}/assets`)
    .set('Authorization', auth(manager))
    .send({
      assetId, busName: 'SWGR-A Main Bus', nominalVoltage: '480V',
      incidentEnergyCalCm2: 8.4, arcFlashBoundaryIn: 36, workingDistanceIn: 18,
    });
  expect(bind.status).toBe(201);

  const issued = await request(app)
    .post(`/api/arc-flash/asset/${assetId}/issue-label`)
    .set('Authorization', auth(manager))
    .send({});
  expect(issued.status).toBe(200);
  token = issued.body.data.token;
  expect(token).toBeTruthy();

  // ── Account B fixtures (cross-tenant control) ───────────────────────────
  const siteB = await prisma.site.create({ data: { accountId: other.accountId, name: `AFL-B ${Date.now()}` } });
  otherSiteId = siteB.id;
  const assetB = await prisma.asset.create({ data: { accountId: other.accountId, siteId: otherSiteId, equipmentType: 'SWITCHGEAR', serialNumber: `AFL-B-${Date.now()}` } });
  otherAssetId = assetB.id;

  const studyB = await request(app)
    .post(`/api/sites/${otherSiteId}/studies`)
    .set('Authorization', auth(other))
    .send({ studyType: 'arc_flash', performedDate: '2024-02-01', peName: 'John PE', method: 'IEEE 1584-2018' });
  expect(studyB.status).toBe(201);
  otherStudyId = studyB.body.data.study.id;

  const bindB = await request(app)
    .post(`/api/sites/studies/${otherStudyId}/assets`)
    .set('Authorization', auth(other))
    .send({
      assetId: otherAssetId, busName: 'SWGR-B Main Bus', nominalVoltage: '208V',
      incidentEnergyCalCm2: 2.1, arcFlashBoundaryIn: 18, workingDistanceIn: 18,
    });
  expect(bindB.status).toBe(201);

  const issuedB = await request(app)
    .post(`/api/arc-flash/asset/${otherAssetId}/issue-label`)
    .set('Authorization', auth(other))
    .send({});
  expect(issuedB.status).toBe(200);
  otherToken = issuedB.body.data.token;
  expect(otherToken).toBeTruthy();
});

afterAll(async () => {
  for (const u of [manager, other]) {
    const acc = u.accountId;
    try { await prisma.systemStudyAsset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.systemStudy.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

describe('arc-flash public label portal', () => {
  test('valid non-stale token -> 200, labelStatus current, correct incident-energy/PPE data', async () => {
    const res = await request(app).get(`/api/public/arc-flash-label/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.labelStatus).toBe('current');
    expect(res.body.data.isCurrent).toBe(true);
    expect(res.body.data.warning).toBeNull();
    expect(res.body.data.busName).toBe('SWGR-A Main Bus');
    expect(res.body.data.equipmentType).toBe('SWITCHGEAR');
    expect(res.body.data.label.nominalVoltage).toBe('480V');
    expect(res.body.data.label.incidentEnergyCalCm2).toBe(8.4);
    expect(res.body.data.label.arcFlashBoundaryIn).toBe(36);
    expect(res.body.data.label.workingDistanceIn).toBe(18);
    // Table 130.4 fallback (no PE-captured shock boundary was supplied) — 480V
    // falls in the 151-750V band: limited 42in / restricted 12in.
    expect(res.body.data.label.shockLimitedApproachIn).toBe(42);
    expect(res.body.data.label.shockRestrictedApproachIn).toBe(12);
    expect(res.body.data.study.superseded).toBe(false);
  });

  test('cross-tenant isolation: each token resolves only its own account data', async () => {
    const resA = await request(app).get(`/api/public/arc-flash-label/${token}`);
    const resB = await request(app).get(`/api/public/arc-flash-label/${otherToken}`);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    expect(resA.body.data.busName).toBe('SWGR-A Main Bus');
    expect(resA.body.data.label.nominalVoltage).toBe('480V');
    expect(resA.body.data.label.incidentEnergyCalCm2).toBe(8.4);

    expect(resB.body.data.busName).toBe('SWGR-B Main Bus');
    expect(resB.body.data.label.nominalVoltage).toBe('208V');
    expect(resB.body.data.label.incidentEnergyCalCm2).toBe(2.1);

    // No cross-contamination between the two tenants' label data.
    expect(resA.body.data.busName).not.toBe(resB.body.data.busName);
    expect(resA.body.data.label.incidentEnergyCalCm2).not.toBe(resB.body.data.label.incidentEnergyCalCm2);
  });

  test('unknown token is 404', async () => {
    const res = await request(app).get('/api/public/arc-flash-label/deadbeefdeadbeefdeadbeef');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test('too-short/invalid token is 404', async () => {
    const res = await request(app).get('/api/public/arc-flash-label/short');
    expect(res.status).toBe(404);
  });

  test('a superseded study marks the label stale with a non-null warning', async () => {
    const newer = await prisma.systemStudy.create({
      data: {
        accountId: manager.accountId, siteId, studyType: 'arc_flash',
        performedDate: new Date('2026-01-01'), expiresAt: new Date('2031-01-01'),
        method: 'IEEE 1584-2018', peName: 'Newer PE',
      },
    });
    await prisma.systemStudy.update({ where: { id: studyId }, data: { supersededById: newer.id } });

    const res = await request(app).get(`/api/public/arc-flash-label/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.labelStatus).toBe('study_superseded');
    expect(res.body.data.isCurrent).toBe(false);
    expect(res.body.data.study.superseded).toBe(true);
    expect(res.body.data.warning).not.toBeNull();
    expect(res.body.data.warning).toEqual(expect.stringContaining('superseded'));
  });
});

export {};

/**
 * EMP generator (NFPA 70B:2023 §4.2) — one-click + regulator-ready guard.
 *
 * Proves:
 *   - buildEmpData() assembles the program from live data, including the §4.2
 *     single-line-diagram coverage statistic (powerPathMapped) from the asset
 *     feed graph, and survives the zero-asset edge case.
 *   - renderEmpPdf() emits a valid PDF without throwing — exercising every
 *     section writer including the added Purpose & Scope front matter and the
 *     Program Approval signature block.
 *   - POST /api/compliance/emp-document is genuinely one-click (no body), is
 *     hash-anchored (kind='emp', sha256 present), and is gated to manager+.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildEmpData, renderEmpPdf } = require('../../lib/empDocument');

let app: any;
let prisma: any;
let manager: TestUser;
let viewer: TestUser;
let siteId: string;
const assetIds: string[] = [];

beforeAll(async () => {
  app    = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;

  manager = await createTestUser('manager');
  // A second same-account user for the gate test (viewer must be blocked).
  viewer  = await createTestUser('viewer', { accountId: manager.accountId });

  const site = await prisma.site.create({
    data: { accountId: manager.accountId, name: `EMP Site ${Date.now()}` },
  });
  siteId = site.id;

  // Asset A is the upstream source; Asset B is fed from A → one mapped feed.
  const a = await prisma.asset.create({
    data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR' },
  });
  const b = await prisma.asset.create({
    data: {
      accountId: manager.accountId, siteId, equipmentType: 'CIRCUIT_BREAKER',
      fedFromAssetId: a.id,
    },
  });
  assetIds.push(a.id, b.id);
});

afterAll(async () => {
  const acc = manager.accountId;
  try { await prisma.complianceSnapshot.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.updateMany({ where: { accountId: acc }, data: { fedFromAssetId: null } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('EMP §4.2 document', () => {
  test('buildEmpData computes single-line / power-path coverage', async () => {
    const data = await buildEmpData(prisma, manager.accountId);
    expect(data.equipmentSurvey.totalAssets).toBe(2);
    // Exactly one asset (B) has its upstream source mapped.
    expect(data.equipmentSurvey.powerPathMapped).toBe(1);
    expect(data.accountName).toBeTruthy();
  });

  test('renderEmpPdf emits a valid PDF (all section writers run)', async () => {
    const data = await buildEmpData(prisma, manager.accountId);
    const buf = await renderEmpPdf(data, {
      snapshotId: 'test-emp-id', accountName: data.accountName,
      generatedByName: 'Test Manager', generatedAtIso: new Date().toISOString(),
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(2000);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('renderEmpPdf survives the zero-asset account (X of Y phrasing)', async () => {
    const empty = await createTestUser('manager');
    try {
      const data = await buildEmpData(prisma, empty.accountId);
      expect(data.equipmentSurvey.totalAssets).toBe(0);
      expect(data.equipmentSurvey.powerPathMapped).toBe(0);
      const buf = await renderEmpPdf(data, {
        snapshotId: 'z', accountName: data.accountName,
        generatedByName: 'X', generatedAtIso: new Date().toISOString(),
      });
      expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
    } finally {
      try { await prisma.user.delete({ where: { id: empty.id } }); } catch {}
      try { await prisma.account.delete({ where: { id: empty.accountId } }); } catch {}
    }
  });

  test('POST /api/compliance/emp-document is one-click + hash-anchored (manager)', async () => {
    const res = await request(app)
      .post('/api/compliance/emp-document')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({}); // no body — truly one-click
    expect(res.status).toBe(201);
    expect(res.body?.success).toBe(true);
    const snap = res.body?.data?.snapshot;
    expect(snap).toBeTruthy();
    expect(snap.kind).toBe('emp');
    expect(typeof snap.sha256).toBe('string');
    expect(snap.sha256.length).toBe(64);
    expect(snap.stats).toBeTruthy();
    expect(snap.stats.assets).toBe(2);
  });

  test('POST /api/compliance/emp-document is blocked for viewer (manager+ gate)', async () => {
    const res = await request(app)
      .post('/api/compliance/emp-document')
      .set('Authorization', `Bearer ${viewer.token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('POST /api/compliance/emp-document requires auth', async () => {
    const res = await request(app).post('/api/compliance/emp-document').send({});
    expect(res.status).toBe(401);
  });
});

export {};

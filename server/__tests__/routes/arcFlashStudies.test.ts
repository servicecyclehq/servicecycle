/**
 * #25 Arc-flash first-class records — study asset coverage + incident-energy
 * label export. Covers: binding a root bus with §130.5(H) label data, power-path
 * downstream expansion, label-data completeness flagging, unbind, validation,
 * and tenancy isolation.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let other: TestUser;
let siteId: string;
let studyId: string;
let rootAssetId: string;
let childAssetId: string;
let grandchildAssetId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  other = await createTestUser('manager');

  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `AF ${Date.now()}` } });
  siteId = site.id;

  // Power path: root SWGR -> child PANELBOARD -> grandchild BREAKER
  const root = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR', serialNumber: 'AF-ROOT' } });
  rootAssetId = root.id;
  const child = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'PANELBOARD', serialNumber: 'AF-CHILD', fedFromAssetId: root.id } });
  childAssetId = child.id;
  const gc = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'CIRCUIT_BREAKER', serialNumber: 'AF-GC', fedFromAssetId: child.id } });
  grandchildAssetId = gc.id;

  const study = await request(app)
    .post(`/api/sites/${siteId}/studies`)
    .set('Authorization', `Bearer ${manager.token}`)
    .send({ studyType: 'arc_flash', performedDate: '2024-01-15', peName: 'Jane PE', peLicense: 'PE-12345', method: 'IEEE 1584-2018' });
  expect(study.status).toBe(201);
  studyId = study.body.data.study.id;
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

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('#25 arc-flash study asset coverage', () => {
  test('binds a root bus with full §130.5(H) label data and expands downstream', async () => {
    const res = await request(app)
      .post(`/api/sites/studies/${studyId}/assets`)
      .set('Authorization', auth(manager))
      .send({
        assetId: rootAssetId,
        busName: 'SWGR-1 Main Bus',
        nominalVoltage: '480V',
        incidentEnergyCalCm2: 8.4,
        arcFlashBoundaryIn: 36,
        workingDistanceIn: 18,
        includeDownstream: true,
      });
    expect(res.status).toBe(201);
    // root + child + grandchild = 3 covered; 2 added via downstream
    expect(res.body.data.coveredCount).toBe(3);
    expect(res.body.data.downstreamAdded).toBe(2);
  });

  test('label-data export flags the root complete and downstream incomplete', async () => {
    const res = await request(app)
      .get(`/api/sites/studies/${studyId}/label-data`)
      .set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.data.coveredCount).toBe(3);
    expect(res.body.data.completeCount).toBe(1);
    expect(res.body.data.study.peName).toBe('Jane PE');
    expect(res.body.data.study.expiresAt).toBeTruthy();
    const root = res.body.data.labels.find((l: any) => l.assetId === rootAssetId);
    expect(root.labelComplete).toBe(true);
    expect(root.incidentEnergyCalCm2).toBe(8.4);
    expect(root.nominalVoltage).toBe('480V');
    const child = res.body.data.labels.find((l: any) => l.assetId === childAssetId);
    expect(child.labelComplete).toBe(false);
  });

  test('a PPE-category-only label is also considered complete', async () => {
    const res = await request(app)
      .post(`/api/sites/studies/${studyId}/assets`)
      .set('Authorization', auth(manager))
      .send({ assetId: childAssetId, nominalVoltage: '208V', arcFlashBoundaryIn: 24, ppeCategory: 2 });
    expect(res.status).toBe(201);
    const labels = await request(app).get(`/api/sites/studies/${studyId}/label-data`).set('Authorization', auth(manager));
    const child = labels.body.data.labels.find((l: any) => l.assetId === childAssetId);
    expect(child.labelComplete).toBe(true);
    expect(child.ppeCategory).toBe(2);
  });

  test('rejects an out-of-range ppeCategory and a missing assetId', async () => {
    const bad1 = await request(app).post(`/api/sites/studies/${studyId}/assets`).set('Authorization', auth(manager)).send({ assetId: rootAssetId, ppeCategory: 9 });
    expect(bad1.status).toBe(400);
    const bad2 = await request(app).post(`/api/sites/studies/${studyId}/assets`).set('Authorization', auth(manager)).send({ busName: 'no asset' });
    expect(bad2.status).toBe(400);
  });

  test('unbind drops coverage count', async () => {
    const res = await request(app)
      .delete(`/api/sites/studies/${studyId}/assets/${grandchildAssetId}`)
      .set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.data.coveredCount).toBe(2);
  });

  test('another account cannot bind to or read this study', async () => {
    const bind = await request(app).post(`/api/sites/studies/${studyId}/assets`).set('Authorization', auth(other)).send({ assetId: rootAssetId });
    expect(bind.status).toBe(404);
    const read = await request(app).get(`/api/sites/studies/${studyId}/label-data`).set('Authorization', auth(other));
    expect(read.status).toBe(404);
  });

  test('study list surfaces a coveredAssets count', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/studies`).set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    const s = res.body.data.studies.find((x: any) => x.id === studyId);
    expect(s._count.coveredAssets).toBe(2);
  });
});

describe('#25 IEEE 1584 inputs, DANGER classification, and per-asset trend', () => {
  test('binds with IEEE 1584 inputs and validates electrode config', async () => {
    const ok = await request(app)
      .post(`/api/sites/studies/${studyId}/assets`)
      .set('Authorization', auth(manager))
      .send({
        assetId: rootAssetId, busName: 'SWGR-1 Main Bus', nominalVoltage: '480V',
        incidentEnergyCalCm2: 8.4, arcFlashBoundaryIn: 36, workingDistanceIn: 18,
        boltedFaultCurrentKA: 25.3, arcingCurrentKA: 14.1, electrodeConfig: 'vcb',
        conductorGapMm: 32, clearingTimeMs: 83, upstreamDevice: 'Main 800A',
      });
    expect(ok.status).toBe(201);
    const labels = await request(app).get(`/api/sites/studies/${studyId}/label-data`).set('Authorization', auth(manager));
    const root = labels.body.data.labels.find((l: any) => l.assetId === rootAssetId);
    expect(root.boltedFaultCurrentKA).toBe(25.3);
    expect(root.electrodeConfig).toBe('VCB'); // upper-cased on input
    expect(root.hazardClass).toBe('WARNING'); // 8.4 cal/cm² @ 480V

    const bad = await request(app).post(`/api/sites/studies/${studyId}/assets`).set('Authorization', auth(manager))
      .send({ assetId: rootAssetId, electrodeConfig: 'XYZ' });
    expect(bad.status).toBe(400);
  });

  test('classifies DANGER above 40 cal/cm² or above 600V', async () => {
    await request(app).post(`/api/sites/studies/${studyId}/assets`).set('Authorization', auth(manager))
      .send({ assetId: childAssetId, nominalVoltage: '480V', arcFlashBoundaryIn: 60, incidentEnergyCalCm2: 52, workingDistanceIn: 18 });
    const l1 = await request(app).get(`/api/sites/studies/${studyId}/label-data`).set('Authorization', auth(manager));
    expect(l1.body.data.labels.find((l: any) => l.assetId === childAssetId).hazardClass).toBe('DANGER'); // 52 > 40

    await request(app).post(`/api/sites/studies/${studyId}/assets`).set('Authorization', auth(manager))
      .send({ assetId: rootAssetId, nominalVoltage: '13.8kV', arcFlashBoundaryIn: 120, incidentEnergyCalCm2: 6, workingDistanceIn: 36 });
    const l2 = await request(app).get(`/api/sites/studies/${studyId}/label-data`).set('Authorization', auth(manager));
    expect(l2.body.data.labels.find((l: any) => l.assetId === rootAssetId).hazardClass).toBe('DANGER'); // 13.8kV > 600V
  });

  test('per-asset trend spans study revisions oldest->newest with delta', async () => {
    const s2 = await request(app).post(`/api/sites/${siteId}/studies`).set('Authorization', auth(manager))
      .send({ studyType: 'arc_flash', performedDate: '2026-02-01', method: 'IEEE 1584-2018' });
    const study2Id = s2.body.data.study.id;
    await request(app).post(`/api/sites/studies/${study2Id}/assets`).set('Authorization', auth(manager))
      .send({ assetId: rootAssetId, nominalVoltage: '13.8kV', incidentEnergyCalCm2: 18, arcFlashBoundaryIn: 140, workingDistanceIn: 36 });

    const res = await request(app).get(`/api/sites/arc-flash/asset/${rootAssetId}/trend`).set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    const pts = res.body.data.points;
    expect(pts.length).toBe(2);
    expect(new Date(pts[0].performedDate).getTime()).toBeLessThan(new Date(pts[1].performedDate).getTime());
    expect(res.body.data.trend.direction).toBe('increasing'); // 6 -> 18
    expect(res.body.data.latest.incidentEnergyCalCm2).toBe(18);
    expect(res.body.data.latest.hazardClass).toBe('DANGER'); // 13.8kV
  });

  test('trend is account-scoped (other tenant 404s)', async () => {
    const res = await request(app).get(`/api/sites/arc-flash/asset/${rootAssetId}/trend`).set('Authorization', auth(other));
    expect(res.status).toBe(404);
  });
});

// [W3] docs/scoping/audits/afx-scenario-preservation.md near-term fix: the
// study list must resolve a source document link two ways — a manually
// typed reportPdfUrl (unchanged contract, wins if present) or an
// ingest-linked reportFileKey (resolved to a servable URL at read time,
// never baked in — an S3 destination's resolved URL is short-lived).
describe('#25 W3 study source-document link', () => {
  test('reportFileKey resolves to a servable URL when no manual reportPdfUrl is set', async () => {
    const s = await request(app).post(`/api/sites/${siteId}/studies`).set('Authorization', auth(manager))
      .send({ studyType: 'arc_flash', performedDate: '2025-03-01', method: 'IEEE 1584-2018' });
    const sId = s.body.data.study.id;
    await prisma.systemStudy.update({ where: { id: sId }, data: { reportFileKey: `${manager.accountId}/arc-flash/fake-key.pdf` } });

    const res = await request(app).get(`/api/sites/${siteId}/studies`).set('Authorization', auth(manager));
    const row = res.body.data.studies.find((x: any) => x.id === sId);
    expect(row.reportPdfUrl).toBeNull();
    expect(row.sourceDocumentUrl).toBe(`/api/documents/file?key=${encodeURIComponent(`${manager.accountId}/arc-flash/fake-key.pdf`)}`);
  });

  test('a manually-typed reportPdfUrl wins over a linked reportFileKey', async () => {
    const s = await request(app).post(`/api/sites/${siteId}/studies`).set('Authorization', auth(manager))
      .send({ studyType: 'arc_flash', performedDate: '2025-03-01', method: 'IEEE 1584-2018', reportPdfUrl: 'https://example.com/study.pdf' });
    const sId = s.body.data.study.id;
    await prisma.systemStudy.update({ where: { id: sId }, data: { reportFileKey: `${manager.accountId}/arc-flash/fake-key-2.pdf` } });

    const res = await request(app).get(`/api/sites/${siteId}/studies`).set('Authorization', auth(manager));
    const row = res.body.data.studies.find((x: any) => x.id === sId);
    expect(row.sourceDocumentUrl).toBe('https://example.com/study.pdf');
  });

  test('neither set: sourceDocumentUrl is null, no crash', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/studies`).set('Authorization', auth(manager));
    const row = res.body.data.studies.find((x: any) => x.id === studyId); // the very first study created in this file, never got a report link
    expect(row.sourceDocumentUrl).toBeNull();
  });
});

export {};

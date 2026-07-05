/**
 * Arc-flash Slice 2 — ingest + gap-analysis + review/confirm route.
 * AI is mocked so a PNG upload drives the vision path deterministically.
 */
const FIXTURE = {
  system: {
    sourceVoltage: '13.8kV',
    mainTransformer: { kva: 1500, primaryVoltage: '13.8kV', secondaryVoltage: '480V', impedancePct: 5.5 },
    serviceFaultCurrentKA: 22,
    studyMeta: { peName: 'S. Hawthorne', date: '2024-01-15', method: 'IEEE 1584-2018', software: 'EasyPower' },
  },
  buses: [
    { busName: 'SWGR-1A', equipmentType: 'switchgear', fedFromBusName: null, nominalVoltage: '13.8kV', boltedFaultCurrentKA: 22, clearingTimeMs: 200, electrodeConfig: 'VCB', conductorGapMm: 152, workingDistanceIn: 36, upstreamDevice: 'Utility 51' },
    { busName: 'MCC-2', equipmentType: 'motor control center', fedFromBusName: 'SWGR-1A', nominalVoltage: '480V', boltedFaultCurrentKA: 30 },
    { busName: 'PNL-3', equipmentType: null, fedFromBusName: 'MCC-2', nominalVoltage: '480V' },
  ],
};

jest.mock('../../lib/ai', () => ({
  complete: jest.fn().mockResolvedValue({ text: JSON.stringify(FIXTURE), provider: 'mock' }),
  completeWithImage: jest.fn().mockResolvedValue({ text: JSON.stringify(FIXTURE) }),
  parseJSON: (t: string) => JSON.parse(t),
}));

import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let other: TestUser;
let siteId: string;
let ingestId: string;

const auth = (u: TestUser) => `Bearer ${u.token}`;
const png = Buffer.from('89504e470d0a1a0a', 'hex'); // PNG magic — content irrelevant (AI mocked)

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  other = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `AFI ${Date.now()}` } });
  siteId = site.id;
});

afterAll(async () => {
  for (const u of [manager, other]) {
    const acc = u.accountId;
    try { await prisma.arcFlashIngestBus.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.arcFlashIngest.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.systemStudyAsset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.systemStudy.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

describe('arc-flash ingest → gap → review', () => {
  test('upload extracts buses, runs the gap engine, parks for review', async () => {
    const res = await request(app)
      .post('/api/arc-flash/ingest')
      .set('Authorization', auth(manager))
      .field('siteId', siteId)
      .field('sourceType', 'one_line')
      .attach('file', png, { filename: 'oneline.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('needs_review');
    expect(res.body.data.method).toBe('vision');
    expect(res.body.data.totalBusCount).toBe(3);
    expect(res.body.data.readyBusCount).toBe(1);      // SWGR-1A fully specified
    expect(res.body.data.overallBand).toBe('red');     // MCC-2 + PNL-3 missing clearing time
    ingestId = res.body.data.ingestId;
  });

  test('draft GET returns buses + auto Review Package with the 2-question ask', async () => {
    const res = await request(app).get(`/api/arc-flash/ingest/${ingestId}`).set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.data.buses).toHaveLength(3);
    const swgr = res.body.data.buses.find((b: any) => b.busName === 'SWGR-1A');
    expect(swgr.equipmentTypeGuess).toBe('SWITCHGEAR');
    expect(swgr.readiness).toBe('ready');
    const mcc = res.body.data.buses.find((b: any) => b.busName === 'MCC-2');
    expect(mcc.readiness).toBe('blocked'); // clearing time missing
    const rp = res.body.data.reviewPackage;
    expect(rp.engineerAsk).toHaveLength(2);
    expect(rp.extract.busCount).toBe(3);
    expect(rp.gapList.length).toBeGreaterThan(0);
  });

  test('list surfaces the draft for the site', async () => {
    const res = await request(app).get(`/api/arc-flash/ingests?siteId=${siteId}`).set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.data.ingests.some((i: any) => i.id === ingestId)).toBe(true);
  });

  test('cross-account isolation: another account cannot read the draft', async () => {
    const res = await request(app).get(`/api/arc-flash/ingest/${ingestId}`).set('Authorization', auth(other));
    expect(res.status).toBe(404);
  });

  test('editing a bus re-runs the gap engine', async () => {
    const draft = await request(app).get(`/api/arc-flash/ingest/${ingestId}`).set('Authorization', auth(manager));
    const mcc = draft.body.data.buses.find((b: any) => b.busName === 'MCC-2');
    const res = await request(app)
      .patch(`/api/arc-flash/ingest/${ingestId}/bus/${mcc.id}`)
      .set('Authorization', auth(manager))
      .send({ clearingTimeMs: 50, resolution: 'create' });
    expect(res.status).toBe(200);
    expect(res.body.data.bus.readiness).toBe('defaultable'); // now only typicals defaulted
    expect(res.body.data.bus.confidence).toBe('yellow');
  });

  test('confirm blocks a create-bus with no equipment type', async () => {
    const draft = await request(app).get(`/api/arc-flash/ingest/${ingestId}`).set('Authorization', auth(manager));
    const pnl = draft.body.data.buses.find((b: any) => b.busName === 'PNL-3');
    // force it to create without a type
    await request(app).patch(`/api/arc-flash/ingest/${ingestId}/bus/${pnl.id}`).set('Authorization', auth(manager)).send({ resolution: 'create', equipmentTypeGuess: null });
    const res = await request(app).post(`/api/arc-flash/ingest/${ingestId}/confirm`).set('Authorization', auth(manager)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PNL-3/);
  });

  test('confirm creates/links assets, wires topology, and spins up a study', async () => {
    const draft = await request(app).get(`/api/arc-flash/ingest/${ingestId}`).set('Authorization', auth(manager));
    const pnl = draft.body.data.buses.find((b: any) => b.busName === 'PNL-3');
    await request(app).patch(`/api/arc-flash/ingest/${ingestId}/bus/${pnl.id}`).set('Authorization', auth(manager)).send({ equipmentTypeGuess: 'PANELBOARD', resolution: 'create' });

    const res = await request(app).post(`/api/arc-flash/ingest/${ingestId}/confirm`).set('Authorization', auth(manager)).send({ createStudy: true, studyType: 'arc_flash' });
    expect(res.status).toBe(200);
    expect(res.body.data.assetsCreated).toBe(3);
    expect(res.body.data.feedsWired).toBe(2);   // SWGR-1A → MCC-2 → PNL-3
    expect(res.body.data.boundCount).toBe(3);
    expect(res.body.data.studyId).toBeTruthy();

    // Idempotent guard: a second confirm is rejected.
    const again = await request(app).post(`/api/arc-flash/ingest/${ingestId}/confirm`).set('Authorization', auth(manager)).send({});
    expect(again.status).toBe(409);

    // The created switchgear is now a real asset feeding the MCC.
    const assets = await prisma.asset.findMany({ where: { accountId: manager.accountId, siteId } });
    expect(assets.length).toBe(3);
    const mccAsset = assets.find((a: any) => a.equipmentType === 'MCC');
    const swgrAsset = assets.find((a: any) => a.equipmentType === 'SWITCHGEAR');
    expect(mccAsset.fedFromAssetId).toBe(swgrAsset.id);
  });

  // [W3] The one-line PNG this whole ingest was uploaded from should now be
  // linked to the produced study (reportFileKey, set at confirm) and
  // resolved to a servable URL on every asset the study covers — see
  // docs/scoping/audits/afx-scenario-preservation.md, W3 near-term fix.
  test('W3: source document is linked to the produced study and resolves per-asset', async () => {
    const study = await prisma.systemStudy.findUnique({ where: { id: (await prisma.arcFlashIngest.findUnique({ where: { id: ingestId } })).producedStudyId } });
    expect(study.reportFileKey).toBeTruthy();
    expect(study.reportPdfUrl).toBeNull(); // never wrote a fake URL into the manual-entry field

    const assets = await prisma.asset.findMany({ where: { accountId: manager.accountId, siteId } });
    const swgrAsset = assets.find((a: any) => a.equipmentType === 'SWITCHGEAR');
    const res = await request(app).get(`/api/arc-flash/asset/${swgrAsset.id}`).set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.data.current.study.sourceDocumentUrl).toBe(`/api/documents/file?key=${encodeURIComponent(study.reportFileKey)}`);
  });
});

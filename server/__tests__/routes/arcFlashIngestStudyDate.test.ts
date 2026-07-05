/**
 * [F1/F3] Study-date + method capture-over-fallback regression lock.
 *
 * Confirm must never silently write today's date or the current NFPA edition
 * when the source document's own studyMeta couldn't be read/parsed — see
 * docs/scoping/audits/afx-scenario-preservation.md, Phase 0 (F1, F3).
 *
 * Each test case swaps the AI mock's return value so the ingest is driven by
 * a distinct studyMeta.date/method, independent of the shared fixture used by
 * __tests__/routes/arcFlashIngest.test.ts.
 */
const baseBus = {
  busName: 'SWGR-1A', equipmentType: 'switchgear', fedFromBusName: null, nominalVoltage: '13.8kV',
  boltedFaultCurrentKA: 22, clearingTimeMs: 200, electrodeConfig: 'VCB', conductorGapMm: 152,
  workingDistanceIn: 36, upstreamDevice: 'Utility 51',
};

function fixture(studyMeta: any) {
  return {
    system: {
      sourceVoltage: '13.8kV',
      mainTransformer: { kva: 1500, primaryVoltage: '13.8kV', secondaryVoltage: '480V', impedancePct: 5.5 },
      serviceFaultCurrentKA: 22,
      studyMeta,
    },
    buses: [baseBus],
  };
}

const aiMock = {
  complete: jest.fn(),
  completeWithImage: jest.fn(),
  parseJSON: (t: string) => JSON.parse(t),
};
jest.mock('../../lib/ai', () => aiMock);

import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let siteId: string;

const auth = (u: TestUser) => `Bearer ${u.token}`;
const png = Buffer.from('89504e470d0a1a0a', 'hex'); // content irrelevant — AI mocked

async function uploadAndConfirm(studyMeta: any) {
  aiMock.completeWithImage.mockResolvedValueOnce({ text: JSON.stringify(fixture(studyMeta)) });
  const up = await request(app)
    .post('/api/arc-flash/ingest')
    .set('Authorization', auth(manager))
    .field('siteId', siteId)
    .field('sourceType', 'one_line')
    .attach('file', png, { filename: 'oneline.png', contentType: 'image/png' });
  expect(up.status).toBe(201);
  const ingestId = up.body.data.ingestId;

  const res = await request(app)
    .post(`/api/arc-flash/ingest/${ingestId}/confirm`)
    .set('Authorization', auth(manager))
    .send({ createStudy: true, studyType: 'arc_flash' });
  expect(res.status).toBe(200);
  const study = await prisma.systemStudy.findUnique({ where: { id: res.body.data.studyId } });
  return { res, study };
}

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `AFI-date ${Date.now()}` } });
  siteId = site.id;
});

afterAll(async () => {
  const acc = manager.accountId;
  try { await prisma.arcFlashIngestBus.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.arcFlashIngest.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.systemStudyAsset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.systemStudy.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: manager.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('arc-flash confirm — study date & method capture (F1/F3)', () => {
  test('ISO date + explicit method: both captured verbatim', async () => {
    const { res, study } = await uploadAndConfirm({ peName: 'S. Hawthorne', date: '2024-01-15', method: 'IEEE 1584-2018', software: 'EasyPower' });
    expect(res.body.data.studyDateSource).toBe('extracted');
    expect(study.performedDate.toISOString().slice(0, 10)).toBe('2024-01-15');
    expect(study.method).toBe('IEEE 1584-2018');
  });

  test('named-month date format parses ("March 15, 2021")', async () => {
    const { res, study } = await uploadAndConfirm({ peName: null, date: 'March 15, 2021', method: null, software: null });
    expect(res.body.data.studyDateSource).toBe('extracted');
    expect(study.performedDate.getFullYear()).toBe(2021);
    expect(study.performedDate.getMonth()).toBe(2); // 0-indexed March
    expect(study.performedDate.getDate()).toBe(15);
  });

  test('unparseable date ("Q3/2021") + missing method: falls back but is flagged, never silently asserted', async () => {
    const { res, study } = await uploadAndConfirm({ peName: null, date: 'Q3/2021', method: null, software: null });
    expect(res.body.data.studyDateSource).toBe('unverified_default');
    // Falls back to "now" (unavoidable — performedDate is NOT NULL) but the
    // fallback must be visibly flagged, not indistinguishable from a real date.
    const ageMs = Date.now() - study.performedDate.getTime();
    expect(ageMs).toBeLessThan(60_000);
    expect(study.notes).toMatch(/could not be read from the source document/);
    expect(study.notes).toMatch(/Q3\/2021/);
    // F3: method must stay null, never silently assert the current edition —
    // this is the field the outdated-method regulatory check depends on.
    expect(study.method).toBeNull();
  });

  test('missing studyMeta entirely: same honest fallback, no crash', async () => {
    const { res, study } = await uploadAndConfirm({});
    expect(res.body.data.studyDateSource).toBe('unverified_default');
    expect(study.notes).toMatch(/could not be read from the source document/);
    expect(study.method).toBeNull();
  });

  test('explicit client-supplied performedDate always wins over extraction', async () => {
    aiMock.completeWithImage.mockResolvedValueOnce({ text: JSON.stringify(fixture({ peName: null, date: '2024-01-15', method: null, software: null })) });
    const up = await request(app)
      .post('/api/arc-flash/ingest')
      .set('Authorization', auth(manager))
      .field('siteId', siteId)
      .field('sourceType', 'one_line')
      .attach('file', png, { filename: 'oneline.png', contentType: 'image/png' });
    const ingestId = up.body.data.ingestId;
    const res = await request(app)
      .post(`/api/arc-flash/ingest/${ingestId}/confirm`)
      .set('Authorization', auth(manager))
      .send({ createStudy: true, studyType: 'arc_flash', performedDate: '2019-06-01' });
    expect(res.status).toBe(200);
    expect(res.body.data.studyDateSource).toBe('client');
    const study = await prisma.systemStudy.findUnique({ where: { id: res.body.data.studyId } });
    expect(study.performedDate.toISOString().slice(0, 10)).toBe('2019-06-01');
  });
});

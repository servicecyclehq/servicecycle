/**
 * #29 IR thermography ingest. Covers NETA Table 100.18 severity, the text
 * parser, and the preview/commit endpoints (one deficiency per hot-spot above
 * threshold, severity by deltaT, tenancy isolation).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { severityForDeltaT } = require('../../lib/thermographyEvaluate');
const { parseThermographyText } = require('../../lib/thermographyParse');

let app: any;
let prisma: any;
let manager: TestUser;
let other: TestUser;
let assetId: string;
let siteId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  other = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `IR ${Date.now()}` } });
  siteId = site.id;
  const a = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR', serialNumber: 'SG-1' } });
  assetId = a.id;
});

afterAll(async () => {
  for (const u of [manager, other]) {
    const acc = u.accountId;
    try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('#29 severityForDeltaT (NETA Table 100.18)', () => {
  test('similar-component bands', () => {
    expect(severityForDeltaT(2).severity).toBe('ADVISORY');
    expect(severityForDeltaT(8).severity).toBe('RECOMMENDED');
    expect(severityForDeltaT(25).severity).toBe('IMMEDIATE');
    expect(severityForDeltaT(0).severity).toBeNull();
  });
  test('over-ambient bands (NETA Table 100.18)', () => {
    expect(severityForDeltaT(50, 'ambient').severity).toBe('IMMEDIATE');   // >40
    expect(severityForDeltaT(25, 'ambient').severity).toBe('ADVISORY');    // 21-40 monitor
    expect(severityForDeltaT(15, 'ambient').severity).toBe('RECOMMENDED'); // 11-20 repair as time permits
    expect(severityForDeltaT(5, 'ambient').severity).toBe('ADVISORY');     // 1-10 possible
  });
});

describe('#29 parseThermographyText', () => {
  test('reads hot-spots and a survey date', () => {
    const text = `IR survey 2026-03-10
      Panel 3 Phase B lug  ΔT 25C
      Main breaker line side  delta-T 8 degC
      Bus joint A  dT: 2`;
    const p = parseThermographyText(text);
    expect(p.surveyDate).toBe('2026-03-10');
    expect(p.hotspots.length).toBe(3);
    const dts = p.hotspots.map((h: any) => h.deltaT).sort((a: number, b: number) => a - b);
    expect(dts).toEqual([2, 8, 25]);
    expect(p.hotspots.find((h: any) => h.deltaT === 25).location).toContain('Phase B');
  });
});

describe('#29 ingest endpoints', () => {
  test('preview grades without writing', async () => {
    const res = await request(app).post(`/api/assets/${assetId}/thermography/preview`).set('Authorization', auth(manager))
      .send({ hotspots: [{ location: 'Lug A', deltaT: 25 }, { location: 'Lug B', deltaT: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.deficienciesToCreate).toBe(2);
    expect(await prisma.deficiency.count({ where: { assetId } })).toBe(0);
  });

  test('commit creates one deficiency per hot-spot above threshold', async () => {
    const res = await request(app).post(`/api/assets/${assetId}/thermography/commit`).set('Authorization', auth(manager))
      .send({ surveyDate: '2026-03-10', hotspots: [{ location: 'Phase B lug', deltaT: 25 }, { location: 'Bus joint', deltaT: 8 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.deficienciesCreated).toBe(2);
    expect(res.body.data.bySeverity.IMMEDIATE).toBe(1);
    expect(res.body.data.bySeverity.RECOMMENDED).toBe(1);
    const defs = await prisma.deficiency.count({ where: { assetId } });
    expect(defs).toBe(2);
  });

  test('hot-spots below threshold create no deficiency', async () => {
    const before = await prisma.deficiency.count({ where: { assetId } });
    const res = await request(app).post(`/api/assets/${assetId}/thermography/commit`).set('Authorization', auth(manager))
      .send({ hotspots: [{ location: 'Cool joint', deltaT: 0 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.deficienciesCreated).toBe(0);
    expect(await prisma.deficiency.count({ where: { assetId } })).toBe(before);
  });

  test('reportText-only commit parses then grades', async () => {
    const res = await request(app).post(`/api/assets/${assetId}/thermography/commit`).set('Authorization', auth(manager))
      .send({ reportText: 'Breaker lug ΔT 30C\nBus tap delta-T 5 degC' });
    expect(res.status).toBe(201);
    expect(res.body.data.deficienciesCreated).toBe(2);
  });

  test('another account cannot ingest to this asset', async () => {
    const res = await request(app).post(`/api/assets/${assetId}/thermography/commit`).set('Authorization', auth(other))
      .send({ hotspots: [{ location: 'x', deltaT: 25 }] });
    expect(res.status).toBe(404);
  });
});

export {};

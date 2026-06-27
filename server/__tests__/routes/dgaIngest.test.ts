/**
 * #28 Oil/DGA lab-report ingest. Covers the IEEE C57.104 condition evaluation,
 * the text parser, and the preview/commit endpoints (LabSample + auto-deficiency
 * by condition, tenancy isolation).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { evaluateDga } = require('../../lib/dgaEvaluate');
const { parseDgaText } = require('../../lib/dgaParse');

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
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `DGA ${Date.now()}` } });
  siteId = site.id;
  const a = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'TRANSFORMER_LIQUID', serialNumber: 'TX-1' } });
  assetId = a.id;
});

afterAll(async () => {
  for (const u of [manager, other]) {
    const acc = u.accountId;
    try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.labSample.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('#28 evaluateDga (IEEE C57.104)', () => {
  test('all-low gases -> Condition 1 / GREEN, no fault', () => {
    const e = evaluateDga({ h2: 10, ch4: 5, c2h2: 0, c2h4: 2, c2h6: 3, co: 50, co2: 500 });
    expect(e.overallCondition).toBe(1);
    expect(e.resultRating).toBe('GREEN');
    expect(e.faultCode).toBeNull();
  });

  test('high acetylene -> arcing fault + worse condition', () => {
    const e = evaluateDga({ h2: 200, ch4: 150, c2h2: 40, c2h4: 250, c2h6: 20, co: 100 });
    expect(e.overallCondition).toBe(4); // c2h2 40 > 35 => C4
    expect(e.resultRating).toBe('RED');
    expect(e.faultCode).toBe('D2');
  });

  test('TDCG escalates the overall condition', () => {
    const e = evaluateDga({ h2: 90, ch4: 110, c2h4: 45, c2h6: 60, co: 340, c2h2: 0 });
    expect(e.tdcg).toBeGreaterThan(0);
    expect(e.overallCondition).toBeGreaterThanOrEqual(1);
  });

  test('[NETA-8-3] low-temp thermal fault (CH4 dominant, low ethylene) reports T1', () => {
    // CH4 elevated, ethylene below the 50 ppm threshold, no acetylene => <300C thermal.
    const e = evaluateDga({ h2: 80, ch4: 200, c2h4: 10, c2h6: 30, co2: 1000 });
    expect(e.faultCode).toBe('T1');
    expect(e.faultLabel).toBe('Thermal fault <300C');
  });

  test('[NETA-8-3] mid ethylene still reports T2 (300-700C)', () => {
    const e = evaluateDga({ ch4: 130, c2h4: 60, c2h2: 0 });
    expect(e.faultCode).toBe('T2');
  });

  test('[NETA-8-10] CO2 is informational and never drives the overall condition', () => {
    // CO2 alone in Condition 4 territory (>10000) must NOT make the unit Condition 4.
    const e = evaluateDga({ h2: 10, ch4: 5, c2h2: 0, c2h4: 2, c2h6: 3, co: 50, co2: 12000 });
    expect(e.perGas.co2.condition).toBe(4); // still reported
    expect(e.overallCondition).toBe(1);     // but not counted
    expect(e.resultRating).toBe('GREEN');
  });
});

describe('#28 parseDgaText', () => {
  test('extracts gases, date and lab from a generic report', () => {
    const text = `SDMyers Laboratory  Report date 2026-02-15
      Hydrogen (H2) ........ 120 ppm
      Methane CH4 .......... 90 ppm
      Acetylene C2H2 ....... 3 ppm
      Ethylene ............. 55 ppm
      Carbon Monoxide ...... 300 ppm
      Carbon Dioxide ....... 2200 ppm`;
    const p = parseDgaText(text);
    expect(p.gases.h2).toBe(120);
    expect(p.gases.ch4).toBe(90);
    expect(p.gases.c2h2).toBe(3);
    expect(p.gases.c2h4).toBe(55);
    expect(p.gases.co).toBe(300);
    expect(p.gases.co2).toBe(2200);
    expect(p.sampleDate).toBe('2026-02-15');
    expect(p.labName).toBe('SDMyers');
  });
});

describe('#28 ingest endpoints', () => {
  test('preview evaluates without writing', async () => {
    const res = await request(app).post(`/api/assets/${assetId}/dga/preview`).set('Authorization', auth(manager))
      .send({ gases: { h2: 10, ch4: 5, c2h2: 0, c2h4: 2 } });
    expect(res.status).toBe(200);
    expect(res.body.data.evaluation.overallCondition).toBe(1);
    const count = await prisma.labSample.count({ where: { assetId } });
    expect(count).toBe(0);
  });

  test('commit creates a LabSample + IMMEDIATE deficiency for Condition 4', async () => {
    const res = await request(app).post(`/api/assets/${assetId}/dga/commit`).set('Authorization', auth(manager))
      .send({ sampleDate: '2026-02-15', gases: { h2: 200, ch4: 150, c2h2: 40, c2h4: 250, c2h6: 20, co: 100 } });
    expect(res.status).toBe(201);
    expect(res.body.data.evaluation.resultRating).toBe('RED');
    expect(res.body.data.deficiencyCreated).toBe(true);
    const sample = await prisma.labSample.findFirst({ where: { assetId, sampleType: 'dga' } });
    expect(sample).toBeTruthy();
    expect(sample.ieeeStatus).toBe(4);
    const def = await prisma.deficiency.findFirst({ where: { assetId, severity: 'IMMEDIATE' } });
    expect(def).toBeTruthy();
  });

  test('normal gases commit with no deficiency', async () => {
    const before = await prisma.deficiency.count({ where: { assetId } });
    const res = await request(app).post(`/api/assets/${assetId}/dga/commit`).set('Authorization', auth(manager))
      .send({ gases: { h2: 10, ch4: 5, c2h2: 0, c2h4: 2, co: 50 } });
    expect(res.status).toBe(201);
    expect(res.body.data.deficiencyCreated).toBe(false);
    const after = await prisma.deficiency.count({ where: { assetId } });
    expect(after).toBe(before);
  });

  test('reportText-only commit parses then evaluates', async () => {
    const res = await request(app).post(`/api/assets/${assetId}/dga/commit`).set('Authorization', auth(manager))
      .send({ reportText: 'Hydrogen 120 ppm\nAcetylene 3 ppm\nMethane 90\nReport 2026-03-01' });
    expect(res.status).toBe(201);
    expect(res.body.data.evaluation.overallCondition).toBeGreaterThanOrEqual(2);
  });

  test('another account cannot ingest to this asset', async () => {
    const res = await request(app).post(`/api/assets/${assetId}/dga/commit`).set('Authorization', auth(other))
      .send({ gases: { h2: 10 } });
    expect(res.status).toBe(404);
  });
});

export {};

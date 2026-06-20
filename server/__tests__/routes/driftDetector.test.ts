/**
 * #4 Repeat-failure / compliance-drift detector. Verifies the three drift types
 * (worsening_trend / unclosed_corrective / repeat_failure), their program-change
 * recommendations, ranking, and the route.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildDriftDetector } = require('../../lib/driftDetector');

let app: any;
let prisma: any;
let admin: TestUser;
let aTrend: string;
let aUnclosed: string;
let aRepeat: string;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `Drift ${Date.now()}` } });

  // worsening_trend: an open ADVISORY "trending" deficiency.
  const t = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'TRANSFORMER_LIQUID', serialNumber: 'D-TRD' } });
  aTrend = t.id;
  await prisma.deficiency.create({ data: { accountId: admin.accountId, assetId: t.id, severity: 'ADVISORY', description: 'Winding resistance trending up 22% since last test -- still in spec, monitor' } });

  // unclosed_corrective: an old open deficiency that predates a later completed WO.
  const u = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'MOTOR', serialNumber: 'D-UNC' } });
  aUnclosed = u.id;
  await prisma.deficiency.create({ data: { accountId: admin.accountId, assetId: u.id, severity: 'RECOMMENDED', description: 'Bearing play out of tolerance', createdAt: new Date(Date.now() - 200 * DAY) } });
  await prisma.workOrder.create({ data: { accountId: admin.accountId, assetId: u.id, status: 'COMPLETE', completedDate: new Date(Date.now() - 20 * DAY) } });

  // repeat_failure: 3+ deficiencies in window, none trending, no unclosed pattern.
  const r = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'MOTOR', serialNumber: 'D-RPT' } });
  aRepeat = r.id;
  for (let i = 0; i < 3; i++) {
    await prisma.deficiency.create({ data: { accountId: admin.accountId, assetId: r.id, severity: 'ADVISORY', description: `finding ${i}`, createdAt: new Date(Date.now() - (10 + i) * DAY), resolvedAt: new Date(Date.now() - (5 + i) * DAY) } });
  }
});

afterAll(async () => {
  const acc = admin.accountId;
  try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('#4 drift detector', () => {
  test('classifies the three drift types with recommendations', async () => {
    const d = await buildDriftDetector(prisma, admin.accountId, {});
    const byId = Object.fromEntries(d.findings.map((f: any) => [f.assetId, f]));

    expect(byId[aTrend].driftType).toBe('worsening_trend');
    expect(byId[aTrend].recommendation).toBe('shorten_interval');
    expect(byId[aTrend].trendingDeficiencies).toBe(1);

    expect(byId[aUnclosed].driftType).toBe('unclosed_corrective');
    expect(byId[aUnclosed].recommendation).toBe('close_corrective');

    expect(byId[aRepeat].driftType).toBe('repeat_failure');
    expect(byId[aRepeat].recommendation).toBe('review_procedure');
    expect(byId[aRepeat].totalInWindow).toBe(3);

    expect(d.summary.flagged).toBe(3);
    expect(d.summary.worseningTrend).toBe(1);
    // worsening_trend ranks above repeat_failure.
    const idxTrend = d.findings.findIndex((f: any) => f.assetId === aTrend);
    const idxRepeat = d.findings.findIndex((f: any) => f.assetId === aRepeat);
    expect(idxTrend).toBeLessThan(idxRepeat);
  });

  test('GET /api/compliance/drift returns the report', async () => {
    const res = await request(app).get('/api/compliance/drift').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.flagged).toBe(3);
    expect(res.body.data.findings.length).toBe(3);
  });
});

export {};

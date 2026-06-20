/**
 * #2 Evidence-to-requirement trace map + gap detector. Verifies the four
 * evidence tiers (documented / stale / undocumented / missing) per asset
 * requirement, the account roll-up (documented %, by-type + by-asset gaps), and
 * both routes.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildAssetEvidenceTrace, buildEvidenceGapSummary } = require('../../lib/evidenceTrace');

let app: any;
let prisma: any;
let admin: TestUser;
let assetId: string;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `Ev ${Date.now()}` } });
  const a = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', manufacturer: 'ACME', model: 'SG', serialNumber: 'EV-1' } });
  assetId = a.id;

  const mk = (suffix: string) => prisma.maintenanceTaskDefinition.create({ data: { accountId: admin.accountId, equipmentType: 'SWITCHGEAR', taskName: `Task ${suffix}`, taskCode: `EV_${suffix}_${Date.now()}`, intervalC2Months: 12 } });
  const tdDoc = await mk('doc');
  const tdStale = await mk('stale');
  const tdUndoc = await mk('undoc');
  const tdMiss = await mk('miss');

  // documented: completed WO, not overdue.
  const sDoc = await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId, taskDefinitionId: tdDoc.id, isActive: true, lastCompletedDate: new Date(Date.now() - 30 * DAY), nextDueDate: new Date(Date.now() + 300 * DAY) } });
  await prisma.workOrder.create({ data: { accountId: admin.accountId, assetId, scheduleId: sDoc.id, status: 'COMPLETE', completedDate: new Date(Date.now() - 30 * DAY), netaDecal: 'GREEN' } });

  // stale: completed WO but overdue now.
  const sStale = await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId, taskDefinitionId: tdStale.id, isActive: true, lastCompletedDate: new Date(Date.now() - 400 * DAY), nextDueDate: new Date(Date.now() - 30 * DAY) } });
  await prisma.workOrder.create({ data: { accountId: admin.accountId, assetId, scheduleId: sStale.id, status: 'COMPLETE', completedDate: new Date(Date.now() - 400 * DAY) } });

  // undocumented: lastCompletedDate set, NO completed WO.
  await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId, taskDefinitionId: tdUndoc.id, isActive: true, lastCompletedDate: new Date(Date.now() - 60 * DAY), nextDueDate: new Date(Date.now() + 300 * DAY) } });

  // missing: no completion at all.
  await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId, taskDefinitionId: tdMiss.id, isActive: true, nextDueDate: null } });
});

afterAll(async () => {
  const acc = admin.accountId;
  try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

const auth = () => `Bearer ${admin.token}`;

describe('#2 evidence trace', () => {
  test('per-asset trace classifies the four evidence tiers', async () => {
    const t = await buildAssetEvidenceTrace(prisma, admin.accountId, assetId);
    expect(t.summary.requirements).toBe(4);
    expect(t.summary.documented).toBe(1);
    expect(t.summary.stale).toBe(1);
    expect(t.summary.undocumented).toBe(1);
    expect(t.summary.missing).toBe(1);
    expect(t.summary.gapTotal).toBe(3);
    // Gaps sort to the top (missing first).
    expect(t.requirements[0].evidenceStatus).toBe('missing');
    // The documented row carries evidence detail.
    const doc = t.requirements.find((r: any) => r.evidenceStatus === 'documented');
    expect(doc.evidence).toBeTruthy();
    expect(doc.evidence.netaDecal).toBe('GREEN');
  });

  test('account roll-up reports documented % and per-type / per-asset gaps', async () => {
    const s = await buildEvidenceGapSummary(prisma, admin.accountId, {});
    expect(s.totals.requirements).toBe(4);
    expect(s.totals.gapTotal).toBe(3);
    expect(s.documentedPct).toBe(25); // 1 of 4
    expect(s.byRequirementType.length).toBeGreaterThanOrEqual(3);
    const top = s.topAssets.find((a: any) => a.assetId === assetId);
    expect(top.gaps).toBe(3);
    expect(top.requirements).toBe(4);
  });

  test('routes serve both the roll-up and the per-asset trace', async () => {
    const roll = await request(app).get('/api/compliance/evidence-gaps').set('Authorization', auth());
    expect(roll.status).toBe(200);
    expect(roll.body.data.totals.requirements).toBeGreaterThanOrEqual(4);

    const one = await request(app).get(`/api/compliance/asset-evidence/${assetId}`).set('Authorization', auth());
    expect(one.status).toBe(200);
    expect(one.body.data.requirements.length).toBe(4);

    const missing = await request(app).get('/api/compliance/asset-evidence/00000000-0000-4000-8000-000000000000').set('Authorization', auth());
    expect(missing.status).toBe(404);
  });
});

export {};

/**
 * Regression tests — 2026-06-20 deep security audit (batch B: cross-tenant
 * nested-write / IDOR / idempotency / SSRF fixes).
 *
 * Covers:
 *  - outagePlanner POST /commit + /work-order reject a foreign tenant's scheduleId
 *  - ingestReview POST /review/:id/approve rejects a foreign tenant's siteId
 *  - quoteRequests PATCH /:id/status accept->WO is idempotent under concurrency
 *  - settings POST /test SSRF + stored-key-exfil guard
 *  - disasterEvents GET / redacts other tenants' affectedSiteIds on system events
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;

let adminA: TestUser; // account A (attacker / caller)
let adminB: TestUser; // account B (victim / foreign tenant)
let siteA: string, siteB: string;
let assetA: string, assetB: string;
let schedA: string, schedB: string;
let jobB: string;
let quoteA: string;

const DAY = 24 * 60 * 60 * 1000;

async function seedAccount(admin: TestUser, tag: string) {
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `${tag} site` } });
  const asset = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'MOTOR', serialNumber: `${tag}-A` } });
  const td = await prisma.maintenanceTaskDefinition.create({ data: { accountId: admin.accountId, equipmentType: 'MOTOR', taskName: 'IR', taskCode: `${tag}_${Date.now()}`, intervalC2Months: 12 } });
  const sched = await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId: asset.id, taskDefinitionId: td.id, isActive: true, nextDueDate: new Date(Date.now() - 30 * DAY) } });
  return { siteId: site.id, assetId: asset.id, schedId: sched.id };
}

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;

  adminA = await createTestUser('admin');
  adminB = await createTestUser('admin');

  const a = await seedAccount(adminA, 'A'); siteA = a.siteId; assetA = a.assetId; schedA = a.schedId;
  const b = await seedAccount(adminB, 'B'); siteB = b.siteId; assetB = b.assetId; schedB = b.schedId;

  // An ingest job parked for review in account B (used for the siteId IDOR test).
  const job = await prisma.ingestJob.create({
    data: { accountId: adminB.accountId, fileKey: `k-${Date.now()}`, fileName: 'r.pdf', status: 'needs_review', kind: 'test_report', result: {} },
  });
  jobB = job.id;

  // A quote request on account A's asset (idempotency test).
  const q = await prisma.quoteRequest.create({
    data: { accountId: adminA.accountId, assetId: assetA, requestedById: adminA.id, driver: 'failed_inspection', timeline: 'within_30_days', status: 'requested', notes: 'test', emergencyMode: false },
  });
  quoteA = q.id;
});

afterAll(async () => {
  for (const u of [adminA, adminB]) {
    const acc = u.accountId;
    try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.blackoutWindow.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.quoteRequest.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.ingestJob.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.disasterEvent.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  // system events have accountId=null — clean any we created.
  try { await prisma.disasterEvent.deleteMany({ where: { accountId: null, title: { startsWith: 'AUDITB-SYS' } } }); } catch {}
  await prisma.$disconnect();
});

describe('outagePlanner — cross-tenant scheduleId rejected (HIGH)', () => {
  test('POST /commit with a foreign tenant scheduleId → 400, no WO created with it', async () => {
    const res = await request(app).post('/api/outage-planner/commit')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ date: new Date().toISOString(), createBlackout: false, selections: [{ assetId: assetA, scheduleIds: [schedB] }] });
    expect(res.status).toBe(400);
    const leaked = await prisma.workOrder.findFirst({ where: { accountId: adminA.accountId, scheduleId: schedB } });
    expect(leaked).toBeNull();
  });

  test('POST /commit with own asset + own schedule → 201', async () => {
    const res = await request(app).post('/api/outage-planner/commit')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ date: new Date().toISOString(), createBlackout: false, selections: [{ assetId: assetA, scheduleIds: [schedA] }] });
    expect(res.status).toBe(201);
  });

  test('legacy POST /work-order with a foreign tenant scheduleId → 400', async () => {
    const res = await request(app).post('/api/outage-planner/work-order')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ scheduledDate: new Date().toISOString(), assetSchedules: [{ assetId: assetA, scheduleIds: [schedB] }] });
    expect(res.status).toBe(400);
  });
});

describe('ingestReview approve — foreign siteId rejected (MED)', () => {
  test("approving B's job with account A's site → 404", async () => {
    const res = await request(app).post(`/api/ingest/review/${jobB}/approve`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ siteId: siteA }); // siteA belongs to account A, not B
    expect(res.status).toBe(404);
  });
});

describe('quoteRequests accept -> work-order idempotency (MED)', () => {
  test('two concurrent accepts create exactly one auto work-order', async () => {
    const fire = () => request(app).patch(`/api/quote-requests/${quoteA}/status`)
      .set('Authorization', `Bearer ${adminA.token}`).send({ status: 'accepted' });
    const results = await Promise.all([fire(), fire()]);
    // At least one accept succeeds; neither 5xx.
    expect(results.some(r => r.status === 200)).toBe(true);
    const wos = await prisma.workOrder.findMany({ where: { accountId: adminA.accountId, quoteRequestId: quoteA }, select: { id: true } });
    expect(wos.length).toBe(1);
  });
});

describe('settings POST /test — SSRF + stored-key exfil guard (MED)', () => {
  test('custom azure endpoint + masked key → 400 (stored key not sent to ad-hoc host)', async () => {
    const res = await request(app).post('/api/settings/test')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ AI_PROVIDER: 'azure_openai', AZURE_OPENAI_ENDPOINT: 'https://169.254.169.254/openai', AI_API_KEY: '••••••••' });
    expect(res.status).toBe(400);
  });

  test('custom azure endpoint resolving to a metadata/private IP → 400 blocked', async () => {
    const res = await request(app).post('/api/settings/test')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ AI_PROVIDER: 'azure_openai', AZURE_OPENAI_ENDPOINT: 'https://169.254.169.254/openai', AI_API_KEY: 'sk-explicit-key-123' });
    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toMatch(/blocked/i);
  });
});

describe('disasterEvents GET / — cross-tenant affectedSiteIds redacted (LOW)', () => {
  test('system event returns only the caller-owned site ids', async () => {
    const ev = await prisma.disasterEvent.create({
      data: { accountId: null, eventType: 'hurricane', severity: 'warning', title: `AUDITB-SYS ${Date.now()}`, region: 'FL', affectedStates: ['FL'], affectedSiteIds: [siteA, siteB], source: 'nws' },
    });
    const res = await request(app).get('/api/disaster-events').set('Authorization', `Bearer ${adminA.token}`);
    expect(res.status).toBe(200);
    const mine = (res.body.data.events || []).find((e: any) => e.id === ev.id);
    expect(mine).toBeTruthy();
    expect(mine.affectedSiteIds).toEqual([siteA]); // siteB (account B) stripped
  });
});

export {};

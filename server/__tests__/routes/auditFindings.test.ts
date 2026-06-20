/**
 * Phase 1 #1 "What will fail an audit" view. Verifies that buildAuditFindings
 * aggregates the existing signals (Path-to-100 overdue/unbaselined/uncovered +
 * written-EMP gaps, undocumented-work evidence gaps, drift uncorrected findings)
 * into ONE severity-ranked list, the route serves it, tenant scoping holds, and
 * a clean scope returns no findings.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildAuditFindings } = require('../../lib/auditFindings');

let app: any;
let prisma: any;
let admin: TestUser;
let other: TestUser;       // separate tenant -- must never see admin's findings
let cleanSiteId: string;   // a site with zero assets -> empty-state

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  other = await createTestUser('admin');

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `Audit ${Date.now()}` } });
  const cleanSite = await prisma.site.create({ data: { accountId: admin.accountId, name: `Clean ${Date.now()}` } });
  cleanSiteId = cleanSite.id;

  // (a) untracked / uncovered asset -> CRITICAL "no maintenance program".
  await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: 'AF-UNCOV' } });

  // (b) overdue maintenance -> HIGH. Asset with an active, overdue schedule.
  const aOverdue = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'MOTOR', serialNumber: 'AF-OVERDUE' } });
  const tdOver = await prisma.maintenanceTaskDefinition.create({ data: { accountId: admin.accountId, equipmentType: 'MOTOR', taskName: 'Overdue task', taskCode: `AF_OV_${Date.now()}`, intervalC2Months: 12 } });
  await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId: aOverdue.id, taskDefinitionId: tdOver.id, isActive: true, lastCompletedDate: new Date(Date.now() - 400 * DAY), nextDueDate: new Date(Date.now() - 40 * DAY) } });

  // (c) undocumented work -> HIGH (evidence lens). lastCompletedDate set, no WO,
  //     not overdue -> Path-to-100 reads it green; the evidence lens flags it.
  const aUndoc = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: 'AF-UNDOC' } });
  const tdUndoc = await prisma.maintenanceTaskDefinition.create({ data: { accountId: admin.accountId, equipmentType: 'SWITCHGEAR', taskName: 'Undoc task', taskCode: `AF_UND_${Date.now()}`, intervalC2Months: 12 } });
  await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId: aUndoc.id, taskDefinitionId: tdUndoc.id, isActive: true, lastCompletedDate: new Date(Date.now() - 60 * DAY), nextDueDate: new Date(Date.now() + 300 * DAY) } });

  // (d) unclosed corrective -> HIGH (drift lens). Old open def predating a later WO.
  const aUnclosed = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'MOTOR', serialNumber: 'AF-UNCL' } });
  await prisma.deficiency.create({ data: { accountId: admin.accountId, assetId: aUnclosed.id, severity: 'RECOMMENDED', description: 'Bearing play out of tolerance', createdAt: new Date(Date.now() - 200 * DAY) } });
  await prisma.workOrder.create({ data: { accountId: admin.accountId, assetId: aUnclosed.id, status: 'COMPLETE', completedDate: new Date(Date.now() - 20 * DAY) } });
  // NOTE: a fresh account also has the two written-EMP gaps (no coordinator /
  // no review on record) -> these add a HIGH emp_program_gap finding.
});

afterAll(async () => {
  for (const u of [admin, other]) {
    const acc = u.accountId;
    try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

describe('#1 audit-failure view', () => {
  test('aggregates the distinct lenses into one severity-ranked list', async () => {
    const d = await buildAuditFindings(prisma, admin.accountId, {});
    const byKind = Object.fromEntries(d.findings.map((f: any) => [f.kind, f]));

    // Each lens contributed its category.
    expect(byKind.untracked_asset).toBeTruthy();
    expect(byKind.untracked_asset.severity).toBe('critical');
    expect(byKind.overdue_maintenance).toBeTruthy();
    expect(byKind.undocumented_work).toBeTruthy();
    expect(byKind.unclosed_finding).toBeTruthy();
    expect(byKind.emp_program_gap).toBeTruthy();
    expect(byKind.emp_program_gap.count).toBe(2); // coordinator + review

    // Critical ranks first; severity is non-increasing down the list.
    expect(d.findings[0].kind).toBe('untracked_asset');
    const W: any = { critical: 4, high: 3, medium: 2, low: 1 };
    for (let i = 1; i < d.findings.length; i++) {
      expect(W[d.findings[i - 1].severity]).toBeGreaterThanOrEqual(W[d.findings[i].severity]);
    }

    // Readiness + roll-up are present and coherent.
    expect(d.summary.clean).toBe(false);
    expect(d.summary.totalFindings).toBeGreaterThanOrEqual(5);
    expect(d.summary.bySeverity.critical).toBeGreaterThanOrEqual(1);
    expect(typeof d.readiness.score).toBe('number');

    // The uncovered finding carries a deep-linkable example.
    expect(byKind.untracked_asset.examples[0].assetId).toBeTruthy();
  });

  test('GET /api/compliance/audit-findings serves the ranked list', async () => {
    const res = await request(app).get('/api/compliance/audit-findings').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.findings.length).toBeGreaterThanOrEqual(5);
    expect(res.body.data.summary.clean).toBe(false);
  });

  test('is tenant-scoped: a separate account sees only its own (EMP) gaps', async () => {
    const res = await request(app).get('/api/compliance/audit-findings').set('Authorization', `Bearer ${other.token}`);
    expect(res.status).toBe(200);
    const kinds = res.body.data.findings.map((f: any) => f.kind);
    // No assets/schedules -> none of admin's asset-level findings leak across.
    expect(kinds).not.toContain('untracked_asset');
    expect(kinds).not.toContain('overdue_maintenance');
    expect(kinds).not.toContain('undocumented_work');
  });

  test('a clean scope (empty site) returns no findings', async () => {
    // A site filter skips account-level EMP gaps and has zero assets -> truly empty.
    const d = await buildAuditFindings(prisma, admin.accountId, { siteId: cleanSiteId });
    expect(d.summary.clean).toBe(true);
    expect(d.findings.length).toBe(0);

    const res = await request(app).get(`/api/compliance/audit-findings?siteId=${cleanSiteId}`).set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.clean).toBe(true);

    const bad = await request(app).get('/api/compliance/audit-findings?siteId=00000000-0000-4000-8000-000000000000').set('Authorization', `Bearer ${admin.token}`);
    expect(bad.status).toBe(404);
  });
});

export {};

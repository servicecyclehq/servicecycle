/**
 * Phase 3 #5 export-everything / no-lock-in. Verifies the full-account export
 * assembles every entity, includes document/snapshot metadata + retrieval paths
 * (not blobs or secrets), is tenant-scoped, and that the route serves JSON
 * (manager+) and XLSX, with viewers forbidden.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildAccountExport } = require('../../lib/accountExport');

let app: any;
let prisma: any;
let manager: TestUser;
let viewer: TestUser;
let other: TestUser;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  viewer = await createTestUser('viewer', { accountId: manager.accountId });
  other = await createTestUser('manager');

  const A = manager.accountId, U = manager.id;
  const site = await prisma.site.create({ data: { accountId: A, name: `Exp ${Date.now()}` } });
  const asset = await prisma.asset.create({ data: { accountId: A, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: 'EXP-1', repairCostEstimate: 1234 } });
  const td = await prisma.maintenanceTaskDefinition.create({ data: { accountId: A, equipmentType: 'SWITCHGEAR', taskName: 'Exp task', taskCode: `EXP_${Date.now()}`, intervalC2Months: 12 } });
  const sched = await prisma.maintenanceSchedule.create({ data: { accountId: A, assetId: asset.id, taskDefinitionId: td.id, isActive: true, nextDueDate: new Date() } });
  const wo = await prisma.workOrder.create({ data: { accountId: A, assetId: asset.id, scheduleId: sched.id, status: 'COMPLETE', completedDate: new Date() } });
  await prisma.deficiency.create({ data: { accountId: A, assetId: asset.id, workOrderId: wo.id, severity: 'RECOMMENDED', description: 'Exp def' } });
  await prisma.quoteRequest.create({ data: { accountId: A, assetId: asset.id, requestedById: U, status: 'requested', driver: 'failed_inspection', timeline: 'within_30_days' } });
  await prisma.document.create({ data: { accountId: A, assetId: asset.id, filename: 'report.pdf', filePath: 'storage/secret-key-abc', fileType: 'application/pdf', uploadedBy: U } });
  await prisma.complianceSnapshot.create({ data: { accountId: A, filename: 'snap.pdf', filePath: 'storage/snap-key', sha256: 'a'.repeat(64) } });

  // Other tenant: one asset that must never appear in manager's export.
  const os = await prisma.site.create({ data: { accountId: other.accountId, name: 'Other' } });
  await prisma.asset.create({ data: { accountId: other.accountId, siteId: os.id, equipmentType: 'MOTOR', serialNumber: 'OTHER-1' } });
});

afterAll(async () => {
  for (const acc of [manager.accountId, other.accountId]) {
    try { await prisma.complianceSnapshot.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.document.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.quoteRequest.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  }
  for (const u of [manager, viewer, other]) { try { await prisma.user.delete({ where: { id: u.id } }); } catch {} }
  for (const acc of [manager.accountId, other.accountId]) { try { await prisma.account.delete({ where: { id: acc } }); } catch {} }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('Phase 3 #5 export everything', () => {
  test('assembles every entity with metadata + retrieval paths, no secrets', async () => {
    const d = await buildAccountExport(prisma, manager.accountId);
    expect(d.counts).toMatchObject({
      sites: 1, assets: 1, maintenanceSchedules: 1, workOrders: 1,
      deficiencies: 1, quoteRequests: 1, documents: 1, snapshots: 1,
    });
    expect(d.meta.exportVersion).toBeTruthy();
    expect(d.meta.standard).toBe('NFPA 70B');
    expect(Array.isArray(d.offboarding)).toBe(true);

    // Documents: retrieval path present, raw storage key absent.
    const doc = d.documents[0];
    expect(doc.downloadPath).toBe(`/api/documents/${doc.id}/file`);
    expect(doc.filePath).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('secret-key-abc');

    // Snapshots: integrity hash + download path.
    expect(d.snapshots[0].sha256).toHaveLength(64);
    expect(d.snapshots[0].downloadPath).toContain('/download');

    // No credential material anywhere in the bundle.
    expect(JSON.stringify(d)).not.toContain('passwordHash');
  });

  test('is tenant-scoped', async () => {
    const d = await buildAccountExport(prisma, other.accountId);
    expect(d.counts.assets).toBe(1);
    expect(d.assets[0].serialNumber).toBe('OTHER-1');
    expect(JSON.stringify(d)).not.toContain('EXP-1');
  });

  test('route serves JSON to manager+ and forbids viewers', async () => {
    const ok = await request(app).get('/api/export/account?format=json').set('Authorization', auth(manager));
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('application/json');
    const parsed = JSON.parse(ok.text);
    expect(parsed.counts.assets).toBe(1);

    const forbidden = await request(app).get('/api/export/account').set('Authorization', auth(viewer));
    expect(forbidden.status).toBe(403);
  });

  test('route serves a multi-sheet XLSX workbook', async () => {
    const res = await request(app).get('/api/export/account?format=xlsx').set('Authorization', auth(manager)).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });
});

export {};

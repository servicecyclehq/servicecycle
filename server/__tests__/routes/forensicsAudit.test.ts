/**
 * Forensics: a committed reading is evidence. Editing or deleting one must leave
 * a before/after (or deleted-values) record in the tamper-evident audit chain.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let mgr: TestUser;
let measurementId: string;
let assetId: string;

async function waitForLog(action: string): Promise<any> {
  for (let i = 0; i < 30; i++) {
    const row = await prisma.activityLog.findFirst({
      where: { accountId: mgr.accountId, action },
      orderBy: { createdAt: 'desc' },
    });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  mgr = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: mgr.accountId, name: `F ${Date.now()}` } });
  const asset = await prisma.asset.create({ data: { accountId: mgr.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: `F-${Date.now()}` } });
  assetId = asset.id;
  const wo = await prisma.workOrder.create({ data: { accountId: mgr.accountId, assetId, status: 'COMPLETE', completedDate: new Date() } });
  const m = await prisma.testMeasurement.create({ data: { accountId: mgr.accountId, workOrderId: wo.id, measurementType: 'insulation_resistance', asFoundValue: 5, asFoundUnit: 'GOhm' } });
  measurementId = m.id;
});

afterAll(async () => {
  const acc = mgr.accountId;
  try { await prisma.activityLog.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.testMeasurement.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: mgr.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('forensics: reading mutations are audit-logged', () => {
  test('editing a reading records before/after', async () => {
    const res = await request(app)
      .put(`/api/work-orders/measurements/${measurementId}`)
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ asFoundValue: 99 });
    expect(res.status).toBe(200);
    const log = await waitForLog('measurement_updated');
    expect(log).toBeTruthy();
    expect(log.assetId).toBe(assetId);
    expect(log.details.before.asFoundValue).toBe(5);
    expect(log.details.after.asFoundValue).toBe(99);
  });

  test('deleting a reading records the deleted values', async () => {
    const res = await request(app)
      .delete(`/api/work-orders/measurements/${measurementId}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    const log = await waitForLog('measurement_deleted');
    expect(log).toBeTruthy();
    expect(log.details.deleted.measurementType).toBe('insulation_resistance');
    expect(log.details.measurementId).toBe(measurementId);
  });
});

export {};
describe('forensics: document deletion is audit-logged', () => {
  test('deleting a document records the deleted document metadata', async () => {
    const doc = await prisma.document.create({
      data: { accountId: mgr.accountId, filename: 'evidence.pdf', filePath: 'k-' + Date.now(), fileType: 'application/pdf', uploadedBy: mgr.id, assetId },
    });
    const res = await request(app)
      .delete(`/api/documents/${doc.id}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    const log = await waitForLog('document_deleted');
    expect(log).toBeTruthy();
    expect(log.details.documentId).toBe(doc.id);
    expect(log.details.filename).toBe('evidence.pdf');
  });
});
describe('forensics: reading delete is a SOFT delete (recoverable, hidden from reads)', () => {
  test('deleted reading is retained with deletedAt and excluded from test-history', async () => {
    const wo = await prisma.workOrder.create({ data: { accountId: mgr.accountId, assetId, status: 'COMPLETE', completedDate: new Date() } });
    const m = await prisma.testMeasurement.create({ data: { accountId: mgr.accountId, workOrderId: wo.id, measurementType: 'contact_resistance', asFoundValue: 12, asFoundUnit: 'uOhm' } });
    const del = await request(app).delete(`/api/work-orders/measurements/${m.id}`).set('Authorization', `Bearer ${mgr.token}`);
    expect(del.status).toBe(200);
    // row retained, soft-deleted (immutable/recoverable)
    const row = await prisma.testMeasurement.findUnique({ where: { id: m.id } });
    expect(row).toBeTruthy();
    expect(row.deletedAt).not.toBeNull();
    // excluded from the live test-history read
    const hist = await request(app).get(`/api/assets/${assetId}/test-history`).set('Authorization', `Bearer ${mgr.token}`);
    expect(hist.status).toBe(200);
    expect(JSON.stringify(hist.body).includes(m.id)).toBe(false);
    // a second delete now 404s (already soft-deleted)
    const del2 = await request(app).delete(`/api/work-orders/measurements/${m.id}`).set('Authorization', `Bearer ${mgr.token}`);
    expect(del2.status).toBe(404);
  });
});
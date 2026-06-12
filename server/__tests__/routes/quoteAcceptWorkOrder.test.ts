/**
 * #22 Close the quote -> work -> green loop. Accepting a QuoteRequest
 * auto-creates a WorkOrder bound to the quote (attribution) and, when the asset
 * has an active schedule, links the most-overdue one so completion clears
 * compliance. Re-accepting is idempotent (no duplicate WO).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let siteId: string;
let assetWithSched: string;
let assetNoSched: string;
let schedId: string;

const DAY = 24 * 60 * 60 * 1000;

async function makeQuote(assetId: string) {
  return prisma.quoteRequest.create({
    data: {
      accountId: manager.accountId, assetId, requestedById: manager.id,
      status: 'quoted', driver: 'planned_replacement', timeline: 'within_30_days',
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `Quote ${Date.now()}` } });
  siteId = site.id;
  const a1 = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  const a2 = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'MOTOR' } });
  assetWithSched = a1.id; assetNoSched = a2.id;
  const td = await prisma.maintenanceTaskDefinition.create({
    data: { accountId: manager.accountId, equipmentType: 'SWITCHGEAR', taskName: 'IR', taskCode: `IR_${Date.now()}`, intervalC2Months: 12 },
  });
  const s = await prisma.maintenanceSchedule.create({
    data: { accountId: manager.accountId, assetId: assetWithSched, taskDefinitionId: td.id, isActive: true, nextDueDate: new Date(Date.now() - 60 * DAY) },
  });
  schedId = s.id;
});

afterAll(async () => {
  const acc = manager.accountId;
  try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.quoteRequest.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: manager.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

const auth = () => `Bearer ${manager.token}`;

describe('#22 accept quote -> auto work order', () => {
  test('accept creates a WO linked to the quote and the overdue schedule', async () => {
    const q = await makeQuote(assetWithSched);
    const res = await request(app).patch(`/api/quote-requests/${q.id}/status`).set('Authorization', auth()).send({ status: 'accepted' });
    expect(res.status).toBe(200);
    expect(res.body.workOrder).toBeTruthy();
    expect(res.body.workOrder.scheduleId).toBe(schedId);

    const wo = await prisma.workOrder.findFirst({ where: { quoteRequestId: q.id } });
    expect(wo).toBeTruthy();
    expect(wo.assetId).toBe(assetWithSched);
  });

  test('re-accepting is idempotent (no duplicate WO)', async () => {
    const q = await makeQuote(assetWithSched);
    await request(app).patch(`/api/quote-requests/${q.id}/status`).set('Authorization', auth()).send({ status: 'accepted' });
    await request(app).patch(`/api/quote-requests/${q.id}/status`).set('Authorization', auth()).send({ status: 'accepted' });
    const count = await prisma.workOrder.count({ where: { quoteRequestId: q.id } });
    expect(count).toBe(1);
  });

  test('accept on an asset with no schedule still creates an ad-hoc WO', async () => {
    const q = await makeQuote(assetNoSched);
    const res = await request(app).patch(`/api/quote-requests/${q.id}/status`).set('Authorization', auth()).send({ status: 'accepted' });
    expect(res.body.workOrder).toBeTruthy();
    expect(res.body.workOrder.scheduleId).toBeNull();
  });

  test('declining does not create a WO', async () => {
    const q = await makeQuote(assetWithSched);
    const res = await request(app).patch(`/api/quote-requests/${q.id}/status`).set('Authorization', auth()).send({ status: 'declined', declineReason: 'no budget' });
    expect(res.status).toBe(200);
    expect(res.body.workOrder).toBeNull();
    const count = await prisma.workOrder.count({ where: { quoteRequestId: q.id } });
    expect(count).toBe(0);
  });
});

export {};

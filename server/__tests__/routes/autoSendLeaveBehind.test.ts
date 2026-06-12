/**
 * #16 Auto-send leave-behind on WO completion. Covers the account-level toggle
 * round-trip through /api/settings, the shared PDF builder, and the auto-send
 * helper (no-op when off, no-throw when on with EMAIL_MOCK).
 */
process.env.EMAIL_MOCK = 'true'; // never hit a real provider in tests

import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildLeaveBehindPdf } = require('../../lib/leaveBehindData');
const { maybeAutoSendLeaveBehind } = require('../../lib/leaveBehindAutoSend');

let app: any;
let prisma: any;
let admin: TestUser;
let siteId: string;
let woId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `LB ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR', serialNumber: 'LB-1' } });
  const wo = await prisma.workOrder.create({
    data: { accountId: admin.accountId, assetId: asset.id, status: 'COMPLETE', completedDate: new Date() },
  });
  woId = wo.id;
});

afterAll(async () => {
  const acc = admin.accountId;
  try { await prisma.accountSetting.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

const auth = () => `Bearer ${admin.token}`;

describe('#16 auto-send leave-behind', () => {
  test('toggle round-trips through /api/settings', async () => {
    const put = await request(app).put('/api/settings').set('Authorization', auth()).send({ autoSendLeaveBehind: true });
    expect(put.status).toBe(200);
    const get = await request(app).get('/api/settings').set('Authorization', auth());
    expect(get.status).toBe(200);
    expect(get.body.data.autoSendLeaveBehind).toBe(true);
  });

  test('buildLeaveBehindPdf returns a PDF for a completed WO', async () => {
    const built = await buildLeaveBehindPdf(admin.accountId, woId);
    expect(built).toBeTruthy();
    expect(built.pdfBuffer.slice(0, 5).toString()).toBe('%PDF-');
    expect(built.filename).toMatch(/leave-behind-/);
  });

  test('buildLeaveBehindPdf returns null for an unknown WO', async () => {
    const built = await buildLeaveBehindPdf(admin.accountId, '00000000-0000-0000-0000-000000000000');
    expect(built).toBeNull();
  });

  test('auto-send helper resolves without throwing (toggle on, EMAIL_MOCK)', async () => {
    await expect(maybeAutoSendLeaveBehind(admin.accountId, woId)).resolves.toBeUndefined();
  });

  test('auto-send helper no-ops cleanly when toggle off', async () => {
    await request(app).put('/api/settings').set('Authorization', auth()).send({ autoSendLeaveBehind: false });
    await expect(maybeAutoSendLeaveBehind(admin.accountId, woId)).resolves.toBeUndefined();
  });
});

export {};

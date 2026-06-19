/**
 * Missing-access / open-items blocker log. Covers create (with asset →
 * compliance-impact count), list + open count, resolve/reopen, validation,
 * manager-only delete, and tenant isolation.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let admin: TestUser;
let viewer: TestUser; // non-manager — delete must be 403
let other: TestUser;  // different account — isolation
let assetId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  viewer = await createTestUser('viewer');
  other = await createTestUser('admin');

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `Blk ${Date.now()}` } });
  const a = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', manufacturer: 'ACME', model: 'SG-9', serialNumber: 'BLK-1' } });
  assetId = a.id;
  // Two active schedules on the asset → compliance impact = 2 blocked tasks.
  const td1 = await prisma.maintenanceTaskDefinition.create({ data: { accountId: admin.accountId, equipmentType: 'SWITCHGEAR', taskName: 'IR', taskCode: `B1_${Date.now()}`, intervalC2Months: 12 } });
  const td2 = await prisma.maintenanceTaskDefinition.create({ data: { accountId: admin.accountId, equipmentType: 'SWITCHGEAR', taskName: 'Torque', taskCode: `B2_${Date.now()}`, intervalC2Months: 12 } });
  await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId: a.id, taskDefinitionId: td1.id, isActive: true, nextDueDate: new Date() } });
  await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId: a.id, taskDefinitionId: td2.id, isActive: true, nextDueDate: null } });
});

afterAll(async () => {
  for (const u of [admin, viewer, other]) {
    const acc = u.accountId;
    try { await prisma.accessBlocker.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('access blockers', () => {
  let blockerId: string;

  test('rejects an invalid kind', async () => {
    const res = await request(app).post('/api/access-blockers').set('Authorization', auth(admin)).send({ kind: 'NOPE' });
    expect(res.status).toBe(400);
  });

  test('creates a blocker on an asset with the compliance-impact count', async () => {
    const res = await request(app).post('/api/access-blockers').set('Authorization', auth(admin))
      .send({ kind: 'LOCKED_DOOR', description: 'Panel room locked', assetId });
    expect(res.status).toBe(201);
    expect(res.body.data.kind).toBe('LOCKED_DOOR');
    expect(res.body.data.assetLabel).toContain('BLK-1');
    expect(res.body.data.blockedSchedules).toBe(2); // two active schedules on the asset
    expect(res.body.data.status).toBe('open');
    blockerId = res.body.data.id;
  });

  test('lists with an open count', async () => {
    const res = await request(app).get('/api/access-blockers?status=open').set('Authorization', auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.openCount).toBeGreaterThanOrEqual(1);
    expect(res.body.data.blockers.find((b: any) => b.id === blockerId)).toBeTruthy();
  });

  test('resolves and reopens', async () => {
    const r1 = await request(app).patch(`/api/access-blockers/${blockerId}`).set('Authorization', auth(admin)).send({ status: 'resolved' });
    expect(r1.status).toBe(200);
    expect(r1.body.data.status).toBe('resolved');
    expect(r1.body.data.resolvedByName).toBeTruthy();
    const r2 = await request(app).patch(`/api/access-blockers/${blockerId}`).set('Authorization', auth(admin)).send({ status: 'open' });
    expect(r2.body.data.status).toBe('open');
    expect(r2.body.data.resolvedAt).toBeNull();
  });

  test('a different account cannot see or delete the blocker (isolation)', async () => {
    const list = await request(app).get('/api/access-blockers').set('Authorization', auth(other));
    expect(list.body.data.blockers.find((b: any) => b.id === blockerId)).toBeFalsy();
    const del = await request(app).delete(`/api/access-blockers/${blockerId}`).set('Authorization', auth(other));
    expect(del.status).toBe(404);
  });

  test('a non-manager cannot delete', async () => {
    const res = await request(app).delete(`/api/access-blockers/${blockerId}`).set('Authorization', auth(viewer));
    expect(res.status).toBe(403);
  });

  test('a manager+ can delete', async () => {
    const res = await request(app).delete(`/api/access-blockers/${blockerId}`).set('Authorization', auth(admin));
    expect(res.status).toBe(200);
  });
});

export {};

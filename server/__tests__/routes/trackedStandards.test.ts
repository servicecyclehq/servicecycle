/**
 * Standards-tracking toggle: an account tracks a subset of standards; bulk-apply
 * only creates schedules for tracked standards. Default (unset) = track all.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let admin: TestUser;
let assetId: string;

async function appliedCodes(): Promise<string[]> {
  const rows = await prisma.maintenanceSchedule.findMany({
    where: { accountId: admin.accountId, assetId },
    select: { taskDefinition: { select: { taskCode: true, standard: { select: { code: true } } } } },
  });
  return rows.map((r: any) => r.taskDefinition.taskCode);
}
async function appliedStandardCodes(): Promise<Set<string>> {
  const rows = await prisma.maintenanceSchedule.findMany({
    where: { accountId: admin.accountId, assetId },
    select: { taskDefinition: { select: { standard: { select: { code: true } } } } },
  });
  return new Set(rows.map((r: any) => r.taskDefinition.standard?.code).filter(Boolean));
}

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `Ts ${Date.now()}` } });
  const a = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: `TS-${Date.now()}` } });
  assetId = a.id;
});

afterAll(async () => {
  const acc = admin.accountId;
  try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.accountSetting.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('tracked-standards endpoints', () => {
  test('default is track-all (null)', async () => {
    const res = await request(app).get('/api/standards/tracked').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.allTracked).toBe(true);
    expect(res.body.data.trackedCodes).toBeNull();
  });
  test('PUT rejects an unknown code', async () => {
    const res = await request(app).put('/api/standards/tracked').set('Authorization', `Bearer ${admin.token}`).send({ codes: ['NOT A STANDARD'] });
    expect(res.status).toBe(400);
  });
  test('PUT sets and GET reflects', async () => {
    const res = await request(app).put('/api/standards/tracked').set('Authorization', `Bearer ${admin.token}`).send({ codes: ['NFPA 70B'] });
    expect(res.status).toBe(200);
    const get = await request(app).get('/api/standards/tracked').set('Authorization', `Bearer ${admin.token}`);
    expect(get.body.data.trackedCodes).toEqual(['NFPA 70B']);
  });
});

describe('bulk-apply respects tracked standards', () => {
  test('tracking only NFPA 70B drops NETA-standard tasks; reverting restores them', async () => {
    // tracked is currently ['NFPA 70B'] from the prior test
    let res = await request(app).post('/api/schedules/bulk-apply').set('Authorization', `Bearer ${admin.token}`).send({ assetId });
    expect(res.status).toBeLessThan(300);
    let stds = await appliedStandardCodes();
    expect(stds.has('NFPA 70B')).toBe(true);
    expect(stds.has('NETA MTS')).toBe(false); // gated out
    expect(await appliedCodes()).toContain('SWGR_IR_THERMO');
    expect(await appliedCodes()).not.toContain('SWGR_INSULATION_RES');

    // revert to track-all, re-apply (idempotent add)
    res = await request(app).put('/api/standards/tracked').set('Authorization', `Bearer ${admin.token}`).send({ allTracked: true });
    expect(res.status).toBe(200);
    res = await request(app).post('/api/schedules/bulk-apply').set('Authorization', `Bearer ${admin.token}`).send({ assetId });
    expect(res.status).toBeLessThan(300);
    expect(await appliedCodes()).toContain('SWGR_INSULATION_RES'); // NETA megger now applied
  });
});

export {};
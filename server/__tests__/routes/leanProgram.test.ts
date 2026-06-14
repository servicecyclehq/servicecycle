/**
 * Lean program: bulk-apply gives a new asset the lean PM set by default and
 * adds the full NETA battery only when neta_full_battery is on. Plus a drift
 * guard that every NETA-battery code still exists in the seed matrix.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { NETA_BATTERY_TASK_CODES, isNetaBatteryTask } = require('../../lib/leanProgram');
const { TASKS } = require('../../scripts/seed-standards');

let app: any;
let prisma: any;
let manager: TestUser;
let siteId: string;
let assetId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `Lean ${Date.now()}` } });
  siteId = site.id;
  const a = await prisma.asset.create({
    data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR', serialNumber: `LEAN-${Date.now()}` },
  });
  assetId = a.id;
});

afterAll(async () => {
  const acc = manager.accountId;
  try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.accountSetting.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: manager.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

async function appliedCodes(): Promise<string[]> {
  const rows = await prisma.maintenanceSchedule.findMany({
    where: { accountId: manager.accountId, assetId },
    select: { taskDefinition: { select: { taskCode: true } } },
  });
  return rows.map((r: any) => r.taskDefinition.taskCode);
}

describe('lean program drift guard', () => {
  test('every NETA-battery code exists in the seed matrix', () => {
    const seedCodes = new Set(TASKS.map((t: any) => t.code));
    for (const code of NETA_BATTERY_TASK_CODES) expect(seedCodes.has(code)).toBe(true);
  });
});

describe('bulk-apply respects neta_full_battery', () => {
  test('lean default excludes the NETA battery for SWITCHGEAR', async () => {
    const res = await request(app)
      .post('/api/schedules/bulk-apply')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ assetId });
    expect(res.status).toBeLessThan(300);
    const codes = await appliedCodes();
    expect(codes).toContain('SWGR_INSULATION_RES'); // megger kept
    expect(codes).toContain('SWGR_IR_THERMO');       // IR kept
    expect(codes).not.toContain('SWGR_CONTACT_RES');
    expect(codes).not.toContain('SWGR_CB_TRIP');
    expect(codes).not.toContain('SWGR_RELAY_CAL');
    expect(codes.every((c: string) => !isNetaBatteryTask(c))).toBe(true);
  });

  test('neta_full_battery on adds the full battery', async () => {
    await prisma.accountSetting.upsert({
      where: { accountId_key: { accountId: manager.accountId, key: 'feature.neta_full_battery' } },
      update: { value: 'true' },
      create: { accountId: manager.accountId, key: 'feature.neta_full_battery', value: 'true' },
    });
    const res = await request(app)
      .post('/api/schedules/bulk-apply')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ assetId });
    expect(res.status).toBeLessThan(300);
    const codes = await appliedCodes();
    expect(codes).toContain('SWGR_CONTACT_RES');
    expect(codes).toContain('SWGR_CB_TRIP');
    expect(codes).toContain('SWGR_RELAY_CAL');
  });
});

export {};
/**
 * Broadened global asset search (bootstrap + assets routes): an asset must be
 * findable by its equipment-position code/name, its location hierarchy, and its
 * notes — not just manufacturer/model/serial/site. Regression guard for the
 * "search SWGR-1A-1 finds nothing" report.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let user: TestUser;
let assetId: string;

const auth = (u: TestUser) => `Bearer ${u.token}`;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  user = await createTestUser('manager');
  const acc = user.accountId;
  const site = await prisma.site.create({ data: { accountId: acc, name: 'Riverside Plant' } });
  const building = await prisma.building.create({ data: { accountId: acc, siteId: site.id, name: 'Main Production' } });
  const area = await prisma.area.create({ data: { accountId: acc, siteId: site.id, buildingId: building.id, name: 'Substation A' } });
  const position = await prisma.equipmentPosition.create({ data: { accountId: acc, siteId: site.id, areaId: area.id, name: 'SWGR-1A Cubicle 1', code: 'SWGR-1A-1' } });
  const asset = await prisma.asset.create({
    data: {
      accountId: acc, siteId: site.id, buildingId: building.id, areaId: area.id, positionId: position.id,
      equipmentType: 'SWITCHGEAR', manufacturer: 'Acme Switch', serialNumber: 'ZX-991',
      notes: 'Lead 15 kV switchgear feeding the mezzanine lineup.',
    },
  });
  assetId = asset.id;
});

afterAll(async () => {
  const acc = user.accountId;
  for (const t of ['asset', 'equipmentPosition', 'area', 'building', 'site']) {
    try { await (prisma as any)[t].deleteMany({ where: { accountId: acc } }); } catch {}
  }
  try { await prisma.user.delete({ where: { id: user.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

async function search(term: string) {
  const r = await request(app).get(`/api/bootstrap?search=${encodeURIComponent(term)}`).set('Authorization', auth(user)).expect(200);
  return r.body.data.assets.map((a: any) => a.id);
}

describe('broadened asset search', () => {
  test('finds the asset by equipment-position code (the reported case)', async () => {
    expect(await search('SWGR-1A-1')).toContain(assetId);
  });
  test('finds by position name', async () => {
    expect(await search('Cubicle 1')).toContain(assetId);
  });
  test('finds by building and area name', async () => {
    expect(await search('Main Production')).toContain(assetId);
    expect(await search('Substation A')).toContain(assetId);
  });
  test('finds by notes text', async () => {
    expect(await search('mezzanine')).toContain(assetId);
  });
  test('still finds by manufacturer + serial', async () => {
    expect(await search('Acme')).toContain(assetId);
    expect(await search('ZX-991')).toContain(assetId);
  });
  test('a non-matching term returns nothing', async () => {
    expect(await search('zzz-no-such-asset')).not.toContain(assetId);
  });
});

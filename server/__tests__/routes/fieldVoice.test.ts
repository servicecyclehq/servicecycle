/**
 * POST /api/field/voice/parse — voice field entry, scoped to assignment.
 *
 * Parses a spoken reading into a measurement proposal and matches the asset
 * within the caller's SCOPE: a field_tech can voice-match only assets reachable
 * from their assigned work, never another customer's equipment.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let sub: TestUser;
let assignedAssetId: string;   // serial SGR-VOICE-1, on the sub's assigned WO
let unassignedAssetId: string; // serial PNL-VOICE-2, NOT assigned to the sub
let assignedWoId: string;

beforeAll(async () => {
  app    = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;

  sub = await createTestUser('field_tech');
  const site = await prisma.site.create({ data: { accountId: sub.accountId, name: `Voice Site ${Date.now()}` } });
  const a = await prisma.asset.create({
    data: { accountId: sub.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: 'SGR-VOICE-1' },
  });
  const b = await prisma.asset.create({
    data: { accountId: sub.accountId, siteId: site.id, equipmentType: 'PANELBOARD', serialNumber: 'PNL-VOICE-2' },
  });
  assignedAssetId = a.id;
  unassignedAssetId = b.id;
  const wo = await prisma.workOrder.create({
    data: { accountId: sub.accountId, assetId: a.id, status: 'IN_PROGRESS', assignedUserId: sub.id },
  });
  assignedWoId = wo.id;
});

afterAll(async () => {
  const acc = sub.accountId;
  try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

const auth = () => ['Authorization', `Bearer ${sub.token}`] as [string, string];

describe('POST /api/field/voice/parse', () => {
  test('parses a reading against an explicit (in-scope) asset + attaches its WO', async () => {
    const res = await request(app)
      .post('/api/field/voice/parse')
      .set(...auth())
      .send({ transcript: 'insulation resistance normal 68', assetId: assignedAssetId });
    expect(res.status).toBe(200);
    expect(res.body?.data?.proposal?.measurementType).toBe('insulation_resistance');
    expect(res.body?.data?.proposal?.value).toBe(68);
    expect(res.body?.data?.proposal?.passFail).toBe('GREEN');
    expect(res.body?.data?.asset?.id).toBe(assignedAssetId);
    const woIds = (res.body?.data?.asset?.openWorkOrders || []).map((w: any) => w.id);
    expect(woIds).toContain(assignedWoId);
  });

  test('refuses an explicit asset outside the sub\'s scope (404)', async () => {
    const res = await request(app)
      .post('/api/field/voice/parse')
      .set(...auth())
      .send({ transcript: 'insulation resistance normal 68', assetId: unassignedAssetId });
    expect(res.status).toBe(404);
  });

  test('matches the spoken asset by serial within scope (single match resolves)', async () => {
    const res = await request(app)
      .post('/api/field/voice/parse')
      .set(...auth())
      .send({ transcript: 'switchgear SGR-VOICE-1 IR normal 68' });
    expect(res.status).toBe(200);
    expect(res.body?.data?.asset?.id).toBe(assignedAssetId);
  });

  test('a spoken asset OUTSIDE scope yields no match (scoped out)', async () => {
    const res = await request(app)
      .post('/api/field/voice/parse')
      .set(...auth())
      .send({ transcript: 'panel PNL-VOICE-2 normal 5' });
    expect(res.status).toBe(200);
    expect(res.body?.data?.asset).toBeNull();
    expect(res.body?.data?.candidates).toHaveLength(0);
  });

  test('missing transcript → 400', async () => {
    const res = await request(app).post('/api/field/voice/parse').set(...auth()).send({});
    expect(res.status).toBe(400);
  });
});

export {};

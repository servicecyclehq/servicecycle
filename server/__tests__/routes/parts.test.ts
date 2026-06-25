/**
 * Parts / SpareInventory CRUD tests.
 *
 * Covers: part create/list/get/update/delete, inventory add/list/update/delete,
 * by-asset spares view, tenant isolation (cross-account is 404), viewer blocked
 * (requireManager gate), and delete-with-inventory conflict (409).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let viewer: TestUser;
let other: TestUser;  // separate tenant
let siteId: string;
let assetId: string;

beforeAll(async () => {
  app    = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  viewer  = await createTestUser('viewer');
  other   = await createTestUser('manager');

  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `Parts-${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({
    data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR', governingCondition: 'C2' },
  });
  assetId = asset.id;
});

afterAll(async () => {
  for (const acc of [manager.accountId, viewer.accountId, other.accountId]) {
    try { await prisma.spareInventory.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.part.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  }
});

// ── helper ─────────────────────────────────────────────────────────────────────
async function createPart(token: string, overrides: Record<string, any> = {}): Promise<string> {
  const res = await request(app)
    .post('/api/parts')
    .set('Authorization', `Bearer ${token}`)
    .send({ partNumber: `PN-${Date.now()}`, description: 'Test breaker', ...overrides });
  expect(res.status).toBe(201);
  return res.body.data.id;
}

// ── Part catalog ────────────────────────────────────────────────────────────────

describe('POST /api/parts', () => {
  it('creates a part as manager', async () => {
    const res = await request(app)
      .post('/api/parts')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ partNumber: 'QO130', description: '30A 1-pole QO breaker', manufacturer: 'Square D', category: 'BREAKER', unitCost: 12.50, leadTimeWeeks: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.partNumber).toBe('QO130');
    expect(res.body.data.accountId).toBe(manager.accountId);
    // cleanup
    await prisma.part.delete({ where: { id: res.body.data.id } });
  });

  it('rejects missing partNumber', async () => {
    const res = await request(app)
      .post('/api/parts')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ description: 'no part number' });
    expect(res.status).toBe(400);
  });

  it('blocks viewer', async () => {
    const res = await request(app)
      .post('/api/parts')
      .set('Authorization', `Bearer ${viewer.token}`)
      .send({ partNumber: 'X1', description: 'blocked' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/parts', () => {
  let partId: string;
  beforeAll(async () => { partId = await createPart(manager.token, { category: 'FUSE' }); });
  afterAll(async () => { try { await prisma.part.delete({ where: { id: partId } }); } catch {} });

  it('lists own account parts', async () => {
    const res = await request(app)
      .get('/api/parts')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((p: any) => p.id);
    expect(ids).toContain(partId);
  });

  it('does not leak other-tenant parts', async () => {
    const otherId = await createPart(other.token);
    const res = await request(app)
      .get('/api/parts')
      .set('Authorization', `Bearer ${manager.token}`);
    const ids = res.body.data.map((p: any) => p.id);
    expect(ids).not.toContain(otherId);
    await prisma.part.delete({ where: { id: otherId } });
  });

  it('filters by category', async () => {
    const res = await request(app)
      .get('/api/parts?category=FUSE')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    res.body.data.forEach((p: any) => expect(p.category).toBe('FUSE'));
  });
});

describe('GET /api/parts/:id', () => {
  let partId: string;
  beforeAll(async () => { partId = await createPart(manager.token); });
  afterAll(async () => { try { await prisma.part.delete({ where: { id: partId } }); } catch {} });

  it('returns part with inventory array', async () => {
    const res = await request(app)
      .get(`/api/parts/${partId}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(partId);
    expect(Array.isArray(res.body.data.inventory)).toBe(true);
  });

  it('returns 404 for other-tenant part', async () => {
    const otherId = await createPart(other.token);
    const res = await request(app)
      .get(`/api/parts/${otherId}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(404);
    await prisma.part.delete({ where: { id: otherId } });
  });
});

describe('PATCH /api/parts/:id', () => {
  let partId: string;
  beforeAll(async () => { partId = await createPart(manager.token, { category: 'RELAY' }); });
  afterAll(async () => { try { await prisma.part.delete({ where: { id: partId } }); } catch {} });

  it('updates part fields', async () => {
    const res = await request(app)
      .patch(`/api/parts/${partId}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ manufacturer: 'ABB', unitCost: 99.00 });
    expect(res.status).toBe(200);
    expect(res.body.data.manufacturer).toBe('ABB');
  });

  it('cannot update other-tenant part', async () => {
    const otherId = await createPart(other.token);
    const res = await request(app)
      .patch(`/api/parts/${otherId}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ manufacturer: 'Hacked' });
    expect(res.status).toBe(404);
    await prisma.part.delete({ where: { id: otherId } });
  });
});

describe('DELETE /api/parts/:id', () => {
  it('deletes a part with no inventory', async () => {
    const partId = await createPart(manager.token);
    const res = await request(app)
      .delete(`/api/parts/${partId}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it('returns 409 when inventory entries exist', async () => {
    const partId = await createPart(manager.token);
    await prisma.spareInventory.create({ data: { accountId: manager.accountId, partId, qtyOnHand: 2 } });
    const res = await request(app)
      .delete(`/api/parts/${partId}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(409);
    // cleanup
    await prisma.spareInventory.deleteMany({ where: { partId } });
    await prisma.part.delete({ where: { id: partId } });
  });
});

// ── SpareInventory ──────────────────────────────────────────────────────────────

describe('POST /api/parts/:id/inventory', () => {
  let partId: string;
  beforeAll(async () => { partId = await createPart(manager.token); });
  afterAll(async () => {
    try { await prisma.spareInventory.deleteMany({ where: { partId } }); } catch {}
    try { await prisma.part.delete({ where: { id: partId } }); } catch {}
  });

  it('adds an account-wide inventory entry', async () => {
    const res = await request(app)
      .post(`/api/parts/${partId}/inventory`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ qtyOnHand: 5, qtyMin: 2, location: 'Bin A3' });
    expect(res.status).toBe(201);
    expect(res.body.data.qtyOnHand).toBe(5);
    expect(res.body.data.location).toBe('Bin A3');
    expect(res.body.data.accountId).toBe(manager.accountId);
  });

  it('adds an asset-scoped inventory entry', async () => {
    const res = await request(app)
      .post(`/api/parts/${partId}/inventory`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ assetId, qtyOnHand: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.assetId).toBe(assetId);
  });

  it('rejects assetId from another tenant', async () => {
    const otherSite = await prisma.site.create({ data: { accountId: other.accountId, name: `OS-${Date.now()}` } });
    const otherAsset = await prisma.asset.create({ data: { accountId: other.accountId, siteId: otherSite.id, equipmentType: 'SWITCHGEAR', governingCondition: 'C2' } });
    const res = await request(app)
      .post(`/api/parts/${partId}/inventory`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ assetId: otherAsset.id, qtyOnHand: 1 });
    expect(res.status).toBe(400);
    await prisma.asset.delete({ where: { id: otherAsset.id } });
    await prisma.site.delete({ where: { id: otherSite.id } });
  });
});

describe('PATCH /api/parts/:id/inventory/:entryId', () => {
  let partId: string;
  let entryId: string;
  beforeAll(async () => {
    partId = await createPart(manager.token);
    const e = await prisma.spareInventory.create({ data: { accountId: manager.accountId, partId, qtyOnHand: 3, qtyMin: 1 } });
    entryId = e.id;
  });
  afterAll(async () => {
    try { await prisma.spareInventory.deleteMany({ where: { partId } }); } catch {}
    try { await prisma.part.delete({ where: { id: partId } }); } catch {}
  });

  it('updates qty and location', async () => {
    const res = await request(app)
      .patch(`/api/parts/${partId}/inventory/${entryId}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ qtyOnHand: 10, location: 'Shelf B2' });
    expect(res.status).toBe(200);
    expect(res.body.data.qtyOnHand).toBe(10);
    expect(res.body.data.location).toBe('Shelf B2');
  });

  it('cannot update other-tenant entry', async () => {
    const otherPartId = await createPart(other.token);
    const otherEntry = await prisma.spareInventory.create({ data: { accountId: other.accountId, partId: otherPartId, qtyOnHand: 1 } });
    const res = await request(app)
      .patch(`/api/parts/${otherPartId}/inventory/${otherEntry.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ qtyOnHand: 999 });
    expect(res.status).toBe(404);
    await prisma.spareInventory.delete({ where: { id: otherEntry.id } });
    await prisma.part.delete({ where: { id: otherPartId } });
  });
});

describe('DELETE /api/parts/:id/inventory/:entryId', () => {
  it('removes an inventory entry', async () => {
    const partId = await createPart(manager.token);
    const entry = await prisma.spareInventory.create({ data: { accountId: manager.accountId, partId, qtyOnHand: 1 } });
    const res = await request(app)
      .delete(`/api/parts/${partId}/inventory/${entry.id}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
    await prisma.part.delete({ where: { id: partId } });
  });
});

describe('GET /api/parts/by-asset/:assetId', () => {
  let partId: string;
  let entryId: string;
  beforeAll(async () => {
    partId = await createPart(manager.token);
    const e = await prisma.spareInventory.create({ data: { accountId: manager.accountId, partId, assetId, qtyOnHand: 4 } });
    entryId = e.id;
  });
  afterAll(async () => {
    try { await prisma.spareInventory.deleteMany({ where: { partId } }); } catch {}
    try { await prisma.part.delete({ where: { id: partId } }); } catch {}
  });

  it('returns spares for an asset with part data', async () => {
    const res = await request(app)
      .get(`/api/parts/by-asset/${assetId}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const entry = res.body.data.find((e: any) => e.id === entryId);
    expect(entry).toBeDefined();
    expect(entry.part.id).toBe(partId);
  });

  it('returns 404 for other-tenant asset', async () => {
    const otherSite = await prisma.site.create({ data: { accountId: other.accountId, name: `OAS-${Date.now()}` } });
    const otherAsset = await prisma.asset.create({ data: { accountId: other.accountId, siteId: otherSite.id, equipmentType: 'SWITCHGEAR', governingCondition: 'C2' } });
    const res = await request(app)
      .get(`/api/parts/by-asset/${otherAsset.id}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(404);
    await prisma.asset.delete({ where: { id: otherAsset.id } });
    await prisma.site.delete({ where: { id: otherSite.id } });
  });
});

// ── Low-stock summary ────────────────────────────────────────────────────────

describe('GET /api/parts/low-stock', () => {
  let partId: string;
  let entryId: string;

  beforeAll(async () => {
    partId = await createPart(manager.token, { partNumber: `LOW-${Date.now()}` });
    const inv = await prisma.spareInventory.create({
      data: { accountId: manager.accountId, partId, qtyOnHand: 1, qtyMin: 5 },
    });
    entryId = inv.id;
  });
  afterAll(async () => {
    try { await prisma.spareInventory.delete({ where: { id: entryId } }); } catch {}
    try { await prisma.part.delete({ where: { id: partId } }); } catch {}
  });

  it('returns count and items below min', async () => {
    const res = await request(app)
      .get('/api/parts/low-stock')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBeGreaterThanOrEqual(1);
    const found = res.body.data.items.find((e: any) => e.part.id === partId);
    expect(found).toBeDefined();
    expect(found.qtyOnHand).toBe(1);
  });

  it('blocks viewer', async () => {
    const res = await request(app)
      .get('/api/parts/low-stock')
      .set('Authorization', `Bearer ${viewer.token}`);
    expect(res.status).toBe(403);
  });
});

// ── CSV import ───────────────────────────────────────────────────────────────

describe('GET /api/parts/import/template', () => {
  it('returns a CSV file', async () => {
    const res = await request(app)
      .get('/api/parts/import/template')
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('partNumber');
  });
});

describe('POST /api/parts/import', () => {
  const csvContent = `partNumber,description,manufacturer,category,unitCost,leadTimeWeeks,notes,qtyOnHand,qtyMin,location
IMPORT-TEST-1,Test Breaker,Square D,BREAKER,24.99,2,,5,2,Bin A
IMPORT-TEST-2,Test Relay,ABB,RELAY,89.00,4,,0,1,`;

  it('preview returns row statuses without writing', async () => {
    const res = await request(app)
      .post('/api/parts/import?preview=true')
      .set('Authorization', `Bearer ${manager.token}`)
      .attach('file', Buffer.from(csvContent), { filename: 'test.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.data.preview).toHaveLength(2);
    expect(res.body.data.preview[0].status).toBe('new');
    // No DB write
    const exists = await prisma.part.findFirst({ where: { accountId: manager.accountId, partNumber: 'IMPORT-TEST-1' } });
    expect(exists).toBeNull();
  });

  it('confirm import creates parts', async () => {
    const res = await request(app)
      .post('/api/parts/import')
      .set('Authorization', `Bearer ${manager.token}`)
      .attach('file', Buffer.from(csvContent), { filename: 'test.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(2);
    // cleanup
    await prisma.spareInventory.deleteMany({ where: { accountId: manager.accountId, part: { partNumber: { in: ['IMPORT-TEST-1', 'IMPORT-TEST-2'] } } } });
    await prisma.part.deleteMany({ where: { accountId: manager.accountId, partNumber: { in: ['IMPORT-TEST-1', 'IMPORT-TEST-2'] } } });
  });

  it('blocks viewer', async () => {
    const res = await request(app)
      .post('/api/parts/import')
      .set('Authorization', `Bearer ${viewer.token}`)
      .attach('file', Buffer.from(csvContent), { filename: 'test.csv', contentType: 'text/csv' });
    expect(res.status).toBe(403);
  });
});

// ── Asset part requirements ──────────────────────────────────────────────────

describe('AssetPartRequirement CRUD', () => {
  let partId: string;

  beforeAll(async () => {
    partId = await createPart(manager.token, { partNumber: `REQ-${Date.now()}` });
  });
  afterAll(async () => {
    try { await prisma.assetPartRequirement.deleteMany({ where: { accountId: manager.accountId } }); } catch {}
    try { await prisma.part.delete({ where: { id: partId } }); } catch {}
  });

  it('POST /api/parts/required-by/:assetId links a part', async () => {
    const res = await request(app)
      .post(`/api/parts/required-by/${assetId}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ partId, qtyRequired: 2 });
    expect(res.status).toBe(201);
    expect(res.body.data.partId).toBe(partId);
    expect(res.body.data.qtyRequired).toBe(2);
  });

  it('GET /api/parts/required-by/:assetId returns requirements with stock status', async () => {
    const res = await request(app)
      .get(`/api/parts/required-by/${assetId}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const found = res.body.data.find((r: any) => r.partId === partId);
    expect(found).toBeDefined();
    expect(found.stockStatus).toBe('OOS'); // no inventory yet
    expect(found.totalOnHand).toBe(0);
  });

  it('does not leak other-tenant asset requirements', async () => {
    const otherSite = await prisma.site.create({ data: { accountId: other.accountId, name: `OREQ-${Date.now()}` } });
    const otherAsset = await prisma.asset.create({ data: { accountId: other.accountId, siteId: otherSite.id, equipmentType: 'SWITCHGEAR', governingCondition: 'C2' } });
    const res = await request(app)
      .get(`/api/parts/required-by/${otherAsset.id}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(404);
    await prisma.asset.delete({ where: { id: otherAsset.id } });
    await prisma.site.delete({ where: { id: otherSite.id } });
  });

  it('DELETE /api/parts/required-by/:assetId/:partId removes link', async () => {
    const res = await request(app)
      .delete(`/api/parts/required-by/${assetId}/${partId}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it('blocks viewer on POST', async () => {
    const res = await request(app)
      .post(`/api/parts/required-by/${assetId}`)
      .set('Authorization', `Bearer ${viewer.token}`)
      .send({ partId, qtyRequired: 1 });
    expect(res.status).toBe(403);
  });
});

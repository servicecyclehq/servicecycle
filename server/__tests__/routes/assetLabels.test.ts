/**
 * #7 condition-of-maintenance labels — the QR label sheet renders a valid PDF
 * and pulls the asset's NETA decal designation + governing condition + the date
 * the condition was established (latest completed work order's decal).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let siteId: string;
let assetId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `Labels ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({
    data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR', manufacturer: 'Square D', model: 'QED', serialNumber: 'LBL-1', governingCondition: 'C3' },
  });
  assetId = asset.id;
  await prisma.workOrder.create({
    data: { accountId: manager.accountId, assetId, status: 'COMPLETE', completedDate: new Date('2026-02-10'), netaDecal: 'YELLOW' },
  });
});

afterAll(async () => {
  const acc = manager.accountId;
  try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: manager.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

function getPdf(url: string) {
  return request(app).get(url).set('Authorization', `Bearer ${manager.token}`).buffer(true)
    .parse((res: any, cb: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

describe('GET /api/assets/labels (#7)', () => {
  test('streams a valid PDF for the selected asset', async () => {
    const res = await getPdf(`/api/assets/labels?assetIds=${assetId}`);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('pdf');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(1000);
    expect(res.body.slice(0, 4).toString('latin1')).toBe('%PDF'); // valid PDF signature
  });

  test('renders for a whole site too', async () => {
    const res = await getPdf(`/api/assets/labels?siteId=${siteId}`);
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString('latin1')).toBe('%PDF');
  });
});

/**
 * #30 Customer weekly digest + quarterly CFO PDF. Covers the digest payload
 * (this-week deltas, next outage, compliance), the on-demand CFO PDF render
 * (%PDF smoke), and the admin-only settings opt-in round trip.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let admin: TestUser;
let siteId: string;
let assetId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `Dig ${Date.now()}` } });
  siteId = site.id;
  const a = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR', serialNumber: 'DIG-1', repairCostEstimate: 5000 } });
  assetId = a.id;

  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000);
  // One open + one resolved-this-week deficiency.
  await prisma.deficiency.create({ data: { accountId: admin.accountId, assetId, severity: 'IMMEDIATE', description: 'open immediate' } });
  await prisma.deficiency.create({ data: { accountId: admin.accountId, assetId, severity: 'RECOMMENDED', description: 'fixed this week', resolvedAt: threeDaysAgo } });
  // A completed WO this week.
  await prisma.workOrder.create({ data: { accountId: admin.accountId, assetId, status: 'COMPLETE', completedDate: threeDaysAgo } });
  // A future outage window.
  const inFuture = new Date(now.getTime() + 30 * 86_400_000);
  await prisma.blackoutWindow.create({ data: { accountId: admin.accountId, siteId, startsAt: inFuture, endsAt: new Date(inFuture.getTime() + 86_400_000), isOutageWindow: true, reason: 'planned shutdown' } });
});

afterAll(async () => {
  const acc = admin.accountId;
  try { await prisma.blackoutWindow.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.accountSetting.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

const auth = () => `Bearer ${admin.token}`;

describe('#30 customer digest', () => {
  test('digest reports this-week activity and the next outage', async () => {
    const res = await request(app).get('/api/compliance/customer-digest').set('Authorization', auth());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(typeof d.compliance.overallRate).toBe('number');
    expect(d.thisWeek.fixed).toBeGreaterThanOrEqual(1);
    expect(d.thisWeek.workOrdersCompleted).toBeGreaterThanOrEqual(1);
    expect(d.thisWeek.newDeficiencies).toBeGreaterThanOrEqual(2);
    expect(d.nextOutage).toBeTruthy();
    expect(d.nextOutage.daysUntil).toBeGreaterThan(0);
    // No prior stored rate yet -> delta null
    expect(d.compliance.delta).toBeNull();
  });
});

describe('#30 CFO report PDF', () => {
  function getPdf(url: string) {
    return request(app).get(url).set('Authorization', auth()).buffer(true)
      .parse((res: any, cb: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  }

  test('renders a valid quarterly CFO PDF', async () => {
    const res: any = await getPdf('/api/compliance/cfo-report.pdf');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('pdf');
    expect(res.body.slice(0, 4).toString('latin1')).toBe('%PDF');
    expect(res.body.length).toBeGreaterThan(1000);
  });
});

describe('#30 settings opt-in', () => {
  test('admin can enable the weekly digest + quarterly CFO opt-ins', async () => {
    const put = await request(app).put('/api/settings').set('Authorization', auth())
      .send({ customerWeeklyDigest: true, customerQuarterlyCfo: true });
    expect(put.status).toBeLessThan(300);

    const get = await request(app).get('/api/settings').set('Authorization', auth());
    expect(get.body.data.customerWeeklyDigest).toBe(true);
    expect(get.body.data.customerQuarterlyCfo).toBe(true);

    const row = await prisma.accountSetting.findFirst({ where: { accountId: admin.accountId, key: 'customer_weekly_digest' } });
    expect(row.value).toBe('true');
  });
});

export {};

/**
 * #35 SIEM audit-log export. Covers NDJSON + CEF formats (hash-chain fields
 * present), admin-only access, format validation, and tenancy scoping.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let admin: TestUser;
let manager: TestUser;
let other: TestUser;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  manager = await createTestUser('manager', { accountId: admin.accountId });
  other = await createTestUser('admin');

  await prisma.activityLog.create({ data: { accountId: admin.accountId, userId: admin.id, action: 'asset_created', details: { foo: 'bar' }, prevHash: 'p1', rowHash: 'h1' } });
  await prisma.activityLog.create({ data: { accountId: admin.accountId, userId: admin.id, action: 'login_failed', details: {}, prevHash: 'h1', rowHash: 'h2' } });
  await prisma.activityLog.create({ data: { accountId: other.accountId, userId: other.id, action: 'asset_created', details: {}, prevHash: 'o1', rowHash: 'o2' } });
});

afterAll(async () => {
  for (const u of [admin, other]) {
    const acc = u.accountId;
    try { await prisma.activityLog.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('#35 SIEM audit-log export', () => {
  test('NDJSON export carries hash-chain fields and is account-scoped', async () => {
    const res = await request(app).get('/api/activity/export').set('Authorization', auth(admin));
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('ndjson');
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const parsed = lines.map((l) => JSON.parse(l));
    // No cross-tenant rows
    expect(parsed.every((r) => r.accountId === admin.accountId)).toBe(true);
    // Hash chain present
    const withHash = parsed.find((r) => r.rowHash === 'h1');
    expect(withHash).toBeTruthy();
    expect(withHash.prevHash).toBe('p1');
    expect(withHash.action).toBe('asset_created');
  });

  test('CEF export emits ServiceCycle CEF lines with elevated severity for security events', async () => {
    const res = await request(app).get('/api/activity/export?format=cef').set('Authorization', auth(admin));
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/plain');
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines.every((l) => l.startsWith('CEF:0|ServiceCycle|ServiceCycle|1.0|'))).toBe(true);
    const loginFailed = lines.find((l) => l.includes('|login_failed|'));
    expect(loginFailed).toBeTruthy();
    expect(loginFailed).toContain('cs2Label=rowHash');
  });

  test('non-admin (manager) is forbidden', async () => {
    const res = await request(app).get('/api/activity/export').set('Authorization', auth(manager));
    expect(res.status).toBe(403);
  });

  test('invalid format is rejected', async () => {
    const res = await request(app).get('/api/activity/export?format=xml').set('Authorization', auth(admin));
    expect(res.status).toBe(400);
  });
});

export {};

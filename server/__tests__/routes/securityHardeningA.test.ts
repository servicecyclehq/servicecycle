/**
 * Cluster A security hardening:
 *  - settings PUT rejects a private/metadata Azure AI endpoint (SSRF guard)
 *  - changing a user's role bumps tokenEpoch (instant stale-token invalidation)
 *  - ingest worker exposes a liveness heartbeat for /api/ready
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let admin: TestUser;
let targetUserId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const u = await prisma.user.create({
    data: {
      accountId: admin.accountId,
      name: 'Demote Me',
      email: `demote-${Date.now()}@test.local`,
      passwordHash: 'x',
      role: 'manager',
    },
  });
  targetUserId = u.id;
});

afterAll(async () => {
  const acc = admin.accountId;
  try { await prisma.user.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('A1: Azure AI endpoint SSRF guard', () => {
  test('rejects a link-local / metadata endpoint', async () => {
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ AZURE_OPENAI_ENDPOINT: 'https://169.254.169.254/openai' });
    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toMatch(/AI endpoint blocked/i);
  });

  test('rejects a loopback endpoint', async () => {
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ AZURE_OPENAI_ENDPOINT: 'https://127.0.0.1:8080/openai' });
    expect(res.status).toBe(400);
  });
});

describe('A2: role change bumps tokenEpoch', () => {
  test('demoting a manager to viewer increments tokenEpoch', async () => {
    const before = await prisma.user.findUnique({ where: { id: targetUserId }, select: { tokenEpoch: true } });
    const res = await request(app)
      .put(`/api/users/${targetUserId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ role: 'viewer' });
    expect(res.status).toBeLessThan(300);
    const after = await prisma.user.findUnique({ where: { id: targetUserId }, select: { tokenEpoch: true, role: true } });
    expect(after.role).toBe('viewer');
    expect(after.tokenEpoch).toBe((before.tokenEpoch || 0) + 1);
  });
});

describe('A3: ingest worker liveness', () => {
  test('getIngestWorkerStatus returns a heartbeat shape', () => {
    const { getIngestWorkerStatus } = require('../../lib/ingestWorker');
    const w = getIngestWorkerStatus();
    expect(w).toHaveProperty('started');
    expect(w).toHaveProperty('ageMs');
    expect(w).toHaveProperty('pollMs');
  });
});

export {};
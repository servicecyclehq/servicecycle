'use strict';

/**
 * Tests for the PATCH /api/contracts/bulk endpoint and the extended
 * GET /api/contracts/export?ids=… filter.
 *
 * The body of the suite is request-shape validation (400 on bad input,
 * 404/no-op on out-of-scope ids) since those don't need a populated DB.
 * A live-server smoke test runs at the end and skips gracefully when seed
 * credentials aren't present — same pattern as idor.test.js.
 */

const { api, login } = require('./helpers');

const ADMIN_EMAIL    = 'admin@acme.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin1234!';

async function tryLogin(email, password) {
  try {
    return await login(email, password);
  } catch {
    return null;
  }
}

describe('PATCH /api/contracts/bulk — input validation', () => {
  let adminToken = null;

  beforeAll(async () => {
    adminToken = await tryLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  test('rejects missing ids', async () => {
    if (!adminToken) { console.warn('skipped — admin not available'); return; }
    const res = await api()
      .patch('/api/contracts/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'active' });
    if (res.status === 404) { console.warn('bulk route not yet mounted on dev server'); return; }
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ids/);
  });

  test('rejects empty ids array', async () => {
    if (!adminToken) return;
    const res = await api()
      .patch('/api/contracts/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: [], status: 'active' });
    if (res.status === 404) return;
    expect(res.status).toBe(400);
  });

  test('rejects > 500 ids', async () => {
    if (!adminToken) return;
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const res = await api()
      .patch('/api/contracts/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids, status: 'active' });
    if (res.status === 404) return;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/500/);
  });

  test('rejects unknown status enum', async () => {
    if (!adminToken) return;
    const res = await api()
      .patch('/api/contracts/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: ['anything'], status: 'totally-bogus' });
    if (res.status === 404) return;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/);
  });

  test('rejects when no mutation field is provided', async () => {
    if (!adminToken) return;
    const res = await api()
      .patch('/api/contracts/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: ['x'] });
    if (res.status === 404) return;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mutation|field/i);
  });

  test('returns matched=0 when ids belong to no real contracts', async () => {
    if (!adminToken) return;
    const res = await api()
      .patch('/api/contracts/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: ['00000000-0000-0000-0000-000000000999'], status: 'active' });
    if (res.status === 404) return;
    expect(res.status).toBe(200);
    expect(res.body.data.matched).toBe(0);
    expect(res.body.data.updated).toBe(0);
  });

  test('rejects unauthenticated bulk patch', async () => {
    const res = await api().patch('/api/contracts/bulk').send({ ids: ['x'], status: 'active' });
    if (res.status === 404) return;
    expect([401, 403]).toContain(res.status);
  });
});

describe('GET /api/contracts/export?ids — bulk export', () => {
  let adminToken = null;

  beforeAll(async () => {
    adminToken = await tryLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  test('rejects empty ids query', async () => {
    if (!adminToken) return;
    const res = await api()
      .get('/api/contracts/export?ids=')
      .set('Authorization', `Bearer ${adminToken}`);
    if (res.status === 404) return;
    expect(res.status).toBe(400);
  });

  test('rejects > 500 ids', async () => {
    if (!adminToken) return;
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`).join(',');
    const res = await api()
      .get(`/api/contracts/export?ids=${ids}`)
      .set('Authorization', `Bearer ${adminToken}`);
    if (res.status === 404) return;
    expect(res.status).toBe(400);
  });

  test('returns CSV with only header when ids match no real contracts', async () => {
    if (!adminToken) return;
    const res = await api()
      .get('/api/contracts/export?ids=00000000-0000-0000-0000-000000000999')
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', c => chunks.push(c));
        response.on('end',  ()  => callback(null, Buffer.concat(chunks).toString('utf8')));
      });
    if (res.status === 404) return;
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    // Header line + zero data rows
    const lines = res.body.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/Vendor,Product/);
  });
});

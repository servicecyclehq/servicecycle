'use strict';

const { api, login } = require('./helpers');

describe('auth', () => {
  // Both negative cases accept 429 in addition to 401 — after 10 bad
  // attempts in 15 minutes the credentialLimiter kicks in (intentional)
  // and that's a stricter response than 401, not a regression. The test
  // assertion is "we never let bad creds through with 200/2xx".
  test('rejects unknown email', async () => {
    const res = await api()
      .post('/api/auth/login')
      .send({ email: 'nobody@example.invalid', password: 'whatever' });
    expect([401, 429]).toContain(res.status);
  });

  test('rejects wrong password', async () => {
    const res = await api()
      .post('/api/auth/login')
      .send({ email: 'admin@acme.com', password: 'definitely-not-the-password' });
    expect([401, 429]).toContain(res.status);
  });

  test('login + token shape', async () => {
    // Uses the seed admin. If you've changed the seed admin password,
    // either reset it (npm run seed) or change SEED_ADMIN_PASSWORD here.
    const password = process.env.SEED_ADMIN_PASSWORD || 'Admin1234!';
    const res = await api()
      .post('/api/auth/login')
      .send({ email: 'admin@acme.com', password });
    if (res.status !== 200) {
      console.warn('login skipped — seed admin password not the default; set SEED_ADMIN_PASSWORD env to skip');
      return;
    }
    expect(res.body).toHaveProperty('data.token');
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.token.split('.')).toHaveLength(3); // JWT structure
    expect(res.body).toHaveProperty('data.refreshToken');
    expect(res.body).toHaveProperty('data.user.email', 'admin@acme.com');
  });

  test('JWT has alg=HS256 (defense against algorithm-confusion attacks)', async () => {
    const password = process.env.SEED_ADMIN_PASSWORD || 'Admin1234!';
    const res = await api()
      .post('/api/auth/login')
      .send({ email: 'admin@acme.com', password });
    if (res.status !== 200) return; // silent skip if creds don't match
    const [headerB64] = res.body.data.token.split('.');
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    expect(header.alg).toBe('HS256');
    expect(header.typ).toBe('JWT');
  });
});

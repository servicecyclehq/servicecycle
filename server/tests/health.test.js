'use strict';

const { api } = require('./helpers');

describe('GET /api/health', () => {
  test('returns 200 with the expected payload shape', async () => {
    const res = await api().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data.status', 'ok');
    expect(res.body).toHaveProperty('data.version');
    expect(typeof res.body.data.uptime).toBe('number');
    expect(res.body.data.uptime).toBeGreaterThanOrEqual(0);
  });

  test('does not leak MASTER_KEY or any other env secret', async () => {
    const res = await api().get('/api/health');
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/MASTER_KEY/i);
    expect(text).not.toMatch(/JWT_SECRET/i);
    expect(text).not.toMatch(/SECRET_KEY/i);
  });
});

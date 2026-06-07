/* Rule 8: webhook creation/modification/test is blocked in DEMO_MODE. */
'use strict';

const { demoWriteGuard } = require('../middleware/demoGuard');

function mk(method, baseUrl, path, body) {
  const req = { method, baseUrl, path, body: body || {}, get: () => undefined };
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const next = jest.fn();
  return { req, res, next };
}

describe('demoGuard — webhook lockdown (Rule 8)', () => {
  const prev = process.env.DEMO_MODE;
  beforeAll(() => { process.env.DEMO_MODE = 'true'; });
  afterAll(() => { process.env.DEMO_MODE = prev; });

  test('blocks POST /api/webhooks in demo', () => {
    const { req, res, next } = mk('POST', '/api/webhooks', '/');
    demoWriteGuard(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.reason).toBe('webhooks_disabled_in_demo');
  });

  test('blocks POST /api/webhooks/:id/test in demo', () => {
    const { req, res, next } = mk('POST', '/api/webhooks', '/abc/test');
    demoWriteGuard(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('blocks PATCH /api/webhooks/:id in demo', () => {
    const { req, res, next } = mk('PATCH', '/api/webhooks', '/abc');
    demoWriteGuard(req, res, next);
    expect(res.statusCode).toBe(403);
  });

  test('ALLOWS GET /api/webhooks in demo (still explorable)', () => {
    const { req, res, next } = mk('GET', '/api/webhooks', '/');
    demoWriteGuard(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  test('no-op when not in demo mode', () => {
    process.env.DEMO_MODE = 'false';
    const { req, res, next } = mk('POST', '/api/webhooks', '/');
    demoWriteGuard(req, res, next);
    expect(next).toHaveBeenCalled();
    process.env.DEMO_MODE = 'true';
  });
});

'use strict';

/**
 * L5: demoGuard now allows PUT /api/users/me/password but still blocks
 * admin-resets-others (PUT /api/users/:id/reset-password) and the rest of
 * the demo-write rules. Pure unit; no DB, no live server.
 */

const { demoWriteGuard } = require('../middleware/demoGuard');

const ORIG_DEMO = process.env.DEMO_MODE;
beforeAll(() => { process.env.DEMO_MODE = 'true'; });
afterAll(()  => { process.env.DEMO_MODE = ORIG_DEMO; });

function fakeReq({ method, baseUrl = '', path = '', body = {} }) {
  return { method, baseUrl, path, body };
}

function fakeRes() {
  const calls = { status: null, body: null };
  const res = {
    status(code) { calls.status = code; return res; },
    json(obj)    { calls.body   = obj;  return res; },
  };
  return { res, calls };
}

function nextSpy() {
  const c = { called: false };
  const fn = () => { c.called = true; };
  return { fn, c };
}

describe('L5: demoGuard — PUT /api/users/me/password is now allowed in demo', () => {

  test('PUT /api/users/me/password passes through (was blocked pre-L5)', () => {
    const { fn: next, c: spy } = nextSpy();
    const { res, calls } = fakeRes();
    demoWriteGuard(fakeReq({ method: 'PUT', baseUrl: '/api/users', path: '/me/password' }), res, next);
    expect(spy.called).toBe(true);
    expect(calls.status).toBeNull();
  });

  test('PUT /api/users/:id/reset-password STILL blocked in demo', () => {
    const { fn: next, c: spy } = nextSpy();
    const { res, calls } = fakeRes();
    demoWriteGuard(
      fakeReq({ method: 'PUT', baseUrl: '/api/users', path: '/abc-123/reset-password' }),
      res,
      next,
    );
    expect(spy.called).toBe(false);
    expect(calls.status).toBe(403);
    expect(calls.body.reason).toBe('password_reset_disabled');
  });

  test('DELETE on any URL still blocked', () => {
    const { fn: next, c: spy } = nextSpy();
    const { res, calls } = fakeRes();
    demoWriteGuard(fakeReq({ method: 'DELETE', baseUrl: '/api/contracts', path: '/123' }), res, next);
    expect(spy.called).toBe(false);
    expect(calls.status).toBe(403);
    expect(calls.body.reason).toBe('delete_disabled');
  });

  test('outside DEMO_MODE both /me/password and /:id/reset-password pass', () => {
    process.env.DEMO_MODE = 'false';
    try {
      for (const fp of [
        { baseUrl: '/api/users', path: '/me/password' },
        { baseUrl: '/api/users', path: '/abc-123/reset-password' },
      ]) {
        const { fn: next, c: spy } = nextSpy();
        const { res, calls } = fakeRes();
        demoWriteGuard(fakeReq({ method: 'PUT', ...fp }), res, next);
        expect(spy.called).toBe(true);
        expect(calls.status).toBeNull();
      }
    } finally {
      process.env.DEMO_MODE = 'true';
    }
  });

  test('budget save is now ALLOWED in demo (rule 7 removed)', () => {
    const { fn: next, c: spy } = nextSpy();
    const { res, calls } = fakeRes();
    demoWriteGuard(
      fakeReq({ method: 'PUT', baseUrl: '/api/budget', path: '/vendor-uplift/v-1' }),
      res,
      next,
    );
    expect(spy.called).toBe(true);
  });
});

/**
 * Cluster D ops hygiene â€” rate-limit helpers (pure, dependency-injected).
 *  - rateLimitHandler sets Retry-After and preserves the JSON message
 *  - buildRateLimitKey keys per-user on a verified JWT, else by IP
 */
const { rateLimitHandler, buildRateLimitKey } = require('../../lib/rateLimitHelpers');

function mockRes() {
  return {
    headers: {} as any, statusCode: 0, body: null as any,
    set(k: string, v: string) { this.headers[k] = v; return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
  };
}

describe('D2 rateLimitHandler', () => {
  test('sets Retry-After and returns the configured 429 message', () => {
    const res = mockRes();
    const req: any = { rateLimit: { resetTime: new Date(Date.now() + 30_000) } };
    const msg = { success: false, error: 'slow down' };
    rateLimitHandler(req, res, () => {}, { windowMs: 60_000, statusCode: 429, message: msg });
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual(msg);
    const ra = parseInt(res.headers['Retry-After'], 10);
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThanOrEqual(31);
  });

  test('falls back to windowMs when no resetTime present', () => {
    const res = mockRes();
    rateLimitHandler({}, res, () => {}, { windowMs: 60_000 });
    expect(Number(res.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
  });
});

describe('D3 buildRateLimitKey', () => {
  const clientIpKey = (_req: any) => 'ip:1.2.3.4';
  test('keys per-user on a valid token', () => {
    const verifyToken = () => ({ userId: 'u-123' });
    const req: any = { headers: { authorization: 'Bearer aaaaaaaaaaaaaaaa' } };
    expect(buildRateLimitKey(req, { verifyToken, clientIpKey })).toBe('user:u-123');
  });
  test('falls back to IP key when the token is invalid', () => {
    const verifyToken = () => { throw new Error('bad token'); };
    const req: any = { headers: { authorization: 'Bearer aaaaaaaaaaaaaaaa' } };
    expect(buildRateLimitKey(req, { verifyToken, clientIpKey })).toBe('ip:1.2.3.4');
  });
  test('falls back to IP key when there is no auth header', () => {
    const verifyToken = () => ({ userId: 'nope' });
    expect(buildRateLimitKey({ headers: {} }, { verifyToken, clientIpKey })).toBe('ip:1.2.3.4');
  });
});

export {};
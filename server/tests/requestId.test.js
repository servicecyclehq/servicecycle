'use strict';

/**
 * tests/requestId.test.js
 * ------------------------
 * v0.37.4 regression suite for middleware/requestId. Locks in:
 *   - mint a fresh UUID v4 when no inbound header is present
 *   - honor a safe inbound X-Request-Id
 *   - reject inbound values with CR/LF (log-injection guard)
 *   - reject inbound values that exceed the length cap
 *   - emit X-Request-Id on the response
 *   - attach req.requestId for downstream use
 */

const { requestId } = require('../middleware/requestId');

// Minimal req/res mocks. We don't pull express here — middleware contract is
// (req, res, next) and req.get(name) + res.setHeader(name, val), nothing else.
function mockReq(headers = {}) {
  return {
    get(name) {
      // Mirror express's case-insensitive header lookup.
      const lower = String(name).toLowerCase();
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === lower) return headers[k];
      }
      return undefined;
    },
  };
}
function mockRes() {
  const headersSet = {};
  return {
    setHeader(name, val) { headersSet[name] = val; },
    _headers: headersSet,
  };
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('requestId middleware', () => {
  test('mints a UUID v4 when no inbound header is present', () => {
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    requestId(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.requestId).toMatch(UUID_V4_RE);
    expect(res._headers['X-Request-Id']).toBe(req.requestId);
  });

  test('honors a safe inbound X-Request-Id', () => {
    const req = mockReq({ 'X-Request-Id': 'k8s-ingress-abc-123' });
    const res = mockRes();
    requestId(req, res, () => {});
    expect(req.requestId).toBe('k8s-ingress-abc-123');
    expect(res._headers['X-Request-Id']).toBe('k8s-ingress-abc-123');
  });

  test('case-insensitive inbound lookup (HTTP header convention)', () => {
    const req = mockReq({ 'x-request-id': 'lowercase-incoming' });
    const res = mockRes();
    requestId(req, res, () => {});
    expect(req.requestId).toBe('lowercase-incoming');
  });

  test('rejects inbound values with CR (log-injection guard)', () => {
    const req = mockReq({ 'X-Request-Id': 'aaa\r\nFAKE-LOG-LINE' });
    const res = mockRes();
    requestId(req, res, () => {});
    expect(req.requestId).toMatch(UUID_V4_RE); // fell back to a fresh UUID
    expect(req.requestId).not.toMatch(/\r|\n/);
  });

  test('rejects inbound values that exceed the 128-char cap', () => {
    const long = 'a'.repeat(200);
    const req = mockReq({ 'X-Request-Id': long });
    const res = mockRes();
    requestId(req, res, () => {});
    expect(req.requestId).toMatch(UUID_V4_RE);
    expect(req.requestId).not.toBe(long);
  });

  test('rejects inbound values with disallowed characters', () => {
    const req = mockReq({ 'X-Request-Id': 'has spaces and slashes/here' });
    const res = mockRes();
    requestId(req, res, () => {});
    expect(req.requestId).toMatch(UUID_V4_RE);
  });

  test('accepts the standard safe charset (alphanumeric + dash + underscore)', () => {
    const req = mockReq({ 'X-Request-Id': 'abcDEF-123_456' });
    const res = mockRes();
    requestId(req, res, () => {});
    expect(req.requestId).toBe('abcDEF-123_456');
  });

  test('non-string inbound header is ignored', () => {
    const req = mockReq();
    // Force req.get to return a non-string
    req.get = () => 42;
    const res = mockRes();
    requestId(req, res, () => {});
    expect(req.requestId).toMatch(UUID_V4_RE);
  });
});

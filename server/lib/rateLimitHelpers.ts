'use strict';

/**
 * lib/rateLimitHelpers.ts
 *
 * Small, dependency-injected helpers for the express-rate-limit limiters in
 * index.ts, factored out so they can be unit-tested without standing up the
 * limiter or tripping its shared in-memory store.
 */

// (D2) Emit a Retry-After header on every 429. express-rate-limit v8 with
// standardHeaders puts reset info in the RateLimit header but does not set
// Retry-After unless legacy headers are enabled; many HTTP clients honor
// Retry-After, so we set it explicitly while preserving the JSON message body.
function rateLimitHandler(req, res, _next, options) {
  const resetMs = (req.rateLimit && req.rateLimit.resetTime)
    ? req.rateLimit.resetTime.getTime()
    : (Date.now() + ((options && options.windowMs) || 60000));
  const secs = Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));
  res.set('Retry-After', String(secs));
  res.status((options && options.statusCode) || 429)
     .json((options && options.message) || { success: false, error: 'Too many requests' });
}

// (D3) Per-user key for authenticated traffic. Verifies the JWT (not forgeable)
// and keys by userId so tenants behind one shared NAT do not share a bucket;
// anonymous traffic falls back to the normalized-IP key. Dependencies are
// injected so this stays pure/testable.
function buildRateLimitKey(req, deps) {
  const verifyToken = deps && deps.verifyToken;
  const clientIpKey = deps && deps.clientIpKey;
  const auth = req && req.headers && req.headers['authorization'];
  if (verifyToken && auth && typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 10) {
    try {
      const decoded = verifyToken(auth.slice(7).trim());
      if (decoded && decoded.userId) return `user:${decoded.userId}`;
    } catch (_) { /* forged/expired/malformed - fall through to IP key */ }
  }
  return clientIpKey(req);
}

module.exports = { rateLimitHandler, buildRateLimitKey };

export {};
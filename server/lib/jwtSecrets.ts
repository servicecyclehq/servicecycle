'use strict';

/**
 * server/lib/jwtSecrets.js
 * -----------------------
 *
 * Dual-secret JWT verification for rotation windows. Shipped in v0.37.0
 * (Pass-6 W4 MT-141) so JWT_SECRET can be rotated without invalidating
 * every active session at once.
 *
 * Strategy: signing always uses JWT_SECRET (the current value). Verifying
 * tries JWT_SECRET first; if that fails AND OLD_JWT_SECRET is set,
 * verifying tries OLD_JWT_SECRET. The dual-verify window lasts until the
 * operator removes OLD_JWT_SECRET from .env — typically 30 days, the
 * refresh-token TTL, so every active session has rotated forward by the
 * time the old secret is decommissioned.
 *
 * The dual-verify path is on by default whenever OLD_JWT_SECRET is
 * present. There is no feature flag — accepting both during rotation is
 * the intended behavior. The startup validator in server/index.js enforces
 * that OLD_JWT_SECRET must meet the same strength requirements as
 * JWT_SECRET if set.
 *
 * Why no flag for the OLD_* check at sign time: re-signing tokens with
 * the new secret during a refresh exchange is the natural transition,
 * so users hitting /api/auth/refresh will get re-signed access tokens
 * under the new key automatically. Long-running access tokens (1h TTL)
 * are the only thing that holds the old key; they expire on their own
 * and get re-issued via refresh under the new key.
 *
 * Refresh tokens themselves are NOT JWTs — they're random opaque strings
 * stored hashed in Postgres (server/routes/auth.js hashToken + the
 * prisma.refreshToken table). They are unaffected by JWT_SECRET rotation
 * and don't need a separate rotation procedure.
 */

const jwt = require('jsonwebtoken');

const DEFAULT_OPTIONS = { algorithms: ['HS256'] };

/**
 * Verify a JWT against JWT_SECRET, falling back to OLD_JWT_SECRET if set.
 *
 * Throws the LATEST verify error if all configured secrets fail. The error
 * surface (TokenExpiredError, JsonWebTokenError) is preserved so callers
 * can distinguish expired vs invalid the same way they do today.
 *
 * @param {string} token   The JWT to verify
 * @param {object} options jsonwebtoken verify options (algorithms etc.).
 *                         Defaults to { algorithms: ['HS256'] }.
 * @returns decoded JWT payload
 */
function verifyToken(token, options = DEFAULT_OPTIONS) {
  const current = process.env.JWT_SECRET;
  const previous = process.env.OLD_JWT_SECRET;

  if (!current) {
    // Match the historical surface — if JWT_SECRET isn't set we treat
    // this as a configuration error, not a token error. Callers wrap
    // verifyToken in try/catch; throwing here lands in their catch arm.
    throw new Error('JWT_SECRET is not set');
  }

  let lastErr;
  try {
    return jwt.verify(token, current, options);
  } catch (err) {
    lastErr = err;
    // Don't fall through for TokenExpiredError — the token's expiry is
    // independent of which secret signed it. Falling through here would
    // produce confusing "Invalid token" instead of "Token expired" when
    // an old expired token is presented during a rotation window.
    if (err.name === 'TokenExpiredError') throw err;
  }

  if (previous) {
    try {
      return jwt.verify(token, previous, options);
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr;
}

/**
 * Sign a JWT using the current JWT_SECRET. Wraps jwt.sign so callers
 * don't reach into process.env directly (makes future changes — KMS,
 * key rotation versions, etc. — a single touch point).
 *
 * @param {object} payload  JWT claims
 * @param {object} options  jsonwebtoken sign options (expiresIn etc.)
 * @returns signed JWT string
 */
function signToken(payload, options) {
  const current = process.env.JWT_SECRET;
  if (!current) throw new Error('JWT_SECRET is not set');
  return jwt.sign(payload, current, options);
}

/**
 * Returns true if a rotation window is currently active (i.e. OLD_JWT_SECRET
 * is set and dual-verify is in play). Useful for /api/admin/rotation-status
 * endpoints or for operators sanity-checking their .env.
 */
function isRotationWindowActive() {
  return Boolean(process.env.OLD_JWT_SECRET && process.env.OLD_JWT_SECRET.length >= 32);
}

module.exports = { verifyToken, signToken, isRotationWindowActive };

export {};

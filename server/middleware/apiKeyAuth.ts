/**
 * API Key authentication middleware for the public REST API (/api/v1/*).
 *
 * Reads:  Authorization: Bearer <plaintext-key>
 * Hashes: SHA-256 (hex) — matches keyHash stored in the api_keys table.
 * Checks: not revoked, not expired.
 * Sets:   req.apiKeyAccountId, req.apiKey (metadata only, no hash)
 *
 * Rate limit: 60 req/min per API key, keyed by keyHash prefix so the limiter
 * never stores or compares the plaintext key. Separate from the user-session
 * apiLimiter so API traffic doesn't eat human-user budgets.
 *
 * Audit log: every authenticated v1 request is written to activityLog
 * (action='api_v1_call') via a fire-and-forget res.on('finish') hook.
 * Supports SOC 2 CC6.8 (logical access monitoring). 401/429 responses
 * are NOT logged — only requests that reach a route handler are captured.
 *
 * On success: calls next().
 * On failure: returns 401/429 JSON with { success: false, error: '...' }.
 */

const crypto   = require('crypto');
const { rateLimit } = require('express-rate-limit');
import prisma from '../lib/prisma';

// ── Per-key rate limiter ──────────────────────────────────────────────────────
// 60 req/min is deliberately lower than the 200/min authenticated-user budget.
// Machine integrations are batch-style — bursting above 60/min almost always
// signals a runaway loop, not a legitimate use case.
//
// Key: first 16 hex chars of the SHA-256 hash. This is enough to uniquely
// separate keys in practice (2^64 collision space) without keeping even a
// partial plaintext in the limiter's memory.
const apiKeyLimiter = rateLimit({
  windowMs:       60 * 1000,   // 1 minute
  max:            60,
  standardHeaders: true,
  legacyHeaders:   false,
  // keyGenerator runs AFTER the hash is attached to req by authenticateApiKey.
  // We key on hashPrefix so the limiter namespace is separate from the JWT
  // limiter (which keys on `ip:`). A compromised key can't burn another
  // key's budget.
  keyGenerator: (req) => `apikey:${req._apiKeyHashPrefix || 'unknown'}`,
  message: { success: false, error: 'Rate limit exceeded — max 60 requests per minute per API key.' },
  skip: (req) => !req._apiKeyHashPrefix, // skip if auth failed (limiter runs after auth)
});

/**
 * Hash a plaintext API key with SHA-256 → hex string.
 * Pure function — used here and in the key-generation route.
 */
function hashApiKey(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Main auth middleware. Verifies the Bearer API key, attaches context to req.
 * Does NOT apply rate limiting — call apiKeyLimiter separately (after this).
 */
async function authenticateApiKey(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'API key required. Pass your key as: Authorization: Bearer <key>',
    });
  }

  const keyHash = hashApiKey(token);
  // Stash a prefix for the rate-limiter key generator (runs next in the chain).
  req._apiKeyHashPrefix = keyHash.slice(0, 16);

  let apiKey;
  try {
    apiKey = await prisma.apiKey.findUnique({
      where:  { keyHash },
      select: { id: true, accountId: true, name: true, scopes: true, revokedAt: true, expiresAt: true, lastUsedAt: true },
    });
  } catch (err) {
    console.error('[apiKeyAuth] DB error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }

  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }

  if (apiKey.revokedAt) {
    return res.status(401).json({ success: false, error: 'API key has been revoked' });
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return res.status(401).json({ success: false, error: 'API key has expired' });
  }

  // Attach context for downstream route handlers.
  req.apiKeyAccountId = apiKey.accountId;
  req.apiKeyScopes    = Array.isArray(apiKey.scopes) && apiKey.scopes.length ? apiKey.scopes : ['read'];
  req.apiKey          = { id: apiKey.id, name: apiKey.name, scopes: req.apiKeyScopes };

  // Fire-and-forget lastUsedAt update. Debounce to at most once per minute
  // per key — the rate limiter already ensures max 60 req/min so one DB write
  // per minute per key is the realistic worst case.
  _touchLastUsed(apiKey.id, apiKey.lastUsedAt);

  // ── Audit log hook (SOC 2 CC6.8) ─────────────────────────────────────────
  // Record after the route handler has finished (status + latency are known).
  const _startMs = Date.now();
  const _keySnap = { id: apiKey.id, name: apiKey.name };
  const _accountId = apiKey.accountId;
  res.on('finish', () => {
    _logApiCall(req, res, _keySnap, _accountId, _startMs);
  });

  next();
}

// ── lastUsedAt debounce ───────────────────────────────────────────────────────
// In-memory map: keyId → epochMs of last write. Per-process; fine for
// single-replica deployments. Multi-replica would write more often (still
// bounded by 1/min), which is acceptable.
// L1: cap at 5,000 entries; evict oldest on overflow (insertion-order LRU).
const _lastUsedCache = new Map();
const LAST_USED_DEBOUNCE_MS = 60 * 1000; // 1 minute
const LAST_USED_CACHE_MAX   = 5000;

function _touchLastUsed(keyId, currentLastUsedAt) {
  const now  = Date.now();
  const last = _lastUsedCache.get(keyId) || 0;
  if (now - last < LAST_USED_DEBOUNCE_MS) return;
  // L1: evict oldest entry if at cap
  if (!_lastUsedCache.has(keyId) && _lastUsedCache.size >= LAST_USED_CACHE_MAX) {
    _lastUsedCache.delete(_lastUsedCache.keys().next().value);
  }
  _lastUsedCache.set(keyId, now);
  prisma.apiKey.update({
    where: { id: keyId },
    data:  { lastUsedAt: new Date() },
  }).catch((e) => {
    _lastUsedCache.delete(keyId); // allow retry on next request
    console.error('[apiKeyAuth] lastUsedAt update failed:', e.message);
  });
}

// ── API call audit logger ─────────────────────────────────────────────────────
// Fire-and-forget — errors are swallowed so a logging failure never surfaces
// to the caller. Capped path to 200 chars to avoid bloating the JSON column.
function _logApiCall(req, res, key: { id: string; name: string }, accountId: string, startMs: number) {
  const latencyMs = Date.now() - startMs;
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  const path = (req.originalUrl || req.url || '').slice(0, 200);
  prisma.activityLog.create({
    data: {
      accountId,
      action: 'api_v1_call',
      details: {
        method:    req.method,
        path,
        status:    res.statusCode,
        latencyMs,
        keyId:     key.id,
        keyName:   key.name,
        ip,
      },
    },
  }).catch((e) => {
    console.error('[apiKeyAuth] audit log write failed:', e.message);
  });
}

/**
 * Scope guard for the public API. Use AFTER authenticateApiKey. A key must
 * carry the named scope or the request is rejected 403. Read endpoints don't
 * need this (any valid key may read); write endpoints require requireScope('write').
 */
function requireScope(scope) {
  return function (req, res, next) {
    const scopes = req.apiKeyScopes || [];
    if (!scopes.includes(scope)) {
      return res.status(403).json({
        success: false,
        error: `This API key lacks the '${scope}' scope. Mint a key with write access to use this endpoint.`,
      });
    }
    next();
  };
}

module.exports = { authenticateApiKey, apiKeyLimiter, hashApiKey, requireScope };

export {};

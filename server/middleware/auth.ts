const { verifyToken } = require('../lib/jwtSecrets');
import prisma from '../lib/prisma';

// L3: in-memory debounce cache for Account.lastActiveAt updates.
// We don't want to do a write on every single authenticated request — that's
// 1 write per page load per user, which is wasteful even on the demo box.
// Debounce window is 1 hour per account; the prune cron (5-day TTL) doesn't
// care about minute-level resolution, so 1h is plenty.
//
// Map is per-process. A multi-replica deployment would write more often
// (still bounded), which is fine — the only cost is extra Postgres traffic
// and we don't run multi-replica on the demo.
const TOUCH_DEBOUNCE_MS   = 60 * 60 * 1000; // 1 hour
const TOUCH_CACHE_MAX     = 5000;             // L1: LRU cap
const accountTouchCache = new Map(); // accountId → epochMs of last write

// v0.33.0 (Pass-5 F-DEMO-02): only WRITE methods count as "meaningful
// activity" for the 5-day TTL prune. A scripted attacker cron-polling
// /api/auth/me once every 23 hours used to keep accounts alive forever
// — `touchAccountActivity` fired on any authenticated request, even
// bare GETs. The TTL cron then never found anything to prune, and once
// 1000 accounts were taken the demo signup funnel sat at "demo at
// capacity" indefinitely. Now: only state-mutating verbs reset the
// liveness clock. A user actively using the app fires plenty of these
// during normal use (creating contracts, generating briefs, marking
// renewals); a scripted keep-alive ping does not.
const TOUCH_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function touchAccountActivity(accountId) {
  // Only meaningful in DEMO_MODE — on self-hosted lastActiveAt is never read,
  // so writing it is wasted IO.
  if (process.env.DEMO_MODE !== 'true' || !accountId) return;
  const now  = Date.now();
  const last = accountTouchCache.get(accountId) || 0;
  if (now - last < TOUCH_DEBOUNCE_MS) return;
  // L1: evict oldest entry if at cap before inserting a new one
  if (!accountTouchCache.has(accountId) && accountTouchCache.size >= TOUCH_CACHE_MAX) {
    accountTouchCache.delete(accountTouchCache.keys().next().value);
  }
  // Mark BEFORE the write so two concurrent requests don't both fire.
  accountTouchCache.set(accountId, now);
  prisma.account.update({
    where: { id: accountId },
    data:  { lastActiveAt: new Date() },
  }).catch((e) => {
    // Roll back the cache stamp so we'll retry on the next request — better
    // to occasionally double-write than to silently let lastActiveAt drift.
    accountTouchCache.delete(accountId);
    console.error('[auth] Account.lastActiveAt update failed:', e.message);
  });
}

/**
 * Verifies the Bearer JWT in the Authorization header.
 * On success, attaches req.user = { id, accountId, name, email, role }.
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

  if (!token) {
    return res.status(401).json({ success: false, error: 'Access token required' });
  }

  try {
    // Pin the algorithm explicitly. Without `algorithms`, jsonwebtoken v9
    // accepts every algorithm in its default list, which leaves the door
    // open to algorithm-confusion attacks (the classic case is verifying
    // an RS256-signed token using the public key as an HS256 secret). Our
    // JWT_SECRET is a random string not an RSA pair, so this is defensive,
    // but pinning is the right hygiene.
    // verifyToken handles dual-secret rotation windows (v0.37.0 MT-141)
    const decoded = verifyToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        accountId: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        contractScopeRestricted: true,
      },
    });

    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, error: 'Account deactivated — contact your administrator' });
    }

    req.user = user;
    // L3: debounced demo-account activity stamp. Fire-and-forget.
    // v0.33.0 (Pass-5 F-DEMO-02): gated on write methods only. A bare
    // GET — including the /api/auth/me poll the SPA fires on focus —
    // does NOT count as activity. Without this gate a scripted hourly
    // /me ping kept every demo account alive past the 5-day TTL and
    // wedged the signup funnel at capacity.
    if (TOUCH_METHODS.has(req.method)) {
      touchAccountActivity(user.accountId);
    }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token expired' });
    }
    return res.status(403).json({ success: false, error: 'Invalid token' });
  }
}

// v0.90.0: soft-auth variant. Populates req.user when a valid bearer is
// present, sets req.user = null when not. Never rejects. Use ONLY on
// endpoints that genuinely make sense for anonymous traffic AND want
// enrichment when auth happens to be available -- e.g. /api/errors/render
// (boundary crashes can happen before AuthContext resolves).
async function optionalAuthenticateToken(req, _res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) { req.user = null; return next(); }
  try {
    const decoded = verifyToken(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, accountId: true, role: true, isActive: true },
    });
    req.user = (user && user.isActive) ? user : null;
  } catch (_e) {
    req.user = null;
  }
  next();
}

module.exports = { authenticateToken, optionalAuthenticateToken };

export {};

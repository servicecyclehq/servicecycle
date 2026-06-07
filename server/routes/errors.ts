// ─────────────────────────────────────────────────────────────────────────────
// server/routes/errors.js  (v0.90.8)
//
// Runtime-error telemetry endpoint. Originally just for React render crashes
// from ErrorBoundary; v0.90.8 generalized to also accept window.onerror
// (kind='uncaught'), unhandled promise rejections (kind='promise'), and
// server-side Express middleware errors (kind='server', via direct prisma
// call from the error handler -- doesn't hit this route).
//
// Auth is best-effort: the crash may have happened BEFORE auth resolved
// (e.g. unhandled rejection during AuthContext bootstrap). We accept the
// POST anonymously and use req.user only as enrichment.
//
// Rate-limited to prevent a crash-loop from a single tab DoSing the
// endpoint. Returns 204 unconditionally so the client never blocks or
// surfaces a follow-on error if the persistence itself fails.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
import prisma from '../lib/prisma';

const router = express.Router();

// In-memory rate limiter. 30 events per IP per minute is generous for a
// genuine crash-loop (a buggy useEffect can fire many crashes per second);
// past 30 we silently drop further events until the window slides.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX       = 30;
const ipWindows = new Map(); // ip -> array of timestamps within window

function ipKey(req) {
  return (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
}

function isRateLimited(ip) {
  const now = Date.now();
  const arr = (ipWindows.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX) {
    ipWindows.set(ip, arr);
    return true;
  }
  arr.push(now);
  ipWindows.set(ip, arr);
  return false;
}

// Periodic cleanup so the ipWindows Map doesn't grow unbounded on long-
// running processes. Runs every 5 minutes; drops entries whose newest
// timestamp is outside the current window.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of ipWindows) {
    if (!arr.length || (now - arr[arr.length - 1]) > RATE_LIMIT_WINDOW_MS) {
      ipWindows.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

function trunc(v, max) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

// Kinds we'll accept from client-side telemetry. 'server' is reserved for
// the Express error middleware path (direct prisma insert, not POST).
const CLIENT_KINDS = new Set(['render', 'uncaught', 'promise']);

// ── POST /api/errors/render ──────────────────────────────────────────────────
//
// Body shape (all optional except errorCode):
//   errorCode      string  — base36 timestamp from caller
//   kind           string  — 'render' | 'uncaught' | 'promise' (defaults 'render')
//   name           string  — e.g. 'TypeError'
//   message        string  — truncated to 1000 chars
//   stack          string  — truncated to 4000 chars
//   componentStack string  — React fiber stack (render-only)
//   path           string  — location.pathname at crash time
//   appVersion     string  — from the client build-id meta tag
//
// Auth: optional. If a valid bearer token is present, req.user is populated
// upstream by middleware/auth.js and we pull userId/accountId from it.
router.post('/render', async (req, res) => {
  // Always 204 — never block the client, never surface a follow-on error.
  // Persistence failures get logged server-side for ops, not returned.
  res.status(204).end();

  try {
    const ip = ipKey(req);
    if (isRateLimited(ip)) return;

    const body = req.body || {};
    if (!body.errorCode || typeof body.errorCode !== 'string') return;

    // v0.90.8: accept kind=render|uncaught|promise. Anything else (or
    // missing) falls back to 'render' so older bundles posting without the
    // field continue to work unchanged. 'server' is not accepted from
    // client telemetry -- only the Express error handler can mark a row
    // as kind='server' (via direct prisma insert in server/index.js).
    const requestedKind = typeof body.kind === 'string' ? body.kind : 'render';
    const kind = CLIENT_KINDS.has(requestedKind) ? requestedKind : 'render';

    await prisma.renderError.create({
      data: {
        kind:           kind,
        errorCode:      trunc(body.errorCode, 32),
        name:           trunc(body.name, 100),
        message:        trunc(body.message, 1000),
        stack:          trunc(body.stack, 4000),
        componentStack: trunc(body.componentStack, 4000),
        path:           trunc(body.path, 500),
        userId:         req.user && req.user.id        ? req.user.id        : null,
        accountId:      req.user && req.user.accountId ? req.user.accountId : null,
        userAgent:      trunc(req.headers['user-agent'], 500),
        // v0.90.0: prefer server-side env over client-claimed version --
        // the server knows the deploy version with certainty; a stale client
        // bundle still reports the deploy that originally served its index.html.
        appVersion:     trunc(process.env.SERVICECYCLE_VERSION || body.appVersion || body.lapseiqVersion, 32),
        ip:             trunc(ip, 64),
      },
    });
  } catch (err) {
    // Don't let a telemetry failure cascade. Better Stack picks up server
    // stdout, so this is observable to ops without affecting the user.
    console.error('[errors.render] persist failed:', err && err.message);
  }
});

module.exports = router;

export {};

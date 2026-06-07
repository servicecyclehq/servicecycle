'use strict';

/**
 * middleware/demoGuard.js
 * -----------------------
 * Sprint 5 (A2/A3): protect a public DEMO_MODE instance from a sales prospect
 * accidentally — or maliciously — wiping the seed data or locking out the
 * next visitor before the 03:30 nightly reset cron runs.
 *
 * No-op when DEMO_MODE !== 'true', so this is safe to mount unconditionally.
 *
 * Rules (each returns 403 when in demo mode):
 *   1. ANY DELETE                                — wipes data
 *   2. PATCH/PUT with body { status: 'archived' | 'cancelled' }
 *                                                — soft-archive equivalent
 *   3. POST /api/contracts/:id/archive equivalents — covered by rule 2
 *   4. (L5: REMOVED) PUT /api/users/me/password is now ALLOWED in demo.
 *      Showing the feature works as intended is more valuable than the
 *      lockout protection — the legacy 4-user account re-bcrypts its
 *      passwords on every nightly reset (03:30), and per-visitor accounts
 *      are wiped entirely on the L3 inactivity prune. So a self-inflicted
 *      lockout heals automatically; the banner explains the cycle.
 *   5. PUT /api/users/:id/reset-password         — admin-resets-others STILL
 *                                                  blocked: a visitor with the
 *                                                  legacy 'admin' login could
 *                                                  otherwise rotate the
 *                                                  manager/viewer/consultant
 *                                                  passwords mid-day and lock
 *                                                  out the next visitor before
 *                                                  the 03:30 reset.
 *   6. PUT /api/users/me with email change       — defensive (current route
 *                                                  ignores the field, but a
 *                                                  future expansion shouldn't
 *                                                  silently weaken the demo)
 *   7. PUT/PATCH /api/budget/*                   — Budget Forecast bulk-edit
 *                                                  (added 2026-05-02 session 4)
 *                                                  persists uplift % per vendor
 *                                                  + needed qty per contract.
 *                                                  Visitors can play with the
 *                                                  values and watch the
 *                                                  projections recalc live in
 *                                                  the SPA, but the SaveAll
 *                                                  round-trip stays a no-op so
 *                                                  the next visitor lands on
 *                                                  pristine seed data.
 *
 * Exception: POST /api/admin/reset-demo MUST still work — that's the
 * operator-triggered reset. Mount this AFTER the admin router or whitelist
 * the path here. We pick whitelist because it co-locates the rule with the
 * other demo logic and survives router-mount order changes.
 *
 * Mount AFTER authenticateToken so req.user is populated for any
 * permission-related logging additions later.
 */

const DEMO_RESET_PATH = '/api/admin/reset-demo';

const DESTRUCTIVE_STATUS_VALUES = new Set(['archived', 'cancelled']);

function _isDemo() {
  return process.env.DEMO_MODE === 'true';
}

function _denied(res, reason) {
  return res.status(403).json({
    success: false,
    error:   'Action disabled in demo mode.',
    reason,            // machine-readable hint for the SPA's toast text
    demoMode: true,
  });
}

/**
 * Router-level middleware. Mounted under `app.use('/api', demoWriteGuard)`
 * so it sees every authenticated route in one place.
 */
function demoWriteGuard(req, res, next) {
  if (!_isDemo()) return next();

  const fullPath = (req.baseUrl || '') + (req.path || '');

  // Whitelist: the operator-initiated reset endpoint must always work.
  // It carries its own admin + DEMO_MODE guards, so the gate trusting it
  // is fine.
  if (fullPath === DEMO_RESET_PATH) return next();

  // Rule 1 — block every DELETE
  if (req.method === 'DELETE') {
    return _denied(res, 'delete_disabled');
  }

  // Rule 2 — block soft-destructive status writes on body { status: ... }.
  if ((req.method === 'PATCH' || req.method === 'PUT') && req.body && typeof req.body === 'object') {
    const incomingStatus = req.body.status;
    if (typeof incomingStatus === 'string' && DESTRUCTIVE_STATUS_VALUES.has(incomingStatus.toLowerCase())) {
      return _denied(res, 'archive_disabled');
    }
  }

  // Rule 3 — archive subroutes (e.g. PATCH /api/contracts/:id/archive).
  // Match on the URL pattern rather than the body so we still catch calls
  // that don't carry { status: 'archived' } in the payload.
  if (req.method === 'PATCH' && /\/archive(\/|$)/.test(fullPath)) {
    return _denied(res, 'archive_disabled');
  }

  // Rule 5 — admin-resets-other-users is still blocked. Self-password
  // change (PUT /api/users/me/password) is now ALLOWED in demo (L5):
  // the nightly reset re-bcrypts the legacy account and the L3 prune
  // wipes per-visitor accounts, so any lockout heals automatically.
  if (req.method === 'PUT' && /^\/api\/users\/[^/]+\/reset-password$/.test(fullPath)) {
    return _denied(res, 'password_reset_disabled');
  }

  // Rule 6 — defensive: if PUT /api/users/me ever starts honouring `email`,
  // the demo admin's address must stay pinned. Cheaper to gate now than to
  // realise a regression later when the demo login stops working.
  if (req.method === 'PUT' && fullPath === '/api/users/me' && req.body && 'email' in req.body) {
    return _denied(res, 'email_change_disabled');
  }

  // Rule 7 (REMOVED 2026-06-01) — Budget Forecast saves are now ALLOWED in
  // demo. Per-visitor sandboxes are isolated accounts (wiped on the nightly
  // reset / inactivity prune) and the budget save endpoints are account-scoped
  // (findFirst by accountId), so a visitor's uplift / needed-qty edits only
  // touch their OWN sandbox -- the next visitor still lands on fresh seed data.
  // This mirrors Renewal Planning (contract line-items), which already persists
  // per-account in demo. Showing the feature actually save beats the old guard.

  // Rule 8 (2026-06-02) — block outbound-webhook creation / modification / test
  // in demo. A public sandbox shouldn't let anonymous visitors register
  // outbound webhook endpoints or fire test deliveries: it's an outbound-request
  // / abuse surface (the SSRF guard blocks private targets, but there's no
  // reason to allow public outbound POSTs from the demo at all). Reads (GET) of
  // the webhooks UI stay allowed so the feature is still visible/explorable.
  if (req.method !== 'GET' && /^\/api\/webhooks(\/|$)/.test(fullPath)) {
    return _denied(res, 'webhooks_disabled_in_demo');
  }

  return next();
}

module.exports = { demoWriteGuard };

export {};

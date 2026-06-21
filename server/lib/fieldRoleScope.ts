'use strict';

/**
 * lib/fieldRoleScope.ts
 * ---------------------
 * The field-labor (field_tech) default-deny boundary.
 *
 * field_tech is the subcontractor / field-labor login: assigned-jobs-only, with
 * NO access to pricing or the full customer list. Rather than gate each
 * sensitive route one by one (fragile — a newly-added route would leak by
 * default), this role is DENIED everywhere by default and ALLOWED only on an
 * explicit allowlist: the assignment-scoped field surface plus the
 * auth/session essentials.
 *
 * The check runs at the single universal chokepoint (middleware/auth
 * authenticateToken), so the boundary holds for every current and future
 * authenticated route without per-route maintenance.
 *
 *   Pricing routes a sub must never see:  /api/rate-cards, /api/quote-requests,
 *     /api/proposals, /api/revenue, /api/compliance/* (debt ledger, CFO report)
 *   Customer-list routes a sub must never see: the account-wide /api/assets,
 *     /api/sites, /api/contractors, /api/work-orders, /api/users lists
 *   → all DENIED here; the sub only reaches their own assigned work via
 *     the scoped /api/field surface.
 */

// Path PREFIXES a field_tech may reach. Matched against req.originalUrl, where
// Express has NOT stripped the mount prefix (the same reason the setup-gate in
// index.ts keys off originalUrl). Anything not matched → 403 field_role_scope.
const FIELD_TECH_ALLOWED_PREFIXES = [
  '/api/field',        // assignment-scoped field surface (reads + scoped writes + voice)
  '/api/auth',         // /me, /logout, /refresh, AI-consent — session lifecycle
  '/api/config',       // read-only client bootstrap (feature flags, aiEnabled) — no pricing/customers
  '/api/preferences',  // per-user UI state (saved views, column visibility) — no pricing/customers
  '/api/errors',       // render-crash telemetry
];

function normalizePath(originalUrl: string): string {
  const u = String(originalUrl || '');
  const q = u.indexOf('?');
  return q === -1 ? u : u.slice(0, q);
}

/**
 * True if a field_tech is permitted to reach this path. DEFAULT-DENY: only the
 * explicit allowlist passes. A prefix matches the bare path or a path with a
 * '/' boundary after it, so '/api/fieldwork' does NOT match '/api/field'.
 */
function isFieldTechAllowed(originalUrl: string): boolean {
  const p = normalizePath(originalUrl);
  return FIELD_TECH_ALLOWED_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(prefix + '/'),
  );
}

module.exports = { isFieldTechAllowed, FIELD_TECH_ALLOWED_PREFIXES };

export {};

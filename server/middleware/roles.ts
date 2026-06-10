// v0.68.2 (audit Low): per-(userId, path) throttle on
// permission_denied logging. Without this, a viewer with a `for` loop on
// /api/users/permissions could fill ActivityLog at line-rate. 1 min
// per (userId, path) cooldown.
const _denyTrack = new Map();
function _shouldLogDeny(userId, path) {
  const key = `${userId || 'anon'}|${path}`;
  const now = Date.now();
  const last = _denyTrack.get(key) || 0;
  if (now - last < 60_000) return false;
  _denyTrack.set(key, now);
  // Bound the map so it can't grow unboundedly.
  if (_denyTrack.size > 5000) {
    // Drop the oldest 1000 entries by walking the Map's insertion order.
    let toDrop = 1000;
    for (const k of _denyTrack.keys()) {
      _denyTrack.delete(k);
      if (--toDrop <= 0) break;
    }
  }
  return true;
}

/**
 * Role middleware — applied after authenticateToken.
 * All checks are against req.user.role which is set by the JWT middleware.
 * Role hierarchy: admin > manager > viewer ≈ consultant (read-only).
 *
 * consultant: external user (e.g., a renewals advisor) explicitly granted
 *   access by a customer admin to operate INSIDE the customer's account.
 *   Read-only-with-attribution by design — the SPA shows a yellow
 *   "Consultant Access — You are viewing this account as a consultant.
 *   Changes are logged" banner that promises read-only behaviour. The
 *   server must enforce that promise.
 *   - GET endpoints: same access as a viewer (subject to scope restriction).
 *   - All write paths: BLOCKED. The same 403 plain viewers get.
 *   - User management, account settings, billing, consultant access
 *     grants: admin-only.
 *
 * Sprint 5 (C1): each role gate also writes a permission_denied ActivityLog
 * entry on 403 so admins can see who tried to access what they couldn't.
 * The audit write is fire-and-forget; a logging failure never blocks the 403.
 */

const { writeLog: writeActivityLog } = require('../lib/activityLog');

/**
 * Internal helper — logs the 403 with method/path/role context. Fire-and-forget.
 * Skips writing when req.user is missing (defensive — these middlewares always
 * sit after authenticateToken, so this branch shouldn't fire in practice).
 */
function _logDenied(req, requiredRole) {
    if (!_shouldLogDeny(req.user && req.user.id, req.path)) return;
if (!req.user || !req.user.id) return;
  writeActivityLog({
    userId:  req.user.id,
    action:  'permission_denied',
    details: {
      method:       req.method,
      path:         req.originalUrl || req.url,
      role:         req.user.role,
      requiredRole,
    },
  });
}

/**
 * Requires the user to be an admin.
 * Use for: user management, account settings, billing, consultant access grants.
 */
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    _logDenied(req, 'admin');
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
}

/**
 * Requires the user to be an admin or manager — the "writer" tier.
 * Use for: creating, editing, or deleting contracts, vendors, documents.
 *
 * Consultants are NOT included. They're read-only-with-attribution by
 * design (see file header). A previous version of this gate accidentally
 * allowed consultants to write, which contradicted the in-app banner
 * promise; that's been corrected.
 */
function requireManager(req, res, next) {
  if (!['admin', 'manager'].includes(req.user.role)) {
    _logDenied(req, 'manager_or_admin');
    return res.status(403).json({ success: false, error: 'Manager or admin access required' });
  }
  next();
}

/**
 * Requires any authenticated user (admin, manager, or viewer).
 * This is the default — all authenticated routes already require a valid JWT.
 * Use explicitly when you want to document that viewers are permitted.
 */
function requireViewer(req, res, next) {
  // All authenticated roles have viewer access. JWT middleware handles auth.
  next();
}

/**
 * Requires oem_admin role.
 * Use for: fleet dashboard, cross-account OEM reporting routes.
 * Logs permission_denied to the activity log on failure (matches requireAdmin pattern).
 */
function requireOemAdmin(req, res, next) {
  if (req.user.role !== 'oem_admin') {
    _logDenied(req, 'oem_admin');
    return res.status(403).json({ success: false, error: 'OEM admin access required' });
  }
  next();
}

/**
 * Requires super_admin role.
 * Use for: platform-level PartnerOrganization management, bootstrapping OEM users.
 * Logs permission_denied to the activity log on failure (matches requireAdmin pattern).
 */
function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'super_admin') {
    _logDenied(req, 'super_admin');
    return res.status(403).json({ success: false, error: 'Super-admin access required' });
  }
  next();
}

module.exports = { requireAdmin, requireManager, requireViewer, requireOemAdmin, requireSuperAdmin };

export {};

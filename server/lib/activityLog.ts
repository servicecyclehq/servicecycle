/**
 * Shared activity-log writer.
 *
 * Fire-and-forget — a logging failure must never break the request that
 * triggered it. Every call swallows its own errors and console.errors them.
 *
 * Action conventions (string column, free-form). Existing values:
 *   asset_created, condition_changed, fields_updated, work_order_completed,
 *   schedule_updated, brief_generated, document_uploaded, user_created
 *
 * Added by Sprint 5 audit pass:
 *   login_failed              — failed login attempt with IP and reason
 *   login_lockout_triggered   — Nth failure triggered per-email lockout (CEF sev 7)
 *   permission_denied         — 403 from a role gate (user authenticated but
 *                               lacked required role for the requested action)
 *   document_accessed         — document download or signed-URL fetch
 *   api_v1_call               — v1 public API request (CC6.8 audit log)
 *
 * Added by 2026-07-03 acquisition scan (SCAN 4, activity-log coverage):
 *   account_exported          -- full-tenant export via GET /api/export/account
 *                               (exfiltration-relevant sibling of the per-user
 *                               user_data_exported GDPR export)
 *   arc_flash_label_generated -- NFPA 70E arc-flash label PDF generated
 *                               (details.scope = 'single' | 'bulk')
 *
 * NOTE: ActivityLog.userId is nullable as of B4 (migration
 * 20260502160000_activity_log_user_optional). Anonymous events such as
 * login_failed against an unregistered email persist with userId = null.
 * The UI already handles `log.user?.name || 'Unknown user'`.
 */

import prisma from './prisma';

/**
 * Write an activity-log row. Never throws.
 *
 * @param {object}   p
 * @param {string|null} p.assetId     - nullable; null for non-asset events
 * @param {string|null} p.userId      - actor user id, or null for anonymous events (B4)
 * @param {string|null} [p.accountId] - tenant id; pass req.user.accountId so the
 *                                      activity route can filter directly (H8). Optional
 *                                      for back-compat — callers that omit it fall back
 *                                      to the user-join OR clause in activity.js.
 * @param {string}   p.action         - one of the action strings above
 * @param {object|null} [p.details]   - optional JSON detail payload
 * @param {string|null} [p.ipAddress] - INFOSEC-8-4: source IP of the actor. The
 *                                      ActivityLog table has no dedicated ipAddress
 *                                      column (Json `details` only), so when supplied
 *                                      it is folded into details.ip. Optional and
 *                                      backward-compatible: callers that omit it write
 *                                      exactly as before, and an existing details.ip is
 *                                      never overwritten by a blank ipAddress. Pass
 *                                      req.ip from privileged/security routes so admin
 *                                      audit events carry the source IP.
 */
async function writeLog({ assetId = null, userId = null, accountId = null, action, details = null, ipAddress = null }) {
  if (!action) {
    // Silently skip — action is the only field that's still mandatory.
    return;
  }
  // INFOSEC-8-4: persist the source IP inside the details JSON (no schema
  // column exists for it). Only when provided and not already present, so we
  // never clobber a caller that already put an `ip` in details.
  let mergedDetails = details;
  if (ipAddress) {
    const base = (details && typeof details === 'object' && !Array.isArray(details)) ? details : {};
    if (base.ip == null) {
      mergedDetails = { ...base, ip: ipAddress };
    }
  }
  try {
    await prisma.activityLog.create({
      data: {
        assetId,
        userId,
        accountId,
        action,
        details: mergedDetails ?? undefined,
      },
    });
  } catch (err) {
    // Audit failures are non-fatal — they must not break the request that
    // triggered them. Surface to operator logs only.
    console.error(`[activityLog] write failed for ${action}:`, err.message);
  }
}

module.exports = { writeLog };

export {};

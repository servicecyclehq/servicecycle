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
 *   login_failed       — failed login attempt with IP and reason
 *   permission_denied  — 403 from a role gate (user authenticated but
 *                        lacked required role for the requested action)
 *   document_accessed  — document download or signed-URL fetch
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
 */
async function writeLog({ assetId = null, userId = null, accountId = null, action, details = null }) {
  if (!action) {
    // Silently skip — action is the only field that's still mandatory.
    return;
  }
  try {
    await prisma.activityLog.create({
      data: {
        assetId,
        userId,
        accountId,
        action,
        details: details ?? undefined,
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

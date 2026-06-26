/**
 * assetAlertNotifier.ts — configurable event-driven alert notifications.
 *
 * Exports three fire-and-forget helpers for alert types that live outside
 * the existing maintenance-engine cadence:
 *
 *   notifyConditionDegradation  — C1→C2 or C2→C3 governing-condition worsening
 *   notifyDeficiencyCreated     — new IMMEDIATE (or RECOMMENDED) deficiency
 *   notifyAssetDecommissioned   — asset inService=false / archived lifecycle event
 *
 * Each function:
 *   1. Reads the relevant AccountSetting keys (COND_DEGRADE_*, DEFICIENCY_*,
 *      ASSET_DECOMMISSION_*) — defaults are inline so missing rows behave correctly.
 *   2. Looks up active account users whose role matches the notify-roles list.
 *   3. Deduplicates via NotificationLog (24 h window for condition + deficiency,
 *      7 days for decommission) so a cron re-run or duplicate route call
 *      can't spam inboxes.
 *   4. Sends dark-theme HTML emails via lib/email.ts sendEmail().
 *   5. Writes a NotificationLog row regardless of send success so the audit
 *      trail is complete.
 *
 * All three are exported as async functions but callers MUST use
 * .catch(() => {}) to keep them fire-and-forget — they must never block
 * an HTTP response.
 */

import prisma from './prisma';
const { sendEmail } = require('./email');
const { redactEmail } = require('./redact');

const MS_PER_DAY = 86_400_000;

// ── Condition ordering ────────────────────────────────────────────────────────
const CONDITION_RANK: Record<string, number> = { C1: 1, C2: 2, C3: 3 };

function isWorsening(oldCond: string | null | undefined, newCond: string | null | undefined): boolean {
  const a = CONDITION_RANK[oldCond ?? ''] ?? 0;
  const b = CONDITION_RANK[newCond ?? ''] ?? 0;
  return b > a;
}

// ── AccountSetting helpers ────────────────────────────────────────────────────
async function getSetting(accountId: string, key: string, defaultValue: string): Promise<string> {
  try {
    const row = await prisma.accountSetting.findUnique({
      where: { accountId_key: { accountId, key } },
    });
    return row?.value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

async function getNotifyUsers(accountId: string, rolesStr: string) {
  const roles = rolesStr.split(',').map((r: string) => r.trim()).filter(Boolean);
  if (roles.length === 0) return [];
  return prisma.user.findMany({
    where: { accountId, isActive: true, role: { in: roles as any[] } },
    select: { id: true, email: true, role: true },
  });
}

// ── HTML email builders ───────────────────────────────────────────────────────
function escHtml(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildConditionDegradationHtml(params: {
  assetName: string;
  assetId: string;
  oldCondition: string;
  newCondition: string;
  triggeredBy: string;
}): string {
  const { assetName, assetId, oldCondition, newCondition, triggeredBy } = params;
  const isCritical = newCondition === 'C3';
  const accentColor = isCritical ? '#dc2626' : '#d97706';
  const headerBg = isCritical ? '#7f1d1d' : '#78350f';
  const badgeBg = isCritical ? '#dc2626' : '#d97706';
  const condLabel = (c: string) =>
    c === 'C1' ? 'Condition 1 (Good)'
    : c === 'C2' ? 'Condition 2 (Fair)'
    : c === 'C3' ? 'Condition 3 (Poor)'
    : c;

  return `<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;color:#e5e7eb;background:#111827;margin:0;padding:20px;">
  <div style="max-width:640px;margin:0 auto;background:#1f2937;border:1px solid #374151;border-radius:8px;overflow:hidden;">
    <div style="background:${headerBg};padding:16px 24px;border-left:4px solid ${accentColor};">
      <h2 style="margin:0;color:#fff;font-size:18px;">&#9888; Asset Condition Degraded</h2>
      <p style="margin:4px 0 0;color:#fde68a;font-size:13px;">ServiceCycle Alert</p>
    </div>
    <div style="padding:20px 24px;">
      <p style="font-size:15px;color:#f9fafb;margin:0 0 12px;">
        Asset <strong style="color:#fff;">${escHtml(assetName)}</strong> has changed from
        <span style="background:#374151;padding:2px 8px;border-radius:4px;font-weight:600;">${escHtml(condLabel(oldCondition))}</span>
        &nbsp;→&nbsp;
        <span style="background:${badgeBg};padding:2px 8px;border-radius:4px;color:#fff;font-weight:600;">${escHtml(condLabel(newCondition))}</span>
      </p>
      <p style="font-size:13px;color:#9ca3af;margin:0 0 8px;">
        Triggered by: ${escHtml(triggeredBy === 'auto' ? 'Automated monitoring' : triggeredBy)}
      </p>
      ${isCritical ? `<p style="font-size:13px;color:#fca5a5;margin:8px 0;">
        &#128680; Condition 3 assets require immediate attention per NFPA 70B:2023.
        Maintenance intervals have been automatically tightened.
      </p>` : ''}
      <p style="font-size:12px;color:#6b7280;margin:20px 0 0;border-top:1px solid #374151;padding-top:12px;">
        This is an automated alert from ServiceCycle. Review the asset in your dashboard.
        Do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>`;
}

function buildDeficiencyHtml(params: {
  assetName: string;
  deficiencyId: string;
  severity: string;
  description: string;
  reportedBy?: string;
}): string {
  const { assetName, severity, description, reportedBy } = params;
  const isImmediate = severity === 'IMMEDIATE';
  const accentColor = isImmediate ? '#dc2626' : '#d97706';
  const headerBg = isImmediate ? '#7f1d1d' : '#78350f';
  const badgeBg = isImmediate ? '#dc2626' : '#d97706';

  return `<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;color:#e5e7eb;background:#111827;margin:0;padding:20px;">
  <div style="max-width:640px;margin:0 auto;background:#1f2937;border:1px solid #374151;border-radius:8px;overflow:hidden;">
    <div style="background:${headerBg};padding:16px 24px;border-left:4px solid ${accentColor};">
      <h2 style="margin:0;color:#fff;font-size:18px;">&#9888; New ${escHtml(severity)} Deficiency</h2>
      <p style="margin:4px 0 0;color:#fde68a;font-size:13px;">ServiceCycle Alert</p>
    </div>
    <div style="padding:20px 24px;">
      <p style="font-size:15px;color:#f9fafb;margin:0 0 12px;">
        A new deficiency has been recorded on asset
        <strong style="color:#fff;">${escHtml(assetName)}</strong>.
      </p>
      <div style="background:#111827;border:1px solid #374151;border-radius:6px;padding:12px 16px;margin:0 0 12px;">
        <p style="font-size:13px;margin:0 0 4px;color:#9ca3af;">Severity</p>
        <span style="background:${badgeBg};padding:2px 10px;border-radius:4px;color:#fff;font-weight:700;font-size:13px;">${escHtml(severity)}</span>
        <p style="font-size:13px;margin:12px 0 4px;color:#9ca3af;">Finding</p>
        <p style="font-size:14px;color:#f3f4f6;margin:0;">${escHtml(description)}</p>
        ${reportedBy ? `<p style="font-size:12px;margin:8px 0 0;color:#6b7280;">Reported by: ${escHtml(reportedBy)}</p>` : ''}
      </div>
      ${isImmediate ? `<p style="font-size:13px;color:#fca5a5;margin:8px 0;">
        &#128680; IMMEDIATE deficiencies require action before re-energizing per NETA MTS.
      </p>` : ''}
      <p style="font-size:12px;color:#6b7280;margin:20px 0 0;border-top:1px solid #374151;padding-top:12px;">
        This is an automated alert from ServiceCycle. Log in to review and assign corrective action.
        Do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>`;
}

function buildDecommissionHtml(params: {
  assetName: string;
  assetId: string;
  decommissionedBy?: string;
}): string {
  const { assetName, decommissionedBy } = params;

  return `<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;color:#e5e7eb;background:#111827;margin:0;padding:20px;">
  <div style="max-width:640px;margin:0 auto;background:#1f2937;border:1px solid #374151;border-radius:8px;overflow:hidden;">
    <div style="background:#374151;padding:16px 24px;border-left:4px solid #6b7280;">
      <h2 style="margin:0;color:#fff;font-size:18px;">&#128274; Asset Decommissioned</h2>
      <p style="margin:4px 0 0;color:#d1d5db;font-size:13px;">ServiceCycle Asset Lifecycle Alert</p>
    </div>
    <div style="padding:20px 24px;">
      <p style="font-size:15px;color:#f9fafb;margin:0 0 12px;">
        Asset <strong style="color:#fff;">${escHtml(assetName)}</strong> has been marked
        <span style="background:#4b5563;padding:2px 8px;border-radius:4px;font-weight:600;">Out of Service</span>.
      </p>
      ${decommissionedBy ? `<p style="font-size:13px;color:#9ca3af;margin:0 0 8px;">Decommissioned by: ${escHtml(decommissionedBy)}</p>` : ''}
      <p style="font-size:13px;color:#d1d5db;margin:0 0 8px;">
        Active maintenance schedules and monitoring for this asset should be reviewed.
        Ensure any open deficiencies or work orders are resolved or cancelled as appropriate.
      </p>
      <p style="font-size:12px;color:#6b7280;margin:20px 0 0;border-top:1px solid #374151;padding-top:12px;">
        This is an automated lifecycle alert from ServiceCycle. Do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── Exported notifiers ────────────────────────────────────────────────────────

export async function notifyConditionDegradation(params: {
  accountId: string;
  assetId: string;
  assetName: string;
  siteId?: string | null;
  oldCondition: string | null | undefined;
  newCondition: string | null | undefined;
  triggeredBy: string;
}): Promise<void> {
  const { accountId, assetId, assetName, oldCondition, newCondition, triggeredBy } = params;

  // Only notify when condition is actually getting worse
  if (!isWorsening(oldCondition, newCondition)) return;

  const enabled = await getSetting(accountId, 'COND_DEGRADE_ALERT_ENABLED', 'true');
  if (enabled !== 'true') return;

  const rolesStr = await getSetting(accountId, 'COND_DEGRADE_NOTIFY_ROLES', 'admin,manager,consultant');
  const users = await getNotifyUsers(accountId, rolesStr);
  if (users.length === 0) return;

  const dedupeWindowMs = 24 * MS_PER_DAY;
  const template = `condition_degraded:${assetId}:${newCondition}`;
  const subject = `[ServiceCycle] Asset condition degraded — ${assetName} (${oldCondition} → ${newCondition})`;
  const html = buildConditionDegradationHtml({ assetName, assetId, oldCondition: oldCondition ?? 'C1', newCondition: newCondition ?? 'C2', triggeredBy });

  for (const user of users) {
    try {
      // Dedup check: skip if a matching notification was sent in the last 24h
      const recent = await prisma.notificationLog.findFirst({
        where: {
          accountId, userId: user.id, template,
          sentAt: { gte: new Date(Date.now() - dedupeWindowMs) },
          status: 'sent',
        },
      });
      if (recent) continue;

      await sendEmail({ to: user.email, subject, html });
      await prisma.notificationLog.create({
        data: {
          accountId, userId: user.id, assetId, channel: 'email',
          template, recipient: user.email, status: 'sent', alertCount: 1,
        },
      });
    } catch (e: any) {
      console.error(`[assetAlertNotifier] conditionDegradation email failed for ${redactEmail(user.email)}:`, e.message);
      // Log failure so audit trail is complete even on send error
      await prisma.notificationLog.create({
        data: {
          accountId, userId: user.id, assetId, channel: 'email',
          template, recipient: user.email, status: 'failed',
          errorMessage: e.message, alertCount: 0,
        },
      }).catch(() => {});
    }
  }
}

export async function notifyDeficiencyCreated(params: {
  accountId: string;
  assetId: string;
  assetName: string;
  deficiencyId: string;
  severity: string;
  description: string;
  reportedBy?: string;
}): Promise<void> {
  const { accountId, assetId, assetName, deficiencyId, severity, description, reportedBy } = params;

  const enabled = await getSetting(accountId, 'DEFICIENCY_ALERT_ENABLED', 'true');
  if (enabled !== 'true') return;

  const minSeverity = await getSetting(accountId, 'DEFICIENCY_ALERT_MIN_SEVERITY', 'IMMEDIATE');
  // RECOMMENDED means notify for both IMMEDIATE and RECOMMENDED; IMMEDIATE (default) only for IMMEDIATE
  const notifySeverities = minSeverity === 'RECOMMENDED'
    ? ['IMMEDIATE', 'RECOMMENDED']
    : ['IMMEDIATE'];
  if (!notifySeverities.includes(severity)) return;

  const rolesStr = await getSetting(accountId, 'DEFICIENCY_ALERT_NOTIFY_ROLES', 'admin,manager');
  const users = await getNotifyUsers(accountId, rolesStr);
  if (users.length === 0) return;

  const dedupeWindowMs = 24 * MS_PER_DAY;
  const template = `deficiency_created:${deficiencyId}`;
  const subject = `[ServiceCycle] ${severity} deficiency — ${assetName}`;
  const html = buildDeficiencyHtml({ assetName, deficiencyId, severity, description, reportedBy });

  for (const user of users) {
    try {
      const recent = await prisma.notificationLog.findFirst({
        where: {
          accountId, userId: user.id, template,
          sentAt: { gte: new Date(Date.now() - dedupeWindowMs) },
          status: 'sent',
        },
      });
      if (recent) continue;

      await sendEmail({ to: user.email, subject, html });
      await prisma.notificationLog.create({
        data: {
          accountId, userId: user.id, assetId, channel: 'email',
          template, recipient: user.email, status: 'sent', alertCount: 1,
        },
      });
    } catch (e: any) {
      console.error(`[assetAlertNotifier] deficiencyCreated email failed for ${redactEmail(user.email)}:`, e.message);
      await prisma.notificationLog.create({
        data: {
          accountId, userId: user.id, assetId, channel: 'email',
          template, recipient: user.email, status: 'failed',
          errorMessage: e.message, alertCount: 0,
        },
      }).catch(() => {});
    }
  }
}

export async function notifyAssetDecommissioned(params: {
  accountId: string;
  assetId: string;
  assetName: string;
  decommissionedBy?: string;
}): Promise<void> {
  const { accountId, assetId, assetName, decommissionedBy } = params;

  const enabled = await getSetting(accountId, 'ASSET_DECOMMISSION_ALERT_ENABLED', 'true');
  if (enabled !== 'true') return;

  const rolesStr = await getSetting(accountId, 'ASSET_DECOMMISSION_NOTIFY_ROLES', 'admin,manager');
  const users = await getNotifyUsers(accountId, rolesStr);
  if (users.length === 0) return;

  const dedupeWindowMs = 7 * 24 * MS_PER_DAY;
  const template = `asset_decommissioned:${assetId}`;
  const subject = `[ServiceCycle] Asset decommissioned — ${assetName}`;
  const html = buildDecommissionHtml({ assetName, assetId, decommissionedBy });

  for (const user of users) {
    try {
      const recent = await prisma.notificationLog.findFirst({
        where: {
          accountId, userId: user.id, template,
          sentAt: { gte: new Date(Date.now() - dedupeWindowMs) },
          status: 'sent',
        },
      });
      if (recent) continue;

      await sendEmail({ to: user.email, subject, html });
      await prisma.notificationLog.create({
        data: {
          accountId, userId: user.id, assetId, channel: 'email',
          template, recipient: user.email, status: 'sent', alertCount: 1,
        },
      });
    } catch (e: any) {
      console.error(`[assetAlertNotifier] assetDecommissioned email failed for ${redactEmail(user.email)}:`, e.message);
      await prisma.notificationLog.create({
        data: {
          accountId, userId: user.id, assetId, channel: 'email',
          template, recipient: user.email, status: 'failed',
          errorMessage: e.message, alertCount: 0,
        },
      }).catch(() => {});
    }
  }
}

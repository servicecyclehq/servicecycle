/**
 * deficiencyAlerts.ts — daily email digest for IMMEDIATE deficiencies.
 *
 * Notification tiers (days open):
 *   0  — new:        deficiency opened in the last 24h
 *   7  — reminder:   open for ~7 days
 *   30 — escalation: open for ~30 days
 *
 * One email per admin/manager user per account when any of their accounts
 * have tiered IMMEDIATE deficiencies that have not been notified yet today.
 *
 * Registered as a daily cron in server/index.ts (08:00 UTC).
 */

import prisma from './prisma';
const { sendEmail }   = require('./email');
const { redactEmail } = require('./redact');

// ── helpers ────────────────────────────────────────────────────────────────────

function escHtml(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ageDays(d: Date): number {
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

function ageLabel(days: number): string {
  if (days === 0) return 'New today';
  if (days === 1) return '1 day open';
  return `${days} days open`;
}

/**
 * Returns true if `createdAt` falls inside the 24-hour window that starts
 * exactly `targetDays` days ago.  Window: [targetDays, targetDays+1).
 */
function isInTierWindow(createdAt: Date, targetDays: number): boolean {
  const ageDaysFloat = (Date.now() - createdAt.getTime()) / 86_400_000;
  return ageDaysFloat >= targetDays && ageDaysFloat < targetDays + 1;
}

const TIER_DAYS = [0, 7, 30];
const TIER_TEMPLATES: Record<number, string> = {
  0:  'deficiency_immediate_new',
  7:  'deficiency_immediate_reminder',
  30: 'deficiency_immediate_escalation',
};

// ── email renderer ─────────────────────────────────────────────────────────────

interface DefItem {
  assetName: string;
  description: string;
  ageLabel: string;
  site: string | null;
}

function buildSubject(count: number, accountName: string, tier: number): string {
  const noun = count === 1 ? 'deficiency' : 'deficiencies';
  const prefix =
    tier === 0  ? '[New]'
    : tier === 7 ? '[Reminder]'
    : '[Escalation]';
  return `${prefix} ${count} IMMEDIATE ${noun} — ${accountName}`;
}

function buildHtml(items: DefItem[], accountName: string, tier: number): string {
  const tierLabel =
    tier === 0  ? 'These deficiencies were logged today.'
    : tier === 7 ? 'These deficiencies have been open for 7 days without resolution.'
    : 'These deficiencies have been open for 30+ days and require immediate escalation.';

  const rows = items
    .map(
      (d) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">
        <strong style="color:#dc2626;">IMMEDIATE</strong>
        &nbsp;&middot;&nbsp;${escHtml(d.assetName)}
        ${d.site ? `<span style="color:#6b7280;font-size:12px;"> (${escHtml(d.site)})</span>` : ''}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#374151;font-size:13px;">${escHtml(d.description)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px;white-space:nowrap;">${escHtml(d.ageLabel)}</td>
    </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;color:#111827;background:#f9fafb;margin:0;padding:20px;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="background:#dc2626;padding:16px 24px;">
      <h2 style="margin:0;color:#fff;font-size:18px;">&#9888; IMMEDIATE Deficiency Alert</h2>
      <p style="margin:4px 0 0;color:#fecaca;font-size:13px;">${escHtml(accountName)}</p>
    </div>
    <div style="padding:20px 24px;">
      <p style="font-size:14px;color:#374151;margin:0 0 4px;">${escHtml(tierLabel)}</p>
      <p style="font-size:13px;color:#6b7280;margin:0 0 16px;">
        IMMEDIATE deficiencies represent an active safety or reliability risk and should be
        addressed without delay per NFPA 70B:2023.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f3f4f6;">
            <th style="padding:8px 12px;text-align:left;font-weight:600;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:.05em;">Asset</th>
            <th style="padding:8px 12px;text-align:left;font-weight:600;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:.05em;">Finding</th>
            <th style="padding:8px 12px;text-align:left;font-weight:600;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:.05em;">Age</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:12px;color:#9ca3af;margin:20px 0 0;">
        Log in to ServiceCycle to assign corrective actions or submit a quote request.
        This is an automated notification &mdash; do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── main export ────────────────────────────────────────────────────────────────

export interface DeficiencyAlertResult {
  accounts: number;
  emails: number;
  skipped: number;
}

export async function runDeficiencyAlerts(): Promise<DeficiencyAlertResult> {
  let emailsSent = 0;
  let accountsProcessed = 0;
  let skipped = 0;

  // All open IMMEDIATE deficiencies (cap 2000 — at scale use pagination)
  const defs = await prisma.deficiency.findMany({
    where: {
      severity: 'IMMEDIATE',
      resolvedAt: null,
      asset: { archivedAt: null },
    },
    select: {
      id: true,
      accountId: true,
      assetId: true,
      description: true,
      createdAt: true,
      asset: {
        select: {
          name: true,
          site: { select: { name: true } },
        },
      },
    },
    take: 2000,
  });

  if (defs.length === 0) return { accounts: 0, emails: 0, skipped: 0 };

  // Group by account
  const byAccount = new Map<string, typeof defs>();
  for (const d of defs) {
    if (!byAccount.has(d.accountId)) byAccount.set(d.accountId, []);
    byAccount.get(d.accountId)!.push(d);
  }

  for (const [accountId, accountDefs] of byAccount) {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { companyName: true },
    });

    // Notify once per tier per account per recipient today
    const recipients = await prisma.user.findMany({
      where: {
        accountId,
        role: { in: ['admin', 'manager'] },
        isActive: true,
        email: { not: null },
      },
      select: { id: true, email: true },
    });
    if (recipients.length === 0) continue;

    const accountName = account?.companyName ?? accountId;

    for (const tierDays of TIER_DAYS) {
      const template = TIER_TEMPLATES[tierDays];
      const tiered = accountDefs.filter((d) => isInTierWindow(d.createdAt, tierDays));
      if (tiered.length === 0) { skipped++; continue; }

      const items: DefItem[] = tiered.map((d) => ({
        assetName:   d.asset?.name ?? 'Unknown asset',
        description: d.description.slice(0, 120),
        ageLabel:    ageLabel(ageDays(d.createdAt)),
        site:        d.asset?.site?.name ?? null,
      }));

      for (const user of recipients) {
        if (!user.email) continue;

        // Dedup: skip if we already sent this template in the last 20 hours
        const alreadySent = await prisma.notificationLog.findFirst({
          where: {
            accountId,
            userId: user.id,
            template,
            sentAt: { gte: new Date(Date.now() - 20 * 3_600_000) },
            status: 'sent',
          },
        });
        if (alreadySent) { skipped++; continue; }

        const subject = buildSubject(tiered.length, accountName, tierDays);
        const html    = buildHtml(items, accountName, tierDays);

        try {
          await sendEmail({ to: user.email, subject, html });
          emailsSent++;
          prisma.notificationLog.create({
            data: {
              accountId,
              userId: user.id,
              channel:           'email',
              template,
              recipient:         user.email,
              status:            'sent',
              alertCount:        tiered.length,
            },
          }).catch((e: any) => console.warn('[deficiencyAlerts] NotifLog write failed:', e.message));
          console.log(`[deficiencyAlerts] Sent tier=${tierDays}d to ${redactEmail(user.email)} (${tiered.length} items)`);
        } catch (err: any) {
          console.error(`[deficiencyAlerts] Failed to send to ${redactEmail(user.email)}:`, err.message);
          prisma.notificationLog.create({
            data: {
              accountId,
              userId: user.id,
              channel:      'email',
              template,
              recipient:    user.email,
              status:       'failed',
              errorMessage: err.message,
              alertCount:   tiered.length,
            },
          }).catch(() => {});
        }
      }
    }
    accountsProcessed++;
  }

  return { accounts: accountsProcessed, emails: emailsSent, skipped };
}

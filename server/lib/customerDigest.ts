/**
 * customerDigest.ts — #30 customer-side weekly digest.
 *
 * The customer-side equivalent of the partner flywheel digest (lib/partnerDigest):
 * a weekly heartbeat to the FACILITY's own admins/managers (+ service rep) that
 * keeps the tab open between test seasons. "This week: 2 items went overdue,
 * 1 fixed, compliance 87 -> 89%, next outage in 41 days."
 *
 *   buildCustomerDigest(prisma, accountId) -> payload (no side effects; safe for
 *     the preview endpoint).
 *   runCustomerDigestCron() -> sends one email per opted-in account and records
 *     the current rate so next week's delta is computable. Opt-in via
 *     AccountSetting customer_weekly_digest='true'.
 */

const { buildComplianceGap } = require('./complianceReport');
const { sendEmail } = require('./email');

const MS_PER_DAY = 86_400_000;
const LAST_RATE_KEY = 'customer_digest_last_rate';
const OPT_IN_KEY    = 'customer_weekly_digest';
const CFO_OPT_IN_KEY = 'customer_quarterly_cfo';

// Resolve the account's notification recipients (admins/managers + service rep).
async function digestRecipients(prisma: any, accountId: string): Promise<{ companyName: string; emails: string[] } | null> {
  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true, serviceRepEmail: true },
  });
  if (!account) return null;
  const recipients = await prisma.user.findMany({
    where: { accountId, role: { in: ['admin', 'manager'] }, isActive: true },
    select: { email: true },
  });
  const emails = new Set<string>(recipients.map((r: any) => r.email).filter(Boolean));
  if (account.serviceRepEmail) emails.add(account.serviceRepEmail);
  return { companyName: account.companyName, emails: Array.from(emails) };
}

function escHtml(s: any): string {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build the weekly digest payload for one account. Pure read — the rate trend
 * uses the stored last-rate but does NOT write it (the cron does that on send).
 */
async function buildCustomerDigest(prisma: any, accountId: string) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
  const assetScope = { archivedAt: null, inService: true };

  const [gap, lastRateRow, wentOverdue, defsResolved, defsOpened, wosCompleted, outageWindow] = await Promise.all([
    buildComplianceGap(prisma, accountId, {}),
    prisma.accountSetting.findFirst({ where: { accountId, key: LAST_RATE_KEY }, select: { value: true } }),
    // Schedules whose due date crossed into the last 7 days (newly overdue).
    prisma.maintenanceSchedule.count({
      where: { accountId, isActive: true, asset: assetScope, nextDueDate: { gte: weekAgo, lte: now } },
    }),
    prisma.deficiency.count({ where: { accountId, resolvedAt: { gte: weekAgo, lte: now } } }),
    prisma.deficiency.count({ where: { accountId, createdAt: { gte: weekAgo, lte: now } } }),
    prisma.workOrder.count({ where: { accountId, status: 'COMPLETE', completedDate: { gte: weekAgo, lte: now } } }),
    // Next declared outage window (planned shutdown) starting in the future.
    prisma.blackoutWindow.findFirst({
      where: { accountId, isOutageWindow: true, startsAt: { gt: now } },
      orderBy: { startsAt: 'asc' },
      select: { startsAt: true, reason: true, site: { select: { name: true } } },
    }),
  ]);

  const currentRate = gap.overallRate;
  const prevRate = lastRateRow && lastRateRow.value != null ? Number(lastRateRow.value) : null;
  const rateDelta = prevRate != null && Number.isFinite(prevRate)
    ? Math.round((currentRate - prevRate) * 10) / 10
    : null;

  // Next outage: prefer a declared window; fall back to the soonest
  // requiresOutage schedule due date.
  let nextOutage: any = null;
  if (outageWindow) {
    nextOutage = {
      kind: 'window',
      date: outageWindow.startsAt,
      daysUntil: Math.ceil((new Date(outageWindow.startsAt).getTime() - now.getTime()) / MS_PER_DAY),
      siteName: outageWindow.site?.name ?? null,
      reason: outageWindow.reason ?? null,
    };
  } else {
    const due = await prisma.maintenanceSchedule.findFirst({
      where: {
        accountId, isActive: true, asset: assetScope,
        nextDueDate: { gt: now },
        taskDefinition: { requiresOutage: true },
      },
      orderBy: { nextDueDate: 'asc' },
      select: { nextDueDate: true, taskDefinition: { select: { taskName: true } } },
    });
    if (due && due.nextDueDate) {
      nextOutage = {
        kind: 'scheduled_task',
        date: due.nextDueDate,
        daysUntil: Math.ceil((new Date(due.nextDueDate).getTime() - now.getTime()) / MS_PER_DAY),
        taskName: due.taskDefinition?.taskName ?? null,
      };
    }
  }

  return {
    generatedAt: now,
    week: { from: weekAgo, to: now },
    compliance: {
      overallRate: currentRate,
      previousRate: prevRate,
      delta: rateDelta,
      coverageRate: gap.coverage?.rate ?? null,
      openActions: gap.summary?.totalActions ?? 0,
    },
    thisWeek: {
      wentOverdue,
      fixed: defsResolved,
      newDeficiencies: defsOpened,
      workOrdersCompleted: wosCompleted,
    },
    nextOutage,
    topActions: (gap.actions || []).slice(0, 5).map((a: any) => ({
      title: a.title, kind: a.kind, siteName: a.siteName ?? null,
    })),
  };
}

function buildDigestHtml(companyName: string, d: any): string {
  const c = d.compliance;
  const trend = c.delta == null
    ? `${c.overallRate}%`
    : `${c.previousRate}% &rarr; ${c.overallRate}% (${c.delta >= 0 ? '+' : ''}${c.delta})`;
  const outageLine = d.nextOutage
    ? `Next outage in ${d.nextOutage.daysUntil} day${d.nextOutage.daysUntil === 1 ? '' : 's'}${d.nextOutage.siteName ? ` at ${escHtml(d.nextOutage.siteName)}` : ''}.`
    : 'No outage window scheduled.';
  const actionItems = (d.topActions || []).map((a: any) => `<li>${escHtml(a.title)}</li>`).join('');
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  return `<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;color:#0a0d12;background:#f9fafb;margin:0;padding:20px;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="background:#0d4f6e;padding:16px 24px;">
      <h2 style="margin:0;color:#fff;font-size:18px;">Your weekly compliance digest</h2>
      <p style="margin:4px 0 0;color:#cfe3ee;font-size:13px;">${escHtml(companyName)}</p>
    </div>
    <div style="padding:20px 24px;">
      <p style="font-size:15px;margin:0 0 12px;"><strong>Compliance:</strong> ${trend}</p>
      <ul style="margin:0 0 16px 16px;font-size:14px;color:#374151;">
        <li>${d.thisWeek.wentOverdue} item${d.thisWeek.wentOverdue === 1 ? '' : 's'} went overdue this week</li>
        <li>${d.thisWeek.fixed} deficienc${d.thisWeek.fixed === 1 ? 'y' : 'ies'} resolved</li>
        <li>${d.thisWeek.workOrdersCompleted} work order${d.thisWeek.workOrdersCompleted === 1 ? '' : 's'} completed</li>
      </ul>
      <p style="font-size:14px;color:#374151;margin:0 0 16px;">${outageLine}</p>
      ${actionItems ? `<p style="font-size:13px;color:#374151;margin:0 0 4px;"><strong>Top items to close:</strong></p><ul style="margin:0 0 16px 16px;font-size:13px;color:#374151;">${actionItems}</ul>` : ''}
      <a href="${clientUrl}/dashboard" style="display:inline-block;background:#0d4f6e;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;">Open ServiceCycle</a>
      <p style="font-size:12px;color:#9ca3af;margin:20px 0 0;">You receive this because weekly digests are enabled for your account. An admin can turn them off in Settings.</p>
    </div>
  </div>
</body>
</html>`;
}

interface CustomerDigestResult {
  accountsProcessed: number;
  emailsSent: number;
}

async function runCustomerDigestCron(): Promise<CustomerDigestResult> {
  const prisma = require('./prisma').default;
  let accountsProcessed = 0;
  let emailsSent = 0;

  const optedIn = await prisma.accountSetting.findMany({
    where: { key: OPT_IN_KEY, value: 'true' },
    select: { accountId: true },
  });

  for (const row of optedIn) {
    const accountId = row.accountId;
    try {
      const rcpt = await digestRecipients(prisma, accountId);
      if (!rcpt || rcpt.emails.length === 0) continue;

      const digest = await buildCustomerDigest(prisma, accountId);
      const html = buildDigestHtml(rcpt.companyName, digest);
      const subject = `Your weekly compliance digest — ${rcpt.companyName} (${digest.compliance.overallRate}%)`;

      for (const to of rcpt.emails) {
        try { await sendEmail({ to, subject, html }); emailsSent++; }
        catch (e: any) { console.error('[customerDigest] email failed:', e.message); }
      }

      // Record the current rate so next week's delta is computable.
      await prisma.accountSetting.upsert({
        where:  { accountId_key: { accountId, key: LAST_RATE_KEY } },
        update: { value: String(digest.compliance.overallRate) },
        create: { accountId, key: LAST_RATE_KEY, value: String(digest.compliance.overallRate) },
      }).catch(() => {});

      accountsProcessed++;
    } catch (e: any) {
      console.error(`[customerDigest] account ${accountId} failed:`, e.message);
    }
  }

  return { accountsProcessed, emailsSent };
}

/**
 * Quarterly CFO report email — builds the board-grade PDF and sends it as an
 * attachment to opted-in accounts (AccountSetting customer_quarterly_cfo='true').
 */
async function runCustomerCfoCron(): Promise<CustomerDigestResult> {
  const prisma = require('./prisma').default;
  const { buildCfoReportData, renderCfoReportPdf } = require('./cfoReport');
  const { getAccountBranding } = require('./partnerBranding');
  let accountsProcessed = 0;
  let emailsSent = 0;

  const optedIn = await prisma.accountSetting.findMany({
    where: { key: CFO_OPT_IN_KEY, value: 'true' },
    select: { accountId: true },
  });

  for (const row of optedIn) {
    const accountId = row.accountId;
    try {
      const rcpt = await digestRecipients(prisma, accountId);
      if (!rcpt || rcpt.emails.length === 0) continue;

      const data = await buildCfoReportData(prisma, accountId);
      const branding = await getAccountBranding(accountId);
      const pdf = await renderCfoReportPdf(data, {
        generatedAtIso: data.generatedAt.toISOString(),
        brandName: branding?.name || null,
        brandColor: branding?.primaryColor || null,
      });
      const filename = `servicecycle-cfo-report-${data.generatedAt.toISOString().slice(0, 10)}.pdf`;
      const attachments = [{ content: pdf.toString('base64'), name: filename }];
      const subject = `Quarterly compliance & budget report — ${rcpt.companyName}`;
      const html = `<p>Attached is your ServiceCycle quarterly compliance & budget report for <strong>${escHtml(rcpt.companyName)}</strong> (overall readiness ${data.overallRate}%).</p>`;

      for (const to of rcpt.emails) {
        try { await sendEmail({ to, subject, html, attachments }); emailsSent++; }
        catch (e: any) { console.error('[customerCfo] email failed:', e.message); }
      }
      accountsProcessed++;
    } catch (e: any) {
      console.error(`[customerCfo] account ${accountId} failed:`, e.message);
    }
  }

  return { accountsProcessed, emailsSent };
}

module.exports = { buildCustomerDigest, runCustomerDigestCron, runCustomerCfoCron, OPT_IN_KEY, CFO_OPT_IN_KEY, LAST_RATE_KEY };

export {};

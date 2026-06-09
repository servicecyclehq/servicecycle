/**
 * standardRevisionCron.ts — fire per-account alerts when a ComplianceStandard
 * is superseded (supersededAt IS NOT NULL).
 *
 * Task 27: When a new NFPA 70B / NETA ATS / NFPA 70E edition is published,
 * alert all accounts with assets governed by the old standard. This is a
 * recurring portfolio-wide revenue trigger requiring minimal maintenance —
 * just update the ComplianceStandard.supersededAt date when the new edition
 * is issued.
 *
 * Email: standard name, effective date, plain-language note that EMP may need
 * review, link to schedule a compliance review.
 *
 * Dedup: NotificationLog prevents re-sending for the same (account, standard).
 *
 * Wire: registered as daily 10:30 UTC cron in server/index.ts.
 */

import prisma from './prisma';
const { sendEmail }   = require('./email');
const { redactEmail } = require('./redact');

function escHtml(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildRevisionHtml(
  standardCode: string,
  oldEdition: string,
  newEdition: string,
  effectiveDate: Date | null,
  accountName: string,
  summary: string | null,
): string {
  const effectiveDateStr = effectiveDate
    ? effectiveDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'see standard body';

  const summaryText = summary ||
    `A new edition of ${standardCode} has been published. Your Electrical Maintenance Program (EMP) and maintenance schedules may reference requirements from the previous edition (${oldEdition}) that have been updated or reorganised. Review your EMP and confirm maintenance intervals remain compliant with the ${newEdition} edition.`;

  return `<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;color:#111827;background:#f9fafb;margin:0;padding:20px;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="background:#1e40af;padding:16px 24px;">
      <h2 style="margin:0;color:#fff;font-size:18px;">&#128209; Compliance Standard Updated</h2>
      <p style="margin:4px 0 0;color:#bfdbfe;font-size:13px;">${escHtml(accountName)}</p>
    </div>
    <div style="padding:20px 24px;">
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px 16px;margin-bottom:16px;">
        <div style="font-size:15px;font-weight:700;color:#1e40af;">${escHtml(standardCode)} ${escHtml(newEdition)}</div>
        <div style="font-size:12px;color:#3b82f6;margin-top:2px;">Supersedes edition ${escHtml(oldEdition)} &mdash; effective ${escHtml(effectiveDateStr)}</div>
      </div>
      <p style="font-size:14px;color:#374151;margin:0 0 12px;">${escHtml(summaryText)}</p>
      <p style="font-size:13px;color:#374151;margin:0 0 8px;"><strong>What this means for your account:</strong></p>
      <ul style="font-size:13px;color:#374151;margin:0 0 16px;padding-left:20px;">
        <li>Your Electrical Maintenance Program (EMP) should be reviewed against the new edition.</li>
        <li>Maintenance intervals and task requirements may have changed.</li>
        <li>Arc flash studies referencing the old edition may need to be updated.</li>
        <li>Insurance carriers and AHJ inspectors will begin referencing the new edition.</li>
      </ul>
      <p style="font-size:13px;color:#374151;margin:0 0 16px;">
        Schedule a compliance review with your service representative to confirm your
        program is aligned with ${escHtml(standardCode)} ${escHtml(newEdition)}.
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:20px 0 0;">
        This notification was triggered by a standard revision recorded in ServiceCycle.
        Log in to acknowledge and view your compliance calendar. Do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>`;
}

export interface StandardRevisionCronResult {
  standardsChecked: number;
  accountsAlerted:  number;
  emailsSent:       number;
  skipped:          number;
}

export async function runStandardRevisionCron(): Promise<StandardRevisionCronResult> {
  let standardsChecked = 0;
  let accountsAlerted  = 0;
  let emailsSent       = 0;
  let skipped          = 0;

  // Find standards that have been superseded but still have active schedules
  const supersededStandards = await prisma.complianceStandard.findMany({
    where: { supersededAt: { not: null } },
    select: {
      id: true, code: true, edition: true, supersededAt: true,
      taskDefinitions: {
        select: {
          schedules: {
            where: { isActive: true },
            select: { accountId: true },
          },
        },
      },
    },
  });

  for (const standard of supersededStandards) {
    standardsChecked++;

    // Collect all unique accountIds that have active schedules governed by this standard
    const accountIds = new Set<string>();
    for (const taskDef of standard.taskDefinitions) {
      for (const sched of taskDef.schedules) {
        accountIds.add(sched.accountId);
      }
    }
    if (accountIds.size === 0) continue;

    // Find the superseding edition (same code, later edition, no supersededAt)
    const newEditionRow = await prisma.complianceStandard.findFirst({
      where: {
        code:         standard.code,
        supersededAt: null,
        id:           { not: standard.id },
      },
      orderBy: { createdAt: 'desc' },
      select:  { edition: true, effectiveDate: true, keyMandate: true },
    });
    const newEdition = newEditionRow?.edition ?? 'New Edition';

    for (const accountId of accountIds) {
      // Dedup: has this account already been notified for this standard revision?
      const template = `standard_revision_${standard.id}`;
      const alreadySent = await prisma.notificationLog.findFirst({
        where: {
          accountId,
          template,
          status: 'sent',
        },
      });
      if (alreadySent) { skipped++; continue; }

      const account = await prisma.account.findUnique({
        where: { id: accountId }, select: { companyName: true },
      });
      const admins = await prisma.user.findMany({
        where: { accountId, role: { in: ['admin', 'manager'] }, isActive: true, email: { not: null } },
        select: { email: true },
      });
      if (admins.length === 0) { skipped++; continue; }

      const subject = `[Compliance] ${standard.code} updated to ${newEdition} — EMP review recommended`;
      const html    = buildRevisionHtml(
        standard.code,
        standard.edition,
        newEdition,
        newEditionRow?.effectiveDate ?? null,
        account?.companyName ?? accountId,
        newEditionRow?.keyMandate ?? null,
      );

      let sent = 0;
      for (const admin of admins) {
        try { await sendEmail({ to: admin.email, subject, html }); sent++; emailsSent++; }
        catch (e: any) { console.error('[standardRevision] email failed:', (e as any).message); }
      }

      // Log ONCE per (account, standard) so we never re-send
      await prisma.notificationLog.create({
        data: {
          accountId,
          channel:    'email',
          template,
          recipient:  admins.map((a) => a.email).join(', '),
          status:     sent > 0 ? 'sent' : 'failed',
          alertCount: 1,
        },
      }).catch(() => {});

      // Also create/update the StandardRevisionAlert row for in-app acknowledgement
      await prisma.standardRevisionAlert.upsert({
        where: {
          // Use a unique compound — fall back to create if no matching row
          // Prisma doesn't support multi-field upsert without @@unique;
          // use findFirst + create pattern instead.
          id: 'placeholder', // will never match
        },
        update: {},
        create: {
          accountId,
          standardId:   standard.id,
          newEdition,
          publishedAt:  standard.supersededAt!,
          summary:      newEditionRow?.keyMandate ?? null,
        },
      }).catch(async () => {
        // Upsert by placeholder never matches — always create via catch
        await prisma.standardRevisionAlert.create({
          data: {
            accountId,
            standardId:   standard.id,
            newEdition,
            publishedAt:  standard.supersededAt!,
            summary:      newEditionRow?.keyMandate ?? null,
          },
        }).catch(() => {});
      });

      accountsAlerted++;
    }
  }

  return { standardsChecked, accountsAlerted, emailsSent, skipped };
}

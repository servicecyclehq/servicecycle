export {};
/**
 * Partner Flywheel — daily digest cron.
 *
 * Finds all undigested PartnerEventLog records (digestSentAt IS NULL,
 * immediateEmailSentAt IS NULL, not archived, older than digestIntervalDays),
 * groups them by (partnerOrg, assignedRep), sends one consolidated email per
 * rep, and marks the records digestSentAt = now.
 *
 * Unassigned records (assignedRepId IS NULL) are sent to all oem_admin users
 * in the partner org.
 */

const prisma = require('./prisma').default;
const { sendEmail } = require('./email');

interface DigestResult {
  orgsProcessed: number;
  emailsSent: number;
  recordsMarked: number;
}

async function runPartnerDigestCron(): Promise<DigestResult> {
  let emailsSent = 0;
  let recordsMarked = 0;
  const processedOrgIds = new Set<string>();

  // Load all partner orgs that have at least one linked account with consent
  const orgs = await prisma.partnerOrganization.findMany({
    where: {
      accounts: {
        some: {
          settings: {
            some: {
              key: { in: [
                'partner_share_deficiencies',
                'partner_share_inspections',
                'partner_share_quote_requests',
                'partner_share_overdue_tasks',
              ]},
              value: 'true',
            },
          },
        },
      },
    },
    select: {
      id: true,
      name: true,
      digestIntervalDays: true,
    },
  });

  for (const org of orgs) {
    processedOrgIds.add(org.id);

    const cutoff = new Date(
      Date.now() - org.digestIntervalDays * 24 * 60 * 60 * 1000
    );

    // Fetch undigested records for this org
    const logs = await prisma.partnerEventLog.findMany({
      where: {
        partnerOrgId: org.id,
        archived: false,
        digestSentAt: null,
        immediateEmailSentAt: null,
        createdAt: { lte: cutoff },
      },
      include: {
        account: { select: { id: true, companyName: true } },
        assignedRep: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (logs.length === 0) continue;

    // Group by assignedRepId (null = unassigned bucket)
    const byRep = new Map<string | null, typeof logs>();
    for (const log of logs) {
      const key = log.assignedRepId ?? null;
      if (!byRep.has(key)) byRep.set(key, []);
      byRep.get(key)!.push(log);
    }

    for (const [repId, repLogs] of byRep) {
      // Wrap each per-rep batch in try/catch so one failure doesn't abort the
      // entire cron run — other reps still get their digests.
      try {
        // Collect IDs upfront — updateMany only fires AFTER a successful send.
        const batchIds = repLogs.map((l: any) => l.id);

        // Resolve recipients
        let recipients: Array<{ id: string; name: string; email: string }> = [];
        if (repId) {
          const rep = repLogs[0].assignedRep;
          if (rep) recipients = [rep];
        } else {
          // Send to all oem_admin users in this org
          recipients = await prisma.user.findMany({
            where: {
              role: 'oem_admin',
              isActive: true,
              account: { partnerOrgId: org.id },
            },
            select: { id: true, name: true, email: true },
          });
        }

        if (recipients.length === 0) {
          // No recipients — mark as digested so they don't pile up indefinitely.
          await prisma.partnerEventLog.updateMany({
            where: { id: { in: batchIds } },
            data: { digestSentAt: new Date() },
          });
          recordsMarked += batchIds.length;
          continue;
        }

        // Group logs by account for the email body
        const byAccount = new Map<string, typeof repLogs>();
        for (const log of repLogs) {
          const acId = log.account.id;
          if (!byAccount.has(acId)) byAccount.set(acId, []);
          byAccount.get(acId)!.push(log);
        }

        const accountCount = byAccount.size;
        const totalCount = repLogs.length;
        const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

        // C2d: inline styles use LITERAL hexes from the locked brand palette
        // (lib/pdfStyle PDF_COLORS) -- email HTML cannot use CSS variables.
        // petrol #073a52, ink #0a0d12, textMuted #1e293b, textFaint #334155,
        // borderSubtle #e3e7ee, pageBg #fafbfd.
        const accountSections = Array.from(byAccount.entries()).map(([acId, acLogs]) => {
          const acName = acLogs[0].account.companyName;
          const eventLines = acLogs.map((l: any) => {
            const badge = EVENT_BADGE[l.eventType] || l.eventType;
            const detail = formatEventDetail(l);
            return `<li>${badge}: ${detail}</li>`;
          }).join('');
          return `
            <div style="margin:16px 0;padding:12px;border-left:4px solid #073a52;background:#fafbfd;font-family:system-ui,sans-serif;font-size:14px;color:#1e293b;">
              <strong>${acName}</strong>
              <ul style="margin:8px 0 8px 16px;">${eventLines}</ul>
              <a href="${clientUrl}/accounts/${acId}" style="color:#073a52;">Open ${acName} →</a>
            </div>
          `;
        }).join('');

        const html = `
          <h2 style="margin:0 0 8px;font-family:system-ui,sans-serif;font-size:18px;color:#0a0d12;">Your ServiceCycle Activity Digest</h2>
          <p style="margin:0 0 12px;font-family:system-ui,sans-serif;font-size:14px;color:#1e293b;">${totalCount} update${totalCount !== 1 ? 's' : ''} across ${accountCount} account${accountCount !== 1 ? 's' : ''} from <strong>${org.name}</strong>.</p>
          ${accountSections}
          <hr style="border:none;border-top:1px solid #e3e7ee;"/>
          <p style="color:#334155;font-size:12px;font-family:system-ui,sans-serif;">You received this because you are a service representative at ${org.name}. Sharing is controlled by each customer account.</p>
        `;

        // Send ALL emails first — if any throw, none of the records are marked.
        for (const recipient of recipients) {
          await sendEmail({
            to: recipient.email,
            subject: `Your ServiceCycle Activity Digest — ${totalCount} update${totalCount !== 1 ? 's' : ''} across ${accountCount} account${accountCount !== 1 ? 's' : ''}`,
            html,
          });
          emailsSent++;
        }

        // Atomic mark: only reached when every email in this batch succeeded.
        await prisma.partnerEventLog.updateMany({
          where: { id: { in: batchIds } },
          data: { digestSentAt: new Date() },
        });
        recordsMarked += batchIds.length;

      } catch (repErr: any) {
        console.error(
          `[partnerDigest] Failed to process rep ${repId ?? '(unassigned)'} in org ${org.id}:`,
          repErr.message
        );
        // Continue to next rep — do not re-throw.
      }
    }
  }

  return { orgsProcessed: processedOrgIds.size, emailsSent, recordsMarked };
}

const EVENT_BADGE: Record<string, string> = {
  IMMEDIATE_DEFICIENCY:  '🔴 Immediate Deficiency',
  INSPECTION_COMPLETED:  '🔵 Inspection Completed',
  QUOTE_REQUEST_CREATED: '🟣 Quote Request',
  TASK_OVERDUE:          '🟡 Overdue Task',
};

function formatEventDetail(log: any): string {
  const p = log.payload as any;
  switch (log.eventType) {
    case 'IMMEDIATE_DEFICIENCY':
      return `${p.assetName ?? 'Asset'} — ${p.description ?? ''}`;
    case 'INSPECTION_COMPLETED':
      return `${p.assetName ?? 'Asset'} — ${p.deficiencyCount ?? 0} deficiencies found`;
    case 'QUOTE_REQUEST_CREATED':
      return `${p.assetName ?? 'Asset'} — quote requested`;
    case 'TASK_OVERDUE':
      return `${p.overdueCount ?? 1} task${(p.overdueCount ?? 1) !== 1 ? 's' : ''} overdue`;
    default:
      return '';
  }
}

module.exports = { runPartnerDigestCron };

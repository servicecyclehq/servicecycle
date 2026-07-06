/**
 * qemwAlerts.ts — QEMW credential expiry + compliance gap detection.
 *
 * ANSI/NETA EMW-2026 (approved 2026-01-06) created the Qualified Electrical
 * Equipment Maintenance Worker (QEMW) certification. 12–18 month first-mover
 * window before PowerDB or Accruent builds this.
 *
 * Two functions:
 *
 *   1. runQemwExpiryAlerts — alert at 60 days and 14 days before cert expiry.
 *      Fires per ContractorTech.qemwExpiresAt.
 *
 *   2. runQemwComplianceGap — for accounts with AccountSetting REQUIRE_QEMW=true,
 *      surface assets with NETA maintenance due that have no assigned tech with
 *      a valid QEMW cert. Creates a QuoteRequest with triggerType: 'QEMW_TRAINING'
 *      using the QEMW_TRAINING rate card entry.
 *
 * Wire: registered as daily 10:00 UTC cron in server/index.ts.
 */

import prisma from './prisma';
const { sendEmail }   = require('./email');
const { redactEmail } = require('./redact');

const MS_PER_DAY = 86_400_000;

function escHtml(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Cert expiry email ────────────────────────────────────────────────────────

function buildQemwExpiryHtml(
  techName: string,
  daysUntilExpiry: number,
  expiryDate: Date,
  contractorName: string,
  accountName: string,
): string {
  const urgencyColor = daysUntilExpiry <= 14 ? '#dc2626' : '#d97706';
  const urgencyLabel = daysUntilExpiry <= 14 ? 'URGENT' : 'Reminder';

  return `<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;color:#111827;background:#f9fafb;margin:0;padding:20px;">
  <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="background:${urgencyColor};padding:16px 24px;">
      <h2 style="margin:0;color:#fff;font-size:18px;">[${escHtml(urgencyLabel)}] QEMW Certification Expiring</h2>
      <p style="margin:4px 0 0;color:#fef2f2;font-size:13px;">${escHtml(accountName)}</p>
    </div>
    <div style="padding:20px 24px;">
      <p style="font-size:14px;color:#374151;margin:0 0 12px;">
        <strong>${escHtml(techName)}</strong> (${escHtml(contractorName)}) has a QEMW certification
        expiring in <strong style="color:${urgencyColor};">${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}</strong>
        on <strong>${expiryDate.toLocaleDateString()}</strong>.
      </p>
      <p style="font-size:13px;color:#374151;margin:0 0 12px;">
        ANSI/NETA EMW-2026 requires renewal every 3 years. An expired QEMW credential may
        create a compliance gap if your account setting requires QEMW-certified technicians
        for NETA maintenance tasks.
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:20px 0 0;">
        To update credential information, log in to ServiceCycle &gt; Contractors &gt; Technicians.
        Contact NETA to initiate renewal: neta.org. Do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── Compliance gap email ─────────────────────────────────────────────────────

function buildQemwGapHtml(
  gapCount: number,
  accountName: string,
  rateRange: string | null,
): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;color:#111827;background:#f9fafb;margin:0;padding:20px;">
  <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="background:#7c3aed;padding:16px 24px;">
      <h2 style="margin:0;color:#fff;font-size:18px;">&#9888; QEMW Compliance Gap Detected</h2>
      <p style="margin:4px 0 0;color:#ede9fe;font-size:13px;">${escHtml(accountName)}</p>
    </div>
    <div style="padding:20px 24px;">
      <p style="font-size:14px;color:#374151;margin:0 0 12px;">
        <strong>${gapCount} asset${gapCount !== 1 ? 's' : ''}</strong> have NETA maintenance due
        with no assigned technician holding a valid QEMW certification.
      </p>
      <p style="font-size:13px;color:#374151;margin:0 0 12px;">
        Your account has REQUIRE_QEMW enabled. ANSI/NETA EMW-2026 requires QEMW-certified
        technicians for qualifying electrical equipment maintenance work. A quote request
        has been opened to schedule QEMW training for your service team.
      </p>
      ${rateRange ? `<p style="font-size:13px;color:#374151;margin:0 0 12px;">Estimated training cost: <strong>${escHtml(rateRange)} per technician</strong> (platform benchmark; group rates and on-site delivery may vary).</p>` : ''}
      <p style="font-size:12px;color:#9ca3af;margin:20px 0 0;">
        Log in to ServiceCycle to view affected assets and manage technician credentials.
        Do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── main exports ─────────────────────────────────────────────────────────────

export interface QemwAlertResult {
  expiryAlerts: number;
  gapAlerts:    number;
  quoteRequests: number;
  emailsSent:   number;
  skipped:      number;
}

export async function runQemwAlerts(): Promise<QemwAlertResult> {
  let expiryAlerts  = 0;
  let gapAlerts     = 0;
  let quoteRequests = 0;
  let emailsSent    = 0;
  let skipped       = 0;

  const now = new Date();

  // ── Part 1: Cert expiry alerts ──────────────────────────────────────────────
  // Fire at 60d and 14d before expiry.
  const expiryTiers = [60, 14];

  const techs = await prisma.contractorTech.findMany({
    where: {
      qemwExpiresAt: { not: null },
    },
    select: {
      id: true, name: true, email: true,
      qemwExpiresAt: true,
      contractor: {
        select: {
          id: true, accountId: true, name: true,
          account: { select: { companyName: true } },
        },
      },
    },
  });

  for (const tech of techs) {
    const expiresAt = tech.qemwExpiresAt!;
    const msUntil   = expiresAt.getTime() - now.getTime();
    const daysUntil = Math.ceil(msUntil / MS_PER_DAY);

    // Only fire within the 60d or 14d windows (window = ±1 day of tier)
    const tier = expiryTiers.find((t) => daysUntil >= t - 1 && daysUntil <= t + 1);
    if (!tier) continue;

    expiryAlerts++;
    const accountId   = tech.contractor.accountId;
    // [2026-07-06 fallback-masks-capture fix] template used to be
    // `qemw_expiry_${tier}d` with no technician identity in it at all, and
    // the dedup lookup below only filters on (accountId, template). An
    // account with MULTIPLE technicians crossing the same tier within the
    // same 5-day window would alert the FIRST tech, then silently skip
    // every OTHER tech at that account+tier as a "duplicate" -- they were
    // never notified at all, and their own cert-expiry alert was masked by
    // an unrelated technician's already-sent row. Folding tech.id into the
    // template scopes the dedup per-technician (no schema change needed;
    // template is not parsed/matched anywhere else in the codebase).
    const template    = `qemw_expiry_${tier}d_${tech.id}`;

    // Dedup: already sent this tier for THIS tech in the last 5 days?
    const alreadySent = await prisma.notificationLog.findFirst({
      where: {
        accountId,
        template,
        sentAt: { gte: new Date(now.getTime() - 5 * MS_PER_DAY) },
        status: 'sent',
      },
    });
    if (alreadySent) { skipped++; continue; }

    // Email the tech directly if they have an email, plus account admins
    const admins = await prisma.user.findMany({
      // [2026-07-06 fallback-masks-capture fix] User.email is a required,
      // non-nullable, unique column -- `{ not: null }` against a non-nullable
      // Prisma field throws PrismaClientValidationError ("Argument `not` must
      // not be null") UNCONDITIONALLY, every single call, regardless of what
      // rows exist. The daily cron in index.ts wraps runQemwAlerts() in a
      // try/catch that only console.errors, so this has been silently
      // crashing the ENTIRE function (both expiry alerts and compliance-gap
      // detection) every time it reached this line -- the whole QEMW alert
      // feature has likely never successfully completed a run against an
      // account with a qualifying technician. `{ not: '' }` preserves the
      // original defensive intent (skip a blank/placeholder email) without
      // the invalid-argument crash.
      where: { accountId, role: { in: ['admin', 'manager'] }, isActive: true, email: { not: '' } },
      select: { email: true },
    });

    const recipients = [
      ...(tech.email ? [tech.email] : []),
      ...admins.map((a) => a.email).filter(Boolean),
    ];
    if (recipients.length === 0) { skipped++; continue; }

    const subject = `[QEMW] Certification expiring in ${daysUntil} days — ${tech.name}`;
    const html    = buildQemwExpiryHtml(
      tech.name,
      daysUntil,
      expiresAt,
      tech.contractor.name,
      tech.contractor.account.companyName,
    );

    for (const email of recipients) {
      try { await sendEmail({ to: email, subject, html }); emailsSent++; }
      catch (e: any) { console.error('[qemwAlerts] expiry email failed:', (e as any).message); }
    }

    await prisma.notificationLog.create({
      data: {
        accountId,
        channel:    'email',
        template,
        recipient:  recipients.join(', '),
        status:     'sent',
        alertCount: 1,
      },
    }).catch(() => {});
  }

  // ── Part 2: Compliance gap detection ────────────────────────────────────────
  // Accounts with REQUIRE_QEMW=true: find assets with maintenance due where
  // no assigned tech has a valid (non-expired) QEMW cert.

  const requireQemwAccounts = await prisma.accountSetting.findMany({
    where: { key: 'REQUIRE_QEMW', value: 'true' },
    select: { accountId: true },
  });

  const qemwAccountIds = requireQemwAccounts.map((s) => s.accountId);
  if (qemwAccountIds.length === 0) {
    return { expiryAlerts, gapAlerts, quoteRequests, emailsSent, skipped };
  }

  // Get NETA maintenance due schedules in those accounts
  const dueSoon = new Date(now.getTime() + 90 * MS_PER_DAY);
  const dueSchedules = await prisma.maintenanceSchedule.findMany({
    where: {
      accountId: { in: qemwAccountIds },
      isActive:  true,
      nextDueDate: { lte: dueSoon },
      asset: { archivedAt: null },
    },
    select: {
      id: true, accountId: true, assetId: true,
    },
    take: 1000,
  });

  // Get all valid QEMW certs across those accounts
  const validQemwTechs = await prisma.contractorTech.findMany({
    where: {
      qemwCertNumber: { not: null },
      OR: [
        { qemwExpiresAt: null },                           // no expiry = assume valid
        { qemwExpiresAt: { gt: now } },                    // not yet expired
      ],
      contractor: { accountId: { in: qemwAccountIds } },
    },
    select: { contractor: { select: { accountId: true } } },
  });

  const accountsWithValidQemw = new Set(validQemwTechs.map((t) => t.contractor.accountId));

  // Rate card for QEMW_TRAINING
  const qemwRate = await prisma.serviceRateCard.findFirst({
    where: { serviceType: 'QEMW_TRAINING', partnerOrgId: null, accountId: null },
  });
  const rateRange = qemwRate
    ? `$${(qemwRate.minCents / 100).toLocaleString()} – $${(qemwRate.maxCents / 100).toLocaleString()}`
    : null;

  // Group gap schedules by account
  const gapsByAccount = new Map<string, typeof dueSchedules>();
  for (const sched of dueSchedules) {
    if (accountsWithValidQemw.has(sched.accountId)) continue; // has valid certs
    if (!gapsByAccount.has(sched.accountId)) gapsByAccount.set(sched.accountId, []);
    gapsByAccount.get(sched.accountId)!.push(sched);
  }

  for (const [accountId, schedules] of gapsByAccount) {
    gapAlerts += schedules.length;

    const template = 'qemw_compliance_gap';
    const alreadySent = await prisma.notificationLog.findFirst({
      where: {
        accountId, template,
        sentAt: { gte: new Date(now.getTime() - 30 * MS_PER_DAY) },
        status: 'sent',
      },
    });
    if (alreadySent) { skipped++; continue; }

    const account = await prisma.account.findUnique({
      where: { id: accountId }, select: { companyName: true },
    });
    const admins = await prisma.user.findMany({
      // see the matching fix + comment on the expiry-alert admin lookup above
      where: { accountId, role: { in: ['admin', 'manager'] }, isActive: true, email: { not: '' } },
      select: { id: true, email: true },
    });
    if (admins.length === 0) { skipped++; continue; }

    // Create one QEMW_TRAINING quote for the account — attach to first affected asset
    const repAssetId = schedules[0].assetId;
    const existingQr = await prisma.quoteRequest.findFirst({
      where: {
        accountId, assetId: repAssetId,
        status: { in: ['requested', 'quoted'] },
        triggerType: 'QEMW_TRAINING',
      },
    });
    if (!existingQr) {
      await prisma.quoteRequest.create({
        data: {
          accountId,
          assetId:       repAssetId,
          requestedById: admins[0].id,
          driver:        'planned_replacement',
          timeline:      'within_30_days',
          status:        'requested',
          triggerType:   'QEMW_TRAINING',
          emergencyMode: false,
          notes: `Auto-triggered: REQUIRE_QEMW enabled and no technicians with valid QEMW certifications found. ${schedules.length} maintenance schedule(s) due within 90 days require QEMW-certified personnel per ANSI/NETA EMW-2026.${rateRange ? ` Estimated training: ${rateRange} per technician.` : ''}`,
        },
      }).catch((e: any) =>
        console.warn('[qemwAlerts] QuoteRequest create failed:', e.message),
      );
      quoteRequests++;
    }

    const html    = buildQemwGapHtml(schedules.length, account?.companyName ?? accountId, rateRange);
    const subject = `[QEMW] Compliance gap — ${schedules.length} maintenance tasks due without certified technicians — ${account?.companyName ?? accountId}`;

    for (const admin of admins) {
      try { await sendEmail({ to: admin.email, subject, html }); emailsSent++; }
      catch (e: any) { console.error('[qemwAlerts] gap email failed:', (e as any).message); }
    }
    await prisma.notificationLog.create({
      data: {
        accountId, channel: 'email', template,
        recipient: admins.map((a) => a.email).join(', '),
        status: 'sent', alertCount: schedules.length,
      },
    }).catch(() => {});
  }

  return { expiryAlerts, gapAlerts, quoteRequests, emailsSent, skipped };
}

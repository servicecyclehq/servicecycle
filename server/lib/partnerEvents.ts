export {};
/**
 * Partner Flywheel — central event fan-out.
 *
 * All partner events funnel through emitPartnerEvent().  It checks consent,
 * deduplicates within the digest window, resolves the assigned rep, writes a
 * PartnerEventLog row, and fires side-effects (immediate email + webhook)
 * asynchronously so failures never affect the primary write path.
 *
 * Consent keys (AccountSetting):
 *   partner_share_deficiencies     → IMMEDIATE_DEFICIENCY
 *   partner_share_inspections      → INSPECTION_COMPLETED
 *   partner_share_quote_requests   → QUOTE_REQUEST_CREATED
 *   partner_share_overdue_tasks    → TASK_OVERDUE
 */

const { createHmac } = require('crypto');
const prisma = require('./prisma').default;
const { sendEmail } = require('./email');

// Map event type → AccountSetting consent key
const CONSENT_KEYS: Record<string, string> = {
  IMMEDIATE_DEFICIENCY:   'partner_share_deficiencies',
  INSPECTION_COMPLETED:   'partner_share_inspections',
  QUOTE_REQUEST_CREATED:  'partner_share_quote_requests',
  TASK_OVERDUE:           'partner_share_overdue_tasks',
};

/**
 * Emit a partner event for the given account.
 * Fire-and-forget safe: callers should .catch(console.error) on the returned promise.
 */
async function emitPartnerEvent(
  accountId: string,
  eventType: string,
  payload: Record<string, any>
): Promise<void> {
  // 1. Load account with partner org and rep assignment
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      companyName: true,
      partnerOrgId: true,
      assignedRepId: true,
      fallbackRepId: true,
      partnerOrg: {
        select: {
          id: true,
          name: true,
          webhookUrl: true,
          webhookSecret: true,
          digestIntervalDays: true,
        },
      },
    },
  });

  if (!account?.partnerOrgId || !account.partnerOrg) return;

  // 2. Check consent
  const consentKey = CONSENT_KEYS[eventType];
  if (!consentKey) return;

  const setting = await prisma.accountSetting.findUnique({
    where: { accountId_key: { accountId, key: consentKey } },
  });
  if (setting?.value !== 'true') return;

  const partnerOrg = account.partnerOrg;

  // 3. Dedup: for non-IMMEDIATE events, skip if same accountId+eventType
  //    was already logged within the digest window and hasn't been digested yet.
  if (eventType !== 'IMMEDIATE_DEFICIENCY') {
    const windowStart = new Date(
      Date.now() - partnerOrg.digestIntervalDays * 24 * 60 * 60 * 1000
    );
    const existing = await prisma.partnerEventLog.findFirst({
      where: {
        accountId,
        eventType,
        digestSentAt: null,
        immediateEmailSentAt: null,
        createdAt: { gte: windowStart },
        archived: false,
      },
    });
    if (existing) return; // already queued in this digest window
  }

  // 4. Resolve rep: assignedRep → fallbackRep → all oem_admins in partner org
  let resolvedRepId: string | null = account.assignedRepId ?? null;

  if (!resolvedRepId && account.fallbackRepId) {
    resolvedRepId = account.fallbackRepId;
  }

  if (!resolvedRepId) {
    // Fall through to all oem_admin users — we store null and handle in digest/email
    resolvedRepId = null;
  }

  // 5. Write PartnerEventLog
  const log = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId: account.partnerOrgId,
      accountId,
      eventType,
      payload,
      assignedRepId: resolvedRepId,
    },
    include: {
      account: { select: { companyName: true } },
      assignedRep: { select: { name: true, email: true } },
    },
  });

  // 6. Fire side-effects (fire-and-forget)
  if (eventType === 'IMMEDIATE_DEFICIENCY') {
    sendImmediatePartnerEmail(log, account, partnerOrg).catch((err: any) =>
      console.error('[partnerEvents] immediate email failed', err)
    );
  }

  if (partnerOrg.webhookUrl) {
    firePartnerWebhook(log, partnerOrg).catch((err: any) =>
      console.error('[partnerEvents] webhook failed', err)
    );
  }
}

// ─── Immediate email ──────────────────────────────────────────────────────────

async function sendImmediatePartnerEmail(
  log: any,
  account: any,
  partnerOrg: any
): Promise<void> {
  const payload = log.payload as any;
  const accountName = account.companyName;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  // Resolve recipients: assignedRep or all oem_admins
  const recipients = await resolveEmailRecipients(log.assignedRepId, account.partnerOrgId);
  if (recipients.length === 0) return;

  const capExLine =
    payload.estimatedCapExMin != null && payload.estimatedCapExMax != null
      ? `<p><strong>Estimated CapEx:</strong> $${payload.estimatedCapExMin.toLocaleString()} – $${payload.estimatedCapExMax.toLocaleString()}</p>`
      : '';

  const html = `
    <h2 style="color:#c0392b;">⚠ Immediate Deficiency — Action Required</h2>
    <p><strong>Account:</strong> ${accountName}</p>
    <p><strong>Asset:</strong> ${payload.assetName ?? 'Unknown'} ${payload.assetSite ? `— ${payload.assetSite}` : ''}</p>
    <p><strong>Severity:</strong> IMMEDIATE</p>
    <p><strong>Description:</strong> ${payload.description ?? ''}</p>
    ${payload.correctiveAction ? `<p><strong>Corrective Action:</strong> ${payload.correctiveAction}</p>` : ''}
    ${capExLine}
    <p><a href="${clientUrl}/accounts/${account.id}" style="background:#c0392b;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;">Open Account →</a></p>
    <hr/>
    <p style="color:#888;font-size:12px;">This alert was sent because ${accountName} has enabled partner sharing with ${partnerOrg.name}.</p>
  `;

  for (const rep of recipients) {
    await sendEmail({
      to: rep.email,
      subject: `[${accountName}] Immediate Deficiency — Action Required`,
      html,
    });
  }

  // Mark immediateEmailSentAt
  await prisma.partnerEventLog.update({
    where: { id: log.id },
    data: { immediateEmailSentAt: new Date() },
  });
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

async function firePartnerWebhook(log: any, partnerOrg: any): Promise<void> {
  if (!partnerOrg.webhookUrl || !partnerOrg.webhookSecret) return;

  const body = JSON.stringify({
    partnerId:        partnerOrg.id,
    eventType:        log.eventType,
    accountId:        log.accountId,
    assignedRepEmail: log.assignedRep?.email ?? null,
    timestamp:        log.createdAt,
    data:             log.payload,
  });

  const sig = createHmac('sha256', partnerOrg.webhookSecret).update(body).digest('hex');

  const resp = await fetch(partnerOrg.webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ServiceCycle-Signature': `sha256=${sig}`,
    },
    body,
    signal: AbortSignal.timeout(5000),
  });

  await prisma.partnerEventLog.update({
    where: { id: log.id },
    data: { webhookSentAt: new Date() },
  });

  if (!resp.ok) {
    console.error(`[partnerEvents] webhook responded ${resp.status} for log ${log.id}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve email recipients.
 * If assignedRepId is set, return that user.
 * Otherwise return all oem_admin users in the partner org.
 */
async function resolveEmailRecipients(
  assignedRepId: string | null,
  partnerOrgId: string
): Promise<Array<{ id: string; name: string; email: string }>> {
  if (assignedRepId) {
    const user = await prisma.user.findUnique({
      where: { id: assignedRepId },
      select: { id: true, name: true, email: true },
    });
    return user ? [user] : [];
  }

  // Fall back to all oem_admin users in the partner org
  return prisma.user.findMany({
    where: {
      role: 'oem_admin',
      isActive: true,
      account: { partnerOrgId },
    },
    select: { id: true, name: true, email: true },
  });
}

module.exports = { emitPartnerEvent, sendImmediatePartnerEmail, firePartnerWebhook, resolveEmailRecipients };

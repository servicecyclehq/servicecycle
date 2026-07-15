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

const { randomUUID } = require('crypto');
const prisma = require('./prisma').default;
const { sendEmail } = require('./email');
const { postJsonToValidatedUrl, signPayload } = require('./webhook');

// Map event type → AccountSetting consent key
const CONSENT_KEYS: Record<string, string> = {
  IMMEDIATE_DEFICIENCY:   'partner_share_deficiencies',
  INSPECTION_COMPLETED:   'partner_share_inspections',
  QUOTE_REQUEST_CREATED:  'partner_share_quote_requests',
  // A customer asking to discuss their proposal (quote/call/meeting) is the same
  // demand-capture category as a quote request, so it reuses that consent gate.
  PROPOSAL_DISCUSSION_REQUESTED: 'partner_share_quote_requests',
  TASK_OVERDUE:           'partner_share_overdue_tasks',
};

/**
 * Emit a partner event for the given account.
 * Fire-and-forget safe: callers should .catch(console.error) on the returned promise.
 */
async function emitPartnerEvent(
  accountId: string,
  eventType: string,
  payload: Record<string, any>,
  // [C-13] Optional dedup scoping. When set, the in-window dedup below only
  // collapses this event against prior UNSENT events that carry the same
  // payload.dedupeKey — so a distinct signal class (e.g. an arc-flash re-study,
  // dedupeKey='ARC_FLASH_STUDY') is never swallowed by an unrelated same-type
  // event (a generic quote request) queued in the same digest window. Omitted =
  // exactly the original behavior (zero change for every existing caller).
  opts?: { dedupeKey?: string }
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
    const dedupeKey = opts?.dedupeKey;
    if (dedupeKey) {
      // [C-13] Scoped dedup. JSON-path filtering isn't used anywhere else in
      // this codebase, so fetch the (few) unsent same-type candidates and
      // discriminate in memory rather than pushing a payload filter into
      // Prisma. Only collapse against events carrying the same dedupeKey.
      const candidates = await prisma.partnerEventLog.findMany({
        where: {
          accountId,
          eventType,
          digestSentAt: null,
          immediateEmailSentAt: null,
          createdAt: { gte: windowStart },
          archived: false,
        },
        select: { payload: true },
      });
      if (candidates.some((c: any) => c.payload && c.payload.dedupeKey === dedupeKey)) return;
    } else {
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

  // [2026-07-06 signing-unification fix] This used to sign with a plain
  // body-only HMAC -- no timestamp, no replay window, indefinitely
  // replayable if a signature+payload pair ever leaked. Switched to
  // lib/webhook.ts's signPayload() over "<timestamp>.<body>", the same
  // scheme the generic account-level webhooks already use. No live partner
  // integrators exist today, so there's no wire-format compat to preserve --
  // matching fix applied to lib/partnerWebhookRetry.ts and the
  // routes/fleetDashboard.ts webhook-test route.
  const timestamp  = String(Math.floor(Date.now() / 1000));
  const deliveryId = randomUUID();
  const sig        = signPayload(body, timestamp, partnerOrg.webhookSecret);

  try {
    // [2026-07-06 SSRF fix] This used to call raw fetch() against an
    // OEM-partner-admin-configured URL with zero SSRF defense -- no HTTPS
    // requirement, no private/metadata-IP check, no DNS-rebind pinning, and
    // fetch()'s default redirect-following could bounce the request
    // anywhere. Routes through lib/webhook.ts's already-hardened
    // validateWebhookUrl() + pinned https.request (same defenses the
    // alert-engine webhook path uses) without changing this endpoint's
    // existing payload shape (signature scheme was separately unified onto
    // signPayload() above).
    const result = await postJsonToValidatedUrl({
      url: partnerOrg.webhookUrl,
      body,
      headers: {
        'Content-Type':               'application/json',
        'X-ServiceCycle-Signature':   sig,
        'X-ServiceCycle-Timestamp':   timestamp,
        'X-ServiceCycle-Delivery-Id': deliveryId,
      },
      timeoutMs: 5000,
    });

    if (!result.ok) {
      // Non-2xx response (or blocked/network failure) — record failure, do not throw.
      console.error(`[partnerEvents] webhook ${result.status ? `responded ${result.status}` : (result.reason || 'failed')} for log ${log.id}`);
      await prisma.partnerEventLog.update({
        where: { id: log.id },
        data: {
          webhookAttempts:     { increment: 1 },
          webhookLastFailedAt: new Date(),
        },
      });
      return;
    }

    await prisma.partnerEventLog.update({
      where: { id: log.id },
      data: { webhookSentAt: new Date() },
    });
  } catch (err: any) {
    // Unexpected error — record failure, do NOT throw (fire-and-forget).
    console.error(`[partnerEvents] webhook delivery failed for log ${log.id}:`, err.message);
    try {
      await prisma.partnerEventLog.update({
        where: { id: log.id },
        data: {
          webhookAttempts:     { increment: 1 },
          webhookLastFailedAt: new Date(),
        },
      });
    } catch (updateErr: any) {
      console.error('[partnerEvents] failed to record webhook failure:', updateErr.message);
    }
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

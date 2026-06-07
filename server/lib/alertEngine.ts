/**
 * LapseIQ Alert Engine
 *
 * Runs nightly to:
 *   1. Find contracts with upcoming evaluationStartByDate, cancelByDate, endDate,
 *      or PaymentInstallment due dates
 *   2. Create Alert records for each threshold (90/60/30 days)
 *   3. Send ONE digest email per recipient (not one per alert).
 *      Routing: contracts with an internalOwner go to that owner;
 *      contracts without an owner fall back to all account admins.
 *
 * Called by the cron job in index.js and also exposed as a standalone
 * function so it can be triggered manually via the API.
 */

const { redactEmail } = require('./redact'); // audit-7 item 3.1.3
import prisma from './prisma';
const { decryptIfEncrypted } = require('./crypto');
const { sendSlackMessage, buildAlertDigest } = require('./slack');
const {
  sendTeamsMessage,
  buildAlertDigest: buildTeamsAlertDigest,
} = require('./teams');
const { deliverWebhook } = require('./webhook');

// ── Email transport ───────────────────────────────────────────────────────────
function createTransport() {
  if (process.env.EMAIL_MOCK === 'true') {
    return {
      sendMail: async (opts) => {
        console.log('\nðŸ“§ [EMAIL MOCK] Would have sent:');
        console.log(`  To:      ${opts.to}`);
        console.log(`  Subject: ${opts.subject}`);
        console.log(`  ---`);
        return { messageId: 'mock-' + Date.now() };
      },
    };
  }

  // Brevo HTTP API transport. See lib/email.js for the rationale on
  // hand-rolled fetch (no SDK) and the Brevo > Resend choice.
  return {
    sendMail: async (opts) => {
      const fromRaw  = opts.from || '';
      const fromMatch = fromRaw.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
      const sender = fromMatch
        ? { name: fromMatch[1] || undefined, email: fromMatch[2] }
        : { email: fromRaw };
      const recipient = { email: opts.to };

      // S3-FN-01 (v0.75.1): AbortController + 10s timeout on Brevo fetch.
      const _ac = new AbortController();
      const _bt = setTimeout(() => _ac.abort(), 10_000);
      let resp;
      try {
        resp = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'api-key': process.env.BREVO_API_KEY,
          },
          body: JSON.stringify({
            sender,
            to: [recipient],
            subject: opts.subject,
            htmlContent: opts.html,
          }),
          signal: _ac.signal,
        });
      } catch (fetchErr) {
        clearTimeout(_bt);
        if (fetchErr.name === 'AbortError') throw new Error('Brevo request timed out after 10s');
        throw fetchErr;
      } finally {
        clearTimeout(_bt);
      }
      if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.text()).slice(0, 500); } catch { /* ignore */ }
        throw new Error(`Brevo error: HTTP ${resp.status} ${resp.statusText} - ${detail}`);
      }
      const data = await resp.json().catch(() => ({}));
      return { messageId: data.messageId || data.id || 'brevo-' + Date.now() };
    },
  };
}

const FROM_ADDRESS = process.env.EMAIL_FROM || null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(d) {
  if (!d) return 'N/A';
  return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtMoney(cost, qty) {
  if (!cost || !qty) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    .format(parseFloat(cost) * parseInt(qty));
}

// ── Digest email builder ──────────────────────────────────────────────────────
const ALERT_PRIORITY = { cancel_by: 0, review_by: 1, renewal: 2, payment_due: 3 };

const TYPE_CONFIG = {
  cancel_by:   { label: 'Cancel Window',      color: '#dc2626', bg: '#fef2f2', emoji: '🚨' },
  review_by:   { label: 'Review Due',          color: '#0d4f6e', bg: '#eaf2f6', emoji: '📋' },
  renewal:     { label: 'Renewal Approaching', color: '#7c3aed', bg: '#f5f3ff', emoji: '📅' },
  payment_due: { label: 'Payment Due',         color: '#d97706', bg: '#fffbeb', emoji: '💳' },
};

function buildDigestHtml(alerts, userName) {
  const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  const byContract = new Map();
  for (const alert of alerts) {
    const id = alert.contract.id;
    if (!byContract.has(id)) {
      byContract.set(id, { contract: alert.contract, alerts: [] });
    }
    byContract.get(id).alerts.push(alert);
  }

  const contractGroups = [...byContract.values()].sort((a, b) => {
    const aPri = Math.min(...a.alerts.map(x => ALERT_PRIORITY[x.alertType]));
    const bPri = Math.min(...b.alerts.map(x => ALERT_PRIORITY[x.alertType]));
    if (aPri !== bPri) return aPri - bPri;
    const aMin = Math.min(...a.alerts.map(x => x.daysUntil));
    const bMin = Math.min(...b.alerts.map(x => x.daysUntil));
    return aMin - bMin;
  });

  const contractCount = contractGroups.length;
  const alertCount    = alerts.length;

  function contractBlock({ contract, alerts: contractAlerts }) {
    const vendor = contract.vendor?.name || '—';
    const value  = fmtMoney(contract.costPerLicense, contract.quantity);
    contractAlerts.sort((a, b) => ALERT_PRIORITY[a.alertType] - ALERT_PRIORITY[b.alertType]);
    const hasUrgent = contractAlerts.some(a => a.daysUntil <= 7);

    const badges = contractAlerts.map(a => {
      const cfg    = TYPE_CONFIG[a.alertType] || TYPE_CONFIG.renewal;
      const daysStr = a.daysUntil === 0 ? 'today'
                    : a.daysUntil  < 0 ? 'overdue'
                    : `in ${a.daysUntil}d`;
      const extra = (a.alertType === 'payment_due' && a.paymentAmount)
        ? ` · ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(parseFloat(a.paymentAmount))}`
        : '';
      return `<span style="display:inline-block;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;color:${cfg.color};background:${cfg.bg};margin-right:6px;margin-bottom:4px;white-space:nowrap;">${cfg.emoji} ${cfg.label}${extra} — ${daysStr}</span>`;
    }).join('');

    const contractUrl = `${appUrl}/contracts/${contract.id}`;
    return `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;vertical-align:top;${hasUrgent ? 'border-left:3px solid #dc2626;padding-left:13px;' : ''}">
          <div style="margin-bottom:6px;">
            <a href="${contractUrl}" style="font-weight:700;color:#1e293b;text-decoration:none;font-size:14px;">${contract.product}</a>
            <span style="font-size:12px;color:#94a3b8;margin-left:8px;">${vendor}</span>
            ${value ? `<span style="font-size:12px;color:#94a3b8;margin-left:8px;">· ${value}</span>` : ''}
          </div>
          <div style="margin-bottom:6px;">${badges}</div>
          <div>
            <a href="${contractUrl}#renewal-summary" style="font-size:12px;color:#0f172a;text-decoration:underline;font-weight:500;">View renewal summary →</a>
          </div>
        </td>
      </tr>`;
  }

  const rows = contractGroups.map(contractBlock).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;">
  <div style="max-width:640px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
    <div style="background:#0f172a;padding:20px 28px;">
      <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.6);letter-spacing:0.08em;text-transform:uppercase;">LapseIQ — Daily Digest</div>
      <div style="font-size:20px;font-weight:700;color:#fff;margin-top:4px;">
        ${contractCount} contract${contractCount !== 1 ? 's' : ''} need${contractCount === 1 ? 's' : ''} your attention
      </div>
      <div style="font-size:13px;color:rgba(255,255,255,0.55);margin-top:4px;">
        Hi ${userName} — here's your renewal summary for ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.
        ${alertCount > contractCount ? `<span style="opacity:0.8;">(${alertCount} active alerts across ${contractCount} contract${contractCount !== 1 ? 's' : ''})</span>` : ''}
      </div>
    </div>
    <div style="padding:0;">
      <table style="width:100%;border-collapse:collapse;">
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="padding:20px 28px;border-top:1px solid #e2e8f0;">
      <a href="${appUrl}/contracts" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;">
        Open LapseIQ →
      </a>
    </div>
    <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;">
      Sent by LapseIQ — your contract renewal manager.
      <a href="${appUrl}/users" style="color:#64748b;">Manage notification preferences</a>
    </div>
  </div>
</body>
</html>`;
}

// ── Alert thresholds ──────────────────────────────────────────────────────────
// DEFAULT_THRESHOLDS drives Alert record creation (in-app bell).
// Per-user AlertPreference.daysBeforeList drives email delivery.
// Alert types where the days-before threshold is user-configurable:
const CONFIGURABLE_DAYS_TYPES = new Set(['cancel_by', 'review_by', 'renewal', 'payment_due']);

// Thresholds updated 2026-05-14: renewal + cancel_by now fire at 60/30/7 days.
// Rationale: 60 days is the industry standard "last realistic chance to cancel
// auto-renewal"; 30 days covers most vendor cancellation windows; 7 days is
// the final-warning fire for imminent deadlines. The old 90-day renewal and
// 14-day cancel_by thresholds were either too early (low signal) or too
// close together (noisy). review_by and payment_due unchanged.
const DEFAULT_THRESHOLDS = {
  // H2 (audit High, 2026-05-22): negative thresholds = overdue alerts.
  // -1 fires the day after the deadline, -7 a week after, -14 two weeks
  // after. Without these, a user on PTO who missed a 7-day cancel-by
  // alert had zero downstream signal that the window closed -- they had
  // to discover it on the next invoice. cancel_by + renewal get the
  // overdue tier; review_by + payment_due do not (review_by overdue is
  // already covered by renewal overdue; payment_due is a different
  // semantic -- overdue payments are AR-driven, not contract-driven).
  cancel_by:   [60, 30, 7, -1, -7, -14],
  review_by:   [30, 14],
  renewal:     [60, 30, 7, -1, -7, -14],
  payment_due: [30, 14, 7],
};

// ── Core alert engine ─────────────────────────────────────────────────────────

/**
 * Look up Slack settings for an account and POST a digest to the configured
 * webhook. Returns silently if Slack isn't configured for this account.
 *
 * Failure is logged at WARN, never thrown — Slack downtime must NOT take out
 * the email digest path. The cron run should still report success when only
 * Slack failed.
 */
async function deliverSlackDigest({ accountId, alertItems }) {
  if (!alertItems || alertItems.length === 0) return;

  const rows = await prisma.accountSetting.findMany({
    where: { accountId, key: { in: ['SLACK_ENABLED', 'SLACK_WEBHOOK_URL'] } },
    select: { key: true, value: true },
  });
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const enabled = map['SLACK_ENABLED'] === 'true' || process.env.SLACK_ENABLED === 'true';
  if (!enabled) return;

  // Decrypt-if-encrypted matches the storage path used by routes/settings.js.
  // Plaintext env-var fallback exists for self-hosted operators who'd rather
  // configure once in .env than per-account in the UI.
  const stored = map['SLACK_WEBHOOK_URL'];
  const webhookUrl = stored ? decryptIfEncrypted(stored) : process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const account = await prisma.account.findUnique({
    where:  { id: accountId },
    select: { companyName: true },
  });

  const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const { text, blocks } = buildAlertDigest(alertItems, {
    accountName: account?.companyName || 'LapseIQ',
    appUrl,
  });

  const result = await sendSlackMessage({ webhookUrl, text, blocks });
  if (!result.ok) {
    console.warn(`[AlertEngine] Slack digest failed for account ${accountId}: ${result.reason}`);
  } else {
    console.log(`[AlertEngine] Slack digest delivered for account ${accountId} (${alertItems.length} alerts)`);
  }
}

/**
 * Same shape as deliverSlackDigest but for Microsoft Teams. Independent
 * lookup + delivery so Slack downtime doesn't block Teams and vice versa.
 * Failures are logged at WARN, never thrown.
 */
async function deliverTeamsDigest({ accountId, alertItems }) {
  if (!alertItems || alertItems.length === 0) return;

  const rows = await prisma.accountSetting.findMany({
    where: { accountId, key: { in: ['TEAMS_ENABLED', 'TEAMS_WEBHOOK_URL'] } },
    select: { key: true, value: true },
  });
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const enabled = map['TEAMS_ENABLED'] === 'true' || process.env.TEAMS_ENABLED === 'true';
  if (!enabled) return;

  const stored = map['TEAMS_WEBHOOK_URL'];
  const webhookUrl = stored ? decryptIfEncrypted(stored) : process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) return;

  const account = await prisma.account.findUnique({
    where:  { id: accountId },
    select: { companyName: true },
  });

  const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const card = buildTeamsAlertDigest(alertItems, {
    accountName: account?.companyName || 'LapseIQ',
    appUrl,
  });

  const result = await sendTeamsMessage({ webhookUrl, card });
  if (!result.ok) {
    console.warn(`[AlertEngine] Teams digest failed for account ${accountId}: ${result.reason}`);
  } else {
    console.log(`[AlertEngine] Teams digest delivered for account ${accountId} (${alertItems.length} alerts)`);
  }
}

/**
 * Fire generic JSON webhooks for all enabled endpoints in an account.
 * One POST per alert item (not a digest) — generic HTTP consumers like
 * Zapier / n8n expect one event per trigger, not a batched summary.
 *
 * Failures are logged at WARN, never thrown, and never block email/Slack/Teams.
 */
async function deliverWebhooks({ accountId, alertItems }) {
  if (!alertItems || alertItems.length === 0) return;

  let endpoints;
  try {
    endpoints = await prisma.webhookEndpoint.findMany({
      where:  { accountId, enabled: true },
      select: { id: true, url: true, hmacSecret: true },
    });
  } catch (err) {
    console.warn(`[AlertEngine] Failed to load webhook endpoints for account ${accountId}:`, err.message);
    return;
  }

  if (endpoints.length === 0) return;

  const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  for (const endpoint of endpoints) {
    const url    = decryptIfEncrypted(endpoint.url);
    const secret = decryptIfEncrypted(endpoint.hmacSecret);

    for (const alertItem of alertItems) {
      try {
        const result = await deliverWebhook({
          url,
          hmacSecret:        secret,
          alertItem,
          appUrl,
          accountId,                  // v0.37.1 W5 MT-132: DLQ persistence
          webhookEndpointId: endpoint.id,
        });
        if (!result.ok) {
          console.warn(
            `[AlertEngine] Webhook ${endpoint.id} failed for contract ${alertItem.contract.id}: ${result.reason}`
          );
        }
      } catch (err) {
        console.warn(`[AlertEngine] Webhook ${endpoint.id} threw:`, err.message);
      }
    }

    // Null out decrypted secrets from local scope — they live in the GC'd
    // closure once the loop exits, but clear early as a defence-in-depth step.
    url    && void 0;
    secret && void 0;
  }
}

// Audit Cluster C P1 (2026-05-16): optional accountId scope. The
// pre-existing call shape `runAlertEngine()` continues to walk every
// account's contracts in a single batch (correct for self-hosted, where
// there's one account). A SaaS deploy can now loop per-account by
// passing `{ accountId }` so a single tenant with 100k contracts doesn't
// hold the rest of the platform behind one query. Default is undefined =
// no filter = original behaviour.
async function runAlertEngine({ accountId }: any = {}) {
  console.log('[AlertEngine] Starting run at', new Date().toISOString(), accountId ? `(scoped to account ${accountId})` : '(all accounts)');
  const transport = createTransport();

  let generated = 0, emailsSent = 0, skipped = 0;

  try {
    const now = new Date();
    const lookAhead = new Date(now.getTime() + 95 * 24 * 60 * 60 * 1000);

    // ── Step 1a: Contracts with upcoming renewal/cancel/review dates ──────────
    // Pass-5 / Agent 3: defensive take(1000) on the nightly alert sweep.
    // Without the cap, a single account with 50k active contracts would
    // pull every row plus include account.users every time the cron runs.
    // 1000 keeps the worst-case batch RAM bounded; on the demo droplet
    // this is the hottest cron job — runs every 4 hours.
    const contracts = await prisma.contract.findMany({
      where: {
        ...(accountId ? { accountId } : {}),
        status: { in: ['active', 'under_review'] },
        OR: [
          { cancelByDate: { gte: now, lte: lookAhead } },
          { evaluationStartByDate: { gte: now, lte: lookAhead } },
          { endDate:      { gte: now, lte: lookAhead } },
        ],
      },
      include: {
        vendor:        { select: { id: true, name: true } },
        internalOwner: { select: { id: true, name: true, email: true, isActive: true } },
        account: {
          include: {
            users: {
              where: { isActive: true },
              select: { id: true, email: true, name: true, role: true },
            },
          },
        },
      },
      take: 1000,
    });

    // ── Step 1b: Upcoming payment installments ────────────────────────────────
    // Prisma rejects a `where` clause inside an `include` for one-to-one
    // relations — the version of this query that lived here pre-2026-05-03
    // threw PrismaClientValidationError on every nightly run, which means
    // payment_due alerts have NEVER successfully fired since they shipped
    // in commit 965b7cf. Filter at the installment level via a relation
    // traversal instead; the include then just pulls the joined rows.
    const upcomingInstallments = await prisma.paymentInstallment.findMany({
      where: {
        dueDate: { gte: now, lte: lookAhead },
        paymentSchedule: {
          contract: {
            status: { in: ['active', 'under_review'] },
            ...(accountId ? { accountId } : {}),
          },
        },
      },
      include: {
        paymentSchedule: {
          include: {
            contract: {
              include: {
                vendor:        { select: { id: true, name: true } },
                internalOwner: { select: { id: true, name: true, email: true, isActive: true } },
                account: {
                  include: {
                    users: {
                      where: { isActive: true },
                      select: { id: true, email: true, name: true, role: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    // ── Step 1c: Pre-fetch existing alerts for dedup ──────────────────────────
    // The previous version of this engine ran one findFirst + one create per
    // (contract × alertType × threshold) hit — up to N×9 round-trips per run
    // for renewal/cancel/review plus one each for payment_due thresholds. The
    // Opus N+1 audit (2026-05-02) flagged this as the highest-priority cron-
    // path waste. Replaced with two bulk-fetches + an in-memory Set check;
    // newly-fired alerts are batched into a single createMany at the end.
    //
    // Two distinct dedup windows:
    //   - cancel_by / review_by / renewal: dedup on EVER having fired with
    //     status sent|acknowledged for the same (contractId, alertType,
    //     daysBeforeEnd). The threshold-window-passed dedup is forever.
    //   - payment_due: dedup only within the last 7 days. Payment cycles
    //     repeat (annual / quarterly / monthly), so a row two years ago for
    //     the same threshold shouldn't suppress today's fire.

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const contractIds = contracts.map((c) => c.id);
    const paymentContractIds = upcomingInstallments
      .map((i) => i.paymentSchedule?.contract?.id)
      .filter(Boolean);

    const [existingNonPayment, existingPayment] = await Promise.all([
      contractIds.length === 0 ? Promise.resolve([]) : prisma.alert.findMany({
        where: {
          contractId: { in: contractIds },
          alertType:  { in: ['cancel_by', 'review_by', 'renewal'] },
          status:     { in: ['sent', 'acknowledged'] },
        },
        select: { contractId: true, alertType: true, daysBeforeEnd: true },
      }),
      paymentContractIds.length === 0 ? Promise.resolve([]) : prisma.alert.findMany({
        where: {
          contractId: { in: paymentContractIds },
          alertType:  'payment_due',
          status:     { in: ['sent', 'acknowledged'] },
          createdAt:  { gte: sevenDaysAgo },
        },
        select: { contractId: true, daysBeforeEnd: true },
      }),
    ]);

    // Sets keyed by stable string composites so lookup is O(1) per check.
    const firedNonPayment = new Set(
      existingNonPayment.map((a) => `${a.contractId}|${a.alertType}|${a.daysBeforeEnd}`)
    );
    const firedPayment = new Set(
      existingPayment.map((a) => `${a.contractId}|${a.daysBeforeEnd}`)
    );

    // Batch buffer for newly-fired alerts. createMany after the loops.
    const newAlerts = [];

    // ── Step 2: Determine which alerts fire today ─────────────────────────────
    // accountDigests: Map<accountId, { users: User[], alertItems: AlertItem[] }>
    const accountDigests = new Map();

    function ensureDigest(accountId, users) {
      if (!accountDigests.has(accountId)) {
        accountDigests.set(accountId, { users, alertItems: [] });
      }
    }

    // Process renewal/cancel/review alerts
    for (const contract of contracts) {
      const checks = [
        { date: contract.cancelByDate, alertType: 'cancel_by',  thresholds: DEFAULT_THRESHOLDS.cancel_by },
        { date: contract.evaluationStartByDate, alertType: 'review_by',  thresholds: DEFAULT_THRESHOLDS.review_by },
        { date: contract.endDate,      alertType: 'renewal',    thresholds: DEFAULT_THRESHOLDS.renewal },
      ];

      for (const { date, alertType, thresholds } of checks) {
        if (!date) continue;
        const daysUntil = Math.ceil((new Date(date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        // H2 (2026-05-22): for renewal + cancel_by the thresholds array
        // now includes negative values (overdue). review_by has no
        // overdue tier -- skip when its calendar date has passed.
        if (daysUntil < 0 && alertType === 'review_by') continue;

        for (const threshold of thresholds) {
          // H2 (2026-05-22): match window widened from |delta|<=1 to <=5
          // so a 2-4 day cron outage doesn't permanently skip a threshold.
          // The existing in-memory firedNonPayment Set + DB dedup prevent
          // any double-fire within the wider window.
          if (Math.abs(daysUntil - threshold) > 5) continue;

          const key = `${contract.id}|${alertType}|${threshold}`;
          if (firedNonPayment.has(key)) { skipped++; continue; }
          // Add to the Set so a second pass over the same key in this run
          // (e.g., daysUntil 30 falling within ±1 of two adjacent thresholds)
          // doesn't double-fire.
          firedNonPayment.add(key);

          newAlerts.push({
            contractId: contract.id,
            accountId:  contract.accountId,
            alertType,
            daysBeforeEnd: threshold,
            scheduledAt: now,
            status: 'sent',
            sentAt: now,
          });

          ensureDigest(contract.accountId, contract.account.users);
          accountDigests.get(contract.accountId).alertItems.push({ contract, alertType, daysUntil });
        }
      }
    }

    // Process payment_due alerts
    for (const installment of upcomingInstallments) {
      const contract = installment.paymentSchedule?.contract;
      if (!contract || !['active', 'under_review'].includes(contract.status)) continue;
      if (!installment.dueDate) continue;

      const daysUntil = Math.ceil((new Date(installment.dueDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      // payment_due has no overdue tier (handled by AR side, not contract)
      if (daysUntil < 0) continue;

      for (const threshold of DEFAULT_THRESHOLDS.payment_due) {
        // H2 (2026-05-22): widen match window from ±1 to ±5 days (see
        // non-payment loop comment above for rationale).
        if (Math.abs(daysUntil - threshold) > 5) continue;

        const key = `${contract.id}|${threshold}`;
        if (firedPayment.has(key)) { skipped++; continue; }
        firedPayment.add(key);

        newAlerts.push({
          contractId: contract.id,
          accountId:  contract.accountId,
          alertType:  'payment_due',
          daysBeforeEnd: threshold,
          scheduledAt: now,
          status: 'sent',
          sentAt: now,
        });

        ensureDigest(contract.accountId, contract.account.users);
        accountDigests.get(contract.accountId).alertItems.push({
          contract,
          alertType:     'payment_due',
          daysUntil,
          paymentAmount: installment.amount ? String(installment.amount) : null,
        });
      }
    }

    // ── Step 2b: Batch-insert all newly-fired alerts in a single round-trip ──
    // Replaces the previous per-hit `prisma.alert.create()` calls. With
    // skipDuplicates a concurrent run that fires the same key gets harmlessly
    // skipped at the DB level (the dedup Set covers within-run; this covers
    // race-with-another-runner).
    if (newAlerts.length > 0) {
      const batchResult = await prisma.alert.createMany({
        data: newAlerts,
        skipDuplicates: true,
      });
      generated = batchResult.count;
    }

    // ── Step 3: Route and send digests ────────────────────────────────────────
    // Each alert item goes to:
    //   - the contract's internalOwner (if one is set and they are active), OR
    //   - all active admins on the account (fallback for unowned contracts)
    //
    // Per-user AlertPreference controls:
    //   - emailEnabled:  false → user never gets emailed for this alert type
    //   - daysBeforeList: only email if daysUntil matches one of their configured thresholds
    //
    // Alert DB records are still created regardless (drives in-app bell).

    for (const [accountId, { users, alertItems }] of accountDigests) {
      if (alertItems.length === 0) continue;
      // S2-FN-01 (v0.74.1): per-tenant try/catch — one bad account cannot abort the whole digest run.
      try {
      const pfx = `[AlertEngine][${accountId.slice(0,8)}]`; // S5-FN-11 (v0.74.0)

      alertItems.sort((a, b) =>
        (ALERT_PRIORITY[a.alertType] ?? 99) - (ALERT_PRIORITY[b.alertType] ?? 99) || a.daysUntil - b.daysUntil
      );

      const admins = users.filter(u => u.role === 'admin');

      // Collect all potential recipient IDs for a single-query preference load
      const potentialRecipientIds = new Set([
        ...admins.map(u => u.id),
        ...alertItems.map(a => a.contract.internalOwner?.id).filter(Boolean),
      ]);

      const prefRows = await prisma.alertPreference.findMany({
        where: { userId: { in: [...potentialRecipientIds] } },
      });

      // prefsByUser: userId → { alertType → AlertPreference }
      const prefsByUser = {};
      for (const pref of prefRows) {
        if (!prefsByUser[pref.userId]) prefsByUser[pref.userId] = {};
        prefsByUser[pref.userId][pref.alertType] = pref;
      }

      // Returns true if a user's preferences allow this alert to be emailed
      function userWantsEmail(userId, alertType, daysUntil) {
        const pref = prefsByUser[userId]?.[alertType];
        // No preference row → use defaults (email on, all default thresholds)
        if (!pref) return true;
        if (!pref.emailEnabled) return false;
        // For time-configurable types, check the user's day thresholds
        if (CONFIGURABLE_DAYS_TYPES.has(alertType)) {
          const days = pref.daysBeforeList
            .split(',')
            .map(d => parseInt(d.trim(), 10))
            .filter(n => !isNaN(n));
          return days.some(d => Math.abs(daysUntil - d) <= 1);
        }
        return true;
      }

      // Build per-recipient buckets, respecting preferences
      const recipientDigests = new Map(); // userId → { user, alertItems[] }

      function addToRecipient(user, alertItem) {
        if (!userWantsEmail(user.id, alertItem.alertType, alertItem.daysUntil)) return;
        if (!recipientDigests.has(user.id)) {
          recipientDigests.set(user.id, { user, alertItems: [] });
        }
        recipientDigests.get(user.id).alertItems.push(alertItem);
      }

      for (const alertItem of alertItems) {
        const owner = alertItem.contract.internalOwner;
        if (owner && owner.isActive) {
          addToRecipient(owner, alertItem);
        } else {
          for (const admin of admins) {
            addToRecipient(admin, alertItem);
          }
        }
      }

      // Send one digest per recipient (skip if preference filtering left them nothing)
      for (const { user, alertItems: userAlerts } of recipientDigests.values()) {
        if (userAlerts.length === 0) continue;
        try {
          if (!FROM_ADDRESS) {
            console.warn('${pfx} EMAIL_FROM not set — skipping digest for', redactEmail(user.email));
            continue;
          }
          const contractCount = new Set(userAlerts.map(a => a.contract.id)).size;
          const html    = buildDigestHtml(userAlerts, user.name);
          const subject = `📋 LapseIQ: ${contractCount} contract${contractCount !== 1 ? 's' : ''} need${contractCount === 1 ? 's' : ''} attention — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

          const sendResult = await transport.sendMail({ from: FROM_ADDRESS, to: user.email, subject, html });
          emailsSent++;
          console.log(`${pfx} Digest sent to ${redactEmail(user.email)} (${userAlerts.length} alerts, ${contractCount} contracts)`);
          // S5-FN-07: record successful send
          prisma.notificationLog.create({ data: {
            accountId, userId: user.id, channel: 'email', template: 'alert_digest',
            recipient: user.email, providerMessageId: sendResult?.messageId || null,
            status: 'sent', alertCount: userAlerts.length,
          } }).catch(e => console.warn('[AlertEngine] NotifLog insert failed:', e.message));
        } catch (emailErr) {
          console.error(`${pfx} Failed to send digest to ${redactEmail(user.email)}:`, emailErr.message);
          // S5-FN-07: record failed send
          prisma.notificationLog.create({ data: {
            accountId, userId: user.id, channel: 'email', template: 'alert_digest',
            recipient: user.email, status: 'failed',
            errorMessage: emailErr.message, alertCount: userAlerts.length,
          } }).catch(e => console.warn('[AlertEngine] NotifLog insert failed:', e.message));
        }
      }

      // ── Slack digest (one per account, all alerts in this run) ──────────
      // Slack channels are shared spaces — sending one message per recipient
      // (the email model) would spam the channel. Send one consolidated
      // digest using the same alertItems pool so coverage matches what
      // recipients see in their email inboxes. Failure here is logged but
      // never fatal; the email path is the source of truth.
      try {
        await deliverSlackDigest({ accountId, alertItems });
      } catch (slackErr) {
        console.warn(`${pfx} Slack delivery skipped for account ${accountId}:`, slackErr.message);
      }

      // Teams digest — same once-per-account pattern as Slack. Independent
      // try/catch so a Teams failure never affects Slack delivery (or
      // vice versa).
      try {
        await deliverTeamsDigest({ accountId, alertItems });
      } catch (teamsErr) {
        console.warn(`${pfx} Teams delivery skipped for account ${accountId}:`, teamsErr.message);
      }

      // Generic webhooks — one POST per alert item to each enabled endpoint.
      // Runs after Slack + Teams so platform-specific delivery is never
      // delayed by a slow external HTTP endpoint.
      try {
        await deliverWebhooks({ accountId, alertItems });
      } catch (webhookErr) {
        console.warn(`${pfx} Webhook delivery skipped:`, webhookErr.message);
      }
      } catch (tenantErr) {
        const _pfx = '[AlertEngine][' + accountId.slice(0,8) + ']';
        console.error(_pfx + ' Tenant digest run failed - skipping account:', tenantErr.message);
      }
    }

    console.log(`[AlertEngine] Done - ${generated} alert records created, ${emailsSent} digest emails sent, ${skipped} skipped`);
    return { generated, emailsSent, skipped };
  } catch (err) {
    console.error('[AlertEngine] Fatal error:', err);
    throw err;
  }
}

module.exports = { runAlertEngine };

export {};

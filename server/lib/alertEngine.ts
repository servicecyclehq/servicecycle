/**
 * ServiceCycle Alert Engine
 *
 * Runs on a cron to:
 *   1. Find active MaintenanceSchedules whose nextDueDate is approaching
 *      (lead tiers) or past (overdue/escalation tiers)
 *   2. Create Alert records for each tier crossed (drives the in-app bell)
 *   3. Send ONE digest email per recipient (not one per alert), plus
 *      account-level Slack / Teams digests and per-alert generic webhooks.
 *
 * Tier matrix (KICKOFF — engineer scheduling on outage work needs the long
 * 180/120-day horizon that renewal tooling never had):
 *
 *   leadDays  alertType          recipients (by role)
 *   ────────  ─────────────────  ───────────────────────────────────────────
 *    180      maintenance_due    consultant (Maintenance Vendor acct mgr —
 *                                engineer booking window opens)
 *    120      maintenance_due    consultant (contractor confirmation needed)
 *     90      maintenance_due    manager + admin (customer planning notice)
 *     60      maintenance_due    manager (outage coordination)
 *     30      maintenance_due    admin + manager + consultant (final prep)
 *      7      maintenance_due    manager + consultant (imminent reminder)
 *     -1      overdue            manager (supervisor)
 *     -7      escalation         admin (plant manager — tier 1)
 *    -30      escalation         admin (executive / compliance — tier 2)
 *    -90      regulatory_breach  admin + manager + consultant, PLUS an
 *                                ActivityLog row (audit trail requirement)
 *
 * OWNER ROUTING: when the alerting asset has an ACTIVE owner (Asset.ownerId,
 * the responsible person), the owner receives EVERY tier for that asset in
 * addition to the role-matrix targets above. Per-user AlertPreference checks
 * (emailEnabled / daysBeforeList) still apply to the owner like any other
 * recipient; the admin fallback for tiers with no role match is unchanged.
 *
 * Overdue tiers are encoded as NEGATIVE leadDays on the Alert row so the
 * (scheduleId, alertType, leadDays) dedup key stays uniform across all tiers.
 *
 * Dedup is per maintenance CYCLE: schedules recur, so an alert fired for the
 * previous cycle must not suppress this cycle's alerts. We compare
 * Alert.createdAt against schedule.lastCompletedDate — alerts created before
 * the last completion belong to a previous cycle and are ignored.
 *
 * Called by the cron job in index.ts and also exposed standalone so it can be
 * triggered manually via the API.
 */

const { redactEmail } = require('./redact');
import prisma from './prisma';
const { decryptIfEncrypted } = require('./crypto');
const { sendSlackMessage, buildAlertDigest } = require('./slack');
const {
  sendTeamsMessage,
  buildAlertDigest: buildTeamsAlertDigest,
} = require('./teams');
const { deliverWebhook, postOnce, validateWebhookUrl, signPayload, EVENT_NAMES } = require('./webhook');
const { assetDisplayName } = require('./email');
const { writeLog } = require('./activityLog');
const { v4: uuidv4 } = require('uuid');

// ── Email transport (inherited Brevo HTTP pattern — see lib/email.ts) ────────
function createTransport() {
  if (process.env.EMAIL_MOCK === 'true') {
    return {
      sendMail: async (opts) => {
        console.log('\n[EMAIL MOCK] Would have sent:');
        console.log(`  To:      ${opts.to}`);
        console.log(`  Subject: ${opts.subject}`);
        console.log(`  ---`);
        return { messageId: 'mock-' + Date.now() };
      },
    };
  }

  return {
    sendMail: async (opts) => {
      const fromRaw  = opts.from || '';
      const fromMatch = fromRaw.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
      const sender = fromMatch
        ? { name: fromMatch[1] || undefined, email: fromMatch[2] }
        : { email: fromRaw };
      const recipient = { email: opts.to };

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

// Rep-facing daily digest (email/Slack/Teams) is OFF by default — the cadenced
// repBriefing (default monthly) now owns rep outbound, so reps don't get a daily
// firehose. In-app Alert rows, webhooks, and partner events still fire here.
// Set ALERT_LEGACY_DIGEST=on to restore the old daily email/Slack/Teams digest.
const LEGACY_DIGEST = process.env.ALERT_LEGACY_DIGEST === 'on';

// ── Locale helpers ────────────────────────────────────────────────────────────
import { DEFAULT_LOCALE } from './locale';

function fmtDate(d: Date | string | null, opts: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', year: 'numeric' }): string {
  if (!d) return 'N/A';
  return new Date(d).toLocaleDateString(DEFAULT_LOCALE, opts);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(d) {
  if (!d) return 'N/A';
  return fmtDate(d, { month: 'long', day: 'numeric', year: 'numeric' });
}

// ── Tier definitions ──────────────────────────────────────────────────────────
// Positive = days BEFORE nextDueDate; negative = days AFTER (overdue tiers).
// roles: which account roles receive the email for that tier. The in-app
// Alert row is created regardless — role routing gates email only.
const TIERS = [
  { leadDays: 180, alertType: 'maintenance_due',   roles: ['consultant'] },
  { leadDays: 120, alertType: 'maintenance_due',   roles: ['consultant'] },
  { leadDays:  90, alertType: 'maintenance_due',   roles: ['manager', 'admin'] },
  { leadDays:  60, alertType: 'maintenance_due',   roles: ['manager'] },
  { leadDays:  30, alertType: 'maintenance_due',   roles: ['admin', 'manager', 'consultant'] },
  { leadDays:   7, alertType: 'maintenance_due',   roles: ['manager', 'consultant'] },
  { leadDays:  -1, alertType: 'overdue',           roles: ['manager'] },
  { leadDays:  -7, alertType: 'escalation',        roles: ['admin'] },
  { leadDays: -30, alertType: 'escalation',        roles: ['admin'] },
  { leadDays: -90, alertType: 'regulatory_breach', roles: ['admin', 'manager', 'consultant'] },
];

const ALERT_PRIORITY = { regulatory_breach: 0, escalation: 1, overdue: 2, maintenance_due: 3 };

const TYPE_CONFIG = {
  regulatory_breach: { label: 'Regulatory Breach Risk', color: '#dc2626', bg: '#fef2f2' },
  escalation:        { label: 'Escalation',             color: '#dc2626', bg: '#fef2f2' },
  overdue:           { label: 'Overdue',                color: '#d97706', bg: '#fffbeb' },
  maintenance_due:   { label: 'Maintenance Due',        color: '#0d4f6e', bg: '#eaf2f6' },
};

// Per-user AlertPreference.daysBeforeList only applies to the positive
// lead-time tiers; overdue/escalation/breach always deliver (suppressing an
// overdue compliance signal via preference would defeat the product).
const CONFIGURABLE_DAYS_TYPES = new Set(['maintenance_due']);

// ── Digest email builder ──────────────────────────────────────────────────────
function buildDigestHtml(alerts, userName) {
  const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  // Group by asset so one transformer with three due tasks renders as one
  // block with three badges, not three scattered rows.
  const byAsset = new Map();
  for (const alert of alerts) {
    const id = alert.asset.id;
    if (!byAsset.has(id)) byAsset.set(id, { asset: alert.asset, alerts: [] });
    byAsset.get(id).alerts.push(alert);
  }

  const assetGroups = [...byAsset.values()].sort((a, b) => {
    const aPri = Math.min(...a.alerts.map(x => ALERT_PRIORITY[x.alertType] ?? 9));
    const bPri = Math.min(...b.alerts.map(x => ALERT_PRIORITY[x.alertType] ?? 9));
    if (aPri !== bPri) return aPri - bPri;
    return Math.min(...a.alerts.map(x => x.daysUntil)) - Math.min(...b.alerts.map(x => x.daysUntil));
  });

  const assetCount = assetGroups.length;
  const alertCount = alerts.length;

  function assetBlock({ asset, alerts: assetAlerts }) {
    const siteName = asset.site?.name || '—';
    assetAlerts.sort((a, b) => (ALERT_PRIORITY[a.alertType] ?? 9) - (ALERT_PRIORITY[b.alertType] ?? 9));
    const hasUrgent = assetAlerts.some(a => a.daysUntil <= 7);

    const badges = assetAlerts.map(a => {
      const cfg = TYPE_CONFIG[a.alertType] || TYPE_CONFIG.maintenance_due;
      const daysStr = a.daysUntil === 0 ? 'due today'
                    : a.daysUntil  < 0 ? `${Math.abs(a.daysUntil)}d overdue`
                    : `due in ${a.daysUntil}d`;
      const task = a.schedule?.taskDefinition?.taskName || 'Maintenance';
      return `<span style="display:inline-block;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;color:${cfg.color};background:${cfg.bg};margin-right:6px;margin-bottom:4px;white-space:nowrap;">${cfg.label}: ${task} — ${daysStr}</span>`;
    }).join('');

    const assetUrl = `${appUrl}/assets/${asset.id}`;
    return `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;vertical-align:top;${hasUrgent ? 'border-left:3px solid #dc2626;padding-left:13px;' : ''}">
          <div style="margin-bottom:6px;">
            <a href="${assetUrl}" style="font-weight:700;color:#1e293b;text-decoration:none;font-size:14px;">${assetDisplayName(asset)}</a>
            <span style="font-size:12px;color:#94a3b8;margin-left:8px;">${siteName}</span>
          </div>
          <div style="margin-bottom:6px;">${badges}</div>
          <div>
            <a href="${assetUrl}" style="font-size:12px;color:#0f172a;text-decoration:underline;font-weight:500;">View asset & schedule →</a>
          </div>
        </td>
      </tr>`;
  }

  const rows = assetGroups.map(assetBlock).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;">
  <div style="max-width:640px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
    <div style="background:#0f172a;padding:20px 28px;">
      <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.6);letter-spacing:0.08em;text-transform:uppercase;">ServiceCycle — Maintenance Digest</div>
      <div style="font-size:20px;font-weight:700;color:#fff;margin-top:4px;">
        ${assetCount} asset${assetCount !== 1 ? 's' : ''} need${assetCount === 1 ? 's' : ''} attention
      </div>
      <div style="font-size:13px;color:rgba(255,255,255,0.55);margin-top:4px;">
        Hi ${userName} — here's your maintenance compliance summary for ${fmtDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.
        ${alertCount > assetCount ? `<span style="opacity:0.8;">(${alertCount} active alerts across ${assetCount} asset${assetCount !== 1 ? 's' : ''})</span>` : ''}
      </div>
    </div>
    <div style="padding:0;">
      <table style="width:100%;border-collapse:collapse;">
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="padding:20px 28px;border-top:1px solid #e2e8f0;">
      <a href="${appUrl}/assets" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;">
        Open ServiceCycle →
      </a>
    </div>
    <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;">
      Sent by ServiceCycle — your equipment maintenance compliance platform.
      <a href="${appUrl}/users" style="color:#64748b;">Manage notification preferences</a>
    </div>
  </div>
</body>
</html>`;
}

// ── Channel delivery (inherited patterns — failure never blocks email) ───────

async function deliverSlackDigest({ accountId, alertItems }) {
  if (!alertItems || alertItems.length === 0) return;

  const rows = await prisma.accountSetting.findMany({
    where: { accountId, key: { in: ['SLACK_ENABLED', 'SLACK_WEBHOOK_URL'] } },
    select: { key: true, value: true },
  });
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const enabled = map['SLACK_ENABLED'] === 'true' || process.env.SLACK_ENABLED === 'true';
  if (!enabled) return;

  const stored = map['SLACK_WEBHOOK_URL'];
  const webhookUrl = stored ? decryptIfEncrypted(stored) : process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const account = await prisma.account.findUnique({
    where:  { id: accountId },
    select: { companyName: true },
  });

  const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const { text, blocks } = buildAlertDigest(alertItems, {
    accountName: account?.companyName || 'ServiceCycle',
    appUrl,
  });

  const result = await sendSlackMessage({ webhookUrl, text, blocks });
  if (!result.ok) {
    console.warn(`[AlertEngine] Slack digest failed for account ${accountId}: ${result.reason}`);
  } else {
    console.log(`[AlertEngine] Slack digest delivered for account ${accountId} (${alertItems.length} alerts)`);
  }
}

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
    accountName: account?.companyName || 'ServiceCycle',
    appUrl,
  });

  const result = await sendTeamsMessage({ webhookUrl, card });
  if (!result.ok) {
    console.warn(`[AlertEngine] Teams digest failed for account ${accountId}: ${result.reason}`);
  } else {
    console.log(`[AlertEngine] Teams digest delivered for account ${accountId} (${alertItems.length} alerts)`);
  }
}

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

  const deliveryPromises: Promise<void>[] = [];
  for (const endpoint of endpoints) {
    const url    = decryptIfEncrypted(endpoint.url);
    const secret = decryptIfEncrypted(endpoint.hmacSecret);

    for (const alertItem of alertItems) {
      deliveryPromises.push(
        deliverWebhook({
          url,
          hmacSecret:        secret,
          alertItem,
          appUrl,
          accountId,
          webhookEndpointId: endpoint.id,
        }).then((result: any) => {
          if (!result.ok) {
            console.warn(
              `[AlertEngine] Webhook ${endpoint.id} failed for asset ${alertItem.asset.id}: ${result.reason}`
            );
          }
        }).catch((err: any) => {
          console.error('[alertEngine] webhook delivery failed:', err?.message);
        })
      );
    }
  }
  await Promise.allSettled(deliveryPromises);
}

// ── Event-webhook delivery (new alert types: deficiency, arc-flash, asset) ────
//
// deliverEventWebhooks delivers a raw event payload (not the maintenance-tier
// alertItem shape) to every enabled webhook endpoint for an account.
//
// Callers (assetAlertNotifier.ts, arcFlashAlertEngine.ts, etc.) use this to
// fan-out deficiency.created, arc_flash.expiring, asset.condition_changed, and
// asset.decommissioned webhooks alongside their existing email sends.
//
// Usage (fire-and-forget, caller must .catch()):
//   await deliverEventWebhooks(accountId, 'deficiency.created', {
//     deficiencyId, assetId, severity, description, triggeredAt,
//   });
//
// The payload is merged with { event, sentAt } before signing. The signing
// and SSRF logic (including retry + DLQ) are delegated to postOnce /
// signPayload / validateWebhookUrl from webhook.ts, matching the existing
// maintenance-tier delivery path exactly.

const DEFAULT_TIMEOUT_MS_EVENT = 5000;
const RETRY_BACKOFF_EVENT = [1000, 4000, 16000];
const MAX_ATTEMPTS_EVENT  = RETRY_BACKOFF_EVENT.length + 1;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export async function deliverEventWebhooks(
  accountId: string,
  eventName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  let endpoints;
  try {
    endpoints = await prisma.webhookEndpoint.findMany({
      where:  { accountId, enabled: true },
      select: { id: true, url: true, hmacSecret: true },
    });
  } catch (err: any) {
    console.warn(`[AlertEngine] deliverEventWebhooks: failed to load endpoints for account ${accountId}:`, err.message);
    return;
  }
  if (!endpoints || endpoints.length === 0) return;

  const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const fullPayload = {
    event:   eventName,
    ...payload,
    appUrl,
    sentAt:  new Date().toISOString(),
  };
  const body       = JSON.stringify(fullPayload);
  const timestamp  = String(Math.floor(Date.now() / 1000));
  const deliveryId = uuidv4();

  for (const endpoint of endpoints) {
    const url    = decryptIfEncrypted(endpoint.url);
    const secret = decryptIfEncrypted(endpoint.hmacSecret);
    const signature = signPayload(body, timestamp, secret);

    const { valid, reason: ssrfReason, addresses } = await validateWebhookUrl(url);
    if (!valid) {
      console.warn(`[AlertEngine] deliverEventWebhooks: blocked delivery to "${url}": ${ssrfReason}`);
      continue;
    }

    let lastResult: any = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_EVENT; attempt++) {
      if (attempt > 1) await sleep(RETRY_BACKOFF_EVENT[attempt - 2]);
      try {
        lastResult = await postOnce({ url, addresses, body, signature, timestamp, deliveryId, timeoutMs: DEFAULT_TIMEOUT_MS_EVENT });
        if (lastResult.ok) break;
        const status = lastResult.status;
        if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) break;
      } catch (e: any) {
        lastResult = { ok: false, reason: e?.message || 'threw' };
      }
    }

    if (!lastResult?.ok) {
      console.warn(
        `[AlertEngine] deliverEventWebhooks: endpoint ${endpoint.id} failed for event "${eventName}": ${lastResult?.reason ?? 'unknown'}`,
      );
    }
  }
}

// ── Core alert engine ─────────────────────────────────────────────────────────
// Optional accountId scope (inherited Cluster C P1 pattern): default
// undefined = sweep every account in one batch (correct for self-hosted).
async function runAlertEngine({ accountId }: any = {}) {
  console.log('[AlertEngine] Starting run at', new Date().toISOString(), accountId ? `(scoped to account ${accountId})` : '(all accounts)');
  const transport = createTransport();

  let generated = 0, emailsSent = 0, skipped = 0;

  try {
    const now = new Date();
    // Window: 185d ahead covers the 180d booking tier with cron-outage slack;
    // unbounded below so deep-overdue schedules keep escalating until fixed.
    const lookAhead = new Date(now.getTime() + 185 * 24 * 60 * 60 * 1000);

    const newAlerts = [];
    const breachLogs = []; // -90d tier writes an audit-trail row

    // accountDigests: Map<accountId, { users, alertItems[] }>
    const accountDigests = new Map();
    function ensureDigest(accId, users) {
      if (!accountDigests.has(accId)) accountDigests.set(accId, { users, alertItems: [] });
    }

    // fired: global dedup Set across all cursor pages — keyed by
    // scheduleId|alertType|leadDays. Populated per batch from the DB
    // (existing sent/acknowledged alerts that belong to the CURRENT cycle).
    const fired = new Set<string>();

    // ── Cursor-paginated schedule sweep — removes the 2000-row hard cap ──────
    let cursor: string | undefined;
    while (true) {
      const batch = await prisma.maintenanceSchedule.findMany({
        where: {
          ...(accountId ? { accountId } : {}),
          isActive:    true,
          nextDueDate: { not: null, lte: lookAhead },
          asset: { archivedAt: null, inService: true },
        },
        take: 500,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        include: {
          taskDefinition: { select: { id: true, taskName: true, taskCode: true, standardRef: true } },
          asset: {
            select: {
              id: true, equipmentType: true, manufacturer: true, model: true,
              serialNumber: true, accountId: true,
              site: { select: { id: true, name: true } },
              // Responsible person — owner-aware routing adds this user as a
              // digest recipient for every tier on their assets. isActive rides
              // along so a deactivated owner is skipped at routing time.
              owner: { select: { id: true, email: true, name: true, role: true, isActive: true } },
            },
          },
          account: {
            include: {
              users: {
                where:  { isActive: true },
                select: { id: true, email: true, name: true, role: true },
              },
            },
          },
        },
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;

      // ── Dedup pre-fetch (per batch) ────────────────────────────────────
      // One bulk fetch + in-memory Set (inherited N+1 audit fix). Cycle-aware:
      // alerts created BEFORE the schedule's lastCompletedDate belong to a
      // previous maintenance cycle and must not suppress this cycle's tiers.
      const batchIds = batch.map(s => s.id);
      const lastCompletedById = new Map(
        batch.map(s => [s.id, s.lastCompletedDate ? new Date(s.lastCompletedDate).getTime() : 0])
      );
      const existing = await prisma.alert.findMany({
        where: {
          scheduleId: { in: batchIds },
          status:     { in: ['sent', 'acknowledged'] },
        },
        select: { scheduleId: true, alertType: true, leadDays: true, createdAt: true },
      });
      for (const a of existing) {
        if (new Date(a.createdAt).getTime() >= (lastCompletedById.get(a.scheduleId) || 0)) {
          fired.add(`${a.scheduleId}|${a.alertType}|${a.leadDays}`);
        }
      }

      // ── Group batch by accountId for per-account error isolation ──────────
      const byAccount = new Map<string, typeof batch>();
      for (const sched of batch) {
        const arr = byAccount.get(sched.accountId) ?? [];
        arr.push(sched);
        byAccount.set(sched.accountId, arr);
      }

      // ── Tier crossing detection (per-account isolated) ────────────────────
      for (const [_acctId, accountSchedules] of byAccount) {
        try {
          for (const schedule of accountSchedules) {
          const daysUntil = Math.ceil(
            (new Date(schedule.nextDueDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
          );

          for (const tier of TIERS) {
            // A tier fires once daysUntil has crossed it (daysUntil <= leadDays),
            // bounded Â±5 days so a multi-day cron outage doesn't permanently skip
            // a tier (inherited H2 widening), except overdue tiers which fire on
            // any crossing (an asset 40d overdue discovered today must still get
            // the -30 escalation, not silently skip it).
            const crossed = tier.leadDays >= 0
              ? Math.abs(daysUntil - tier.leadDays) <= 5
              : daysUntil <= tier.leadDays;
            if (!crossed) continue;

            const key = `${schedule.id}|${tier.alertType}|${tier.leadDays}`;
            if (fired.has(key)) { skipped++; continue; }
            fired.add(key);

            newAlerts.push({
              scheduleId: schedule.id,
              assetId:    schedule.asset.id,
              accountId:  schedule.accountId,
              alertType:  tier.alertType,
              leadDays:   tier.leadDays,
              scheduledAt: now,
              status:     'sent',
              sentAt:     now,
            });

            if (tier.alertType === 'regulatory_breach') {
              breachLogs.push({
                assetId:   schedule.asset.id,
                accountId: schedule.accountId,
                action:    'regulatory_breach_flagged',
                details:   {
                  scheduleId:  schedule.id,
                  task:        schedule.taskDefinition?.taskName,
                  standardRef: schedule.taskDefinition?.standardRef,
                  daysOverdue: Math.abs(daysUntil),
                  nextDueDate: schedule.nextDueDate,
                },
              });
            }

            ensureDigest(schedule.accountId, schedule.account.users);
            accountDigests.get(schedule.accountId).alertItems.push({
              schedule: {
                id: schedule.id,
                nextDueDate: schedule.nextDueDate,
                taskDefinition: { taskName: schedule.taskDefinition?.taskName || 'Maintenance task' },
              },
              asset:     schedule.asset,
              alertType: tier.alertType,
              daysUntil,
              leadDays:  tier.leadDays,
              roles:     tier.roles,
            });
          }
        }
        } catch (accountErr: any) {
          console.error(`[alertEngine] Error processing alerts for account ${_acctId}:`, accountErr);
          // Continue to next account rather than aborting all
        }
      } // end for byAccount
    } // end while cursor pagination

    // ── Batch-insert alerts + breach audit rows ───────────────────────────
    if (newAlerts.length > 0) {
      const batchResult = await prisma.alert.createMany({ data: newAlerts, skipDuplicates: true });
      generated = batchResult.count;
    }
    for (const log of breachLogs) {
      // writeLog handles its own errors; the audit trail for a regulatory
      // breach matters enough to attempt per-row rather than silently batch.
      try { await writeLog(log); } catch (e) { console.warn('[AlertEngine] breach audit log failed:', e.message); }
    }

    // ── Route and send digests ────────────────────────────────────────────
    // Recipients are role-routed per tier (see TIERS). Per-user
    // AlertPreference still applies on top: emailEnabled=false silences
    // maintenance_due mail; daysBeforeList narrows which lead tiers a user
    // receives. Overdue/escalation/breach are never preference-suppressed.
    for (const [accId, { users, alertItems }] of accountDigests) {
      if (alertItems.length === 0) continue;
      try {
        const pfx = `[AlertEngine][${accId.slice(0, 8)}]`;

        alertItems.sort((a, b) =>
          (ALERT_PRIORITY[a.alertType] ?? 99) - (ALERT_PRIORITY[b.alertType] ?? 99) || a.daysUntil - b.daysUntil
        );

        const prefRows = await prisma.alertPreference.findMany({
          where: { userId: { in: users.map(u => u.id) } },
        });
        const prefsByUser = {};
        for (const pref of prefRows) {
          if (!prefsByUser[pref.userId]) prefsByUser[pref.userId] = {};
          prefsByUser[pref.userId][pref.alertType] = pref;
        }

        function userWantsEmail(userId, alertType, leadDays) {
          const pref = prefsByUser[userId]?.[alertType];
          if (!pref) return true; // no row → defaults (email on, all tiers)
          if (!pref.emailEnabled) return false;
          if (CONFIGURABLE_DAYS_TYPES.has(alertType)) {
            const days = pref.daysBeforeList
              .split(',')
              .map(d => parseInt(d.trim(), 10))
              .filter(n => !isNaN(n));
            return days.includes(leadDays);
          }
          return true;
        }

        const recipientDigests = new Map(); // userId → { user, alertItems[] }
        function addToRecipient(user, alertItem) {
          if (!userWantsEmail(user.id, alertItem.alertType, alertItem.leadDays)) return;
          if (!recipientDigests.has(user.id)) recipientDigests.set(user.id, { user, alertItems: [] });
          recipientDigests.get(user.id).alertItems.push(alertItem);
        }

        for (const alertItem of alertItems) {
          const targets = users.filter(u => alertItem.roles.includes(u.role));
          // Fallback: an account with no user in the tier's target roles
          // (e.g. no consultant invited yet) routes to admins so the 180d
          // booking window is never silently dropped.
          const effective = targets.length > 0 ? targets : users.filter(u => u.role === 'admin');
          for (const user of effective) addToRecipient(user, alertItem);
          // Owner routing: the asset's responsible person ALWAYS receives the
          // alert (every tier), in addition to the role-matrix targets.
          // Deactivated owners are skipped; preference checks still apply via
          // userWantsEmail inside addToRecipient. The id check prevents a
          // double-push when the owner is already a role-matrix target.
          const owner = alertItem.asset?.owner;
          if (owner && owner.isActive && !effective.some(u => u.id === owner.id)) {
            addToRecipient(owner, alertItem);
          }
        }

        if (LEGACY_DIGEST) {
        for (const { user, alertItems: userAlerts } of recipientDigests.values()) {
          if (userAlerts.length === 0) continue;
          try {
            if (!FROM_ADDRESS) {
              console.warn(`${pfx} EMAIL_FROM not set — skipping digest for`, redactEmail(user.email));
              continue;
            }
            const assetCount = new Set(userAlerts.map(a => a.asset.id)).size;
            const html    = buildDigestHtml(userAlerts, user.name);
            const subject = `ServiceCycle: ${assetCount} asset${assetCount !== 1 ? 's' : ''} need${assetCount === 1 ? 's' : ''} maintenance attention — ${fmtDate(new Date(), { month: 'short', day: 'numeric' })}`;

            const sendResult = await transport.sendMail({ from: FROM_ADDRESS, to: user.email, subject, html });
            emailsSent++;
            console.log(`${pfx} Digest sent to ${redactEmail(user.email)} (${userAlerts.length} alerts, ${assetCount} assets)`);
            prisma.notificationLog.create({ data: {
              accountId: accId, userId: user.id, channel: 'email', template: 'maintenance_digest',
              recipient: user.email, providerMessageId: sendResult?.messageId || null,
              status: 'sent', alertCount: userAlerts.length,
            } }).catch(e => console.warn('[AlertEngine] NotifLog insert failed:', e.message));
          } catch (emailErr) {
            console.error(`${pfx} Failed to send digest to ${redactEmail(user.email)}:`, emailErr.message);
            prisma.notificationLog.create({ data: {
              accountId: accId, userId: user.id, channel: 'email', template: 'maintenance_digest',
              recipient: user.email, status: 'failed',
              errorMessage: emailErr.message, alertCount: userAlerts.length,
            } }).catch(e => console.warn('[AlertEngine] NotifLog insert failed:', e.message));
          }
        }

        // Slack / Teams: one consolidated digest per account (shared spaces).
        try {
          await deliverSlackDigest({ accountId: accId, alertItems });
        } catch (slackErr) {
          console.warn(`${pfx} Slack delivery skipped:`, slackErr.message);
        }
        try {
          await deliverTeamsDigest({ accountId: accId, alertItems });
        } catch (teamsErr) {
          console.warn(`${pfx} Teams delivery skipped:`, teamsErr.message);
        }
        } // end LEGACY_DIGEST gate — cadenced repBriefing owns rep email/Slack/Teams now
        try {
          await deliverWebhooks({ accountId: accId, alertItems });
        } catch (webhookErr) {
          console.warn(`${pfx} Webhook delivery skipped:`, webhookErr.message);
        }

        // Partner Flywheel: emit TASK_OVERDUE once per account for any overdue/escalation alerts (fire-and-forget)
        try {
          const overdueItems = alertItems.filter((a: any) =>
            a.alertType === 'overdue' || a.alertType === 'escalation'
          );
          if (overdueItems.length > 0) {
            const { emitPartnerEvent } = require('./partnerEvents');
            const overdueAssetIds = [...new Set(overdueItems.map((a: any) => a.asset.id))] as string[];
            emitPartnerEvent(accId, 'TASK_OVERDUE', {
              overdueCount: overdueItems.length,
              assetIds: overdueAssetIds,
            }).catch((e: any) => console.error('[AlertEngine] partnerEvent emit failed:', e.message));
          }
        } catch (peErr: any) {
          console.warn(`${pfx} Partner event emit skipped:`, peErr.message);
        }

      } catch (tenantErr) {
        const _pfx = '[AlertEngine][' + accId.slice(0, 8) + ']';
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

module.exports = { runAlertEngine, TIERS, deliverSlackDigest, deliverTeamsDigest, deliverWebhooks, deliverEventWebhooks };

export {};

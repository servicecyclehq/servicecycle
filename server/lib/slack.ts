/**
 * server/lib/slack.js
 *
 * Slack incoming-webhook integration for the nightly alert digest.
 *
 * Why a separate module from email.js:
 *   - Email is per-recipient (admin / contract owner); Slack is per-account
 *     (one channel, everyone who cares is in it).
 *   - Block Kit ≠ HTML, so the templating shape is different enough that
 *     mixing it into alertEngine.js made the engine harder to read.
 *   - Test endpoint (/api/settings/slack/test) imports just this file.
 *
 * SSRF defense:
 *   The webhook URL is admin-configurable. To prevent an admin (or an
 *   attacker who has compromised an admin) from pointing it at internal
 *   services, isValidSlackWebhookUrl() restricts the URL to the
 *   `https://hooks.slack.com/services/` origin. Slack's own docs guarantee
 *   all incoming-webhook URLs share that prefix — anything else is rejected.
 *
 * Failure mode:
 *   sendSlackMessage() never throws to its caller. A failed delivery is
 *   logged at WARN and the function returns { ok: false, reason }. Slack
 *   downtime must NOT take out the email digest path.
 */

'use strict';

const ALLOWED_PREFIX = 'https://hooks.slack.com/services/';
const DEFAULT_TIMEOUT_MS = 5000;

function isValidSlackWebhookUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (!url.startsWith(ALLOWED_PREFIX)) return false;
  // Must have a path component after the prefix. The Slack format is
  // /services/T.../B.../<token>, so require at least 3 path segments.
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.hostname !== 'hooks.slack.com') return false;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 4 || parts[0] !== 'services') return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * POST a payload to a Slack incoming webhook.
 * @returns {Promise<{ ok: boolean, status?: number, reason?: string }>}
 */
async function sendSlackMessage({ webhookUrl, blocks, text, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (process.env.SLACK_MOCK === 'true') {
    console.log(`\n💬 [SLACK MOCK]\n  URL: ${webhookUrl ? '<set>' : '<missing>'}\n  text: ${text}\n  blocks: ${blocks ? blocks.length : 0}\n`);
    return { ok: true, status: 200, reason: 'mock' };
  }

  if (!isValidSlackWebhookUrl(webhookUrl)) {
    return { ok: false, reason: 'invalid-webhook-url' };
  }

  const body = JSON.stringify({
    // text is a fallback for screen readers / notifications; blocks render in-channel
    text: text || 'LapseIQ alert',
    blocks: Array.isArray(blocks) && blocks.length ? blocks : undefined,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const responseText = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, status: res.status, reason: responseText || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      reason: err.name === 'AbortError' ? 'timeout' : (err.message || 'network-error'),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Block Kit builders ────────────────────────────────────────────────────────

const TYPE_LABEL = {
  cancel_by:   '🚨 Cancel window',
  review_by:   '📋 Review due',
  renewal:     '📅 Renewal approaching',
  payment_due: '💳 Payment due',
};

function fmtDays(days) {
  if (days === 0) return 'today';
  if (days < 0) return 'overdue';
  return `in ${days}d`;
}

function fmtMoney(amount) {
  if (!amount) return null;
  const n = parseFloat(amount);
  if (!isFinite(n)) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

/**
 * Build Block Kit blocks for a per-account digest.
 *
 * @param {object[]} alertItems — same shape used in alertEngine.js:
 *   { contract, alertType, daysUntil, paymentAmount? }
 * @param {object}   meta
 * @param {string}   meta.accountName
 * @param {string}   meta.appUrl       — base URL for deep links to contract pages
 * @returns {{ text: string, blocks: object[] }}
 */
function buildAlertDigest(alertItems, { accountName, appUrl }) {
  const contractIds = new Set(alertItems.map(a => a.contract.id));
  const contractCount = contractIds.size;
  const alertCount = alertItems.length;

  const headerText = `${contractCount} contract${contractCount !== 1 ? 's' : ''} need${contractCount === 1 ? 's' : ''} attention`;

  // Group by contract so a single contract with three alert types renders once.
  const byContract = new Map();
  for (const item of alertItems) {
    const id = item.contract.id;
    if (!byContract.has(id)) byContract.set(id, { contract: item.contract, items: [] });
    byContract.get(id).items.push(item);
  }

  // Sort: most-urgent contract first (smallest daysUntil across its items).
  const groups = [...byContract.values()].sort((a, b) => {
    const aMin = Math.min(...a.items.map(x => x.daysUntil));
    const bMin = Math.min(...b.items.map(x => x.daysUntil));
    return aMin - bMin;
  });

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText.slice(0, 150), emoji: true },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `*${accountName}* · ${alertCount} active alert${alertCount !== 1 ? 's' : ''}` },
      ],
    },
    { type: 'divider' },
  ];

  // Slack caps total blocks at 50; reserve a few for the footer button.
  const MAX_GROUPS = 20;
  const visibleGroups = groups.slice(0, MAX_GROUPS);

  for (const { contract, items } of visibleGroups) {
    const vendor = contract.vendor?.name || '—';
    const value = fmtMoney(
      contract.costPerLicense && contract.quantity
        ? parseFloat(contract.costPerLicense) * parseInt(contract.quantity, 10)
        : null
    );
    const url = `${appUrl}/contracts/${contract.id}`;

    items.sort((a, b) => a.daysUntil - b.daysUntil);

    const itemLines = items.map(it => {
      const label = TYPE_LABEL[it.alertType] || it.alertType;
      const extra = it.alertType === 'payment_due' && it.paymentAmount
        ? ` · ${fmtMoney(it.paymentAmount)}`
        : '';
      return `• ${label}${extra} — ${fmtDays(it.daysUntil)}`;
    }).join('\n');

    const headerLine = `*<${url}|${escapeMrkdwn(contract.product || 'Contract')}>* · ${escapeMrkdwn(vendor)}${value ? ` · ${value}` : ''}`;

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${headerLine}\n${itemLines}` },
    });
  }

  if (groups.length > MAX_GROUPS) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `…and ${groups.length - MAX_GROUPS} more contract${groups.length - MAX_GROUPS !== 1 ? 's' : ''}. Open LapseIQ to see the rest.` },
      ],
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Open LapseIQ', emoji: true },
        url: `${appUrl}/contracts`,
        style: 'primary',
      },
    ],
  });

  return {
    text: `LapseIQ: ${headerText}`,
    blocks,
  };
}

/**
 * Slack mrkdwn escape: just the three characters that have special meaning
 * outside of markup. Slack does not honour HTML escaping in mrkdwn —
 * `<`, `>`, `&` are the documented set.
 * https://api.slack.com/reference/surfaces/formatting#escaping
 */
function escapeMrkdwn(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Test message used by POST /api/settings/slack/test. */
function buildTestMessage({ accountName, byUserName }) {
  return {
    text: `LapseIQ Slack test from ${accountName}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '✅ LapseIQ Slack integration test', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Webhook for *${escapeMrkdwn(accountName)}* is wired up.\nSent by *${escapeMrkdwn(byUserName)}* at ${new Date().toLocaleString('en-US')}.`,
        },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'You will receive renewal/cancel/payment digests in this channel as alerts fire.' },
        ],
      },
    ],
  };
}

module.exports = {
  isValidSlackWebhookUrl,
  sendSlackMessage,
  buildAlertDigest,
  buildTestMessage,
};

export {};

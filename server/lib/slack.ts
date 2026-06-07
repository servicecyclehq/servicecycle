/**
 * server/lib/slack.js
 *
 * Slack incoming-webhook integration for the nightly alert digest.
 *
 * Why a separate module from email.js:
 *   - Email is per-recipient (admin / site contact); Slack is per-account
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
    text: text || 'ServiceCycle alert',
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
  maintenance_due:   '🔧 Maintenance due',
  overdue:           '⚠️ Overdue',
  escalation:        '🚨 Escalation',
  regulatory_breach: '⛔ Regulatory breach',
};

function fmtDays(days) {
  if (days === 0) return 'today';
  if (days < 0) return `${Math.abs(days)}d overdue`;
  return `in ${days}d`;
}

// Human label for an asset: manufacturer + model + serial when available,
// equipment type as the fallback. Mirrors lib/email.js assetDisplayName.
function assetLabel(asset) {
  if (!asset || typeof asset !== 'object') return 'Asset';
  const parts = [asset.manufacturer, asset.model].filter(Boolean);
  if (asset.serialNumber) parts.push(`S/N ${asset.serialNumber}`);
  if (parts.length > 0) return parts.join(' ');
  return asset.equipmentType ? String(asset.equipmentType).replace(/_/g, ' ') : 'Asset';
}

/**
 * Build Block Kit blocks for a per-account digest.
 *
 * @param {object[]} alertItems — same shape used in alertEngine.js:
 *   { schedule, asset, alertType, daysUntil, leadDays? }
 *   schedule: { id, nextDueDate?, taskDefinition?: { taskName } }
 *   asset:    { id, equipmentType?, manufacturer?, model?, serialNumber?, site?: { name } }
 * @param {object}   meta
 * @param {string}   meta.accountName
 * @param {string}   meta.appUrl       — base URL for deep links to asset pages
 * @returns {{ text: string, blocks: object[] }}
 */
function buildAlertDigest(alertItems, { accountName, appUrl }) {
  const assetIds = new Set(alertItems.map(a => a.asset.id));
  const assetCount = assetIds.size;
  const alertCount = alertItems.length;

  const headerText = `${assetCount} asset${assetCount !== 1 ? 's' : ''} need${assetCount === 1 ? 's' : ''} attention`;

  // Group by asset so a single asset with three due tasks renders once.
  const byAsset = new Map();
  for (const item of alertItems) {
    const id = item.asset.id;
    if (!byAsset.has(id)) byAsset.set(id, { asset: item.asset, items: [] });
    byAsset.get(id).items.push(item);
  }

  // Sort: most-urgent asset first (smallest daysUntil across its items).
  const groups = [...byAsset.values()].sort((a, b) => {
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

  for (const { asset, items } of visibleGroups) {
    const site = asset.site?.name || '—';
    const url = `${appUrl}/assets/${asset.id}`;

    items.sort((a, b) => a.daysUntil - b.daysUntil);

    const itemLines = items.map(it => {
      const label = TYPE_LABEL[it.alertType] || it.alertType;
      const task = it.schedule?.taskDefinition?.taskName
        ? ` · ${escapeMrkdwn(it.schedule.taskDefinition.taskName)}`
        : '';
      return `• ${label}${task} — ${fmtDays(it.daysUntil)}`;
    }).join('\n');

    const headerLine = `*<${url}|${escapeMrkdwn(assetLabel(asset))}>* · ${escapeMrkdwn(site)}`;

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${headerLine}\n${itemLines}` },
    });
  }

  if (groups.length > MAX_GROUPS) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `…and ${groups.length - MAX_GROUPS} more asset${groups.length - MAX_GROUPS !== 1 ? 's' : ''}. Open ServiceCycle to see the rest.` },
      ],
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Open ServiceCycle', emoji: true },
        url: `${appUrl}/assets`,
        style: 'primary',
      },
    ],
  });

  return {
    text: `ServiceCycle: ${headerText}`,
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
    text: `ServiceCycle Slack test from ${accountName}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '✅ ServiceCycle Slack integration test', emoji: true },
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
          { type: 'mrkdwn', text: 'You will receive maintenance-due / overdue digests in this channel as alerts fire.' },
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

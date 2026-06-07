/**
 * server/lib/teams.js
 *
 * Microsoft Teams incoming-webhook integration for the nightly alert
 * digest. Mirror of lib/slack.js — separate module so the test endpoint
 * (/api/settings/teams/test) can import it standalone, and so the
 * payload-shape divergence (MessageCard vs Block Kit) doesn't bleed
 * into alertEngine.js.
 *
 * Why MessageCard and not Adaptive Card v1.5:
 *   - MessageCard ("Office 365 Connector Card") works on every Teams
 *     incoming-webhook flavour — both the legacy Connector webhook
 *     (deprecated but still functional) and the newer Power Automate
 *     "Post to Teams via webhook" workflow.
 *   - Adaptive Card payloads need a different envelope per webhook
 *     flavour (some require { type: "message", attachments: [...] },
 *     others want a raw card). MessageCard is one shape everywhere.
 *   - Teams renders MessageCard natively — no app installation, no
 *     bot framework dance.
 *
 * SSRF defense:
 *   isValidTeamsWebhookUrl() restricts the URL to Microsoft-controlled
 *   hosts:
 *     - <tenant>.webhook.office.com  (newer connector / workflow URLs)
 *     - outlook.office.com / outlook.office365.com  (legacy webhooks)
 *   Power Automate workflow URLs (*.logic.azure.com) are deliberately
 *   NOT allowed — they're broader-shaped and customers using Power
 *   Automate can request the broader pattern when needed.
 *
 * Failure mode:
 *   sendTeamsMessage() never throws. Failures return { ok: false, reason }
 *   so Teams downtime can't take out the email digest path.
 */

'use strict';

const DEFAULT_TIMEOUT_MS = 5000;

// ── Allowed hosts ──────────────────────────────────────────────────────────────
// Exact hostnames OR a leading "*." for subdomain wildcards. A pure exact-match
// list isn't enough because the modern Teams URL embeds a tenant prefix:
// "<tenant>.webhook.office.com".
const ALLOWED_TEAMS_HOSTS = [
  'outlook.office.com',
  'outlook.office365.com',
  '*.webhook.office.com',
];

function hostMatchesAllowlist(hostname) {
  if (typeof hostname !== 'string') return false;
  for (const pattern of ALLOWED_TEAMS_HOSTS) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".webhook.office.com"
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) return true;
    } else if (hostname === pattern) {
      return true;
    }
  }
  return false;
}

function isValidTeamsWebhookUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  // Reject embedded credentials (URL form auth would survive an SSRF probe).
  if (u.username || u.password) return false;
  if (!hostMatchesAllowlist(u.hostname)) return false;
  // Path must include a webhook segment to weed out an empty / homepage URL.
  // Both legacy (/webhook/...) and new (/webhookb2/...) shapes are accepted.
  const path = u.pathname.toLowerCase();
  if (!path.includes('/webhook/') && !path.includes('/webhookb2/')) return false;
  return true;
}

/**
 * POST a payload to a Teams incoming webhook.
 * @returns {Promise<{ ok: boolean, status?: number, reason?: string }>}
 */
async function sendTeamsMessage({ webhookUrl, card, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (process.env.TEAMS_MOCK === 'true') {
    console.log(`\n📨 [TEAMS MOCK]\n  URL: ${webhookUrl ? '<set>' : '<missing>'}\n  title: ${card?.title || '<no title>'}\n  sections: ${card?.sections?.length || 0}\n`);
    return { ok: true, status: 200, reason: 'mock' };
  }

  if (!isValidTeamsWebhookUrl(webhookUrl)) {
    return { ok: false, reason: 'invalid-webhook-url' };
  }

  const body = JSON.stringify(card);

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

// ── MessageCard builders ──────────────────────────────────────────────────────

const TYPE_LABEL = {
  maintenance_due:   'Maintenance due',
  overdue:           'Overdue',
  escalation:        'Escalation',
  regulatory_breach: 'Regulatory breach',
};

// Hex without the leading # — MessageCard's themeColor format.
const TYPE_COLOR = {
  maintenance_due:   '2563EB', // blue-600
  overdue:           'D97706', // amber-600
  escalation:        'DC2626', // red-600
  regulatory_breach: '7F1D1D', // red-900
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
 * Build a Teams MessageCard for a per-account digest.
 *
 * @param {object[]} alertItems — same shape used in alertEngine.js:
 *   { schedule, asset, alertType, daysUntil, leadDays? }
 *   schedule: { id, nextDueDate?, taskDefinition?: { taskName } }
 *   asset:    { id, equipmentType?, manufacturer?, model?, serialNumber?, site?: { name } }
 * @param {object}   meta
 * @param {string}   meta.accountName
 * @param {string}   meta.appUrl
 * @returns {object}  MessageCard JSON (POST body)
 */
function buildAlertDigest(alertItems, { accountName, appUrl }) {
  const assetIds = new Set(alertItems.map(a => a.asset.id));
  const assetCount = assetIds.size;
  const alertCount = alertItems.length;

  const headerText = `${assetCount} asset${assetCount !== 1 ? 's' : ''} need${assetCount === 1 ? 's' : ''} attention`;

  // Group by asset so an asset with three due tasks renders once.
  const byAsset = new Map();
  for (const item of alertItems) {
    const id = item.asset.id;
    if (!byAsset.has(id)) byAsset.set(id, { asset: item.asset, items: [] });
    byAsset.get(id).items.push(item);
  }

  // Sort: most urgent asset first.
  const groups = [...byAsset.values()].sort((a, b) => {
    const aMin = Math.min(...a.items.map(x => x.daysUntil));
    const bMin = Math.min(...b.items.map(x => x.daysUntil));
    return aMin - bMin;
  });

  // Cap groups to keep cards under Teams' practical render limit. The
  // legacy connector enforces a 28KB total payload; 25 items keeps
  // generous headroom for verbose product names.
  const MAX_GROUPS = 25;
  const visible = groups.slice(0, MAX_GROUPS);
  const overflow = groups.length - visible.length;

  // Highest-priority alert across the digest drives the theme color so the
  // user gets an at-a-glance signal in their channel feed.
  const priorityOrder = ['regulatory_breach', 'escalation', 'overdue', 'maintenance_due'];
  const highestType = priorityOrder.find(t => alertItems.some(a => a.alertType === t)) || 'maintenance_due';

  const sections: any[] = visible.map(({ asset, items }) => {
    const site = asset.site?.name || '—';
    const url = `${appUrl}/assets/${asset.id}`;

    items.sort((a, b) => a.daysUntil - b.daysUntil);

    const facts = items.map(it => ({
      name: TYPE_LABEL[it.alertType] || it.alertType,
      value: (() => {
        const days = fmtDays(it.daysUntil);
        const task = it.schedule?.taskDefinition?.taskName;
        return task ? `${escapeMarkdown(task)} · ${days}` : days;
      })(),
    }));

    return {
      activityTitle:    `[${escapeMarkdown(assetLabel(asset))}](${url})`,
      activitySubtitle: escapeMarkdown(site),
      facts,
      markdown: true,
    };
  });

  if (overflow > 0) {
    sections.push({
      text: `…and ${overflow} more asset${overflow !== 1 ? 's' : ''}. Open ServiceCycle to see the rest.`,
      markdown: true,
    });
  }

  return {
    '@type':      'MessageCard',
    '@context':   'http://schema.org/extensions',
    summary:      `ServiceCycle: ${headerText}`,
    themeColor:   TYPE_COLOR[highestType],
    title:        headerText,
    text:         `**${escapeMarkdown(accountName)}** · ${alertCount} active alert${alertCount !== 1 ? 's' : ''}`,
    sections,
    potentialAction: [
      {
        '@type': 'OpenUri',
        name:    'Open ServiceCycle',
        targets: [{ os: 'default', uri: `${appUrl}/assets` }],
      },
    ],
  };
}

/**
 * MessageCard markdown is mostly CommonMark-compatible. Escape the few
 * characters that would break the rendering (square brackets and
 * backticks; angle brackets are NOT special in MessageCard markdown,
 * unlike Slack mrkdwn).
 */
function escapeMarkdown(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/`/g, '\\`');
}

/** Test message used by POST /api/settings/teams/test. */
function buildTestMessage({ accountName, byUserName }) {
  return {
    '@type':    'MessageCard',
    '@context': 'http://schema.org/extensions',
    summary:    `ServiceCycle Teams test from ${accountName}`,
    themeColor: '0F172A',
    title:      'ServiceCycle Teams integration test',
    text:       `Webhook for **${escapeMarkdown(accountName)}** is wired up.\n\nSent by **${escapeMarkdown(byUserName)}** at ${new Date().toLocaleString('en-US')}.`,
    sections: [
      {
        text: 'You will receive maintenance-due / overdue digests in this channel as alerts fire.',
        markdown: true,
      },
    ],
  };
}

module.exports = {
  isValidTeamsWebhookUrl,
  sendTeamsMessage,
  buildAlertDigest,
  buildTestMessage,
  // Exported for tests + advanced operators wiring custom routing.
  ALLOWED_TEAMS_HOSTS,
};

export {};

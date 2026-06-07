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
  cancel_by:   'Cancel window',
  review_by:   'Review due',
  renewal:     'Renewal approaching',
  payment_due: 'Payment due',
};

// Hex without the leading # — MessageCard's themeColor format.
const TYPE_COLOR = {
  cancel_by:   'DC2626', // red-600
  review_by:   '2563EB', // blue-600
  renewal:     '7C3AED', // violet-600
  payment_due: 'D97706', // amber-600
};

function fmtDays(days) {
  if (days === 0) return 'today';
  if (days < 0) return 'overdue';
  return `in ${days}d`;
}

function fmtMoney(amount) {
  if (amount == null) return null;
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

/**
 * Build a Teams MessageCard for a per-account digest.
 *
 * @param {object[]} alertItems — same shape used in alertEngine.js:
 *   { contract, alertType, daysUntil, paymentAmount? }
 * @param {object}   meta
 * @param {string}   meta.accountName
 * @param {string}   meta.appUrl
 * @returns {object}  MessageCard JSON (POST body)
 */
function buildAlertDigest(alertItems, { accountName, appUrl }) {
  const contractIds = new Set(alertItems.map(a => a.contract.id));
  const contractCount = contractIds.size;
  const alertCount = alertItems.length;

  const headerText = `${contractCount} contract${contractCount !== 1 ? 's' : ''} need${contractCount === 1 ? 's' : ''} attention`;

  // Group by contract so a contract with three alert types renders once.
  const byContract = new Map();
  for (const item of alertItems) {
    const id = item.contract.id;
    if (!byContract.has(id)) byContract.set(id, { contract: item.contract, items: [] });
    byContract.get(id).items.push(item);
  }

  // Sort: most urgent contract first.
  const groups = [...byContract.values()].sort((a, b) => {
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
  const priorityOrder = ['cancel_by', 'payment_due', 'review_by', 'renewal'];
  const highestType = priorityOrder.find(t => alertItems.some(a => a.alertType === t)) || 'renewal';

  const sections: any[] = visible.map(({ contract, items }) => {
    const vendor = contract.vendor?.name || '—';
    const value = fmtMoney(
      contract.costPerLicense && contract.quantity
        ? parseFloat(contract.costPerLicense) * parseInt(contract.quantity, 10)
        : null
    );
    const url = `${appUrl}/contracts/${contract.id}`;

    items.sort((a, b) => a.daysUntil - b.daysUntil);

    const facts = items.map(it => ({
      name: TYPE_LABEL[it.alertType] || it.alertType,
      value: (() => {
        const days = fmtDays(it.daysUntil);
        if (it.alertType === 'payment_due' && it.paymentAmount) {
          return `${fmtMoney(it.paymentAmount)} · ${days}`;
        }
        return days;
      })(),
    }));

    const subtitle = value ? `${escapeMarkdown(vendor)} · ${value}` : escapeMarkdown(vendor);

    return {
      activityTitle:    `[${escapeMarkdown(contract.product || 'Contract')}](${url})`,
      activitySubtitle: subtitle,
      facts,
      markdown: true,
    };
  });

  if (overflow > 0) {
    sections.push({
      text: `…and ${overflow} more contract${overflow !== 1 ? 's' : ''}. Open LapseIQ to see the rest.`,
      markdown: true,
    });
  }

  return {
    '@type':      'MessageCard',
    '@context':   'http://schema.org/extensions',
    summary:      `LapseIQ: ${headerText}`,
    themeColor:   TYPE_COLOR[highestType],
    title:        headerText,
    text:         `**${escapeMarkdown(accountName)}** · ${alertCount} active alert${alertCount !== 1 ? 's' : ''}`,
    sections,
    potentialAction: [
      {
        '@type': 'OpenUri',
        name:    'Open LapseIQ',
        targets: [{ os: 'default', uri: `${appUrl}/contracts` }],
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
    summary:    `LapseIQ Teams test from ${accountName}`,
    themeColor: '0F172A',
    title:      'LapseIQ Teams integration test',
    text:       `Webhook for **${escapeMarkdown(accountName)}** is wired up.\n\nSent by **${escapeMarkdown(byUserName)}** at ${new Date().toLocaleString('en-US')}.`,
    sections: [
      {
        text: 'You will receive renewal / cancel / payment digests in this channel as alerts fire.',
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

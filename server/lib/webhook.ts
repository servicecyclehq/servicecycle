/**
 * server/lib/webhook.js
 *
 * Generic outbound webhook delivery for ServiceCycle alert events.
 *
 * Each configured WebhookEndpoint receives a signed JSON POST whenever the
 * nightly alert engine fires. This enables Zapier, n8n, Make, custom HTTP
 * listeners, and any other tool that speaks plain HTTP.
 *
 * Payload shape (stable; treat as public API contract):
 * {
 *   event:       "maintenance.due" | "maintenance.overdue" |
 *                "maintenance.escalation" | "maintenance.regulatory_breach",
 *   alertType:   "maintenance_due" | "overdue" | "escalation" | "regulatory_breach",
 *   daysUntil:   number,                   // days until nextDueDate (negative = overdue)
 *   leadDays:    number | null,            // lead-time tier for maintenance_due rows
 *   scheduleId:  string,
 *   assetId:     string,
 *   asset:       string,                   // display label (manufacturer model S/N or equipment type)
 *   equipmentType: string | null,
 *   siteName:    string | null,
 *   taskName:    string | null,            // maintenance task this schedule tracks
 *   nextDueDate: ISO-8601 | null,
 *   appUrl:      string,                   // deep-link to asset in ServiceCycle
 *   sentAt:      ISO-8601,
 * }
 *
 * A "workorder.completed" event (same envelope, workOrderId instead of
 * scheduleId) is reserved for the work-order route layer; EVENT_NAMES below
 * is the canonical map.
 *
 * SSRF defense:
 *   - HTTPS required (no plain HTTP, no file://, no data://).
 *   - Destination hostname is resolved to its IP and checked against private /
 *     loopback / link-local ranges before the request is sent.
 *   - No redirects followed (redirect: 'error').
 *
 * Signing (v0.37.1 W5 MT-132 — timestamped):
 *   X-ServiceCycle-Signature:   sha256=<hex-hmac-of-"timestamp.body">
 *   X-ServiceCycle-Timestamp:   unix-seconds string (sender clock)
 *   X-ServiceCycle-Delivery-Id: per-delivery UUID
 *
 *   The HMAC is now computed over `<timestamp>.<body>` (concatenated with
 *   a literal "."). Verifiers reject deliveries whose timestamp is more
 *   than 5 minutes off their clock — defends against replay even if the
 *   transport-layer TLS terminates at a CDN. The pre-W5 signature shape
 *   (HMAC of body alone, no timestamp prefix) is gone; integrators on
 *   the old contract get an unverifiable signature and must update their
 *   verifier. The signature header name + algorithm are unchanged so the
 *   change is minimal-surface.
 *
 * Retry posture (v0.37.1 W5 MT-132):
 *   deliverWebhook now retries up to 3 attempts with exponential backoff
 *   (1s, 4s, 16s wait BEFORE the 2nd/3rd/4th attempts). Total wait budget
 *   is bounded at ~21s + cumulative request time. SSRF rejections are
 *   NOT retried — they're a permanent config error.
 *
 *   On final exhaustion the failure lands in the OutboundWebhookDLQ
 *   table via webhookDlq.persistFailedDelivery; the caller still gets
 *   { ok: false, reason } so its own bookkeeping path is unaffected.
 *
 * Failure mode:
 *   deliverWebhook() never throws. A failed delivery returns { ok: false }.
 *   Webhook downtime must NOT affect Slack, Teams, or email digest paths.
 */

'use strict';

const crypto = require('crypto');
const dns    = require('dns').promises;
const https  = require('https');
const { v4: uuidv4 } = require('uuid');
const { persistFailedDelivery } = require('./webhookDlq');

const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_BACKOFF_MS   = [1000, 4000, 16000]; // before attempts #2, #3, #4
const MAX_ATTEMPTS       = RETRY_BACKOFF_MS.length + 1; // 4

// ── SSRF guard ────────────────────────────────────────────────────────────────

// T1-N1 (Pass-6 audit): Pre-DNS hostname denylist for cloud-metadata endpoints.
// The post-DNS isPrivateAddress check catches 169.254.169.254 once resolved,
// but three attack vectors slip through if DNS is short-circuited or a
// custom resolver returns a non-link-local address:
//   1. metadata.google.internal resolves to 169.254.169.254 via GCP DNS;
//      an attacker-controlled resolver could return a public IP alias.
//   2. metadata.azure.com always resolves to 169.254.169.254 — blocked by
//      IP, but explicit hostname rejection is defense-in-depth.
//   3. Alibaba ECS IMDS at 100.100.100.200 is already blocked by the CGNAT
//      range check, but the hostname denylist makes the intent explicit.
// Hostnames are checked lower-cased before any DNS lookup so the check
// cannot be bypassed by case variation (Metadata.Google.Internal etc.).
const HOST_DENYLIST = new Set([
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata',                   // bare hostname — routes to link-local on some cloud networks
  '100.100.100.200',            // Alibaba Cloud ECS metadata IP (belt-and-suspenders)
  'instance-data',              // OpenStack metadata service bare hostname
  'instance-data.ec2.internal', // AWS EC2 internal alias
]);

function isPrivateAddress(address) {
  if (address === '::1') return true;
  if (/^fe[89ab][0-9a-f]:/i.test(address)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(address)) return true;
  const v4mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const ip4 = v4mapped ? v4mapped[1] : address;
  const parts = ip4.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  const [a, b] = parts;
  if (a === 127)                        return true;  // 127.0.0.0/8 loopback
  if (a === 10)                         return true;  // 10.0.0.0/8 RFC1918
  if (a === 172 && b >= 16 && b <= 31)  return true;  // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168)           return true;  // 192.168.0.0/16 RFC1918
  if (a === 169 && b === 254)           return true;  // 169.254.0.0/16 link-local + AWS/GCP metadata
  // H4 (audit High, 2026-05-22): SSRF range additions.
  if (a === 0)                          return true;  // 0.0.0.0/8 -- "this network", routes to localhost on Linux
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT (carrier-grade NAT, internal-only)
  if (a === 192 && b === 0   && parts[2] === 0) return true;  // 192.0.0.0/24 IETF protocol assignments
  return false;
}

async function validateWebhookUrl(url) {
  if (typeof url !== 'string' || !url) return { valid: false, reason: 'empty-url' };
  let u;
  try { u = new URL(url); } catch { return { valid: false, reason: 'invalid-url' }; }
  if (u.protocol !== 'https:') return { valid: false, reason: 'https-required' };
  if (u.username || u.password) return { valid: false, reason: 'credentials-in-url' };
  const host = u.hostname;
  if (!host) return { valid: false, reason: 'no-hostname' };
  if (isPrivateAddress(host)) return { valid: false, reason: 'private-ip' };
  // T1-N1 (Pass-6): Reject cloud-metadata hostnames before DNS so a
  // custom/attacker-controlled resolver cannot return a non-private alias.
  if (HOST_DENYLIST.has(host.toLowerCase())) {
    return { valid: false, reason: 'cloud-metadata-host' };
  }
  let addresses;
  try {
    const result = await dns.lookup(host, { all: true });
    addresses = result.map(r => r.address);
    if (addresses.length === 0) return { valid: false, reason: 'no-dns-result' };
    // H4 (audit High, 2026-05-22): reject if ANY resolved address is
    // private, not only if ALL are. Pre-fix, a DNS record like
    //   evil.example.com -> [1.2.3.4, 169.254.169.254]
    // resolved both addresses; .every required ALL to be private to
    // reject, so [public, private] passed validation and the runtime
    // fetch followed an A record that happened to be picked, sometimes
    // hitting AWS metadata at 169.254.169.254.
    if (addresses.some(isPrivateAddress)) return { valid: false, reason: 'private-ip' };
  } catch {
    return { valid: false, reason: 'dns-failed' };
  }
  // F-SSRF-REBIND (2026-06-02): return the validated addresses so the caller
  // can PIN the TCP connection to them. Without pinning, the runtime request
  // re-resolves the hostname (a TOCTOU window): a low-TTL attacker-controlled
  // domain could pass validation with a public IP, then resolve to a private /
  // metadata IP at connect time (classic DNS rebinding). postOnce() now feeds
  // these addresses into a pinned dns.lookup so the socket can only reach an
  // already-vetted IP.
  return { valid: true, addresses };
}

// ── HMAC signing ──────────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 over the literal string `<timestamp>.<body>`.
 * The timestamp prefix is what defends against replay. Verifiers MUST
 * reject any delivery whose timestamp is >5 minutes off their clock,
 * even if the signature itself is valid.
 *
 * @param {string} body      raw JSON payload string
 * @param {string} timestamp unix-seconds string
 * @param {string} secret    hex-encoded 32-byte secret
 * @returns {string}         "sha256=<hex>"
 */
function signPayload(body, timestampOrSecret, maybeSecret) {
  // Backward-compatible call shape — older callers pass (body, secret) with
  // no timestamp. They get a signature over body alone so the existing test
  // payload helpers and one-shot calls still work, but live alert deliveries
  // (the only production caller) pass the full triple.
  let body_, ts, secret;
  if (maybeSecret === undefined) {
    body_ = body;
    ts    = null;
    secret = timestampOrSecret;
  } else {
    body_ = body;
    ts    = timestampOrSecret;
    secret = maybeSecret;
  }
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(ts ? `${ts}.${body_}` : body_, 'utf8');
  return 'sha256=' + hmac.digest('hex');
}

// ── Payload builder ───────────────────────────────────────────────────────────

// Canonical alertType → event-name map. The dotted form is the public
// contract integrators filter on; 'workorder.completed' is emitted by the
// work-order completion route (not the alert engine) but lives here so the
// names stay in one place.
const EVENT_NAMES = Object.freeze({
  // ── Maintenance / schedule tier events (legacy) ──────────────────────────
  maintenance_due:     'maintenance.due',
  overdue:             'maintenance.overdue',
  escalation:          'maintenance.escalation',
  regulatory_breach:   'maintenance.regulatory_breach',
  regulatory_breach_cleared: 'maintenance.regulatory_breach_cleared',
  workorder_completed: 'workorder.completed',

  // ── Deficiency lifecycle events ───────────────────────────────────────────
  // Fired by the alert engine / deficiency service when a deficiency is
  // created or its resolvedAt timestamp is set. Payload carries deficiencyId,
  // assetId, severity, description, triggeredAt (ISO-8601).
  deficiency_created:  'deficiency.created',
  deficiency_resolved: 'deficiency.resolved',

  // ── Arc-flash study expiry events ─────────────────────────────────────────
  // Fired by the arc-flash expiry alert when a study's reviewDueDate crosses
  // the 90-day warning window (expiring) or passes it (expired). Payload
  // carries studyId, assetId, reviewDueDate, daysUntilExpiry.
  arc_flash_expiring:  'arc_flash.expiring',
  arc_flash_expired:   'arc_flash.expired',

  // ── Asset lifecycle events ────────────────────────────────────────────────
  // condition_changed: fires when governingCondition transitions (e.g. C2→C3).
  // decommissioned: fires when inService is set to false on an asset.
  asset_condition_changed: 'asset.condition_changed',
  asset_decommissioned:    'asset.decommissioned',
});

// Human label for an asset: manufacturer + model + serial when available,
// equipment type as the fallback. Mirrors lib/email.js assetDisplayName —
// kept local so the delivery module stays prisma/email-free for unit tests.
function assetLabel(asset) {
  if (!asset || typeof asset !== 'object') return 'Asset';
  const parts = [asset.manufacturer, asset.model].filter(Boolean);
  if (asset.serialNumber) parts.push(`S/N ${asset.serialNumber}`);
  if (parts.length > 0) return parts.join(' ');
  return asset.equipmentType ? String(asset.equipmentType).replace(/_/g, ' ') : 'Asset';
}

/**
 * @param {object} alertItem — { schedule, asset, alertType, daysUntil, leadDays? }
 *   schedule: { id, nextDueDate?, taskDefinition?: { taskName } }
 *   asset:    { id, equipmentType?, manufacturer?, model?, serialNumber?, site?: { name } }
 */
function buildPayload(alertItem, appUrl) {
  const { schedule, asset, alertType, daysUntil, leadDays } = alertItem;
  const payload: any = {
    event:         EVENT_NAMES[alertType] || `maintenance.${alertType}`,
    alertType,
    daysUntil,
    leadDays:      leadDays ?? null,
    scheduleId:    schedule?.id || null,
    assetId:       asset.id,
    asset:         assetLabel(asset),
    equipmentType: asset.equipmentType || null,
    siteName:      asset.site?.name || null,
    taskName:      schedule?.taskDefinition?.taskName || null,
    nextDueDate:   schedule?.nextDueDate ? new Date(schedule.nextDueDate).toISOString() : null,
    appUrl:        `${appUrl}/assets/${asset.id}`,
    sentAt:        new Date().toISOString(),
  };
  return JSON.stringify(payload);
}

// ── IP-pinned DNS lookup (F-SSRF-REBIND) ──────────────────────────────────────

// Build a Node dns.lookup-compatible function that resolves ONLY to the
// addresses validateWebhookUrl() already vetted. Because the socket resolves
// through this instead of re-querying DNS, the hostname cannot be rebound to a
// private/metadata IP in the window between validation and connection. TLS SNI
// and certificate validation still use the real hostname (via `servername`),
// so HTTPS integrity is fully preserved.
function pinnedLookup(addresses) {
  const list = (addresses || []).map((a) => ({
    address: a,
    family:  a.includes(':') ? 6 : 4,
  }));
  return function lookup(_hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (!list.length) return callback(new Error('ssrf-no-validated-address'));
    if (options && options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  };
}

// ── Single-attempt POST (no retry, no DLQ) ────────────────────────────────────

// Uses Node's https module (not fetch) so we can pin the connection to the
// pre-validated IP via `lookup`. https.request never follows redirects, so a
// 3xx cannot bounce the request to an internal target either.
async function postOnce({ url, addresses, body, signature, timestamp, deliveryId, timeoutMs }) {
  const outHeaders = {
    'Content-Type':                'application/json',
    'Content-Length':              Buffer.byteLength(body),
    'X-ServiceCycle-Signature':    signature,
    'X-ServiceCycle-Timestamp':    timestamp,
    'X-ServiceCycle-Delivery-Id':  deliveryId,
    'User-Agent':                  'ServiceCycle-Webhook/1.0',
  };

  let u;
  try { u = new URL(url); } catch { return { ok: false, reason: 'invalid-url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https-required' };

  return await new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    const req = https.request(
      {
        protocol:   'https:',
        hostname:   u.hostname,
        servername: u.hostname,            // TLS SNI + cert validation use the real host
        port:       u.port || 443,
        path:       (u.pathname || '/') + (u.search || ''),
        method:     'POST',
        headers:    outHeaders,
        timeout:    timeoutMs,
        lookup:     pinnedLookup(addresses), // F-SSRF-REBIND: connect only to vetted IPs
      },
      (res) => {
        const status = res.statusCode;
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (data.length < 200) data += c; });
        res.on('end', () => {
          if (status >= 200 && status < 300) return done({ ok: true, status });
          if (status >= 300 && status < 400) {
            return done({ ok: false, status, reason: `redirect-blocked (HTTP ${status})` });
          }
          return done({ ok: false, status, reason: (data || `HTTP ${status}`).slice(0, 200) });
        });
      }
    );

    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => {
      done({ ok: false, reason: err && err.message === 'timeout' ? 'timeout' : ((err && err.message) || 'network-error') });
    });

    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Delivery (retry + DLQ landing) ────────────────────────────────────────────

/**
 * POST a single alert payload to one webhook endpoint, with retry + DLQ
 * persistence on exhaustion.
 *
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.hmacSecret
 * @param {object} params.alertItem
 * @param {string} params.appUrl
 * @param {string} params.accountId          - required when DLQ persistence is desired
 * @param {string} [params.webhookEndpointId] - FK for the DLQ row
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{ ok: boolean, status?: number, reason?: string,
 *                     attempts: number, deliveryId: string, dlqRowId?: string }>}
 */
async function deliverWebhook({
  url, hmacSecret, alertItem, appUrl,
  accountId = null, webhookEndpointId = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  // SSRF check at delivery time — permanent error, do NOT retry.
  // `addresses` are the vetted IPs we pin the connection to (F-SSRF-REBIND).
  const { valid, reason: ssrfReason, addresses } = await validateWebhookUrl(url);
  if (!valid) {
    console.warn(`[webhook] Blocked delivery to "${url}": ${ssrfReason}`);
    return { ok: false, reason: ssrfReason, attempts: 0, deliveryId: null };
  }

  const deliveryId = uuidv4();
  const body       = buildPayload(alertItem, appUrl);
  const timestamp  = String(Math.floor(Date.now() / 1000));
  const signature  = signPayload(body, timestamp, hmacSecret);

  let firstFailedAt = null;
  let lastResult    = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      const wait = RETRY_BACKOFF_MS[attempt - 2];
      await sleep(wait);
    }
    lastResult = await postOnce({ url, addresses, body, signature, timestamp, deliveryId, timeoutMs });
    if (lastResult.ok) {
      return { ...lastResult, attempts: attempt, deliveryId };
    }
    if (!firstFailedAt) firstFailedAt = new Date();
    // 4xx other than 408/429 is a permanent client error — don't waste retries.
    const status = lastResult.status;
    if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      break;
    }
  }

  // All attempts exhausted (or short-circuited). Persist to DLQ if the
  // caller gave us an accountId. The persisted row carries the full
  // payload (parsed back to object form) so a future admin retry can
  // replay it byte-for-byte.
  let dlqRowId;
  if (accountId) {
    let payloadObj = null;
    try { payloadObj = JSON.parse(body); } catch (_) { payloadObj = { raw: body }; }
    const row = await persistFailedDelivery({
      accountId,
      webhookEndpointId,
      deliveryId,
      eventType:     payloadObj && payloadObj.event ? payloadObj.event : 'unknown',
      targetUrl:     url,
      payload:       payloadObj,
      attemptCount:  MAX_ATTEMPTS,
      lastError:     lastResult ? lastResult.reason : null,
      lastStatus:    lastResult ? lastResult.status : null,
      firstFailedAt: firstFailedAt || new Date(),
    });
    if (row) dlqRowId = row.id;
  }

  return {
    ...lastResult,
    attempts:   MAX_ATTEMPTS,
    deliveryId,
    dlqRowId,
  };
}

// ── Test payload ──────────────────────────────────────────────────────────────

function buildTestPayload(appUrl) {
  const fakeAsset = {
    id:            'test-00000000-0000-0000-0000-000000000000',
    equipmentType: 'SWITCHGEAR',
    manufacturer:  'Acme Electric',
    model:         'SG-2000',
    serialNumber:  'TEST-0001',
    site:          { name: 'Main Plant' },
  };
  const fakeSchedule = {
    id:             'test-00000000-0000-0000-0000-000000000001',
    nextDueDate:    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    taskDefinition: { taskName: 'IR thermography scan' },
  };
  return buildPayload(
    { schedule: fakeSchedule, asset: fakeAsset, alertType: 'maintenance_due', daysUntil: 30, leadDays: 30 },
    appUrl
  );
}

module.exports = {
  deliverWebhook,
  validateWebhookUrl,
  signPayload,
  buildPayload,
  buildTestPayload,
  EVENT_NAMES,
  // v0.67.10: exposed for webhookRetry.js DLQ auto-retry
  postOnce,
  // F-SSRF-REBIND: exposed for unit tests
  pinnedLookup,
};

export {};

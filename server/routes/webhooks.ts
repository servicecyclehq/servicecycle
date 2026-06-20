const { writeLog: writeActivityLog } = require('../lib/activityLog');
/**
 * server/routes/webhooks.js
 *
 * Generic outbound webhook endpoint management — admin only.
 * Mounted at /api/webhooks in server/index.js.
 *
 * Endpoint management:
 *   GET    /          — list endpoints for the account (url masked)
 *   POST   /          — create a new endpoint (secret generated server-side)
 *   PATCH  /:id       — update label / url / enabled flag
 *   DELETE /:id       — delete endpoint
 *   POST   /:id/test  — fire a synthetic test payload to the endpoint
 *
 * DLQ (v0.37.1 W5 MT-132):
 *   GET    /dlq           — list failed deliveries for the account
 *   POST   /dlq/:id/retry — replay a DLQ row through deliverWebhook again
 *   DELETE /dlq/:id       — purge a DLQ row (operator-initiated)
 *
 * Security:
 *   - Admin only (requireAdmin middleware).
 *   - Maximum MAX_ENDPOINTS_PER_ACCOUNT (5) per account — enforced at create time.
 *   - URL stored encrypted; HMAC secret stored encrypted.
 *   - The raw hmacSecret is returned ONCE on create so the operator can
 *     copy it into their receiving-end verifier. It is never returned again.
 *   - SSRF validation happens both at create time (sync URL shape check) and
 *     at delivery time in lib/webhook.js (DNS resolution check).
 */

'use strict';

const router = require('express').Router();
const crypto = require('crypto');
const { z }  = require('zod');

import prisma from '../lib/prisma';
const { requireAdmin } = require('../middleware/roles');
const { encrypt, decryptIfEncrypted } = require('../lib/crypto');
const { validateWebhookUrl, deliverWebhook, buildTestPayload, signPayload, postOnce } = require('../lib/webhook');

const MAX_ENDPOINTS_PER_ACCOUNT = 5;

// All routes require admin role.
router.use(requireAdmin);

// ── Zod schemas ───────────────────────────────────────────────────────────────

const CreateSchema = z.object({
  label: z.string().max(100).trim().optional().default(''),
  url:   z.string().url().max(2048),
});

const UpdateSchema = z.object({
  label:   z.string().max(100).trim().optional(),
  url:     z.string().url().max(2048).optional(),
  enabled: z.boolean().optional(),
}).refine(d => Object.keys(d).length > 0, { message: 'No fields to update' });

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mask a URL so only the scheme + host are visible in list responses. */
function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/…`;
  } catch {
    return '(invalid url)';
  }
}

/** Generate a 32-byte hex HMAC secret. */
function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── DLQ admin endpoints (MT-132) ─────────────────────────────────────────────
//
// Defined BEFORE the parametric endpoint-management routes so /dlq is not
// matched by /:id. Express router order matters here.
//
// All DLQ rows are scoped to req.user.accountId — no admin can see another
// account's failed deliveries.

router.get('/dlq', async (req, res) => {
  const { accountId } = req.user;
  const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    const rows = await prisma.outboundWebhookDLQ.findMany({
      where:   { accountId },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      select: {
        id:               true,
        deliveryId:       true,
        webhookEndpointId: true,
        eventType:        true,
        targetUrlMasked:  true,
        attemptCount:     true,
        lastError:        true,
        lastStatus:       true,
        firstFailedAt:    true,
        lastAttemptAt:    true,
        createdAt:        true,
      },
    });
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[webhooks] GET /dlq error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

router.post('/dlq/:id/retry', async (req, res) => {
  const { accountId } = req.user;
  const { id } = req.params;
  try {
    const row = await prisma.outboundWebhookDLQ.findFirst({
      where: { id, accountId },
    });
    if (!row) return res.status(404).json({ success: false, error: 'Not found' });

    // The endpoint may have been deleted; refuse to retry in that case.
    if (!row.webhookEndpointId) {
      return res.status(400).json({
        success: false,
        error:   'Original webhook endpoint has been deleted; cannot retry.',
      });
    }

    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { id: row.webhookEndpointId, accountId },
    });
    if (!endpoint) {
      return res.status(400).json({ success: false, error: 'Original webhook endpoint not found.' });
    }
    if (!endpoint.enabled) {
      return res.status(400).json({ success: false, error: 'Webhook endpoint is currently disabled.' });
    }

    const url    = decryptIfEncrypted(endpoint.url);
    const secret = decryptIfEncrypted(endpoint.hmacSecret);
    const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';

    // Replay through deliverWebhook with a synthetic alertItem derived from
    // the persisted payload. The payload's asset id may point to an asset
    // that's been deleted/archived since the original failure — the
    // receiving end will see the same payload it would have seen before,
    // which is the right semantic for "retry the original delivery".
    // NOTE: the alertItem shape below mirrors lib/webhook.js#buildPayload's
    // current input; keep the two in sync when the asset-shaped payload
    // lands there. payload.contractId is the legacy DLQ-row spelling.
    const payload: any = row.payload || {};
    const alertItem: any = {
      contract: {
        id:           payload.assetId || payload.contractId || row.deliveryId,
        product:      payload.product || null,
        vendor:       payload.vendor ? { name: payload.vendor } : null,
        endDate:      payload.endDate || null,
        cancelByDate: payload.cancelByDate || null,
      },
      alertType:     payload.alertType || 'renewal',
      daysUntil:     payload.daysUntil || 0,
      paymentAmount: payload.paymentAmount || null,
    };

    const result = await deliverWebhook({
      url,
      hmacSecret:        secret,
      alertItem,
      appUrl,
      accountId,
      webhookEndpointId: endpoint.id,
    });

    // If the retry succeeded, purge the original DLQ row.
    if (result.ok) {
      await prisma.outboundWebhookDLQ.delete({ where: { id: row.id } }).catch(() => {});
    }

    return res.json({
      success:  result.ok,
      attempts: result.attempts,
      status:   result.status,
      reason:   result.reason,
      dlqRowId: result.dlqRowId, // new DLQ row id if the retry also failed
    });
  } catch (err) {
    console.error('[webhooks] POST /dlq/:id/retry error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

router.delete('/dlq/:id', async (req, res) => {
  const { accountId } = req.user;
  const { id } = req.params;
  try {
    const row = await prisma.outboundWebhookDLQ.findFirst({ where: { id, accountId } });
    if (!row) return res.status(404).json({ success: false, error: 'Not found' });
    await prisma.outboundWebhookDLQ.delete({ where: { id } });
    return res.json({ success: true });
  } catch (err) {
    console.error('[webhooks] DELETE /dlq/:id error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── GET / — list ──────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { accountId } = req.user;
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where:   { accountId },
      orderBy: { createdAt: 'asc' },
      select:  { id: true, label: true, url: true, enabled: true, createdAt: true },
    });

    return res.json({
      success: true,
      data: endpoints.map(ep => ({
        id:        ep.id,
        label:     ep.label,
        urlMasked: maskUrl(decryptIfEncrypted(ep.url)),
        enabled:   ep.enabled,
        createdAt: ep.createdAt,
      })),
    });
  } catch (err) {
    console.error('[webhooks] GET / error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── POST / — create ───────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { accountId } = req.user;

  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error:   'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { label, url } = parsed.data;

  // Quick structural check before DB round-trips
  const { valid, reason: urlReason } = await validateWebhookUrl(url).catch(() => ({ valid: false, reason: 'validation-error' }));
  if (!valid) {
    return res.status(400).json({ success: false, error: `Invalid webhook URL: ${urlReason}` });
  }

  try {
    // Enforce per-account cap
    const count = await prisma.webhookEndpoint.count({ where: { accountId } });
    if (count >= MAX_ENDPOINTS_PER_ACCOUNT) {
      return res.status(400).json({
        success: false,
        error:   `Maximum ${MAX_ENDPOINTS_PER_ACCOUNT} webhook endpoints per account.`,
      });
    }

    const plainSecret = generateSecret();

    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        accountId,
        label:      label || '',
        url:        encrypt(url),
        hmacSecret: encrypt(plainSecret),
        enabled:    true,
      },
      select: { id: true, label: true, enabled: true, createdAt: true },
    });

    // H8 (audit High, 2026-05-22): audit-log the create. Best-effort.
    try {
      writeActivityLog({
        userId: req.user.id,
        accountId,
        action: 'webhook_created',
        details: { webhookId: endpoint.id, label: endpoint.label, urlMasked: maskUrl(url), ip: req.ip || null },
      });
    } catch (logErr) {
      console.error('activity log (webhook_created) error:', logErr);
    }

    // Return the plaintext secret ONCE — never stored in plaintext.
    return res.status(201).json({
      success: true,
      data: {
        ...endpoint,
        urlMasked:         maskUrl(url),
        hmacSecretOnce:    plainSecret,   // caller must copy now; will not be shown again
      },
    });
  } catch (err) {
    console.error('[webhooks] POST / error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── PATCH /:id — update ───────────────────────────────────────────────────────

router.patch('/:id', async (req, res) => {
  const { accountId } = req.user;
  const { id } = req.params;

  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error:   'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const updates = parsed.data;

  // If updating URL, validate it
  if (updates.url) {
    const { valid, reason: urlReason } = await validateWebhookUrl(updates.url).catch(() => ({ valid: false, reason: 'validation-error' }));
    if (!valid) {
      return res.status(400).json({ success: false, error: `Invalid webhook URL: ${urlReason}` });
    }
    updates.url = encrypt(updates.url);
  }

  try {
    const existing = await prisma.webhookEndpoint.findFirst({ where: { id, accountId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });

    const updated = await prisma.webhookEndpoint.update({
      where:  { id },
      data:   updates,
      select: { id: true, label: true, enabled: true, createdAt: true, url: true },
    });

    return res.json({
      success: true,
      data: {
        id:        updated.id,
        label:     updated.label,
        urlMasked: maskUrl(decryptIfEncrypted(updated.url)),
        enabled:   updated.enabled,
        createdAt: updated.createdAt,
      },
    });
  } catch (err) {
    console.error('[webhooks] PATCH /:id error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  const { accountId } = req.user;
  const { id } = req.params;

  try {
    const existing = await prisma.webhookEndpoint.findFirst({ where: { id, accountId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });

    await prisma.webhookEndpoint.delete({ where: { id } });

    // H8 (audit High, 2026-05-22): audit-log the delete.
    try {
      writeActivityLog({
        userId: req.user.id,
        accountId,
        action: 'webhook_revoked',
        details: { webhookId: id, ip: req.ip || null },
      });
    } catch (logErr) {
      console.error('activity log (webhook_revoked) error:', logErr);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[webhooks] DELETE /:id error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── POST /:id/test — fire test payload ────────────────────────────────────────

router.post('/:id/test', async (req, res) => {
  const { accountId } = req.user;
  const { id } = req.params;

  try {
    const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id, accountId } });
    if (!endpoint) return res.status(404).json({ success: false, error: 'Not found' });
    if (!endpoint.enabled) {
      return res.status(400).json({ success: false, error: 'Endpoint is disabled' });
    }

    const url       = decryptIfEncrypted(endpoint.url);
    const secret    = decryptIfEncrypted(endpoint.hmacSecret);
    const appUrl    = process.env.CLIENT_URL || 'http://localhost:5173';

    // H4 (audit High, 2026-05-22): test endpoint now signs with the SAME
    // timestamped HMAC + X-ServiceCycle-Timestamp header that production
    // deliveries use (see lib/webhook.js postOnce). Before this, the test
    // produced signatures matching a pre-W5 contract that production no
    // longer uses -- integrators who built a verifier against this test
    // would pass tests then silently fail in production.
    const body      = buildTestPayload(appUrl);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signPayload(body, timestamp, secret);

    // SSRF (F-SSRF-REBIND): validate AND pin. validateWebhookUrl resolves the
    // host and returns the vetted public IPs; postOnce connects ONLY to those
    // IPs via pinnedLookup. The previous code validated then sent with the
    // global fetch(url), which re-resolves the hostname at connect time — a
    // low-TTL attacker domain could pass validation with a public A record and
    // then rebind to a private / cloud-metadata IP (169.254.169.254) when fetch
    // connected. Routing through postOnce (the same path production deliveries
    // use) closes that DNS-rebinding TOCTOU window.
    const { valid, addresses, reason: ssrfReason } = await validateWebhookUrl(url).catch(() => ({ valid: false, reason: 'validation-error' }));
    if (!valid) {
      return res.status(400).json({ success: false, error: `Blocked: ${ssrfReason}` });
    }

    const result = await postOnce({
      url,
      addresses,
      body,
      signature,
      timestamp,
      deliveryId: crypto.randomUUID(),
      timeoutMs:  5000,
    });

    if (!result.ok) {
      return res.status(502).json({ success: false, error: result.reason, status: result.status });
    }

    return res.json({ success: true, status: result.status });
  } catch (err) {
    console.error('[webhooks] POST /:id/test error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});


// NOTE (2026-06-20 audit): a second, divergent set of GET /dlq and
// DELETE /dlq/:id handlers (backed by lib/webhookDlq listForAccount/dismissOne)
// previously lived here. They were DEAD — Express matches the first registration,
// so the canonical accountId-scoped handlers above (GET /dlq line ~85,
// DELETE /dlq/:id line ~194) always served these paths. The dead duplicates were
// removed to prevent a future edit landing on a handler that never runs.

module.exports = router;

export {};

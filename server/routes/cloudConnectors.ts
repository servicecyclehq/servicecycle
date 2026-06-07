/**
 * routes/cloudConnectors.js
 *
 * Cloud marketplace connector configuration API.
 * Admin-only — all routes require req.user.role === 'admin'.
 *
 * GET    /api/cloud-connectors              List all connectors for the account (credentials masked)
 * GET    /api/cloud-connectors/:provider    Get one connector (credentials masked)
 * PUT    /api/cloud-connectors/:provider    Upsert connector config + credentials
 * DELETE /api/cloud-connectors/:provider    Disconnect / remove a connector
 * POST   /api/cloud-connectors/:provider/test   Validate credentials (format only for now)
 *
 * Credential security (H1):
 *   - Sensitive credential values are encrypted at rest using AES-256-GCM (lib/crypto.js).
 *   - On read for client display: credentials are decrypted then immediately masked.
 *   - On write: sensitive fields are encrypted before persisting.
 *   - On test: sensitive fields are decrypted to pass to validateCredentials().
 *   - Non-sensitive fields (IDs, project names, etc.) stay plaintext.
 */

const router   = require('express').Router();
import prisma from '../lib/prisma';
const { getProvider, VALID_PROVIDERS, PROVIDER_META } = require('../lib/cloudConnectors');
const { encryptIfNeeded, decryptIfEncrypted, isEncrypted } = require('../lib/crypto');
const { syncPurchases } = require('../lib/syncEngine');

// ── M2: Safe error categorization ────────────────────────────────────────────
// Map raw upstream provider errors to safe category strings before persisting
// in lastError. Raw messages may contain ARNs, IAM principal info, billing
// account IDs, etc. that we don't want to surface in the admin UI.
function _categorizeSyncError(err) {
  const status = err?.response?.status;
  const msg    = (err?.message || '').toLowerCase();
  if (status === 401 || msg.includes('unauthorized') || msg.includes('invalid_client') ||
      msg.includes('credentials') || msg.includes('forbidden') || status === 403) {
    return 'Authentication failed — check credentials and IAM permissions.';
  }
  if (status === 404 || msg.includes('not found') || msg.includes('no such')) {
    return 'Resource not found — verify account ID / project ID / subscription ID.';
  }
  if (status === 429 || msg.includes('throttl') || msg.includes('rate limit') || msg.includes('quota')) {
    return 'Rate limited by cloud provider — will retry at next sync.';
  }
  if (msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('network') ||
      msg.includes('timeout') || msg.includes('socket')) {
    return 'Network error — could not reach cloud provider API.';
  }
  if (status >= 500 && status < 600) {
    return `Cloud provider returned a server error (${status}) — will retry at next sync.`;
  }
  return 'Sync failed — check server logs for details.';
}

// Sensitive credential field name fragments — must match maskCredentials list
const SENSITIVE_KEYS = ['secretAccessKey', 'clientSecret', 'serviceAccountKey', 'privateKey', 'apiKey', 'secret', 'password'];

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.some(s => key.toLowerCase().includes(s.toLowerCase()));
}

// ── Auth guard: admin only ────────────────────────────────────────────────────
router.use((req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required to manage cloud connectors' });
  }
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Encrypt sensitive fields in a credentials object before DB storage.
 * Non-sensitive fields are stored as plaintext.
 */
function encryptCredentials(creds) {
  if (!creds || typeof creds !== 'object') return creds;
  const result: any = {};
  for (const [key, value] of Object.entries<any>(creds)) {
    if (isSensitiveKey(key) && value) {
      result[key] = encryptIfNeeded(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Decrypt sensitive fields in a credentials object loaded from DB.
 * Returns plaintext credentials for internal use (test endpoint, etc.).
 */
function decryptCredentials(creds) {
  if (!creds || typeof creds !== 'object') return creds;
  const result: any = {};
  for (const [key, value] of Object.entries<any>(creds)) {
    result[key] = (isSensitiveKey(key) && value) ? decryptIfEncrypted(value) : value;
  }
  return result;
}

/**
 * Mask a credential object for safe client delivery.
 * Password/secret/key fields are replaced with "••••••••" regardless of whether
 * they were encrypted or plaintext in the DB (the client never sees ciphertext).
 * Plain text fields (IDs, project names) show their value so the user can
 * verify what was saved without re-entering everything.
 */
function maskCredentials(creds) {
  if (!creds || typeof creds !== 'object') return {};
  const result: any = {};
  for (const [key, value] of Object.entries<any>(creds)) {
    if (isSensitiveKey(key)) {
      // Show masked placeholder whether the stored value is encrypted or blank
      result[key] = value ? '••••••••' : '';
    } else {
      result[key] = value ?? '';
    }
  }
  return result;
}

/**
 * Merge incoming credential update with existing DECRYPTED stored credentials,
 * preserving currently-saved values for fields that were sent back masked.
 */
function mergeCredentials(existingDecrypted, incoming) {
  const merged: any = { ...(existingDecrypted || {}) };
  for (const [key, value] of Object.entries<any>(incoming || {})) {
    // Skip if client sent back the masked placeholder — keep existing value
    if (typeof value === 'string' && /^[•]+$/.test(value.trim())) continue;
    merged[key] = value;
  }
  return merged;
}

// ── GET /api/cloud-connectors ─────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await prisma.cloudConnector.findMany({
      where: { accountId: req.user.accountId },
      orderBy: { provider: 'asc' },
    });

    // Return all known providers — ones not yet configured get a skeleton record
    const result = VALID_PROVIDERS.map(provider => {
      const saved = rows.find(r => r.provider === provider);
      const meta  = PROVIDER_META[provider];
      if (saved) {
        // Mask directly from stored value — never decrypt on GET (client sees '••••••••')
        return {
          ...meta,
          id:          saved.id,
          label:       saved.label,
          status:      saved.status,
          lastError:   saved.lastError,
          lastSyncAt:  saved.lastSyncAt,
          credentials: maskCredentials(saved.credentials),
          configured:  true,
        };
      }
      return {
        ...meta,
        id:          null,
        label:       null,
        status:      'not_configured',
        lastError:   null,
        lastSyncAt:  null,
        credentials: {},
        configured:  false,
      };
    });

    res.json({ success: true, data: { connectors: result } });
  } catch (err) {
    console.error('List cloud connectors error:', err);
    res.status(500).json({ success: false, error: 'Failed to load cloud connectors' });
  }
});

// ── GET /api/cloud-connectors/:provider ───────────────────────────────────────
router.get('/:provider', async (req, res) => {
  const { provider } = req.params;
  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ success: false, error: `Unknown provider: ${provider}` });
  }

  try {
    const providerMod = getProvider(provider);
    const row = await prisma.cloudConnector.findUnique({
      where: { accountId_provider: { accountId: req.user.accountId, provider } },
    });

    const meta = PROVIDER_META[provider];
    res.json({
      success: true,
      data: {
        ...meta,
        id:                 row?.id          ?? null,
        label:              row?.label       ?? null,
        status:             row?.status      ?? 'not_configured',
        lastError:          row?.lastError   ?? null,
        lastSyncAt:         row?.lastSyncAt  ?? null,
        // Mask directly — never decrypt on GET
        credentials:        maskCredentials(row?.credentials ?? {}),
        configured:         !!row,
        fields:             providerMod.FIELDS,
        setupInstructions:  providerMod.SETUP_INSTRUCTIONS,
      },
    });
  } catch (err) {
    console.error('Get cloud connector error:', err);
    res.status(500).json({ success: false, error: 'Failed to load connector' });
  }
});

// ── PUT /api/cloud-connectors/:provider ───────────────────────────────────────
// Upserts the connector configuration. Accepts { label, credentials }.
// Credentials are merged with existing stored values so masked fields are preserved,
// then sensitive fields are encrypted before persisting.
router.put('/:provider', async (req, res) => {
  const { provider } = req.params;
  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ success: false, error: `Unknown provider: ${provider}` });
  }

  try {
    const { label, credentials } = req.body;

    // Load existing connector (if any)
    const existing = await prisma.cloudConnector.findUnique({
      where: { accountId_provider: { accountId: req.user.accountId, provider } },
    });

    // Decrypt existing stored creds so mergeCredentials works in plaintext space
    const existingDecrypted = decryptCredentials(existing?.credentials ?? {});

    // Merge — incoming masked fields are skipped (existing plaintext preserved)
    const mergedPlaintext = mergeCredentials(existingDecrypted, credentials);

    // M1: strip unknown keys and validate before persisting
    const providerMod = getProvider(provider);
    const allowedKeys = new Set((providerMod.FIELDS ?? []).map(f => f.key));
    for (const k of Object.keys(mergedPlaintext)) {
      if (!allowedKeys.has(k)) delete mergedPlaintext[k];
    }
    const validation = providerMod.validateCredentials(mergedPlaintext);
    if (!validation.ok) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    // Encrypt sensitive fields before persisting
    const mergedEncrypted = encryptCredentials(mergedPlaintext);

    const connector = await prisma.cloudConnector.upsert({
      where:  { accountId_provider: { accountId: req.user.accountId, provider } },
      update: {
        label:       label ?? existing?.label ?? null,
        credentials: mergedEncrypted,
        status:      'not_configured', // reset to not_configured until tested
        lastError:   null,
        updatedAt:   new Date(),
      },
      create: {
        accountId:   req.user.accountId,
        provider,
        label:       label ?? null,
        credentials: mergedEncrypted,
        status:      'not_configured',
      },
    });

    res.json({
      success: true,
      data: {
        id:          connector.id,
        provider,
        label:       connector.label,
        status:      connector.status,
        // Mask from stored encrypted blob — client sees '••••••••'
        credentials: maskCredentials(connector.credentials),
      },
    });
  } catch (err) {
    console.error('Save cloud connector error:', err);
    res.status(500).json({ success: false, error: 'Failed to save connector' });
  }
});

// ── DELETE /api/cloud-connectors/:provider ────────────────────────────────────
router.delete('/:provider', async (req, res) => {
  const { provider } = req.params;
  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ success: false, error: `Unknown provider: ${provider}` });
  }

  try {
    await prisma.cloudConnector.deleteMany({
      where: { accountId: req.user.accountId, provider },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete cloud connector error:', err);
    res.status(500).json({ success: false, error: 'Failed to remove connector' });
  }
});

// ── POST /api/cloud-connectors/:provider/test ─────────────────────────────────
// Validates credentials: format check + live API connectivity test.
// Decrypts stored creds so the full plaintext is available for the live test.
router.post('/:provider/test', async (req, res) => {
  const { provider } = req.params;
  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ success: false, error: `Unknown provider: ${provider}` });
  }

  try {
    const providerMod = getProvider(provider);
    const { credentials } = req.body;

    // Load existing creds from DB, decrypt, and merge
    const existing = await prisma.cloudConnector.findUnique({
      where: { accountId_provider: { accountId: req.user.accountId, provider } },
    });
    const existingDecrypted = decryptCredentials(existing?.credentials ?? {});
    const mergedPlaintext   = mergeCredentials(existingDecrypted, credentials);

    // Step 1: format validation (fast, no network)
    const validation = providerMod.validateCredentials(mergedPlaintext);
    if (!validation.ok) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    // Step 2: live connectivity test (real API call)
    let liveResult;
    try {
      liveResult = await providerMod.testConnection(mergedPlaintext);
    } catch (liveErr) {
      liveResult = { ok: false, error: liveErr.message };
    }

    // Update connector status based on live result
    if (existing) {
      await prisma.cloudConnector.update({
        where: { id: existing.id },
        data:  {
          status:      liveResult.ok ? 'connected' : 'error',
          lastError:   liveResult.ok ? null : (liveResult.error || 'Connectivity test failed'),
          credentials: encryptCredentials(mergedPlaintext),
        },
      });
    }

    if (!liveResult.ok) {
      return res.status(400).json({
        success: false,
        error:   liveResult.error || 'Live connectivity test failed. Check your credentials and IAM permissions.',
      });
    }

    res.json({
      success: true,
      message: liveResult.message || 'Connection successful.',
    });
  } catch (err) {
    console.error('Test cloud connector error:', err);
    res.status(500).json({ success: false, error: 'Failed to test connector' });
  }
});

// ── POST /api/cloud-connectors/:provider/sync ─────────────────────────────────
// Triggers a data sync: fetches purchases from the cloud provider and upserts
// them into LapseIQ contracts. Admin-only.
router.post('/:provider/sync', async (req, res) => {
  const { provider } = req.params;
  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ success: false, error: `Unknown provider: ${provider}` });
  }

  try {
    const providerMod = getProvider(provider);

    // Load and decrypt stored credentials
    const existing = await prisma.cloudConnector.findUnique({
      where: { accountId_provider: { accountId: req.user.accountId, provider } },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: `No ${provider} connector configured. Save credentials first.` });
    }

    const mergedPlaintext = decryptCredentials(existing.credentials ?? {});

    // Format validation before making network calls
    const validation = providerMod.validateCredentials(mergedPlaintext);
    if (!validation.ok) {
      return res.status(400).json({ success: false, error: `Connector credentials are invalid: ${validation.error}` });
    }

    // Mark connector as syncing
    await prisma.cloudConnector.update({
      where: { id: existing.id },
      data:  { status: 'connected', lastError: null },
    });

    // Fetch purchases from cloud provider
    let records;
    try {
      records = await providerMod.fetchPurchases(mergedPlaintext);
    } catch (fetchErr) {
      // M2: log raw error server-side, store safe category in DB
      console.error(`[cloud-connectors] fetchPurchases error (${provider}):`, fetchErr.message);
      const safeError = _categorizeSyncError(fetchErr);
      await prisma.cloudConnector.update({
        where: { id: existing.id },
        data:  { status: 'error', lastError: safeError },
      });
      return res.status(502).json({ success: false, error: safeError });
    } finally {
      // M3: wipe plaintext credential reference as soon as fetch completes or fails
      Object.keys(mergedPlaintext).forEach(k => { mergedPlaintext[k] = null; });
    }

    // Upsert into LapseIQ contracts
    const syncResult = await syncPurchases(req.user.accountId, provider, records);

    res.json({
      success: true,
      data: {
        provider,
        recordsFetched: records.length,
        created:        syncResult.created,
        updated:        syncResult.updated,
        skipped:        syncResult.skipped,
        errors:         syncResult.errors,
        lastSyncAt:     new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('Sync cloud connector error:', err);
    res.status(500).json({ success: false, error: 'Failed to run marketplace sync' });
  }
});

module.exports = router;

export {};

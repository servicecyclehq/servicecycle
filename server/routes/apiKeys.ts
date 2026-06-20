/**
 * API Key management routes — admin only.
 * Mounted at /api/settings/api-keys in server/index.js.
 *
 * POST   /                — generate a new key; returns plaintext ONCE
 * GET    /                — list active + revoked keys (metadata only, no hash)
 * DELETE /:id             — revoke a key (soft-delete via revokedAt)
 *
 * Key generation:
 *   1. Generate 32 random bytes → hex string (64 chars) prefixed with "liq_"
 *      so users can recognize ServiceCycle keys at a glance and secret-scanners
 *      (e.g. GitHub push protection) can target this prefix.
 *   2. SHA-256 hash the key → store only the hash.
 *   3. Return plaintext to the client ONCE in the response.
 *      The plaintext is never logged or stored.
 */

const router  = require('express').Router();
const crypto  = require('crypto');
const { z }   = require('zod');
import prisma from '../lib/prisma';
const { requireAdmin } = require('../middleware/roles');
const { hashApiKey }   = require('../middleware/apiKeyAuth');
// T5-N1 (audit-2): writeActivityLog called on lines below but was never
// imported — every key mint/revoke silently threw ReferenceError swallowed
// by the surrounding try/catch. Import matches the pattern in users.js.
const { writeLog: writeActivityLog } = require('../lib/activityLog');

// All routes require admin role (checked after authenticateToken at mount site).
router.use(requireAdmin);

// ── Zod schemas ───────────────────────────────────────────────────────────────
const CreateSchema = z.object({
  name:      z.string().min(1).max(100).trim(),
  expiresAt: z.string().datetime({ offset: true }).optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional())
    .nullable()
    .optional(),
  // Phase 3 #7: requested scopes. 'read' is always implied; 'write' must be
  // explicitly granted to mint a key that can use the bi-directional endpoints.
  scopes: z.array(z.enum(['read', 'write'])).optional(),
});

// Normalize requested scopes: always include 'read', dedupe, drop anything
// unrecognized. A key with no scopes requested is read-only.
function normalizeScopes(requested) {
  const set = new Set(['read']);
  for (const s of (requested || [])) {
    if (s === 'read' || s === 'write') set.add(s);
  }
  return [...set];
}

// ── POST / — generate key ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { name, expiresAt } = parsed.data;
  const scopes = normalizeScopes(parsed.data.scopes);
  const accountId = req.user.accountId;

  // Generate a 32-byte (256-bit) random key with a recognisable prefix.
  const rawBytes   = crypto.randomBytes(32).toString('hex');
  const plaintext  = `liq_${rawBytes}`;
  const keyHash    = hashApiKey(plaintext);

  try {
    const apiKey = await prisma.apiKey.create({
      data: {
        accountId,
        name,
        keyHash,
        scopes,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
      select: { id: true, name: true, scopes: true, expiresAt: true, createdAt: true },
    });

    // H8 (audit High, 2026-05-22): write to ActivityLog so admins can see
    // who minted which API key + when. Best-effort log; failure must not
    // block the create response.
    try {
      writeActivityLog({
        userId: req.user.id,
        accountId: req.user.accountId,
        action: 'api_key_created',
        details: { apiKeyId: apiKey.id, name: apiKey.name, ip: req.ip || null },
      });
    } catch (logErr) {
      console.error('activity log (api_key_created) error:', logErr);
    }

    // Return plaintext ONLY here — never again.
    return res.status(201).json({
      success: true,
      data: {
        ...apiKey,
        key: plaintext, // shown once — store it now!
      },
    });
  } catch (err) {
    console.error('[apiKeys] create error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET / — list keys ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where:   { accountId: req.user.accountId },
      select: {
        id:         true,
        name:       true,
        scopes:     true,
        lastUsedAt: true,
        expiresAt:  true,
        createdAt:  true,
        revokedAt:  true,
        // keyHash is intentionally excluded — never returned to client
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, data: keys });
  } catch (err) {
    console.error('[apiKeys] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── DELETE /:id — revoke key ──────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  // Verify the key belongs to this account before revoking
  const existing = await prisma.apiKey.findFirst({
    where:  { id, accountId: req.user.accountId },
    select: { id: true, revokedAt: true },
  }).catch(() => null);

  if (!existing) {
    return res.status(404).json({ success: false, error: 'API key not found' });
  }

  if (existing.revokedAt) {
    return res.status(409).json({ success: false, error: 'API key is already revoked' });
  }

  try {
    await prisma.apiKey.update({
      where: { id },
      data:  { revokedAt: new Date() },
    });

    // H8 (audit High, 2026-05-22): audit-log the revoke.
    try {
      writeActivityLog({
        userId: req.user.id,
        accountId: req.user.accountId,
        action: 'api_key_revoked',
        details: { apiKeyId: id, ip: req.ip || null },
      });
    } catch (logErr) {
      console.error('activity log (api_key_revoked) error:', logErr);
    }

    return res.json({ success: true, data: { id, revoked: true } });
  } catch (err) {
    console.error('[apiKeys] revoke error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};

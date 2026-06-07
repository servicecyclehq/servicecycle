// ─────────────────────────────────────────────────────────────────────────────
// routes/preferences.js — v0.42 per-user key/value preferences
//
// Backs the new client-side useUserPreference() hook. Used today for saved
// views + column visibility on Contracts and Alerts lists; intentionally
// generic so any future personalization (theme, density, default filters,
// etc.) can land without a new endpoint.
//
// Endpoints (mounted under /api/preferences):
//   GET    /                  → { items: [{ key, value, updatedAt }] }
//   GET    /:key              → { key, value, updatedAt } or 404
//   PUT    /:key              → upsert (body: { value })
//   DELETE /:key              → 204 (no-op if not present)
//
// All endpoints require an authenticated user (mounted with authenticateToken
// upstream in server/index.js). No role gate — preferences are personal.
// Each user can only see / change their own row by construction (req.user.id
// is the only userId used in queries).
//
// Storage shape is { value: JSON } — callers stash whatever shape they want.
// To keep payloads from growing unbounded, PUT rejects values that serialize
// to more than 256 KB (covers ~hundreds of saved views with rich state).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const { z } = require('zod');
import prisma from '../lib/prisma';

const router = express.Router();

// Bound the key length + alphabet so accidental URL-encoded garbage doesn't
// pollute the table. Dotted + colon-namespaced segments are fine
// ("contracts.columnVisibility", "lapseiq:contracts-list:saved-views") —
// matches the namespacing client code is already using for localStorage.
const KEY_RE  = /^[a-z][a-z0-9._:-]{0,127}$/i;
const MAX_VAL = 256 * 1024; // 256 KB JSON serialized

const PutBodySchema = z.object({
  value: z.unknown().refine(
    (v) => {
      // refine to a real serializable value within the size cap
      let s;
      try { s = JSON.stringify(v); } catch { return false; }
      if (typeof s !== 'string') return false;
      return s.length <= MAX_VAL;
    },
    { message: `value must be JSON-serializable and ≤ ${MAX_VAL} bytes` }
  ),
});

function validKey(req, res) {
  const key = req.params.key;
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    res.status(400).json({ error: 'invalid_key', message: 'key must match /^[a-z][a-z0-9._-]{0,127}$/i' });
    return null;
  }
  return key;
}

// ── GET /api/preferences — list all for the current user ────────────────────
router.get('/', async (req, res) => {
  try {
    const items = await prisma.userPreference.findMany({
      where: { userId: req.user.id },
      select: { key: true, value: true, updatedAt: true },
      orderBy: { key: 'asc' },
    });
    res.json({ items });
  } catch (err) {
    console.error('[preferences] list failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /api/preferences/:key ───────────────────────────────────────────────
router.get('/:key', async (req, res) => {
  const key = validKey(req, res);
  if (!key) return;
  try {
    const row = await prisma.userPreference.findUnique({
      where: { userId_key: { userId: req.user.id, key } },
      select: { key: true, value: true, updatedAt: true },
    });
    // Audit-7 follow-up: return 200 with null value when the pref does not exist.
    // Pre-fix this returned 404 which produced repeated 404 noise in the network
    // tab on every list-page mount (columnVisibility + saved-views not yet saved).
    // The 'not yet set' semantic is exactly null, not 'not found'.
    if (!row) return res.json({ key, value: null, updatedAt: null });
    res.json(row);
  } catch (err) {
    console.error('[preferences] get failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── PUT /api/preferences/:key — upsert ──────────────────────────────────────
router.put('/:key', async (req, res) => {
  const key = validKey(req, res);
  if (!key) return;

  const parsed = PutBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_body',
      message: parsed.error.issues?.[0]?.message || 'value is required and must be JSON-serializable',
    });
  }
  const { value } = parsed.data;

  try {
    const row = await prisma.userPreference.upsert({
      where:  { userId_key: { userId: req.user.id, key } },
      update: { value },
      create: { userId: req.user.id, key, value },
      select: { key: true, value: true, updatedAt: true },
    });
    res.json(row);
  } catch (err) {
    console.error('[preferences] upsert failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── DELETE /api/preferences/:key ────────────────────────────────────────────
router.delete('/:key', async (req, res) => {
  const key = validKey(req, res);
  if (!key) return;
  try {
    await prisma.userPreference.deleteMany({
      where: { userId: req.user.id, key },
    });
    res.status(204).end();
  } catch (err) {
    console.error('[preferences] delete failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;

export {};

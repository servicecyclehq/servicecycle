/**
 * Contract categories — per-account taxonomy (Phase 2 of the non-SaaS
 * expansion). The 9 system defaults are seeded by
 * server/scripts/seed-categories.js on every new account creation; users
 * can also create custom categories.
 *
 * Endpoints
 *   GET    /api/categories                — list all (active + archived)
 *                                            for this account; any auth
 *                                            user can read so the contract
 *                                            form picker renders.
 *   POST   /api/categories                — admin only (v0.3.1 tightening,
 *                                            was manager+admin); creates a
 *                                            new user-defined category.
 *   PUT    /api/categories/:id            — admin only; updates name, icon,
 *                                            color, displayOrder,
 *                                            defaultNoticeDays,
 *                                            defaultAutoRenewal. Slug is
 *                                            immutable (existing contract
 *                                            assignments rely on stable id).
 *   PATCH  /api/categories/:id/archive    — admin only; toggles archivedAt.
 *                                            Soft-delete only — existing
 *                                            contracts keep their categoryId
 *                                            so reports stay consistent; the
 *                                            category just no longer appears
 *                                            in the picker.
 *
 * Slug rules: machine-key, stable across renames. The 9 system defaults
 * have pinned slugs (saas, telecom, utilities, insurance, lease_rent,
 * hardware, services, supplies, other) — user-created categories get
 * auto-slugged from their display name; uniqueness is enforced per account.
 *
 * v0.3.1 hardening (2026-05-11 audit):
 *   F-001 — Permission gate tightened from requireManager to requireAdmin
 *           to match the rest of the Settings surface (manager can't reach
 *           /settings at all, so the prior requireManager was a dead grant).
 *   F-002 — Color and icon now validated: color must be #RRGGBB, icon
 *           rejects < and > like name does.
 *   F-003 — defaultNoticeDays clamped to 0..3650 (10yr cap); displayOrder
 *           clamped to 0..10000.
 *   F-004 — Numeric fields now accept both numbers and numeric strings,
 *           and return 400 on type mismatch instead of silently nulling.
 *   F-005 — writeActivityLog calls added on create/update/archive.
 */

'use strict';

const router = require('express').Router();
import prisma from '../lib/prisma';
const { requireAdmin } = require('../middleware/roles');
const { writeLog: writeActivityLog } = require('../lib/activityLog');

const MAX_CATEGORIES_PER_ACCOUNT = 50; // sanity cap — picker UI gets unwieldy past this
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/; // v0.3.1 F-002

/**
 * Slugify a display name into a stable slug. Used at create time only;
 * never rewritten so existing contract assignments survive renames.
 * Mirrors customFields.slugifyKey for consistency.
 */
function slugifyName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/**
 * v0.3.1 F-003 + F-004: Parse + bounds-check an integer field that came
 * in either as a real number or a numeric string. Returns:
 *   { ok: true, value: <int|null> }            on valid number or null/undef
 *   { ok: false, error: '<message>' }          on bad type or out-of-bounds
 *
 * Pass null/undefined through as null (lets callers distinguish "field
 * absent" from "field present with invalid value").
 */
function parseBoundedInt(raw, fieldName, { min = 0, max = 2147483647 } = {}) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `${fieldName} must be a number` };
  }
  const i = Math.trunc(n);
  if (i < min || i > max) {
    return { ok: false, error: `${fieldName} must be between ${min} and ${max}` };
  }
  return { ok: true, value: i };
}

/**
 * v0.3.1 F-004: Coerce a boolean-ish input (real boolean, "true"/"false",
 * 1/0). Returns:
 *   { ok: true, value: <bool|null> }   on valid input or null/undef
 *   { ok: false, error: '<message>' }  on bad type
 */
function parseBool(raw, fieldName) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  if (raw === 'true' || raw === 1 || raw === '1')  return { ok: true, value: true };
  if (raw === 'false' || raw === 0 || raw === '0') return { ok: true, value: false };
  return { ok: false, error: `${fieldName} must be true or false` };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where:   { accountId: req.user.accountId },
      orderBy: [{ archivedAt: 'asc' }, { displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
    // Include contract count per category so the Settings tab can show
    // "Insurance · 4 contracts" — useful when deciding whether archive is safe.
    const counts = await prisma.contract.groupBy({
      by: ['categoryId'],
      where: { accountId: req.user.accountId, archivedAt: null },
      _count: { _all: true },
    });
    const countByCategoryId = Object.fromEntries(counts.map(r => [r.categoryId, r._count._all]));
    const enriched = categories.map(c => ({
      ...c,
      contractCount: countByCategoryId[c.id] || 0,
    }));
    res.json({ success: true, data: { categories: enriched } });
  } catch (err) {
    console.error('GET /categories:', err);
    res.status(500).json({ success: false, error: 'Failed to load categories' });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, icon, color, defaultNoticeDays, defaultAutoRenewal, displayOrder } = req.body || {};

    // --- name ---
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (name.length > 80) {
      return res.status(400).json({ success: false, error: 'name must be 80 characters or fewer' });
    }
    if (/[<>]/.test(name)) {
      return res.status(400).json({ success: false, error: 'name cannot contain < or >' });
    }

    // --- icon (F-002) ---
    let cleanIcon = null;
    if (icon != null && icon !== '') {
      if (typeof icon !== 'string') {
        return res.status(400).json({ success: false, error: 'icon must be a string' });
      }
      if (/[<>]/.test(icon)) {
        return res.status(400).json({ success: false, error: 'icon cannot contain < or >' });
      }
      cleanIcon = icon.slice(0, 16);
    }

    // --- color (F-002) ---
    let cleanColor = null;
    if (color != null && color !== '') {
      if (typeof color !== 'string' || !HEX_COLOR_RE.test(color)) {
        return res.status(400).json({ success: false, error: 'color must be a 6-char hex string like #3b82f6' });
      }
      cleanColor = color;
    }

    // --- defaultNoticeDays (F-003 + F-004) ---
    const ndays = parseBoundedInt(defaultNoticeDays, 'defaultNoticeDays', { min: 0, max: 3650 });
    if (!ndays.ok) return res.status(400).json({ success: false, error: ndays.error });

    // --- defaultAutoRenewal (F-004) ---
    const autorenew = parseBool(defaultAutoRenewal, 'defaultAutoRenewal');
    if (!autorenew.ok) return res.status(400).json({ success: false, error: autorenew.error });

    // --- displayOrder (F-003 + F-004) ---
    const dord = parseBoundedInt(displayOrder, 'displayOrder', { min: 0, max: 10000 });
    if (!dord.ok) return res.status(400).json({ success: false, error: dord.error });

    const slug = slugifyName(name);
    if (!slug) {
      return res.status(400).json({ success: false, error: 'name must contain at least one letter or digit' });
    }

    // Cap total categories per account.
    const count = await prisma.category.count({
      where: { accountId: req.user.accountId, archivedAt: null },
    });
    if (count >= MAX_CATEGORIES_PER_ACCOUNT) {
      return res.status(400).json({ success: false, error: `Limit of ${MAX_CATEGORIES_PER_ACCOUNT} active categories reached. Archive an unused category first.` });
    }

    try {
      const created = await prisma.category.create({
        data: {
          accountId:          req.user.accountId,
          createdById:        req.user.id,
          name:               name.trim(),
          slug,
          icon:               cleanIcon,
          color:              cleanColor,
          defaultNoticeDays:  ndays.value,
          defaultAutoRenewal: autorenew.value,
          displayOrder:       dord.value != null ? dord.value : (100 + count * 10),
          isSystemDefault:    false,
        },
      });
      // F-005: audit
      writeActivityLog({
        userId:  req.user.id,
        action:  'category_created',
        details: { categoryId: created.id, slug: created.slug, name: created.name },
      });
      res.json({ success: true, data: { category: created } });
    } catch (e) {
      if (e.code === 'P2002') {
        return res.status(400).json({ success: false, error: `A category with slug "${slug}" already exists. Pick a different name.` });
      }
      throw e;
    }
  } catch (err) {
    console.error('POST /categories:', err);
    res.status(500).json({ success: false, error: 'Failed to create category' });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await prisma.category.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Category not found' });

    // Slug is immutable — even renaming a system default keeps the slug so
    // category-specific code (Phase 4 prompt template routing, etc.)
    // continues to resolve. Same pattern as CustomFieldDefinition.fieldKey.
    const data: any = {};
    const changes = []; // F-005: track what changed for the audit row

    if (typeof req.body.name === 'string' && req.body.name.trim().length > 0) {
      if (req.body.name.length > 80) {
        return res.status(400).json({ success: false, error: 'name must be 80 characters or fewer' });
      }
      if (/[<>]/.test(req.body.name)) {
        return res.status(400).json({ success: false, error: 'name cannot contain < or >' });
      }
      data.name = req.body.name.trim().slice(0, 80);
      if (data.name !== existing.name) changes.push('name');
    }
    if ('icon' in req.body) {
      const raw = req.body.icon;
      if (raw == null || raw === '') {
        data.icon = null;
      } else {
        if (typeof raw !== 'string') {
          return res.status(400).json({ success: false, error: 'icon must be a string' });
        }
        if (/[<>]/.test(raw)) {
          return res.status(400).json({ success: false, error: 'icon cannot contain < or >' });
        }
        data.icon = raw.slice(0, 16);
      }
      if (data.icon !== existing.icon) changes.push('icon');
    }
    if ('color' in req.body) {
      const raw = req.body.color;
      if (raw == null || raw === '') {
        data.color = null;
      } else {
        if (typeof raw !== 'string' || !HEX_COLOR_RE.test(raw)) {
          return res.status(400).json({ success: false, error: 'color must be a 6-char hex string like #3b82f6' });
        }
        data.color = raw;
      }
      if (data.color !== existing.color) changes.push('color');
    }
    if ('displayOrder' in req.body) {
      const dord = parseBoundedInt(req.body.displayOrder, 'displayOrder', { min: 0, max: 10000 });
      if (!dord.ok) return res.status(400).json({ success: false, error: dord.error });
      data.displayOrder = dord.value != null ? dord.value : existing.displayOrder;
      if (data.displayOrder !== existing.displayOrder) changes.push('displayOrder');
    }
    if ('defaultNoticeDays' in req.body) {
      const ndays = parseBoundedInt(req.body.defaultNoticeDays, 'defaultNoticeDays', { min: 0, max: 3650 });
      if (!ndays.ok) return res.status(400).json({ success: false, error: ndays.error });
      data.defaultNoticeDays = ndays.value;
      if (data.defaultNoticeDays !== existing.defaultNoticeDays) changes.push('defaultNoticeDays');
    }
    if ('defaultAutoRenewal' in req.body) {
      const ar = parseBool(req.body.defaultAutoRenewal, 'defaultAutoRenewal');
      if (!ar.ok) return res.status(400).json({ success: false, error: ar.error });
      data.defaultAutoRenewal = ar.value;
      if (data.defaultAutoRenewal !== existing.defaultAutoRenewal) changes.push('defaultAutoRenewal');
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields provided' });
    }

    const updated = await prisma.category.update({
      where: { id: existing.id },
      data,
    });
    // F-005: audit
    if (changes.length > 0) {
      writeActivityLog({
        userId:  req.user.id,
        action:  'category_updated',
        details: { categoryId: updated.id, slug: updated.slug, fields: changes },
      });
    }
    res.json({ success: true, data: { category: updated } });
  } catch (err) {
    console.error('PUT /categories/:id:', err);
    res.status(500).json({ success: false, error: 'Failed to update category' });
  }
});

router.patch('/:id/archive', requireAdmin, async (req, res) => {
  try {
    const existing = await prisma.category.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Category not found' });

    const archive = req.body.archived === true || req.body.archived === 'true';

    // Block archiving "saas" specifically — it's the system-fallback default
    // used by POST /api/contracts when no categoryId is supplied. Archiving
    // it would leave new contract creates with no fallback.
    if (archive && existing.slug === 'saas') {
      return res.status(400).json({
        success: false,
        error: 'The SaaS category is the fallback for new contracts and cannot be archived. Rename or re-style it instead.',
      });
    }

    const updated = await prisma.category.update({
      where: { id: existing.id },
      data:  { archivedAt: archive ? new Date() : null },
    });
    // F-005: audit
    writeActivityLog({
      userId:  req.user.id,
      action:  archive ? 'category_archived' : 'category_restored',
      details: { categoryId: updated.id, slug: updated.slug },
    });
    res.json({ success: true, data: { category: updated } });
  } catch (err) {
    console.error('PATCH /categories/:id/archive:', err);
    res.status(500).json({ success: false, error: 'Failed to toggle archive' });
  }
});

module.exports = router;

export {};

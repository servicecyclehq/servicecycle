/**
 * Custom asset fields — admin-defined fields that show up on every
 * asset form.
 *
 * Endpoints
 *   GET    /api/custom-fields                — list all (active + archived)
 *                                              for this account; any
 *                                              authenticated user can read
 *                                              so the asset form renders.
 *   POST   /api/custom-fields                — admin only; creates a new
 *                                              definition.
 *   PUT    /api/custom-fields/:id            — admin only; updates name,
 *                                              helpText, required, options,
 *                                              displayOrder. Type and
 *                                              fieldKey are immutable after
 *                                              creation (changing them
 *                                              would silently break stored
 *                                              values).
 *   PATCH  /api/custom-fields/:id/archive    — admin only; toggles
 *                                              archivedAt. Soft-delete only;
 *                                              values stay readable on
 *                                              existing assets so the
 *                                              CSV export stays complete.
 *
 * Field types and validation:
 *   - text      — any string
 *   - textarea  — any string (UI render hint)
 *   - number    — coerces to Number, rejects NaN
 *   - date      — must parse via new Date()
 *   - checkbox  — 'true'|'false' (stored as string for column-uniformity)
 *   - select    — must match one of definition.options[].value
 *
 * v0.3.3 (2026-05-11): F-005 — writeActivityLog calls added on
 * create/update/archive/restore so any Settings-tab data mutation lands
 * in the Activity Log.
 */

'use strict';

const router = require('express').Router();
import prisma from '../lib/prisma';
const { requireAdmin } = require('../middleware/roles');
const { writeLog: writeActivityLog } = require('../lib/activityLog');

const ALLOWED_TYPES = new Set(['text', 'textarea', 'number', 'date', 'checkbox', 'select']);
const MAX_FIELDS_PER_ACCOUNT = 50; // sanity cap — UI render gets unwieldy past this

/**
 * Slugify a display name into a stable fieldKey. Used at definition
 * create-time only; never rewritten so existing values keep their
 * association across renames.
 */
function slugifyKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/**
 * Validate options for the `select` type. Returns the cleaned array or
 * throws Error with a user-readable message.
 */
function cleanSelectOptions(opts) {
  if (!Array.isArray(opts)) throw new Error('options must be an array');
  if (opts.length === 0)    throw new Error('select fields need at least one option');
  if (opts.length > 100)    throw new Error('select fields are capped at 100 options');
  const clean = opts.map((o, i) => {
    if (typeof o === 'string') return { value: o, label: o };
    if (!o || typeof o !== 'object') throw new Error(`option ${i} must be a string or { value, label }`);
    const value = String(o.value ?? '').trim();
    const label = String(o.label ?? value).trim();
    if (!value) throw new Error(`option ${i} has empty value`);
    return { value, label };
  });
  // Reject duplicate values within the same field — silent overrides
  // produce data the user can't cleanly query.
  const seen = new Set();
  for (const o of clean) {
    if (seen.has(o.value)) throw new Error(`duplicate option value: ${o.value}`);
    seen.add(o.value);
  }
  return clean;
}

/**
 * Validate a value AGAINST a definition. Returns the canonical
 * string-form to store, or throws Error with a user-readable message.
 * Empty string / null returns null (which Prisma stores as NULL).
 *
 * Exported so the asset POST/PUT path can reuse the exact same rules.
 */
function validateValueForDefinition(definition, raw) {
  if (raw === '' || raw == null) return null;
  switch (definition.type) {
    case 'text':
    case 'textarea':
      return String(raw);
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${definition.name}: must be a number`);
      return String(n);
    }
    case 'date': {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) throw new Error(`${definition.name}: must be a date`);
      // Store as YYYY-MM-DD so CSV exports stay friendly without re-coercion.
      return d.toISOString().split('T')[0];
    }
    case 'checkbox': {
      const v = String(raw).toLowerCase();
      if (v === 'true' || v === '1' || v === 'yes') return 'true';
      if (v === 'false' || v === '0' || v === 'no') return 'false';
      throw new Error(`${definition.name}: must be true or false`);
    }
    case 'select': {
      const options = Array.isArray(definition.options) ? definition.options : [];
      const allowed = new Set(options.map(o => o.value));
      const s = String(raw);
      if (!allowed.has(s)) throw new Error(`${definition.name}: ${s} is not a valid option`);
      return s;
    }
    default:
      throw new Error(`unknown field type: ${definition.type}`);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const fields = await prisma.customFieldDefinition.findMany({
      where:   { accountId: req.user.accountId },
      orderBy: [{ archivedAt: 'asc' }, { displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
    res.json({ success: true, data: { fields } });
  } catch (err) {
    console.error('GET /custom-fields:', err);
    res.status(500).json({ success: false, error: 'Failed to load custom fields' });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, type, helpText, required, options, displayOrder, appliesTo } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (!ALLOWED_TYPES.has(type)) {
      return res.status(400).json({ success: false, error: `type must be one of ${[...ALLOWED_TYPES].join(', ')}` });
    }

    const fieldKey = slugifyKey(name);
    if (!fieldKey) {
      return res.status(400).json({ success: false, error: 'name must contain at least one letter or digit' });
    }

    let cleanOptions = null;
    if (type === 'select') {
      try { cleanOptions = cleanSelectOptions(options); }
      catch (e) { return res.status(400).json({ success: false, error: e.message }); }
    }

    // Cap total fields per account so the asset form stays usable.
    const count = await prisma.customFieldDefinition.count({
      where: { accountId: req.user.accountId, archivedAt: null },
    });
    if (count >= MAX_FIELDS_PER_ACCOUNT) {
      return res.status(400).json({ success: false, error: `Limit of ${MAX_FIELDS_PER_ACCOUNT} active custom fields reached. Archive an unused field first.` });
    }

    try {
      const created = await prisma.customFieldDefinition.create({
        data: {
          accountId:    req.user.accountId,
          createdById:  req.user.id,
          name:         name.trim(),
          fieldKey,
          type,
          helpText:     helpText?.trim() || null,
          required:     !!required,
          options:      cleanOptions,
          // Slice H: tag the field for the arc-flash equipment long tail (else a
          // general asset field). Values stay on the asset-scoped value table.
          appliesTo:    appliesTo === 'arc_flash' ? 'arc_flash' : null,
          displayOrder: Number.isFinite(displayOrder) ? parseInt(displayOrder, 10) : count,
        },
      });
      // F-005 (v0.3.3): audit
      writeActivityLog({
        userId:  req.user.id,
        action:  'custom_field_created',
        details: { fieldId: created.id, fieldKey: created.fieldKey, name: created.name, type: created.type },
      });
      res.json({ success: true, data: { field: created } });
    } catch (e) {
      if (e.code === 'P2002') {
        return res.status(400).json({ success: false, error: `A field with key "${fieldKey}" already exists. Pick a different name.` });
      }
      throw e;
    }
  } catch (err) {
    console.error('POST /custom-fields:', err);
    res.status(500).json({ success: false, error: 'Failed to create custom field' });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await prisma.customFieldDefinition.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Custom field not found' });

    // Type and fieldKey are immutable after creation — changing them
    // would silently break the type-coerced value blob in
    // custom_field_values, since each existing value was stored under
    // the old type's canonical form.
    const data: any = {};
    const changes = []; // F-005 (v0.3.3): track what changed for the audit row
    if (typeof req.body.name === 'string' && req.body.name.trim().length > 0) {
      data.name = req.body.name.trim();
      if (data.name !== existing.name) changes.push('name');
    }
    if ('helpText' in req.body) {
      data.helpText = req.body.helpText ? String(req.body.helpText).trim() : null;
      if (data.helpText !== existing.helpText) changes.push('helpText');
    }
    if ('required' in req.body) {
      data.required = !!req.body.required;
      if (data.required !== existing.required) changes.push('required');
    }
    if ('displayOrder' in req.body && Number.isFinite(req.body.displayOrder)) {
      data.displayOrder = parseInt(req.body.displayOrder, 10);
      if (data.displayOrder !== existing.displayOrder) changes.push('displayOrder');
    }
    if ('appliesTo' in req.body) {
      const a = req.body.appliesTo === 'arc_flash' ? 'arc_flash' : null;
      data.appliesTo = a;
      if (a !== existing.appliesTo) changes.push('appliesTo');
    }
    if ('options' in req.body && existing.type === 'select') {
      try { data.options = cleanSelectOptions(req.body.options); }
      catch (e) { return res.status(400).json({ success: false, error: e.message }); }
      // Options are arrays of objects — cheap structural diff via JSON.
      if (JSON.stringify(data.options) !== JSON.stringify(existing.options)) {
        changes.push('options');
      }
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields provided' });
    }

    const updated = await prisma.customFieldDefinition.update({
      where: { id: existing.id },
      data,
    });
    // F-005 (v0.3.3): audit only when something actually changed.
    if (changes.length > 0) {
      writeActivityLog({
        userId:  req.user.id,
        action:  'custom_field_updated',
        details: { fieldId: updated.id, fieldKey: updated.fieldKey, fields: changes },
      });
    }
    res.json({ success: true, data: { field: updated } });
  } catch (err) {
    console.error('PUT /custom-fields/:id:', err);
    res.status(500).json({ success: false, error: 'Failed to update custom field' });
  }
});

router.patch('/:id/archive', requireAdmin, async (req, res) => {
  try {
    const existing = await prisma.customFieldDefinition.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Custom field not found' });

    const archive = req.body.archived === true || req.body.archived === 'true';
    const updated = await prisma.customFieldDefinition.update({
      where: { id: existing.id },
      data:  { archivedAt: archive ? new Date() : null },
    });
    // F-005 (v0.3.3): audit
    writeActivityLog({
      userId:  req.user.id,
      action:  archive ? 'custom_field_archived' : 'custom_field_restored',
      details: { fieldId: updated.id, fieldKey: updated.fieldKey, name: updated.name },
    });
    res.json({ success: true, data: { field: updated } });
  } catch (err) {
    console.error('PATCH /custom-fields/:id/archive:', err);
    res.status(500).json({ success: false, error: 'Failed to toggle archive' });
  }
});

module.exports = router;
module.exports.validateValueForDefinition = validateValueForDefinition;
module.exports.slugifyKey                 = slugifyKey;
module.exports.cleanSelectOptions         = cleanSelectOptions;

export {};

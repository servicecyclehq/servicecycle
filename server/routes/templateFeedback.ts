/**
 * Template Feedback (Phase 4).
 *
 * Per-section thumbs-up/down + optional free-text feedback on AI renewal
 * briefs. v0.4.0 shipped LOCAL-ONLY. v0.18.0 adds Layer B: opt-in
 * upstream sync to the ForgeRift-operated Cloudflare Worker at
 * feedback.lapseiq.com when the per-account AccountSetting
 * `ai_feedback_upstream_enabled` is 'true'.
 *
 * Upstream payload is ANONYMOUS:
 *   { instanceId, categorySlug, templateVersion, section, rating,
 *     freeText?, lapseiqVersion }
 * instanceId = first 16 chars of SHA-256(accountId) — no account name
 * or user identity leaves the customer's server.
 *
 * Routes:
 *   POST /api/template-feedback   — authenticated user submits feedback
 *   GET  /api/template-feedback   — admin only, paginated list for the
 *                                   caller's account
 *
 * Security invariants (roadmap §6.3):
 *   - Account isolation: POST writes accountId from req.user.accountId,
 *     never trusts body. GET filters by accountId.
 *   - Contract scoping: contractId on POST must belong to the caller's
 *     account; reject otherwise.
 *   - Input validation: freeText capped at 1000 chars at the route layer.
 *   - Section enum: must be one of the 4 known sections.
 *   - XSS: rendered with sanitisation in admin UI; we still strip
 *     control chars + trim here. Schema column is plain TEXT.
 *   - Upstream call is fire-and-forget (no await, no user-visible error
 *     on upstream failure). Local write always completes first.
 *   - Admin-only GET: requireAdmin middleware.
 */

'use strict';

const crypto  = require('crypto');
const express = require('express');
const { z }   = require('zod');
const router  = express.Router();

import prisma from '../lib/prisma';
const { requireAdmin } = require('../middleware/roles');
const { validateBody, UuidStr } = require('../lib/validate');

// ── Upstream sync helper ──────────────────────────────────────────────────────
//
// Fire-and-forget POST to the ForgeRift CF Worker when the account has
// opted in (AccountSetting ai_feedback_upstream_enabled = 'true').
// Never awaited, never surfaces errors to the caller — local write always
// completes first. Env var FEEDBACK_UPSTREAM_URL defaults to the live
// Worker endpoint; operators can override for testing.
//
// instanceId: first 16 hex chars of SHA-256(accountId) — deterministic
// per-account but unguessable and unlinked to any identity.

const FEEDBACK_UPSTREAM_URL = process.env.FEEDBACK_UPSTREAM_URL
  || 'https://feedback.lapseiq.com/api/template-feedback';

function anonymousInstanceId(accountId) {
  return crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 16);
}

async function _sendUpstream(accountId, payload) {
  try {
    const body = JSON.stringify({
      instanceId:      anonymousInstanceId(accountId),
      categorySlug:    payload.categorySlug,
      templateVersion: payload.templateVersion,
      section:         payload.section,
      rating:          payload.rating,
      freeText:        payload.freeText || null,
      lapseiqVersion:  process.env.npm_package_version || '',
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);  // 5s timeout
    await fetch(FEEDBACK_UPSTREAM_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    // Fail silently — upstream outage must never affect local write
    console.warn('[templateFeedback] upstream sync failed (non-fatal):', err.message);
  }
}

async function maybeFireUpstream(accountId, payload) {
  try {
    const setting = await prisma.accountSetting.findUnique({
      where:  { accountId_key: { accountId, key: 'ai_feedback_upstream_enabled' } },
      select: { value: true },
    });
    if (setting?.value === 'true') {
      // Intentionally NOT awaited — fire and forget
      _sendUpstream(accountId, payload).catch(() => {});
    }
  } catch {
    // DB lookup failure is non-fatal
  }
}

// Section names mirror the keys the structured-brief response uses. If the
// envelope ever grows or renames a section, update this set AND the LLM
// output instruction in lib/aiBrief/outputContract.js, in lockstep.
const VALID_SECTIONS = ['situation', 'market', 'tactics', 'watchFor'];

const FREE_TEXT_MAX = 1000;

const FeedbackSchema = z.object({
  contractId:      UuidStr,
  categorySlug:    z.string().min(1).max(64),
  templateVersion: z.string().min(1).max(16),
  section:         z.enum(VALID_SECTIONS),
  rating:          z.boolean(),
  freeText:        z.string().max(FREE_TEXT_MAX).nullable().optional(),
});

// ── POST /api/template-feedback ──────────────────────────────────────────────
router.post('/', async (req, res) => {
  const parsed = validateBody(req, res, FeedbackSchema);
  if (!parsed) return; // 400 already sent

  try {
    // Account scoping: verify the referenced contract belongs to the
    // caller's account before writing. Prevents posting feedback
    // referencing another tenant's contracts.
    const contract = await prisma.contract.findFirst({
      where:  { id: parsed.contractId, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    // Strip control chars from freeText (defence-in-depth — XSS render
    // is handled in the UI, but stripping at write time keeps the
    // stored shape clean).
    const cleanFreeText = parsed.freeText
      ? parsed.freeText.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').trim() || null
      : null;

    const row = await prisma.templateFeedback.create({
      data: {
        accountId:       req.user.accountId,
        contractId:      parsed.contractId,
        userId:          req.user.id,
        categorySlug:    parsed.categorySlug,
        templateVersion: parsed.templateVersion,
        section:         parsed.section,
        rating:          parsed.rating,
        freeText:        cleanFreeText,
      },
      select: { id: true, createdAt: true },
    });

    // Layer B — opt-in upstream sync (fire-and-forget, non-fatal)
    maybeFireUpstream(req.user.accountId, {
      categorySlug:    parsed.categorySlug,
      templateVersion: parsed.templateVersion,
      section:         parsed.section,
      rating:          parsed.rating,
      freeText:        cleanFreeText,
    });

    return res.json({ success: true, data: { id: row.id, createdAt: row.createdAt } });
  } catch (err) {
    console.error('POST /template-feedback:', err);
    return res.status(500).json({ success: false, error: 'Failed to record feedback' });
  }
});

// ── GET /api/template-feedback ───────────────────────────────────────────────
// Admin-only paginated list for the caller's account. Roadmap §6.3 calls
// out admin-only as a security checklist item.
router.get('/', requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where: any = { accountId: req.user.accountId };
    if (req.query.categorySlug) where.categorySlug = String(req.query.categorySlug).slice(0, 64);
    if (req.query.section && VALID_SECTIONS.includes(req.query.section)) {
      where.section = req.query.section;
    }

    const [rows, total] = await prisma.$transaction([
      prisma.templateFeedback.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
        select:  {
          id: true, createdAt: true, categorySlug: true, templateVersion: true,
          section: true, rating: true, freeText: true,
          user:     { select: { id: true, name: true, email: true } },
          contract: { select: { id: true, product: true, vendor: { select: { name: true } } } },
        },
      }),
      prisma.templateFeedback.count({ where }),
    ]);

    return res.json({
      success: true,
      data:    { rows, total, limit, offset },
    });
  } catch (err) {
    console.error('GET /template-feedback:', err);
    return res.status(500).json({ success: false, error: 'Failed to load template feedback' });
  }
});

module.exports = router;

export {};

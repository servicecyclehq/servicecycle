'use strict';

/**
 * routes/earlyAccess.js (L7)
 *
 * Public landing-page lead capture. Replaces the pre-L7 mailto: CTAs.
 *
 * POST /api/early-access  (no auth)
 *   - Validates the body via zod (rejects malformed input loudly).
 *   - Honeypot field "website" — if filled, return 200 silently and
 *     drop the row. Bots autofill; humans don't see the field.
 *   - Inserts EarlyAccessRequest row first (so we recover from a Resend
 *     outage), then fires the auto-reply + operator notification emails
 *     in parallel via Promise.allSettled (one failure doesn't block the
 *     other).
 *   - Returns 201 with { id } on success.
 *
 * GET /api/early-access  (admin only — mounted by admin router)
 *   - Lists recent submissions sorted by createdAt DESC, paginated.
 *
 * Rate limiting: applied at mount time in server/index.js via the existing
 * apiLimiter (anonymous bucket = 30 req/min/IP). No additional limiter
 * here — being too strict invites hand-raisers to bounce off.
 */

const express = require('express');
const { z }   = require('zod');
import prisma from '../lib/prisma';
const { sendEmail, earlyAccessReplyHtml, earlyAccessNotificationHtml } = require('../lib/email');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin }      = require('../middleware/roles');

const router = express.Router();

// Lead PII must never be readable from a demo sandbox, even by a demo "admin"
// (demo shares the ops DB). Mirrors admin.ts denyOnDemo so the guard travels
// with the route regardless of which mount serves it.
function denyOnDemo(req, res, next) {
  if (process.env.DEMO_MODE === 'true') {
    return res.status(403).json({
      success: false,
      error:   'Early-access leads are not viewable from the demo sandbox.',
    });
  }
  next();
}

// ── Submit schema ────────────────────────────────────────────────────────────
// `website` is the honeypot — we expect empty. `timing` is free-form to avoid
// enum migrations every time the funnel categories shift.
const SubmitSchema = z.object({
  name:    z.string().trim().min(1).max(120),
  email:   z.string().trim().toLowerCase().email().max(254),
  company: z.string().trim().max(160).optional().nullable(),
  timing:  z.enum(['now', 'this_week', 'this_month', 'browsing']).optional().nullable(),
  website: z.string().optional().nullable(),  // honeypot — must be empty
}).strict();

const INSTALL_SCRIPT_URL = process.env.SERVICECYCLE_INSTALL_URL || 'https://servicecycle.app/install.sh';
const DEMO_URL           = process.env.SERVICECYCLE_DEMO_URL    || 'https://servicecycle.app';

// ── POST /api/early-access ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
  // Validate body
  const parsed = SubmitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error:   'Invalid submission',
      issues:  parsed.error.issues.map(i => ({ path: i.path.join('.'), msg: i.message })),
    });
  }
  const { name, email, company, timing, website } = parsed.data;

  // Honeypot — if a bot filled `website`, return success silently and drop
  // the row. Don't reveal the trap; don't waste an email send.
  if (website && website.trim() !== '') {
    console.log(`[earlyAccess] honeypot tripped from ${req.ip}`);
    return res.status(201).json({ success: true, data: { id: 'honeypot' } });
  }

  let row;
  try {
    row = await prisma.earlyAccessRequest.create({
      data: {
        name,
        email,
        company:   company || null,
        timing:    timing  || null,
        ipAddress: req.ip || null,
        userAgent: (req.get('user-agent') || '').slice(0, 500) || null,
      },
      select: { id: true, name: true, email: true, company: true, timing: true, createdAt: true },
    });
  } catch (err) {
    console.error('[earlyAccess] DB insert failed:', err);
    return res.status(500).json({ success: false, error: 'Could not record your request — please email support@servicecycle.app directly.' });
  }

  // Fire both emails in parallel; neither blocks the response. Failures
  // log loudly but don't fail the request — the row is in the DB and we
  // can chase up manually.
  const submittedAt = row.createdAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  Promise.allSettled([
    sendEmail({
      to:      row.email,
      subject: 'ServiceCycle — your early-access request',
      html:    earlyAccessReplyHtml({
        name: row.name,
        installScriptUrl: INSTALL_SCRIPT_URL,
        demoUrl: DEMO_URL,
      }),
    }),
    process.env.SUPPORT_EMAIL ? sendEmail({
      to:      process.env.SUPPORT_EMAIL,
      subject: `[ServiceCycle Feedback] new lead — ${row.name} (${row.email})`,
      html:    earlyAccessNotificationHtml({
        name:        row.name,
        email:       row.email,
        company:     row.company,
        timing:      row.timing,
        ipAddress:   req.ip || '',
        submittedAt,
      }),
    }) : Promise.resolve('SUPPORT_EMAIL unset — operator notification skipped'),
  ]).then(results => {
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[earlyAccess] email ${i === 0 ? 'reply' : 'notification'} send failed:`, r.reason?.message || r.reason);
      }
    });
  });

  return res.status(201).json({ success: true, data: { id: row.id } });
});

// ── GET /api/early-access/list (admin) ───────────────────────────────────────
// SECURITY: this router is mounted on BOTH the PUBLIC path (index.ts:
// `app.use('/api/early-access', countryGate, earlyAccessRoutes)` — no auth) and
// the admin path (admin.ts: behind requireAdmin + denyOnDemo). Because Express
// routers match every sub-path, /list was reachable UNAUTHENTICATED via the
// public mount, dumping the entire lead/prospect PII table. The gate must
// therefore live ON THE ROUTE, not just at mount time — authenticate + require
// admin + denyOnDemo here so it is safe no matter which mount serves it.
router.get('/list', authenticateToken, requireAdmin, denyOnDemo, async (req, res) => {
  const take    = Math.min(parseInt(req.query.take || '50', 10), 200);
  const cursor  = req.query.cursor || null;
  try {
    const rows = await prisma.earlyAccessRequest.findMany({
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { createdAt: 'desc' },
      select:  { id: true, name: true, email: true, company: true, timing: true, createdAt: true },
    });
    return res.json({
      success: true,
      data: {
        rows,
        nextCursor: rows.length === take ? rows[rows.length - 1].id : null,
      },
    });
  } catch (err) {
    console.error('[earlyAccess] list failed:', err);
    return res.status(500).json({ success: false, error: 'Could not load early-access requests' });
  }
});

module.exports = router;

export {};

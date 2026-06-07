/**
 * routes/help.js — Per-module help endpoints for the in-app Help drawer.
 *
 *   GET   /api/help/modules            — list of available modules (slug + title + description)
 *   GET   /api/help/modules/:slug      — markdown content for one module
 *   GET   /api/help/modules/:slug/pdf  — PDF export of one module
 *   HEAD  /api/help/modules/:slug/pdf  — headers only (no body); does NOT stream pdfkit
 *
 * Public — no auth required. Help is intentionally reachable from any
 * page including the unauthenticated login screen so a curious prospect
 * who hits the demo URL can read the docs without signing up.
 *
 * Rate-limit posture:
 *   - The PDF endpoint has its own per-route limiter (10/min/IP).
 *   - v0.36.7 (Pass-6 W2 MT-014): the markdown read endpoints get their own
 *     60/min/IP limiter so the global apiLimiter skip-list can drop the
 *     /api/help/ entry. The skip-list growth was flagged in Pass-6/Lens-2
 *     P1-R2 + Pass-6/Lens-5 F-DEMO-NEW-05; this closes that delta.
 */

'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');

const helpRegistry  = require('../lib/helpRegistry');
const { streamHelpDocPdf } = require('../lib/pdfHelpDoc');

const router = express.Router();

// ── Per-route limiter for the cheap markdown reads (MT-014) ─────────────────
// 60/min/IP — generous enough that legitimate Help-drawer browsing (which
// can fan out 9 module reads in a few seconds when the operator opens the
// drawer and clicks around) is unbottlenecked, but caps a hostile script
// hammering /api/help/modules at one request per second steady-state.
const helpReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many help requests — try again in a minute.' },
});

// ── Module list ──────────────────────────────────────────────────────────────
router.get('/modules', helpReadLimiter, (req, res) => {
  return res.json({
    success: true,
    data: { modules: helpRegistry.listModules() },
  });
});

// ── Module content (markdown) ───────────────────────────────────────────────
router.get('/modules/:slug', helpReadLimiter, (req, res) => {
  const slug    = req.params.slug;
  const known   = helpRegistry.MODULE_INDEX.find(m => m.slug === slug);
  if (!known) {
    return res.status(404).json({ success: false, error: 'Unknown help module.' });
  }
  const body = helpRegistry.getModule(slug);
  if (body == null) {
    return res.status(503).json({
      success: false,
      error:   'Help content for this module is not available on this instance. Re-run `npm run help:sync` and restart the server.',
    });
  }
  return res.json({
    success: true,
    data: {
      slug:        known.slug,
      title:       known.title,
      description: known.description,
      markdown:    body,
    },
  });
});

// ── PDF export — its own limiter, since pdfkit work is heavier ──────────────
const pdfLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many PDF exports — try again in a minute.' },
});

// v0.36.7 hot patch (Pass-6 W2 promoted-P0): explicit HEAD handler.
//
// Pre-fix, HEAD /api/help/modules/:slug/pdf fell through to the GET handler
// below. The handler calls streamHelpDocPdf(res, ...), which calls
// doc.pipe(res). On a HEAD request Node's ServerResponse auto-suppresses the
// body — but pdfkit's Readable doesn't know that. pdfkit's internal text-wrap
// engine then recursed against the suppressed-body downstream and threw
// `Maximum call stack size exceeded`; the orphaned PDFDocument continued to
// emit data into the closed response, eventually firing
// ERR_STREAM_WRITE_AFTER_END as an UNHANDLED 'error' event on
// ServerResponse and crashing the Node process. The v0.36.4 hot patch
// removed the `width: 12` constraint but did not address the HEAD path.
//
// HEAD must respond with the same Content-Type + Content-Disposition headers
// as GET would, but NO body. This is the correct HTTP semantic for HEAD on
// a PDF resource and structurally prevents the recursion.
router.head('/modules/:slug/pdf', pdfLimiter, (req, res) => {
  const slug  = req.params.slug;
  const known = helpRegistry.MODULE_INDEX.find(m => m.slug === slug);
  if (!known) {
    return res.status(404).end();
  }
  const markdown = helpRegistry.getModule(slug);
  if (markdown == null) {
    return res.status(503).end();
  }
  const filename = `LapseIQ-Help-${slug}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).end();
});

router.get('/modules/:slug/pdf', pdfLimiter, (req, res) => {
  const slug  = req.params.slug;
  const known = helpRegistry.MODULE_INDEX.find(m => m.slug === slug);
  if (!known) {
    return res.status(404).json({ success: false, error: 'Unknown help module.' });
  }
  const markdown = helpRegistry.getModule(slug);
  if (markdown == null) {
    return res.status(503).json({
      success: false,
      error:   'Help content for this module is not available on this instance.',
    });
  }

  const filename = `LapseIQ-Help-${slug}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Don't cache help PDFs at the browser layer — the source can change
  // between deploys and we don't want stale copies pinned.
  res.setHeader('Cache-Control', 'no-store');

  try {
    streamHelpDocPdf(res, { slug, title: known.title, markdown });
  } catch (err) {
    console.error('[help.pdf] generation error:', err && err.message ? err.message : err);
    // Headers already sent (doc.pipe flushes Content-Type detection) — best-
    // effort error signal via aborting the stream. streamHelpDocPdf itself
    // installs a res.on('close') hook that destroys the pdfkit Readable so a
    // late synchronous throw here cannot leak a write-after-end event.
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
    } else {
      try { res.end(); } catch (_) { /* noop */ }
    }
  }
});

module.exports = router;

export {};

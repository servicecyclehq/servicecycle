/**
 * routes/publicParse.ts — #17 parser-as-funnel (public, email-gated).
 *
 * POST /api/public/parse-report — a prospect drops a test-report PDF + email,
 * the DETERMINISTIC engine reads it (no AI cost), and they get a teaser fix
 * list ("14 findings, 3 critical — create a free account to keep it"). The
 * email is captured as a lead; the full extraction is NOT returned and the
 * report is not retained. Mounted WITHOUT auth (rate-limited at the mount).
 *
 * The hardest GTM asset to fake is a demo on the prospect's own data.
 */

const router = require('express').Router();
const multer = require('multer');
const crypto = require('crypto');
import prisma from '../lib/prisma';
const { runDeterministic } = require('../lib/testReportExtract');
const { severityFor } = require('../lib/testReportParse');

const MAX_BYTES = 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req: any, file: any, cb: any) => {
    // Require both a .pdf extension AND application/pdf MIME type.
    // Extension-only check is bypassable by renaming any file to .pdf;
    // the MIME check adds a second gate (still client-declared, but
    // combined with the magic-byte check in runDeterministic, this is
    // defense-in-depth against common content-type spoofing).
    const validExt  = /\.pdf$/i.test(file.originalname || '');
    const validMime = file.mimetype === 'application/pdf';
    if (!validExt || !validMime) {
      return cb(new Error('Upload a valid PDF file'));
    }
    cb(null, true);
  },
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Pure teaser builder — counts findings + criticals from measurements. */
function buildTeaser(measurements: any[]) {
  const list = Array.isArray(measurements) ? measurements : [];
  const findings = list.filter((m: any) => severityFor(m.passFail, m.critical));
  const criticalCount = findings.filter((m: any) => severityFor(m.passFail, m.critical) === 'IMMEDIATE').length;
  // Top few findings, label only (no values) — enough to be compelling, not
  // enough to skip signing up.
  const topFindings = findings.slice(0, 3).map((m: any) => ({
    label: String(m.label || m.measurementType || 'Reading'),
    phase: m.phase || null,
    severity: severityFor(m.passFail, m.critical),
  }));
  return { measurementCount: list.length, findingsCount: findings.length, criticalCount, topFindings };
}

router.post('/parse-report', upload.single('file'), async (req: any, res: any) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 200) {
      return res.status(400).json({ success: false, error: 'A valid email is required to see your results.' });
    }
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ success: false, error: 'Upload a test-report PDF.' });
    }

    // Deterministic engine ONLY (no AI). Fail-open: an unreadable report still
    // captures the lead and returns an honest zero-finding teaser.
    let measurements: any[] = [];
    let source = 'none';
    try {
      const py = await runDeterministic(req.file.buffer);
      if (py && py.ok && Array.isArray(py.measurements)) {
        measurements = py.measurements;
        source = py.ocr ? 'pdfplumber-ocr' : 'pdfplumber';
      }
    } catch (e: any) {
      console.warn('[publicParse] deterministic parse failed (fail-open):', e?.message || e);
    }

    const teaser = buildTeaser(measurements);
    const ipHash = req.ip ? crypto.createHash('sha256').update(String(req.ip)).digest('hex').slice(0, 32) : null;

    // Fire-and-forget lead capture — never block the response on it.
    prisma.publicParseLead.create({
      data: {
        email, fileName: String(req.file.originalname || '').slice(0, 200), source,
        measurementCount: teaser.measurementCount, findingsCount: teaser.findingsCount,
        criticalCount: teaser.criticalCount, ipHash,
      },
    }).catch((e: any) => console.error('[publicParse] lead capture failed:', e?.message || e));

    return res.json({ success: true, data: { ...teaser, source } });
  } catch (err: any) {
    console.error('[publicParse]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Could not read that report — try a text-based PDF.' });
  }
});

module.exports = router;
module.exports.buildTeaser = buildTeaser;

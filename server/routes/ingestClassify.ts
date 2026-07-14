/**
 * routes/ingestClassify.ts — the AddData "drop anything" pre-scan.
 *
 *   POST /api/ingest/classify   multipart file (PDF or .docx) -> a first-page /
 *                               first-N-KB text sample is scanned for arc-flash
 *                               vs instrument-test vocabulary and a routing hint
 *                               is returned:
 *                                 { kind: 'test_report' | 'arc_flash' | 'ambiguous',
 *                                   arcFlashScore, testReportScore, textChars, reason? }
 *
 * Server-side (not in the browser) so it can reuse the SAME text extractors the
 * real importers use (pdfjs for PDF, mammoth for docx) instead of duplicating
 * them. NO writes, no AI — pure deterministic keyword scan. Fails SOFT: an
 * unreadable/scanned/ambiguous document returns kind:'ambiguous' so the client
 * asks the user which importer to use rather than guessing wrong.
 *
 * Mounted at /api/ingest (authenticateToken + ingestLimiter in index.ts).
 * requireManager — same tier as the importers it routes to.
 */

'use strict';

const router = require('express').Router();
const multer = require('multer');
const { requireManager } = require('../middleware/roles');
const { extractPdfText } = require('../lib/testReportParse');
const { extractDocxText } = require('../lib/docxText');

const MAX_BYTES = 15 * 1024 * 1024;
const PDF_RE = /\.pdf$/i;
const DOCX_RE = /\.docx$/i;
const DOC_RE = /\.doc$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req: any, file: any, cb: any) => {
    const name = file.originalname || '';
    if (DOCX_RE.test(name) || PDF_RE.test(name)) return cb(null, true);
    if (DOC_RE.test(name)) return cb(new Error('Legacy .doc (Word 97-2003) is not supported — save as .docx and try again.'));
    return cb(new Error('Only PDF or Word (.docx) can be auto-classified.'));
  },
});

// Multi-word phrases only — strong, low-false-positive signals. Single ambiguous
// words (e.g. "breaker", "voltage") are deliberately excluded.
const AF_TERMS = [
  'incident energy', 'ieee 1584', 'ppe category', 'arc flash boundary', 'arc-flash boundary',
  'cal/cm', 'arcing current', 'working distance', 'arc flash', 'arc-flash',
  'flash protection boundary', 'nfpa 70e', 'bolted fault',
];
const TR_TERMS = [
  'insulation resistance', 'contact resistance', 'megohm', 'meg-ohm', 'megaohm',
  'doble', 'megger', 'meggar', 'power factor', 'polarization index',
  'dielectric absorption', 'winding resistance', 'turns ratio', 'hipot', 'test voltage',
];

function countHits(hay: string, terms: string[]): number {
  let n = 0;
  for (const t of terms) if (hay.includes(t)) n++;
  return n;
}

// 2026-07-13: within the arc_flash bucket, ALSO suggest (never force) which of
// the ArcFlashImport page's two sourceType options to pre-select -- "one-line
// diagram" vs "study report". A one-line is mostly vector line-art with sparse
// equipment tags (bus names, kV/kA labels), so it extracts to very little text
// even across multiple pages; a real study report is dense prose + tables. This
// is a low-stakes pre-fill on an editable dropdown, NOT a routing decision --
// the user still lands on the same page and can flip it before extracting, so a
// wrong guess here costs one click, not a silent misroute. Threshold picked to
// clear a short arc-flash-adjacent label/caption but not a real report page.
const ONE_LINE_TEXT_CHAR_THRESHOLD = 600;

/**
 * Pure scorer (unit-testable, no IO): scan a text sample and decide the importer.
 * "Clearly wins" = winner has >= 2 phrase hits AND at least double the loser (or
 * the loser has none). A single strong phrase with zero on the other side still
 * routes; a genuine tie stays ambiguous so the client asks the user.
 */
function classifyText(rawText: string): { kind: 'test_report' | 'arc_flash' | 'ambiguous'; arcFlashScore: number; testReportScore: number; textChars: number; reason?: string; suggestedSourceType?: 'one_line' | 'study_report' } {
  const sample = String(rawText || '').toLowerCase().slice(0, 20000);
  if (sample.replace(/\s+/g, '').length < 40) {
    return { kind: 'ambiguous', reason: 'no_text', arcFlashScore: 0, testReportScore: 0, textChars: sample.length };
  }
  const af = countHits(sample, AF_TERMS);
  const tr = countHits(sample, TR_TERMS);
  let kind: 'test_report' | 'arc_flash' | 'ambiguous' = 'ambiguous';
  if (af >= 2 && (tr === 0 || af >= tr * 2)) kind = 'arc_flash';
  else if (tr >= 2 && (af === 0 || tr >= af * 2)) kind = 'test_report';
  else if (af > 0 && tr === 0) kind = 'arc_flash';
  else if (tr > 0 && af === 0) kind = 'test_report';
  const result: ReturnType<typeof classifyText> = { kind, arcFlashScore: af, testReportScore: tr, textChars: sample.length };
  if (kind === 'arc_flash') {
    result.suggestedSourceType = sample.replace(/\s+/g, '').length < ONE_LINE_TEXT_CHAR_THRESHOLD ? 'one_line' : 'study_report';
  }
  return result;
}

router.post('/classify', requireManager, (req: any, res: any) => {
  upload.single('file')(req, res, async (err: any) => {
    if (err) return res.status(400).json({ success: false, error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const name = req.file.originalname || '';
    try {
      let text = '';
      try {
        text = DOCX_RE.test(name)
          ? await extractDocxText(req.file.buffer)
          : await extractPdfText(req.file.buffer);
      } catch {
        // Scanned/corrupt/legacy — we can't read it, so we don't guess.
        return res.json({ success: true, data: { kind: 'ambiguous', reason: 'unreadable', arcFlashScore: 0, testReportScore: 0, textChars: 0 } });
      }

      return res.json({ success: true, data: classifyText(text) });
    } catch (e) {
      console.error('[ingest/classify]', e);
      return res.status(500).json({ success: false, error: 'Failed to classify the document' });
    }
  });
});

module.exports = router;
module.exports.classifyText = classifyText;
export {};

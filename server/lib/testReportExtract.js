'use strict';
//
// testReportExtract.js -- deterministic-first PDF extraction for test-report
// ingest (gem V4). Shells out to the bundled Python extractor
// (pyextract/run.py, pdfplumber word-geometry + ruled-table extraction) which
// is far stronger on tabular PowerDB/Megger reports than the pdfjs text-regex
// fallback. FAILS OPEN: any error -> { ok:false } and the caller proceeds with
// the existing pdfjs parser unchanged, so a missing Python runtime can never
// break ingest.
//
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PY = process.env.PYEXTRACT_PYTHON || 'python3';
const RUN = path.join(__dirname, '..', 'pyextract', 'run.py');
const TIMEOUT_MS = parseInt(process.env.PYEXTRACT_TIMEOUT_MS || '45000', 10);

// Run the Python extractor on a PDF buffer. Async, non-blocking, fail-open.
// A2 Half 2 (2026-07-05): `options.resumeFrom` (IngestJob.lastGoodPage) is
// forwarded as `--resume-from N`. Per the Option-A design, this does NOT skip
// pages -- see extract_fields()'s docstring in pyextract/extractor.py -- it's
// passed through purely so retries are distinguishable in output/logs.
function runDeterministic(buffer, options) {
  const resumeFrom = options && options.resumeFrom;
  const extraArgs = (resumeFrom != null) ? ['--resume-from', String(resumeFrom)] : [];
  return new Promise((resolve) => {
    let tmp = null;
    try {
      tmp = path.join(os.tmpdir(), `tr-${crypto.randomBytes(8).toString('hex')}.pdf`);
      fs.writeFileSync(tmp, buffer);
    } catch (e) {
      return resolve({ ok: false, error: 'tmp-write: ' + (e && e.message) });
    }
    execFile(PY, [RUN, tmp, ...extraArgs],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        try { fs.unlinkSync(tmp); } catch (_) { /* tmpfs reaps anyway */ }
        if (err || !stdout) return resolve({ ok: false });
        try {
          const line = String(stdout).trim().split('\n').pop();
          const out = JSON.parse(line);
          resolve(out && out.ok ? out : { ok: false });
        } catch (_) {
          resolve({ ok: false });
        }
      });
  });
}

module.exports = { runDeterministic };

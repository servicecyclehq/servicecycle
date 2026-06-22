/**
 * lib/pdfText.ts — deterministic-first PDF text + tables via pdfplumber.
 *
 * The arc-flash text path's first pass (same approach as the test-report
 * pipeline's runDeterministic): pdfplumber reads the ruled tables in a study
 * report far better than pdfjs, and confirms a usable text layer exists so the
 * expensive vision path only fires when there genuinely is none. FAILS OPEN —
 * any error returns { ok:false } and the caller falls back to pdfjs.
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PY = process.env.PYEXTRACT_PYTHON || 'python3';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'pdf_text.py');
const TIMEOUT_MS = parseInt(process.env.PYEXTRACT_TIMEOUT_MS || '45000', 10);

async function extractPdfPlumber(buffer: Buffer): Promise<any> {
  return new Promise((resolve) => {
    let tmp: string | null = null;
    try {
      tmp = path.join(os.tmpdir(), `aftext-${crypto.randomBytes(8).toString('hex')}.pdf`);
      fs.writeFileSync(tmp, buffer);
    } catch {
      return resolve({ ok: false });
    }
    execFile(PY, [SCRIPT, tmp], { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout: any) => {
      try { if (tmp) fs.unlinkSync(tmp); } catch { /* tmpfs reaps anyway */ }
      if (err || !stdout) return resolve({ ok: false });
      try {
        const out = JSON.parse(String(stdout).trim().split('\n').pop());
        resolve(out && out.ok ? out : { ok: false });
      } catch {
        resolve({ ok: false });
      }
    });
  });
}

export { extractPdfPlumber };

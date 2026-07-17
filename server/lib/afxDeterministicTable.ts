/**
 * lib/afxDeterministicTable.ts -- deterministic arc-flash RESULTS-TABLE extraction.
 *
 * Runs scripts/afx_table_extract.py (pdfplumber, NO AI) to read the per-bus
 * IEEE-1584 summary table straight out of a text-based study report (SKM Dapper
 * "Arc Flash Analysis Summary Table" and SKM "IEEE 1584 Bus Report" exports).
 *
 * When the table parses at high confidence, the caller (extractArcFlashDocument)
 * returns these buses and SKIPS the AI cascade ENTIRELY -- free, instant, and
 * resilient to AI-provider outages (an SKM 503 shouldn't block a clean report).
 *
 * FAILS OPEN: any error, timeout, low confidence, or unhandled report format
 * yields applied:false, so the existing AI path is left completely untouched.
 * The confidence GATE lives here so the AI is only skipped when the deterministic
 * parse is essentially certain -- a wrong deterministic read must never silently
 * replace the AI. Mirrors lib/vectorTopology.ts (same execFile/tmp/fail-open shape).
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PY = process.env.PYEXTRACT_PYTHON || 'python3';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'afx_table_extract.py');
const TIMEOUT_MS = parseInt(process.env.PYEXTRACT_TIMEOUT_MS || '30000', 10);
// Gate: only skip AI when the deterministic table parse is essentially certain.
const MIN_CONF = parseFloat(process.env.AF_DET_MIN_CONF || '0.9');
const MIN_BUSES = parseInt(process.env.AF_DET_MIN_BUSES || '2', 10);

export interface DetTableResult { applied: boolean; parser: string | null; confidence: number; buses: any[]; }
const NONE: DetTableResult = { applied: false, parser: null, confidence: 0, buses: [] };

// Run the Python table reader on the PDF bytes. Never throws.
async function tryDeterministicTableExtract(buffer: Buffer): Promise<DetTableResult> {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return NONE;
  return new Promise((resolve) => {
    let tmp: string | null = null;
    try {
      tmp = path.join(os.tmpdir(), `afxtab-${crypto.randomBytes(8).toString('hex')}.pdf`);
      fs.writeFileSync(tmp, buffer);
    } catch {
      return resolve(NONE);
    }
    execFile(PY, [SCRIPT, tmp], { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout: any) => {
      try { if (tmp) fs.unlinkSync(tmp); } catch { /* tmp reaped anyway */ }
      if (err || !stdout) return resolve(NONE);
      try {
        const out = JSON.parse(String(stdout).trim().split('\n').pop());
        const conf = Number(out && out.confidence) || 0;
        const buses = out && Array.isArray(out.buses) ? out.buses : [];
        if (out && out.ok && conf >= MIN_CONF && buses.length >= MIN_BUSES) {
          return resolve({ applied: true, parser: out.parser || null, confidence: conf, buses });
        }
      } catch { /* fall through to fail-open */ }
      resolve(NONE);
    });
  });
}

export { tryDeterministicTableExtract };

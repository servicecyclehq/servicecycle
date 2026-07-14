/**
 * lib/pdfSplit.ts — page-count + page-range splitting for the W1 native-PDF path.
 *
 * When a study report is dense enough to risk the model's output-token ceiling
 * in a single native-PDF call, extractArcFlashDocument cuts it into OVERLAPPING
 * page windows (so a table straddling a seam is whole in at least one window)
 * and sends each window's sub-PDF natively, merging the results by bus name.
 * This module produces those sub-PDF buffers via scripts/pdf_split.py
 * (pypdfium2, already in the image) — same spawn-python pattern as rasterizePdf.
 *
 * BEST-EFFORT by design: any failure returns 0 pages / [] so the caller falls
 * back cleanly to a single call or the deterministic text/vision path.
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PY = process.env.PYEXTRACT_PYTHON || 'python3';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'pdf_split.py');
const TIMEOUT_MS = parseInt(process.env.PYEXTRACT_TIMEOUT_MS || '45000', 10);

function runSplit(args: string[], timeout: number): Promise<any> {
  return new Promise((resolve) => {
    execFile(PY, [SCRIPT, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout: any) => {
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

// True total page count of the PDF (0 on any failure). Used to decide whether a
// single native call is safe or the document must be windowed.
async function pdfPageCount(buffer: Buffer): Promise<number> {
  let tmp: string | null = null;
  try {
    tmp = path.join(os.tmpdir(), `afsplit-${crypto.randomBytes(8).toString('hex')}.pdf`);
    fs.writeFileSync(tmp, buffer);
  } catch {
    return 0;
  }
  try {
    const out = await runSplit([tmp, 'count'], TIMEOUT_MS);
    return out && out.ok ? (out.pages || 0) : 0;
  } finally {
    try { if (tmp) fs.unlinkSync(tmp); } catch { /* tmpfs reaps anyway */ }
  }
}

// Split into sub-PDF buffers, one per [startPage, endPage] range (1-based,
// inclusive). Returns [] on any failure so the caller can fall back.
async function splitPdfByRanges(buffer: Buffer, ranges: Array<[number, number]>): Promise<Buffer[]> {
  if (!Array.isArray(ranges) || !ranges.length) return [];
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afsplit-'));
  } catch {
    return [];
  }
  const inPath = path.join(dir, 'in.pdf');
  const prefix = path.join(dir, 'part');
  try {
    fs.writeFileSync(inPath, buffer);
    const rangeStr = ranges.map(([a, b]) => `${a}-${b}`).join(',');
    const out = await runSplit([inPath, 'split', prefix, rangeStr], TIMEOUT_MS);
    if (!out || !out.ok || !Array.isArray(out.files)) return [];
    const buffers: Buffer[] = [];
    for (const f of out.files) {
      try { buffers.push(fs.readFileSync(f)); } catch { /* skip missing part */ }
    }
    return buffers;
  } catch {
    return [];
  } finally {
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export { pdfPageCount, splitPdfByRanges };

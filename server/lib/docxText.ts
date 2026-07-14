/**
 * lib/docxText.ts — plain-text extraction from .docx (OOXML) uploads.
 *
 * Wires the already-installed `mammoth` package (text-only: extractRawText pulls
 * the document body, never executes macros/VBA) so a Word .docx can feed the
 * SAME downstream pipelines as PDF-extracted text (test-report parse, arc-flash
 * extraction, the AddData classify pre-scan).
 *
 * Legacy binary `.doc` (Word 97-2003, an OLE2 compound file) is NOT supported by
 * mammoth and there is no lightweight pure-JS extractor for it — rather than fail
 * with a confusing mammoth stack trace, we detect the OLE2 magic bytes up front
 * and reject with a clear "save as .docx" message (fail-soft, honest).
 *
 * Guards (engineering-guidelines: cap decompressed size, well-maintained lib,
 * no macro execution):
 *   - input buffer capped (15 MB, matches the codebase's attachment caps);
 *   - a .docx is a ZIP, and mammoth inflates word/document.xml via jszip/pako
 *     with NO size cap of its own. So BEFORE handing the buffer to mammoth we run
 *     a real decompression-bomb guard (lib/zipInflateGuard) that INFLATES every
 *     entry's actual DEFLATE stream and counts true output bytes, aborting the
 *     moment the running total exceeds the cap. It never trusts the ZIP's
 *     declared uncompressed-size metadata (attacker-controlled) and it fails
 *     CLOSED on anything it cannot verify — so a zip-bomb-style .docx is rejected
 *     before it can exhaust memory, and a lying header cannot bypass the check;
 *   - extracted text is length-capped so a pathological document body can't
 *     balloon a downstream prompt/regex pass.
 */

'use strict';

const { assertZipInflatesWithinBudget } = require('./zipInflateGuard');

const MAX_DOCX_BYTES = 15 * 1024 * 1024;        // compressed input cap (matches attachment caps)
const MAX_DECOMPRESSED_BYTES = 80 * 1024 * 1024; // total inflated size cap (zip-bomb guard)
const MAX_TEXT_CHARS = 4 * 1024 * 1024;          // extracted-text length cap

/**
 * Extract plain text from a .docx buffer. Throws a clear Error on empty input,
 * oversize input, a legacy .doc (OLE2), a non-docx payload, or a zip-bomb.
 */
async function extractDocxText(buffer: Buffer): Promise<string> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('The Word document is empty.');
  }
  if (buffer.length > MAX_DOCX_BYTES) {
    throw new Error(`Word document exceeds the ${Math.round(MAX_DOCX_BYTES / 1024 / 1024)} MB limit.`);
  }

  // Legacy .doc / OLE2 compound file (D0 CF 11 E0 A1 B1 1A E1) — not supported.
  if (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 && buffer[5] === 0xb1 && buffer[6] === 0x1a && buffer[7] === 0xe1
  ) {
    throw new Error('Legacy .doc (Word 97-2003) files are not supported. Please re-save the document as .docx and upload it again.');
  }

  // A .docx must be a ZIP container ("PK\x03\x04", or the empty/spanned variants).
  const looksZip =
    buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
  if (!looksZip) {
    throw new Error('That does not look like a valid .docx file.');
  }

  // Zip-bomb guard: inflate every entry's REAL DEFLATE output and reject if the
  // true total blows the cap. Never trusts declared sizes; fails CLOSED (reject)
  // on anything it cannot verify. See lib/zipInflateGuard.
  const budget = assertZipInflatesWithinBudget(buffer, { maxTotalBytes: MAX_DECOMPRESSED_BYTES });
  if (!budget.ok) {
    throw new Error('Word document is too large when decompressed and was rejected.');
  }

  const mammoth = require('mammoth');
  let result: any;
  try {
    result = await mammoth.extractRawText({ buffer });
  } catch (e: any) {
    throw new Error('Could not read the Word document: ' + (e && e.message ? e.message : String(e)));
  }
  let text = result && typeof result.value === 'string' ? result.value : '';
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
  return text;
}

/** True when a filename looks like a modern Word .docx (not legacy .doc). */
function isDocxName(name: string): boolean {
  return /\.docx$/i.test(name || '');
}

/** True when a filename is a legacy binary .doc (unsupported). */
function isLegacyDocName(name: string): boolean {
  return /\.doc$/i.test(name || '');
}

module.exports = { extractDocxText, isDocxName, isLegacyDocName, MAX_DOCX_BYTES };
export {};

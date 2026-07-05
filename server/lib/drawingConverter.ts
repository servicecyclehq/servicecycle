/**
 * lib/drawingConverter.ts — EDMS Phase 1 scaffold (2026-07-05, feat/edms-phase-1
 * branch, NOT merged to main, NOT wired to any route).
 *
 * docs/scoping/EDMS_MODULE_SCOPE_2026-07-04.md §16 locks the product framing:
 * PDF is first-class throughout SC (search, redline, versioning, mobile view,
 * PE-seal verification); DWG/DXF are accepted as a courtesy and converted
 * server-side, clearly marked "best-effort." §19 Phase 1 scope is schema +
 * storage foundation ONLY — this file is the adapter *interface* so Phase 2's
 * upload flow has something to call, with the real LibreOffice/LibreDWG
 * pipeline (§16 "Technical conversion pipeline") deliberately deferred.
 *
 * Nothing in this file is called from any route yet.
 */

'use strict';

/**
 * @typedef {Object} ConversionResult
 * @property {Buffer} pdfBuffer        — the PDF bytes to store as the revision artifact
 * @property {string} sourceFormat     — "pdf" | "dwg" | "dxf" | "image"
 * @property {Buffer} [originalBuffer] — original bytes, when sourceFormat !== "pdf"
 *                                        (§16: "original DWG preservation" — stored
 *                                        alongside the converted PDF, never discarded)
 * @property {string} [originalFormat] — original file extension when converted
 */

/**
 * @interface DrawingConverter
 * convert(buffer, opts) => Promise<ConversionResult>
 * opts: { filename?: string }
 */

// ─── PdfConverter — passthrough ─────────────────────────────────────────────
// A PDF (or already-rasterized image) needs no conversion. This is the
// "recommended" path per the locked upload-UI copy in §16: exporting a PDF
// from the user's CAD tool is always first-class.
class PdfConverter {
  async convert(buffer, _opts) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('PdfConverter.convert: empty or invalid buffer');
    }
    return { pdfBuffer: buffer, sourceFormat: 'pdf' };
  }
}

// ─── DwgConverter — stub, env-flag gated, always throws (Phase 1) ───────────
// The real pipeline (§16): LibreOffice Draw headless as primary path, a
// LibreDWG -> Chromium/Puppeteer SVG chain as fallback, ~500MB Docker layer.
// None of that ships in Phase 1 — this class exists purely so the adapter
// *interface* is settled now (Phase 2+ swaps the stub body, callers don't
// change). It always throws; the message differs by whether the courtesy
// DWG-accept feature is even nominally turned on, so a caller/operator gets
// an actionable answer either way.
//
// Env flag: EDMS_DWG_CONVERSION_ENABLED. Defaulting to unset/false means the
// out-of-the-box behavior for any tenant (even with `edms` flag on) is
// "PDF-first, DWG not yet accepted" — matching the current real capability,
// not the eventual one.
class DwgConverter {
  async convert(_buffer, opts: any = {}) {
    const enabled = String(process.env.EDMS_DWG_CONVERSION_ENABLED || '').toLowerCase() === 'true';
    const name = opts.filename ? ` ("${opts.filename}")` : '';

    if (!enabled) {
      // This is the locked upload-UI copy from EDMS_MODULE_SCOPE_2026-07-04.md
      // §16, reused verbatim as the actionable error so the eventual route
      // handler can surface it directly without re-authoring the message.
      throw new Error(
        `DWG/DXF conversion is not yet available${name}. ` +
        'Recommended: upload a PDF exported from your CAD tool -- that is the ' +
        'format SC treats as first-class throughout (search, redline, ' +
        'versioning, mobile view, PE-seal verification). ' +
        'DWG/DXF courtesy conversion is planned but not yet implemented.',
      );
    }

    // Flag is on, but Phase 1 intentionally ships no conversion pipeline yet
    // (LibreOffice/LibreDWG install + subprocess plumbing is Phase 1 build-out
    // per §19, not this scaffold). Distinct message so an operator who flips
    // the flag early gets a clear "not yet" rather than a silent no-op or a
    // confusing downstream failure.
    throw new Error(
      `DWG/DXF conversion is scaffolded but not yet implemented${name} -- ` +
      'the LibreOffice/LibreDWG pipeline (EDMS_MODULE_SCOPE_2026-07-04.md §16) ' +
      'has not been built. Please export to PDF and upload that instead.',
    );
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────
// Selects a converter by lowercased file extension (without the dot). Treats
// anything unrecognized as "already a PDF" rather than guessing wrong in the
// other direction (never silently attempt a DWG conversion on a mystery type).
function getDrawingConverter(sourceFormat: string) {
  const fmt = String(sourceFormat || '').toLowerCase().replace(/^\./, '');
  if (fmt === 'dwg' || fmt === 'dxf') return new DwgConverter();
  return new PdfConverter();
}

module.exports = {
  PdfConverter,
  DwgConverter,
  getDrawingConverter,
};

export {};

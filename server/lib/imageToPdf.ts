/**
 * imageToPdf.ts — #20 photo-of-paper capture.
 *
 * Wraps a phone photo (JPG/PNG/HEIC/WebP) of a paper field sheet into a single
 * full-page PDF so it can flow through the existing test-report ingest pipeline
 * (which OCRs no-text-layer PDFs via pdfplumber + tesseract). HEIC is transcoded
 * and EXIF-rotated by lib/imageNormalize first so pdfkit can embed it.
 */

const PDFDocument = require('pdfkit');

const PAGE_W = 612; // US Letter @ 72dpi
const PAGE_H = 792;
const MARGIN = 18;

export async function imageToPdf(imageBuffer: Buffer, mimeType: string): Promise<Buffer> {
  const { normalizeImage } = require('./imageNormalize');
  // HEIC -> JPEG, EXIF auto-rotate, size cap. pdfkit only embeds JPEG/PNG.
  const norm = await normalizeImage(imageBuffer, mimeType);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
    doc.on('error', (e: Error) => settle(() => reject(e)));
    try {
      doc.image(norm.buffer, MARGIN, MARGIN, {
        fit: [PAGE_W - MARGIN * 2, PAGE_H - MARGIN * 2],
        align: 'center',
        valign: 'center',
      });
      doc.end();
    } catch (e) {
      settle(() => reject(e instanceof Error ? e : new Error(String(e))));
    }
  });
}

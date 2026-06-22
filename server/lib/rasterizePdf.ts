/**
 * lib/rasterizePdf.ts — convert a PDF's pages to PNG image buffers.
 *
 * The arc-flash vision path needs an image; scanned / vector one-line PDFs have
 * no text layer. Rather than ask the user to convert the file (friction — the
 * thing that kills data-in), we transparently rasterize the PDF server-side via
 * pypdfium2 (PDFium, already in the image) and feed the images to vision.
 *
 * BEST-EFFORT by design: any failure (missing python dep, corrupt PDF, timeout)
 * returns [] so the caller falls back cleanly to "upload an image instead".
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rasterize_pdf.py');

async function rasterizePdf(buffer: Buffer, opts: { maxPages?: number; scaleTo?: number } = {}): Promise<Buffer[]> {
  const maxPages = opts.maxPages || 4;
  const scaleTo = opts.scaleTo || 2000;
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afpdf-'));
    const pdfPath = path.join(dir, 'in.pdf');
    const prefix = path.join(dir, 'page');
    fs.writeFileSync(pdfPath, buffer);

    const count: number = await new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (n: number) => { if (!done) { done = true; resolve(n); } };
      let py: any;
      try {
        py = spawn('python3', [SCRIPT, pdfPath, prefix, String(maxPages), String(scaleTo)], { timeout: 60000 });
      } catch {
        return finish(0);
      }
      py.stdout.on('data', (d: any) => { out += d.toString(); });
      py.on('error', () => finish(0));
      py.on('close', (code: number) => finish(code === 0 ? (parseInt(out.trim(), 10) || 0) : 0));
    });

    const buffers: Buffer[] = [];
    for (let i = 1; i <= count; i++) {
      try { buffers.push(fs.readFileSync(`${prefix}-${i}.png`)); } catch { /* skip missing page */ }
    }
    return buffers;
  } catch {
    return [];
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

export { rasterizePdf };

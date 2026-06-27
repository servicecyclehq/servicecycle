/**
 * pdfHelpDoc.js -- Stream a per-module help doc as a PDF.
 *
 * pdfkit + the marketing color palette so the visual identity matches the
 * rest of ServiceCycle's PDF surfaces.
 *
 * Markdown -> pdfkit walker: handles the subset we actually use in the
 * help docs:
 *   - `# H1` -> page title (rendered once at the top, then skipped if
 *     it appears later)
 *   - `## H2` -> section heading
 *   - `### H3` -> subsection heading (rare; supported)
 *   - paragraphs (separated by blank lines)
 *   - `- item` / `* item` -> bullet lists
 *   - `1. item` -> ordered lists
 *   - inline **bold** -> bold text
 *   - inline `code` -> monospace inline
 *   - inline *italic* -> italic
 *
 * No HTML tables, no images, no nested lists -- the help docs don't use
 * them and supporting them would balloon this walker without value.
 *
 * v0.36.4 hot patch (Pass-6 / Lens-2 P0-D-01):
 *   - Removed the `width: 12` constraint on bullet/ordered-list rendering.
 *   - Added `doc.on('error', ...)` so any pdfkit stream-time error
 *     gracefully ends the response instead of bubbling as an unhandled
 *     rejection.
 *   - Wrapped the block render loop in try/catch so a single block's
 *     failure doesn't take the whole document down.
 *   - Added a 5000-block iteration ceiling as belt-and-suspenders.
 *
 * v0.36.7 hot patch (Pass-6 W2 promoted-P0):
 *   The v0.36.4 patch closed the recursion bug for GET requests but left a
 *   crash path that took the server down once per HEAD request. The HEAD
 *   handler in routes/help.js now short-circuits before reaching this
 *   function, but the defensive cleanup below makes streamHelpDocPdf safe
 *   to call even if `res` closes mid-stream:
 *
 *   - Install res.on('close') + res.on('error') listeners BEFORE doc.pipe.
 *     If the underlying connection or response stream goes away first
 *     (HEAD body-suppression, client disconnect mid-download, upstream
 *     proxy abort), we destroy the pdfkit Readable so it stops emitting
 *     data into a dead writable. Prevents ERR_STREAM_WRITE_AFTER_END
 *     from leaking as an unhandled 'error' event on ServerResponse.
 *
 *   - Track a `destroyed` flag so the per-block render loop bails the
 *     moment res is gone instead of running through all blocks for a
 *     stream nobody is reading.
 *
 *   - On the doc.on('error') path: unpipe from res before ending, so
 *     pdfkit's internal flush doesn't race with res.end().
 *
 * Combined with the route-level HEAD short-circuit, this collapses the
 * crash-on-HEAD class into a no-op + a structured 200 response.
 */

'use strict';

const PDFDocument = require('pdfkit');

// v0.36.5 polish (Pass-3 B V-01): align with marketing tokens.
const COLORS = {
  bgDark:    '#0a0d12',
  textOnDark:'#ffffff',
  textOnDarkMuted: '#9aa3b2',
  text:      '#0a0d12',
  textMuted: '#5b6373',
  textSubtle:'#9aa3b2',
  border:    '#dde2eb',
  accent:    '#0d4f6e',
  cardBg:    '#fafbfd',
  codeBg:    '#eef1f6',
};

const FONT_REG    = 'Helvetica';
const FONT_BOLD   = 'Helvetica-Bold';
const FONT_OBL    = 'Helvetica-Oblique';
const FONT_MONO   = 'Courier';

const PAGE = {
  margin:   54,           // 0.75in
  contentW: 612 - 54 * 2, // letter width minus margins
};

const MAX_BLOCKS = 5000; // defensive ceiling vs. pathological tokenizer

// -- Tokenize markdown into a block list ------------------------------------
function tokenize(md) {
  const lines  = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];

  let i = 0;
  while (i < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[i];
    const trim = line.trim();

    if (trim === '') { i += 1; continue; }

    // Headings
    let m;
    if ((m = trim.match(/^#\s+(.+)$/)))  { blocks.push({ type: 'h1', text: m[1] }); i += 1; continue; }
    if ((m = trim.match(/^##\s+(.+)$/))) { blocks.push({ type: 'h2', text: m[1] }); i += 1; continue; }
    if ((m = trim.match(/^###\s+(.+)$/))){ blocks.push({ type: 'h3', text: m[1] }); i += 1; continue; }

    // Bullet list (collect consecutive lines)
    if (/^[*-]\s+/.test(trim)) {
      const items = [];
      while (i < lines.length && /^[*-]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[*-]\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trim)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // Paragraph (collect contiguous non-blank lines)
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^#{1,3}\s/.test(lines[i].trim()) && !/^[*-]\s/.test(lines[i].trim()) && !/^\d+\.\s/.test(lines[i].trim())) {
      para.push(lines[i].trim());
      i += 1;
    }
    if (para.length > 0) blocks.push({ type: 'p', text: para.join(' ') });
  }

  return blocks;
}

// -- Render inline markdown to a sequence of styled chunks ------------------
function inlineChunks(s) {
  const chunks = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let lastEnd = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > lastEnd) {
      chunks.push({ text: s.slice(lastEnd, m.index), font: FONT_REG });
    }
    const tok = m[0];
    if (tok.startsWith('`'))       chunks.push({ text: tok.slice(1, -1), font: FONT_MONO });
    else if (tok.startsWith('**')) chunks.push({ text: tok.slice(2, -2), font: FONT_BOLD });
    else                           chunks.push({ text: tok.slice(1, -1), font: FONT_OBL });
    lastEnd = m.index + tok.length;
  }
  if (lastEnd < s.length) chunks.push({ text: s.slice(lastEnd), font: FONT_REG });
  return chunks.length > 0 ? chunks : [{ text: s, font: FONT_REG }];
}

function drawInlineText(doc, chunks, opts: any = {}) {
  for (let i = 0; i < chunks.length; i++) {
    const c     = chunks[i];
    const last  = i === chunks.length - 1;
    doc.font(c.font).text(c.text, { continued: !last, ...opts });
  }
}

// -- Header band - matches the email digest / report PDFs ------------------
function drawHeaderBand(doc, title) {
  const top = doc.y;
  doc.rect(0, top - 12, doc.page.width, 56).fill(COLORS.bgDark);
  doc.fillColor(COLORS.textOnDark).font(FONT_BOLD).fontSize(18)
     .text('ServiceCycle Help', PAGE.margin, top, { align: 'left' });
  doc.fillColor(COLORS.textOnDarkMuted).font(FONT_REG).fontSize(10)
     .text(title, PAGE.margin, top + 22, { align: 'left' });

  const d = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  doc.fillColor(COLORS.textOnDarkMuted).font(FONT_REG).fontSize(9)
     .text(d, PAGE.margin, top + 24, { align: 'right' });

  doc.fillColor(COLORS.text);
  doc.y = top + 56 + 18;
}

// -- Footer - repeats on every page via pageAdded listener -----------------
// v0.36.8 (Pass-6 W3 follow-up to W2 PDF P0):
//   drawFooter writes at y = page.height - margin + 10 (= 748 on LETTER).
//   The footer text() lands at y + 4 = 752, which is below the usable
//   bottom of the page (page.height - margin = 738). With pdfkit's default
//   lineBreak:true, an out-of-margin write triggers an auto page break ->
//   pageAdded listener fires -> drawFooter() is called again -> recursion
//   -> Max call stack -> 500. lineBreak:false suppresses the auto-break.
//   _renderingFooter is belt-and-suspenders against any future drawFooter
//   call paths (e.g. an inner text() that we didn't account for).
function drawFooter(doc, pageNum) {
  if (doc._renderingFooter) return;
  doc._renderingFooter = true;
  const sx = doc.x, sy = doc.y; // cursor-neutral: footer draws below the bottom margin
  try {
    const y = doc.page.height - PAGE.margin + 10;
    doc.moveTo(PAGE.margin, y).lineTo(doc.page.width - PAGE.margin, y)
       .strokeColor(COLORS.border).lineWidth(0.5).stroke();
    doc.fillColor(COLORS.textSubtle).font(FONT_REG).fontSize(8)
       .text('servicecycle.app - generated help reference', PAGE.margin, y + 4, { align: 'left', lineBreak: false });
    // Page number tracked by the caller (bufferedPageRange().start is NaN without
    // bufferPages -> "Page NaN"), right-aligned by computed x (a width + align:'right'
    // flows below the bottom margin and spawns a blank page).
    doc.fillColor(COLORS.textSubtle).font(FONT_REG).fontSize(8);
    const pageLabel = `Page ${pageNum}`;
    doc.text(pageLabel, doc.page.width - PAGE.margin - doc.widthOfString(pageLabel), y + 4, { lineBreak: false });
  } finally {
    doc.x = sx; doc.y = sy;
    doc._renderingFooter = false;
  }
}

/**
 * Render the help doc PDF to a Buffer (pure — no Express response object).
 *
 *   const buf = await renderHelpDocPdf({ slug, title, markdown })
 *
 * Contains the exact pdfkit drawing/markdown-rendering pipeline used by
 * streamHelpDocPdf, but instead of piping to a writable it collects the
 * 'data' chunks and resolves Buffer.concat(chunks) on 'end'. The 'error'
 * handler is bound BEFORE any write so a pdfkit stream-time error rejects
 * the promise instead of bubbling as an unhandled rejection.
 *
 * This is the rendering core; streamHelpDocPdf is a thin response wrapper
 * around it.
 */
function renderHelpDocPdf({ slug, title, markdown }: { slug: string; title: string; markdown: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
      info: {
        Title:    `ServiceCycle Help - ${title || slug}`,
        Author:   'ServiceCycle',
        Subject:  'Per-module help reference',
        Creator:  'ServiceCycle help engine',
      },
    });

    // Collect output into a Buffer. Bind the 'error' handler BEFORE any
    // write so a pdfkit stream-time error rejects rather than escaping as
    // an unhandled rejection.
    const chunks = [];
    doc.on('error', (err) => {
      try { console.error('[pdfHelpDoc] stream error:', err && err.message ? err.message : err); } catch (_) { /* noop */ }
      reject(err);
    });
    doc.on('data', (chunk) => { chunks.push(chunk); });
    doc.on('end', () => {
      try {
        resolve(Buffer.concat(chunks));
      } catch (e) {
        reject(e);
      }
    });

    let pageNum = 1;
    doc.on('pageAdded', () => {
      pageNum += 1;
      drawFooter(doc, pageNum);
      doc.fillColor(COLORS.textSubtle).font(FONT_REG).fontSize(9)
         .text(`Help . ${title || slug}`, PAGE.margin, PAGE.margin - 18);
      doc.fillColor(COLORS.text);
      doc.y = PAGE.margin;
    });

    drawHeaderBand(doc, title || slug);
    drawFooter(doc, 1); // first page footer while page 1 is current

    const blocks = tokenize(markdown);
    let firstH1Skipped = false;

    for (const b of blocks) {
      try {
        if (doc.y > doc.page.height - PAGE.margin - 90) {
          doc.addPage();
        }
        _renderBlock(doc, b, { firstH1Skipped });
        if (b.type === 'h1' && !firstH1Skipped) firstH1Skipped = true;
      } catch (err) {
        try { console.error('[pdfHelpDoc] block render failed; skipping. type=' + (b && b.type) + ' err=' + (err && err.message ? err.message : err)); } catch (_) { /* noop */ }
        // Continue rendering remaining blocks; if pdfkit's internal state
        // is unsalvageable doc.on('error') will fire and reject the promise.
      }
    }

    try {
      doc.end();
    } catch (e) {
      try { console.error('[pdfHelpDoc] doc.end() failed:', e && e.message ? e.message : e); } catch (_) { /* noop */ }
      reject(e);
    }
  });
}

/**
 * Stream the help doc PDF to the response.
 *
 *   streamHelpDocPdf(res, { slug, title, markdown })
 *
 * Caller sets Content-Type + Content-Disposition before invoking.
 *
 * Now a thin wrapper: renders the PDF to a Buffer via renderHelpDocPdf,
 * then sends it on `res`. Preserves the prior response behavior:
 *   - A HEAD request must NOT reach this function — the route handler in
 *     routes/help.js short-circuits HEAD before calling here. Defensive
 *     check below is belt-and-suspenders; if one slips through we end the
 *     response cleanly without touching pdfkit.
 *   - If rendering errors, respond 500 (or end the response if headers
 *     were already sent) instead of bubbling an unhandled rejection.
 */
async function streamHelpDocPdf(res, { slug, title, markdown }) {
  // Defense-in-depth: HEAD requests should never get here (route handles
  // them separately). If one slipped through anyway, return cleanly without
  // touching pdfkit at all.
  if (res && res.req && res.req.method === 'HEAD') {
    try { res.end(); } catch (_) { /* noop */ }
    return;
  }

  let buf;
  try {
    buf = await renderHelpDocPdf({ slug, title, markdown });
  } catch (err) {
    try { console.error('[pdfHelpDoc] render failed:', err && err.message ? err.message : err); } catch (_) { /* noop */ }
    try {
      if (res && !res.headersSent) {
        res.status(500).end();
      } else if (res && res.writable) {
        res.end();
      }
    } catch (_) { /* noop */ }
    return;
  }

  try {
    res.send(buf);
  } catch (_) { /* noop */ }
}

// Extracted so the per-block try/catch above can wrap it cleanly.
function _renderBlock(doc, b, state) {
  switch (b.type) {
    case 'h1': {
      if (!state.firstH1Skipped) { return; } // already in header band
      doc.moveDown(0.4);
      doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(18).text(b.text);
      doc.moveDown(0.3);
      return;
    }
    case 'h2': {
      doc.moveDown(0.6);
      doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(13).text(b.text);
      const lineY = doc.y + 2;
      doc.moveTo(PAGE.margin, lineY).lineTo(PAGE.margin + 36, lineY)
         .strokeColor(COLORS.accent).lineWidth(1.5).stroke();
      doc.moveDown(0.5);
      doc.fillColor(COLORS.text);
      return;
    }
    case 'h3': {
      doc.moveDown(0.4);
      doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(11).text(b.text);
      doc.moveDown(0.2);
      return;
    }
    case 'p': {
      doc.fillColor(COLORS.text).font(FONT_REG).fontSize(10.5);
      const chunks = inlineChunks(b.text);
      drawInlineText(doc, chunks, { lineGap: 2 });
      doc.moveDown(0.6);
      return;
    }
    case 'ul': {
      doc.fillColor(COLORS.text).font(FONT_REG).fontSize(10.5);
      for (const item of b.items) {
        const chunks = inlineChunks(item);
        const first = chunks[0] || { text: '', font: FONT_REG };
        chunks[0] = { ...first, text: '•  ' + first.text };
        drawInlineText(doc, chunks, { lineGap: 2 });
        doc.moveDown(0.2);
      }
      doc.moveDown(0.4);
      return;
    }
    case 'ol': {
      doc.fillColor(COLORS.text).font(FONT_REG).fontSize(10.5);
      let n = 1;
      for (const item of b.items) {
        const chunks = inlineChunks(item);
        const first = chunks[0] || { text: '', font: FONT_REG };
        chunks[0] = { ...first, text: `${n}. ` + first.text };
        drawInlineText(doc, chunks, { lineGap: 2 });
        doc.moveDown(0.2);
        n += 1;
      }
      doc.moveDown(0.4);
      return;
    }
    default:
      return;
  }
}

module.exports = { streamHelpDocPdf, renderHelpDocPdf };

export {};

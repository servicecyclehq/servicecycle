/**
 * /api/assets/labels — printable QR label sheets for Field Mode.
 *
 * GET / streams a US-Letter PDF laid out as a 3 × 8 grid of equipment labels
 * (~63 × 25 mm each — Avery 5160-class peel-off sheets). Each label carries:
 *   - a QR code (left) encoding the ABSOLUTE field-card url
 *     `${CLIENT_URL}/field/asset/<assetId>` — scanning the sticker on the
 *     switchgear lands the tech straight on the asset's field card
 *   - asset identity line (bold), site + position line, serial line,
 *     and a tiny ServiceCycle footer.
 *
 * Filters: ?siteId= (one site, validated against the account) or no filter
 * (all sites); ?assetIds=<comma-list> overrides with an explicit selection.
 * Cap: 240 labels (10 sheets) per request.
 *
 * Read-only — any authenticated role can print labels. Mounted behind
 * authenticateToken in index.ts, and MUST be mounted BEFORE the /api/assets
 * routers (whose GET /:id would otherwise swallow the 'labels' path segment).
 * TENANCY: every asset row is accountId-filtered; siteId is ownership-checked.
 *
 * Stream hardening follows the house pdfHelpDoc v0.36.4/v0.36.7 pattern:
 * doc 'error' bound before pipe, res 'close'/'error' destroy the pdfkit
 * Readable, per-label try/catch so one bad row can't kill the sheet. QR PNGs
 * are generated BEFORE the response is opened so a qrcode failure still
 * returns a clean JSON 500 (headers not yet sent).
 */

const router = require('express').Router();
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const prisma = require('../lib/prisma').default;
const { getAccountBranding } = require('../lib/partnerBranding');
const { PDF_COLORS, PDF_FONTS } = require('../lib/pdfStyle'); // C2d: shared doc theme (typography/colors ONLY -- never geometry)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_LABELS = 240; // 10 full sheets

// ── Sheet geometry (points; US Letter 612 × 792) ─────────────────────────────
// 3 cols × 8 rows of 178 × 71 pt labels (≈ 63 × 25 mm — Avery 5160-ish),
// centered with small gutters.
const GRID = {
  cols: 3,
  rows: 8,
  labelW: 178,
  labelH: 71,
  gutterX: 9,   // 3·178 + 2·9 = 552 → marginX (612−552)/2 = 30
  gutterY: 16,  // 8·71 + 7·16 = 680 → marginY (792−680)/2 = 56
  marginX: 30,
  marginY: 56,
};
const PER_PAGE = GRID.cols * GRID.rows; // 24

const QR_SIZE = 60;  // ≈ 21 mm
const QR_PAD  = 5;   // inset from the label's left/top edge

// C2d micro-typography: faces/text colors from the shared theme (lib/pdfStyle).
// Values only -- the GRID label geometry above is physical Avery 5160-class
// stock and is deliberately NOT themed.
const FONT_REG  = PDF_FONTS.sans;        // 'Helvetica' -- same face as before
const FONT_BOLD = PDF_FONTS.sansBold;    // 'Helvetica-Bold'
const TEXT_MUTED = PDF_COLORS.textMuted; // secondary label lines
const TEXT_FAINT = PDF_COLORS.textFaint; // tiny brand footer

// #7 condition-of-maintenance label (NFPA 70B §4.2 / Annex). The standard's EMP
// element list calls for the equipment to carry its condition designation and
// the date that condition was established. The NETA decal (a completed work
// order's netaDecal result) supplies the Serviceable / Limited / Non-serviceable
// designation; the asset's governingCondition supplies the C1/C2/C3 rating.
// C2d: decal swatch colors mirror the physical NETA decal (green/yellow/red)
// signal colors -- deliberately NOT mapped to the brand palette.
const DECAL_DESIGNATION: any = { GREEN: 'Serviceable', YELLOW: 'Limited Service', RED: 'Non-serviceable' };
const DECAL_COLOR: any = { GREEN: '#16a34a', YELLOW: '#d97706', RED: '#dc2626' };

function fmtShortDate(d: any): string | null {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Truncate `s` so it renders within `maxW` at the doc's current font/size.
// pdfkit's lineBreak:false happily overflows the box, so we measure.
function fitText(doc, s, maxW) {
  let t = String(s == null ? '' : s);
  if (doc.widthOfString(t) <= maxW) return t;
  while (t.length > 1 && doc.widthOfString(t + '…') > maxW) {
    t = t.slice(0, -1);
  }
  return t + '…';
}

function assetLine(a) {
  const mm = [a.manufacturer, a.model].filter(Boolean).join(' ');
  return [a.equipmentType, mm || null].filter(Boolean).join(' · ');
}

function positionLine(a) {
  const pos = a.position
    ? (a.position.code ? `${a.position.name} (${a.position.code})` : a.position.name)
    : null;
  return [a.site?.name, pos].filter(Boolean).join(' · ');
}

function filenameSlug(s) {
  const slug = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'site';
}

// Render one label at grid slot (col, row) on the current page.
function drawLabel(doc, x, y, asset, qrPng, brandName) {
  // QR block, left.
  doc.image(qrPng, x + QR_PAD, y + QR_PAD, { width: QR_SIZE, height: QR_SIZE });

  const tx = x + QR_PAD + QR_SIZE + 8;
  const tw = x + GRID.labelW - tx - 4;

  // Line 1 — asset identity, bold.
  doc.font(FONT_BOLD).fontSize(8).fillColor(PDF_COLORS.ink);
  doc.text(fitText(doc, assetLine(asset), tw), tx, y + 9, { lineBreak: false });

  // Line 2 — site · position.
  doc.font(FONT_REG).fontSize(7).fillColor(TEXT_MUTED);
  doc.text(fitText(doc, positionLine(asset) || '—', tw), tx, y + 21, { lineBreak: false });

  // Line 3 — serial.
  doc.font(FONT_REG).fontSize(7).fillColor(TEXT_MUTED);
  doc.text(fitText(doc, asset.serialNumber ? `S/N ${asset.serialNumber}` : 'S/N —', tw), tx, y + 32, { lineBreak: false });

  // Line 4 — #7 condition of maintenance: [decal swatch] designation · Cn · est. date.
  // NFPA 70B wants the designation AND the date it was established on the gear.
  const decal = asset._decal;
  const gov = asset.governingCondition || 'C2';
  const designation = decal ? DECAL_DESIGNATION[decal] : null;
  const estDate = fmtShortDate(asset._decalDate);
  const condParts = [];
  if (designation) condParts.push(designation);
  condParts.push(gov);
  let condLine = condParts.join(' · ');
  if (estDate) condLine += ` · est. ${estDate}`;
  let cx = tx;
  if (decal && DECAL_COLOR[decal]) {
    doc.save();
    doc.rect(tx, y + 44, 5, 5).fill(DECAL_COLOR[decal]);
    doc.restore();
    cx = tx + 8;
  }
  doc.font(FONT_REG).fontSize(6.5).fillColor(TEXT_MUTED);
  doc.text(fitText(doc, condLine, tw - (cx - tx)), cx, y + 43, { lineBreak: false });

  // Footer — tiny brand mark, bottom of the text block. #15 co-brand: the
  // contractor's name in front of the ServiceCycle mark when present.
  doc.font(FONT_REG).fontSize(5.5).fillColor(TEXT_FAINT);
  // C2d note: pdfStyle's mono footer voice was tried and rejected here --
  // Courier at 5.5pt ellipsizes the co-branded mark ('<brand> - ServiceCycle')
  // inside the ~101pt label text column; the sans face keeps it whole.
  const footerText = brandName ? `${brandName} · ServiceCycle` : 'ServiceCycle';
  doc.text(fitText(doc, footerText, tw), tx, y + GRID.labelH - 11, { lineBreak: false });
  doc.fillColor(PDF_COLORS.ink);
}

// PURE renderer — the exact PDFDocument setup + label-grid loop, decoupled from
// Express/Prisma so it can be exercised with mock assets and pre-built QR PNGs.
// `qrPngs[i]` corresponds to `assets[i]`. Resolves a complete PDF Buffer.
function renderAssetLabelsPdf(
  assets: any[],
  qrPngs: Buffer[],
  brandName: string | null
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 0,            // grid is positioned absolutely; no auto page breaks
      autoFirstPage: false, // pages added explicitly per 24 labels
      info: {
        Title:   'ServiceCycle Asset QR Labels',
        Author:  'ServiceCycle',
        Subject: 'Asset labels',
        Creator: 'ServiceCycle field mode',
      },
    });

    // Collect into a Buffer. 'error' bound BEFORE any write.
    const chunks: Buffer[] = [];
    doc.on('error', (err) => reject(err));
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    for (let i = 0; i < assets.length; i++) {
      if (i % PER_PAGE === 0) doc.addPage();

      const slot = i % PER_PAGE;
      const col = slot % GRID.cols;
      const row = Math.floor(slot / GRID.cols);
      const x = GRID.marginX + col * (GRID.labelW + GRID.gutterX);
      const y = GRID.marginY + row * (GRID.labelH + GRID.gutterY);

      // Per-label try/catch — one malformed row must not take the sheet down.
      try {
        drawLabel(doc, x, y, assets[i], qrPngs[i], brandName);
      } catch (err) {
        try {
          console.error('[assetLabels] label render failed; skipping.',
            err && err.message ? err.message : err);
        } catch (_) { /* noop */ }
      }
    }

    doc.end();
  });
}

// ─── GET /api/assets/labels ───────────────────────────────────────────────────
// ?siteId=     — labels for one site (validated against the account);
//                omitted = all sites in the account
// ?assetIds=   — comma-separated explicit asset selection (overrides siteId
//                as the row filter; every id still accountId-scoped)
router.get('/', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const { siteId, assetIds } = req.query;

    // Validate siteId (also names the downloaded file when present).
    let site = null;
    if (siteId !== undefined) {
      if (!UUID_RE.test(String(siteId))) {
        return res.status(400).json({ success: false, error: 'siteId must be a uuid' });
      }
      site = await prisma.site.findFirst({
        where: { id: String(siteId), accountId },
        select: { id: true, name: true },
      });
      if (!site) return res.status(404).json({ success: false, error: 'Site not found' });
    }

    // Explicit selection override.
    let idList = null;
    if (assetIds !== undefined) {
      idList = String(assetIds).split(',').map((s) => s.trim()).filter(Boolean);
      if (idList.length === 0) {
        return res.status(400).json({ success: false, error: 'assetIds must contain at least one id' });
      }
      if (idList.length > MAX_LABELS) {
        return res.status(400).json({ success: false, error: `assetIds is capped at ${MAX_LABELS} per request` });
      }
      if (idList.some((id) => !UUID_RE.test(id))) {
        return res.status(400).json({ success: false, error: 'assetIds must be a comma-separated list of uuids' });
      }
    }

    const where: any = { accountId, archivedAt: null };
    if (idList) {
      where.id = { in: idList };
    } else if (site) {
      where.siteId = site.id;
    }

    const assets = await prisma.asset.findMany({
      where,
      select: {
        id: true, equipmentType: true, manufacturer: true, model: true,
        serialNumber: true, governingCondition: true,
        site:     { select: { id: true, name: true } },
        position: { select: { name: true, code: true } },
      },
      orderBy: [{ site: { name: 'asc' } }, { createdAt: 'asc' }],
      take: MAX_LABELS,
    });

    if (assets.length === 0) {
      return res.status(404).json({ success: false, error: 'No assets match the requested label set' });
    }

    // #7: the condition designation + "date established" come from each asset's
    // most recent completed work order that recorded a NETA decal. One query for
    // the whole sheet; first row per asset wins (ordered newest-first).
    const decalRows = await prisma.workOrder.findMany({
      where: { accountId, assetId: { in: assets.map((a: any) => a.id) }, netaDecal: { not: null } },
      select: { assetId: true, netaDecal: true, completedDate: true, scheduledDate: true },
      orderBy: { completedDate: 'desc' },
    });
    const decalByAsset = new Map<string, any>();
    for (const w of decalRows) {
      if (!decalByAsset.has(w.assetId)) decalByAsset.set(w.assetId, w);
    }
    for (const a of assets as any[]) {
      const w = decalByAsset.get(a.id);
      a._decal = w ? w.netaDecal : null;
      a._decalDate = w ? (w.completedDate || w.scheduledDate) : null;
    }

    // Generate every QR PNG BEFORE opening the response — a qrcode failure
    // here still returns clean JSON because no headers have been sent.
    const clientBase = String(process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/+$/, '');
    const qrPngs = await Promise.all(
      assets.map((a) =>
        QRCode.toBuffer(`${clientBase}/field/asset/${a.id}`, {
          type: 'png',
          errorCorrectionLevel: 'M',
          margin: 0,
          width: 240, // rendered down to 60pt — crisp at print resolution
        })
      )
    );

    const fileSite = site ? filenameSlug(site.name) : (idList ? 'selected' : 'all-sites');
    const filename = `servicecycle-asset-labels-${fileSite}.pdf`;

    const branding = await getAccountBranding(accountId); // #15 co-brand
    const brandName = branding?.name || null;

    // Build the full PDF in-memory via the pure renderer, THEN send. A render
    // failure surfaces as a rejected promise and is caught below as a clean
    // JSON 500 because no headers have been sent yet.
    const buf = await renderAssetLabelsPdf(assets, qrPngs, brandName);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(buf);
  } catch (err) {
    console.error('Asset labels error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Failed to generate label sheet' });
    } else {
      try { res.end(); } catch (_) { /* noop */ }
    }
  }
});

module.exports = router;
module.exports.renderAssetLabelsPdf = renderAssetLabelsPdf;

export {};

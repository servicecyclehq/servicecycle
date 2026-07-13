'use strict';

/**
 * lib/compliancePdf.js
 * --------------------
 * pdfkit renderer for compliance audit snapshots.
 *
 *   renderSnapshotPdf(reportBundles, meta) → Promise<Buffer>
 *
 * Unlike pdfHelpDoc (which streams straight into `res`), this renderer
 * accumulates the whole document into a Buffer — the caller needs the bytes
 * twice (SHA-256 + storage write) BEFORE anything is sent to the client, so
 * streaming would be actively wrong here.
 *
 * Stream-error hardening carried over from pdfHelpDoc v0.36.4/v0.36.7
 * (the ERR_STREAM_WRITE_AFTER_END crash class):
 *   - doc.on('error') is bound BEFORE any write so a pdfkit stream-time
 *     error rejects the promise instead of bubbling as an unhandled
 *     'error' event that kills the process.
 *   - the per-row render loops are wrapped in try/catch so one bad row
 *     doesn't take the whole document down.
 *   - the footer writer is guarded against pageAdded recursion
 *     (lineBreak:false on out-of-margin writes + a _renderingFooter flag —
 *     same fix as pdfHelpDoc v0.36.8).
 *   - a settled flag ensures resolve/reject fire exactly once even if
 *     pdfkit emits 'error' after 'end'.
 *
 * Layout is intentionally conservative — black/grey text, thin rules, no
 * decoration beyond the house header band. This document lands on an
 * insurance adjuster's desk; it should read like an engineering record,
 * not a dashboard screenshot.
 */

const PDFDocument = require('pdfkit');
// C2h: locked palette + house fonts/geometry + shared footer now come from
// the shared PDF theme module (lib/pdfStyle.ts) instead of a local COLORS
// block (docs/design/EXPORT_SURFACE_INVENTORY_2026-07-13.md callout 6).
// Forward-only: affects newly generated snapshots only -- stored/hashed
// historical snapshot bytes are never re-rendered by this change.
const { PDF_COLORS, PDF_FONTS, PDF_PAGE, attachFooter } = require('./pdfStyle');

const ON_DARK_MUTED = '#9aa3b2'; // on-dark muted text for the co-brand header band (locked palette has no on-dark slot)
const COLORS = {
  bgDark:          PDF_COLORS.ink,
  textOnDark:      PDF_COLORS.card,
  textOnDarkMuted: ON_DARK_MUTED,
  text:            PDF_COLORS.ink,
  textMuted:       PDF_COLORS.textMuted,
  textSubtle:      PDF_COLORS.textFaint,
  border:          PDF_COLORS.border,
  accent:          PDF_COLORS.petrol,
  cardBg:          PDF_COLORS.pageBg,
  danger:          PDF_COLORS.danger,
  dangerBg:        PDF_COLORS.dangerBg,
};

const FONT_REG  = PDF_FONTS.sans;
const FONT_BOLD = PDF_FONTS.sansBold;
const FONT_OBL  = PDF_FONTS.sansOblique;

const PAGE = PDF_PAGE;
const BOTTOM = PDF_PAGE.bottom;

// Asset/task table columns — widths sum to PAGE.contentW (504).
const COLS = [
  { key: 'asset',    label: 'Asset',           w: 100 },
  { key: 'site',     label: 'Site',            w: 60  },
  { key: 'task',     label: 'Task',            w: 105 },
  { key: 'last',     label: 'Last completed',  w: 58  },
  { key: 'next',     label: 'Next due',        w: 58  },
  { key: 'status',   label: 'Status',          w: 48  },
  { key: 'evidence', label: 'Latest evidence', w: 75  },
];

const CELL_PAD   = 3;
const TABLE_FS   = 8;   // table body font size
const MAX_CELL   = 220; // hard truncation so a pathological field can't exceed a page

// ── small helpers ─────────────────────────────────────────────────────────────

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toISOString().slice(0, 10); } catch (_) { return '—'; }
}

function clip(s) {
  const t = String(s == null ? '' : s);
  return t.length > MAX_CELL ? t.slice(0, MAX_CELL - 1) + '…' : t;
}

function assetLabel(a) {
  const mm = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const sn = a.serialNumber ? `S/N ${a.serialNumber}` : null;
  const parts = [a.equipmentType, mm || null, sn].filter(Boolean);
  return parts.join(' · ');
}

function statusLabel(status) {
  switch (status) {
    case 'overdue':     return 'OVERDUE';
    case 'current':     return 'Current';
    case 'unbaselined': return 'Not baselined';
    case 'inactive':    return 'Inactive';
    default:            return String(status || '—');
  }
}

// -- footer -----------------------------------------------------------------
// C2h: the bespoke per-file drawFooter was replaced by the shared theme's
// attachFooter/drawFooter (lib/pdfStyle.ts); see renderSnapshotPdf below.

// ── cover page ────────────────────────────────────────────────────────────────

function drawCoverPage(doc, reportBundles, meta) {
  // Header band — matches the other ServiceCycle PDF surfaces. #15 co-brand.
  doc.rect(0, 0, doc.page.width, 96).fill(meta.brandColor || COLORS.bgDark);
  doc.fillColor(COLORS.textOnDark).font(FONT_BOLD).fontSize(22)
     .text('ServiceCycle', PAGE.margin, 30, { lineBreak: false });
  doc.fillColor(COLORS.textOnDarkMuted).font(FONT_REG).fontSize(12)
     .text('Compliance Snapshot — Audit Evidence Record', PAGE.margin, 60, { lineBreak: false });

  doc.fillColor(COLORS.text);
  let y = 140;

  if (meta.brandName) {
    doc.font(FONT_REG).fontSize(10).fillColor(COLORS.textMuted)
       .text(`Prepared by ${meta.brandName} · powered by ServiceCycle`, PAGE.margin, y, { width: PAGE.contentW });
    y = doc.y + 10;
  }

  doc.font(FONT_BOLD).fontSize(18).text(clip(meta.accountName || 'Account'), PAGE.margin, y, { width: PAGE.contentW });
  y = doc.y + 18;

  const kv = (label, value) => {
    doc.font(FONT_BOLD).fontSize(10).fillColor(COLORS.textMuted)
       .text(label, PAGE.margin, y, { width: 150, lineBreak: false });
    doc.font(FONT_REG).fontSize(10).fillColor(COLORS.text)
       .text(clip(value), PAGE.margin + 150, y, { width: PAGE.contentW - 150 });
    y = Math.max(doc.y, y + 14) + 6;
  };

  kv('Scope',              meta.scopeDescription || 'All standards — all sites');
  kv('Generated at (UTC)', meta.generatedAtIso);
  kv('Generated by',       meta.generatedByName || 'Unknown user');
  kv('Snapshot ID',        meta.snapshotId);
  kv('Standards covered',  (meta.standardEditions && meta.standardEditions.length > 0)
                             ? meta.standardEditions.join(', ')
                             : '—');

  // Prominent integrity note — the product promise, verbatim.
  y += 18;
  const noteText =
    'The SHA-256 of this document is recorded in the ServiceCycle ' +
    'tamper-evident audit log at generation time. Recompute the hash of ' +
    `this file and compare against audit log entry ${meta.snapshotId} ` +
    'to verify it has not been altered.';
  const noteInnerW = PAGE.contentW - 24;
  doc.font(FONT_REG).fontSize(10);
  const noteH = doc.heightOfString(noteText, { width: noteInnerW, lineGap: 2 }) + 40;

  doc.rect(PAGE.margin, y, PAGE.contentW, noteH).fill(COLORS.cardBg);
  doc.rect(PAGE.margin, y, 3, noteH).fill(COLORS.accent);
  doc.rect(PAGE.margin, y, PAGE.contentW, noteH)
     .strokeColor(COLORS.border).lineWidth(0.75).stroke();

  doc.fillColor(COLORS.accent).font(FONT_BOLD).fontSize(10)
     .text('DOCUMENT INTEGRITY', PAGE.margin + 12, y + 12, { width: noteInnerW, lineBreak: false });
  doc.fillColor(COLORS.text).font(FONT_REG).fontSize(10)
     .text(noteText, PAGE.margin + 12, y + 28, { width: noteInnerW, lineGap: 2 });

  // Estimate disclaimer — this report leaves the building, so it must not read
  // as a certification. The rates are computed against the standard editions
  // listed above as configured in ServiceCycle on the generation date, which
  // may lag the current published edition.
  y += noteH + 14;
  const disText =
    'ESTIMATE — NOT A CERTIFICATION. Compliance figures are an estimate computed against the ' +
    'standard editions listed above, as configured in ServiceCycle on the generation date. Those ' +
    'requirements may lag the current published edition. This document is not a legal certification, ' +
    'engineering assessment, or guarantee of compliance. Verify against the current published standard ' +
    'and have a qualified professional review before relying on it.';
  doc.font(FONT_REG).fontSize(9);
  const disH = doc.heightOfString(disText, { width: noteInnerW, lineGap: 2 }) + 34;
  doc.rect(PAGE.margin, y, PAGE.contentW, disH).fill('#fffbeb');
  doc.rect(PAGE.margin, y, 3, disH).fill('#b45309');
  doc.rect(PAGE.margin, y, PAGE.contentW, disH).strokeColor('#fde68a').lineWidth(0.75).stroke();
  doc.fillColor('#92400e').font(FONT_BOLD).fontSize(9)
     .text('SCOPE & LIMITATIONS', PAGE.margin + 12, y + 10, { width: noteInnerW, lineBreak: false });
  doc.fillColor(COLORS.text).font(FONT_REG).fontSize(9)
     .text(disText, PAGE.margin + 12, y + 24, { width: noteInnerW, lineGap: 2 });
}

// ── per-standard section ──────────────────────────────────────────────────────

function drawSectionHeading(doc, bundle) {
  const std = bundle.standard || {};
  doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(15)
     .text(
       std.edition ? `${std.code} (${std.edition} edition)` : String(std.code || 'Standard'),
       PAGE.margin, PAGE.margin, { width: PAGE.contentW }
     );
  if (std.title) {
    doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(10)
       .text(clip(std.title), { width: PAGE.contentW });
  }
  if (std.keyMandate) {
    doc.fillColor(COLORS.textMuted).font(FONT_OBL).fontSize(9)
       .text(clip(`Key mandate: ${std.keyMandate}`), { width: PAGE.contentW });
  }
  const lineY = doc.y + 6;
  doc.moveTo(PAGE.margin, lineY).lineTo(PAGE.margin + PAGE.contentW, lineY)
     .strokeColor(COLORS.accent).lineWidth(1).stroke();
  return lineY + 12;
}

function drawSummaryBlock(doc, bundle, y) {
  const s = bundle.summary || {};
  const items = [
    ['Assets',            String(s.assetCount ?? 0)],
    ['Active schedules',  String(s.scheduleCount ?? 0)],
    ['Current',           String(s.currentCount ?? 0)],
    ['Overdue',           String(s.overdueCount ?? 0)],
    ['Not yet baselined', String(s.unbaselinedCount ?? 0)],
    ['Compliance rate',   s.complianceRate == null ? 'n/a' : `${s.complianceRate}%`],
  ];
  const boxH = 56;
  doc.rect(PAGE.margin, y, PAGE.contentW, boxH).fill(COLORS.cardBg);
  doc.rect(PAGE.margin, y, PAGE.contentW, boxH)
     .strokeColor(COLORS.border).lineWidth(0.75).stroke();

  const cellW = PAGE.contentW / items.length;
  items.forEach(([label, value], i) => {
    const x = PAGE.margin + i * cellW;
    const isOverdue = label === 'Overdue' && Number(value) > 0;
    doc.fillColor(isOverdue ? COLORS.danger : COLORS.text)
       .font(FONT_BOLD).fontSize(14)
       .text(value, x, y + 10, { width: cellW, align: 'center', lineBreak: false });
    doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(7.5)
       .text(label, x, y + 32, { width: cellW, align: 'center', lineBreak: false });
  });

  if (bundle.scope && bundle.scope.siteName) {
    doc.fillColor(COLORS.textMuted).font(FONT_OBL).fontSize(8.5)
       .text(`Scope: site "${clip(bundle.scope.siteName)}" only`, PAGE.margin, y + boxH + 6, { lineBreak: false });
    return y + boxH + 22;
  }
  return y + boxH + 16;
}

function drawTableHeader(doc, y) {
  doc.rect(PAGE.margin, y, PAGE.contentW, 16).fill(COLORS.bgDark);
  let x = PAGE.margin;
  doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.textOnDark);
  for (const col of COLS) {
    doc.text(col.label, x + CELL_PAD, y + 4, { width: col.w - CELL_PAD * 2, lineBreak: false });
    x += col.w;
  }
  doc.fillColor(COLORS.text);
  return y + 16;
}

function rowCells(row) {
  const wo = row.latestWorkOrder;
  return {
    asset:    clip(assetLabel(row.asset)),
    site:     clip(row.asset.siteName || '—'),
    task:     clip(row.task.standardRef ? `${row.task.taskName} (${row.task.standardRef})` : row.task.taskName),
    last:     fmtDate(row.schedule.lastCompletedDate),
    next:     fmtDate(row.schedule.nextDueDate),
    status:   statusLabel(row.schedule.status),
    evidence: wo
      ? `${fmtDate(wo.completedDate)}${wo.netaDecal ? ` · ${wo.netaDecal} decal` : ''}`
      : '—',
  };
}

function measureRowHeight(doc, cells) {
  doc.font(FONT_REG).fontSize(TABLE_FS);
  let h = 0;
  for (const col of COLS) {
    const cellH = doc.heightOfString(String(cells[col.key] || '—'), {
      width: col.w - CELL_PAD * 2,
      lineGap: 1,
    });
    if (cellH > h) h = cellH;
  }
  return Math.max(h + CELL_PAD * 2, 14);
}

function drawRow(doc, row, cells, y, h) {
  const overdue = row.schedule.status === 'overdue';
  if (overdue) {
    // Visual flag: light red row tint + bold red status/next-due text.
    doc.rect(PAGE.margin, y, PAGE.contentW, h).fill(COLORS.dangerBg);
  }
  let x = PAGE.margin;
  for (const col of COLS) {
    const isFlagCell = overdue && (col.key === 'status' || col.key === 'next');
    doc.font(isFlagCell ? FONT_BOLD : FONT_REG)
       .fontSize(TABLE_FS)
       .fillColor(isFlagCell ? COLORS.danger : COLORS.text)
       .text(String(cells[col.key] || '—'), x + CELL_PAD, y + CELL_PAD, {
         width: col.w - CELL_PAD * 2,
         lineGap: 1,
       });
    x += col.w;
  }
  doc.moveTo(PAGE.margin, y + h).lineTo(PAGE.margin + PAGE.contentW, y + h)
     .strokeColor(COLORS.border).lineWidth(0.5).stroke();
  doc.fillColor(COLORS.text);
}

function drawAssetTaskTable(doc, bundle, y) {
  if (!bundle.rows || bundle.rows.length === 0) {
    doc.fillColor(COLORS.textMuted).font(FONT_OBL).fontSize(9)
       .text('No maintenance schedules under this standard in the selected scope.', PAGE.margin, y);
    return doc.y + 8;
  }

  y = drawTableHeader(doc, y);

  for (const row of bundle.rows) {
    // Per-row try/catch — one malformed row must not take the document
    // down (pdfHelpDoc v0.36.4 lesson).
    try {
      const cells = rowCells(row);
      const h = measureRowHeight(doc, cells);
      if (y + h > BOTTOM - 6) {
        doc.addPage();
        y = drawTableHeader(doc, PAGE.margin);
      }
      drawRow(doc, row, cells, y, h);
      y += h;
    } catch (err) {
      try {
        console.error('[compliancePdf] row render failed; skipping.',
          err && err.message ? err.message : err);
      } catch (_) { /* noop */ }
    }
  }
  return y + 10;
}

function drawDeficiencies(doc, bundle, y) {
  const defs = bundle.openDeficiencies || [];

  const ensureSpace = (need) => {
    if (y + need > BOTTOM - 6) { doc.addPage(); y = PAGE.margin; }
  };

  ensureSpace(48);
  doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(11)
     .text(`Open deficiencies (${defs.length})`, PAGE.margin, y, { lineBreak: false });
  y += 14;
  doc.fillColor(COLORS.textMuted).font(FONT_OBL).fontSize(8)
     .text(
       bundle.openDeficienciesNote ||
       'Asset-level findings on equipment scheduled under this standard — not attributed to the standard itself.',
       PAGE.margin, y, { width: PAGE.contentW, lineGap: 1 }
     );
  y = doc.y + 8;

  if (defs.length === 0) {
    doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(9)
       .text('None.', PAGE.margin, y);
    return doc.y + 8;
  }

  for (const d of defs) {
    try {
      const head = `[${d.severity}] ${assetLabel(d.asset)} — ${d.asset.siteName || 'unknown site'}`;
      const body = clip(d.description) +
        (d.correctiveAction ? ` Corrective action: ${clip(d.correctiveAction)}` : '') +
        ` (logged ${fmtDate(d.createdAt)})`;

      doc.font(FONT_BOLD).fontSize(8.5);
      const headH = doc.heightOfString(head, { width: PAGE.contentW, lineGap: 1 });
      doc.font(FONT_REG).fontSize(8.5);
      const bodyH = doc.heightOfString(body, { width: PAGE.contentW - 10, lineGap: 1 });
      ensureSpace(headH + bodyH + 10);

      doc.fillColor(d.severity === 'IMMEDIATE' ? COLORS.danger : COLORS.text)
         .font(FONT_BOLD).fontSize(8.5)
         .text(head, PAGE.margin, y, { width: PAGE.contentW, lineGap: 1 });
      y = doc.y + 1;
      doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(8.5)
         .text(body, PAGE.margin + 10, y, { width: PAGE.contentW - 10, lineGap: 1 });
      y = doc.y + 6;
    } catch (err) {
      try {
        console.error('[compliancePdf] deficiency render failed; skipping.',
          err && err.message ? err.message : err);
      } catch (_) { /* noop */ }
    }
  }
  return y;
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Render the snapshot PDF into a Buffer.
 *
 * @param {Array}  reportBundles — output of buildStandardReport(), one per standard
 * @param {object} meta
 * @param {string} meta.snapshotId       — pre-generated ComplianceSnapshot id (in footer + integrity note)
 * @param {string} meta.accountName      — account companyName for the cover
 * @param {string} meta.generatedByName  — actor user name
 * @param {string} meta.generatedAtIso   — UTC ISO timestamp string
 * @param {string} meta.scopeDescription — e.g. 'NFPA 70B — Plant 2' / 'All standards — all sites'
 * @param {string[]} meta.standardEditions — e.g. ['NFPA 70B (2023)', 'NETA MTS (2024)']
 * @returns {Promise<Buffer>}
 */
function renderSnapshotPdf(reportBundles, meta) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
      info: {
        Title:   `ServiceCycle Compliance Snapshot ${meta.snapshotId}`,
        Author:  'ServiceCycle',
        Subject: meta.scopeDescription || 'Compliance snapshot',
        Creator: 'ServiceCycle compliance engine',
      },
    });

    const chunks = [];
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { doc.destroy(); } catch (_) { /* noop */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    // Hardening: error handler bound BEFORE any write (pdfHelpDoc v0.36.4) —
    // without it a pdfkit stream error is an unhandled 'error' event that
    // crashes the process.
    doc.on('error', fail);
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    try {
      // Standard page footers via the shared theme (lib/pdfStyle.attachFooter):
      // page-1 footer now + redrawn on every pageAdded, recursion-guarded and
      // cursor-neutral. No in-footer integrity hash -- the SHA-256 is computed
      // from these bytes AFTER rendering, so it cannot be printed inside them.
      attachFooter(doc, {
        generatedAtIso: meta.generatedAtIso,
        docId: meta.snapshotId ? 'snapshot ' + meta.snapshotId : undefined,
        brandName: meta.brandName,
      });
      drawCoverPage(doc, reportBundles, meta);

      for (const bundle of reportBundles) {
        doc.addPage();
        let y = drawSectionHeading(doc, bundle);
        y = drawSummaryBlock(doc, bundle, y);
        y = drawAssetTaskTable(doc, bundle, y);
        drawDeficiencies(doc, bundle, y + 6);
      }

      doc.end();
    } catch (err) {
      fail(err);
    }
  });
}

module.exports = { renderSnapshotPdf };

export {};


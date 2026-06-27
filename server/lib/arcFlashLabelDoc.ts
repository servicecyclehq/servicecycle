'use strict';

/**
 * arcFlashLabelDoc.ts — generate an NFPA 70E §130.5(H) / ANSI Z535.4 conformant
 * arc-flash + shock hazard LABEL as a print-ready PDF, sized to a standard 4x6
 * label so it prints 1:1 on the customer's own label stock (we generate the
 * file; they print it — SC is not a printing platform).
 *
 * Content branches by labeling METHOD: incident-energy (IE @ working distance +
 * required arc rating) OR PPE category. The facility/equipment identity leads;
 * the SC/operator brand stays minimal. SC is the data layer — the label is
 * printed from the captured study; a licensed PE owns the underlying calculation.
 */

const { shockApproachBoundaries } = require('./arcFlashLabel');

// ANSI Z535.4 signal-word colors.
const SAFETY_RED = '#C8102E';     // DANGER
const SAFETY_ORANGE = '#FF8200';  // WARNING
const INK = '#0f172a';
const MUTED = '#475569';

// 4x6 in at 72 pt/in (portrait).
const LABEL_W = 288;
const LABEL_H = 432;

function voltsOf(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /kv/i.test(m[2] || '') ? n * 1000 : n;
}
function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function fmtDate(d: any): string { try { return d ? new Date(d).toLocaleDateString() : '—'; } catch { return '—'; } }

/**
 * Decide severity + which fields the label shows. Pure + unit-testable.
 * @param row SystemStudyAsset(+study,+asset)
 */
function buildLabelModel(row: any, opts: any = {}): any {
  const ie = num(row.incidentEnergyCalCm2);

  // INS-14: Block label generation when both IE and PPE category are absent.
  if (ie == null && (row.ppeCategory == null || row.ppeCategory === '')) {
    throw new Error('Cannot generate label: no incident energy or PPE category on file. Complete the arc flash study first.');
  }

  // INS-1: Block label generation when PE attribution is missing.
  const peName = row.study?.peName || opts.peName || null;
  const firmName = row.study?.performedBy || opts.firmName || null;
  if (!peName && !firmName) {
    throw new Error("PE attribution required before printing — enter the performing engineer's name and firm in the study record.");
  }

  const v = voltsOf(row.nominalVoltage);
  const danger = ie != null && ie > 40;
  // Method: explicit ppeMethod, else infer (IE present → incident-energy).
  let method = row.ppeMethod;
  if (method !== 'incident_energy' && method !== 'ppe_category') {
    method = ie != null ? 'incident_energy' : (row.ppeCategory != null ? 'ppe_category' : 'incident_energy');
  }
  // [NETA-8-8 / LEGAL-8-14] Shock approach boundaries are mandatory on the NFPA
  // 70E §130.5(H) label. Prefer the study's recorded value; otherwise derive the
  // published Table 130.4 distance from the nominal voltage so the label never
  // prints a blank/soft placeholder. shockApproachSource tells the renderer
  // whether the figure was captured or table-derived (so it can annotate it).
  const limitedStored = num(row.shockLimitedApproachIn);
  const restrictedStored = num(row.shockRestrictedApproachIn);
  const tbl = shockApproachBoundaries(row.nominalVoltage);
  const shockLimitedApproachIn = limitedStored != null ? limitedStored : tbl.limitedIn;
  const shockRestrictedApproachIn = restrictedStored != null ? restrictedStored : tbl.restrictedIn;
  return {
    signalWord: danger ? 'DANGER' : 'WARNING',
    danger,
    method,
    nominalVoltage: row.nominalVoltage || (v != null ? `${v} V` : null),
    incidentEnergyCalCm2: ie,
    workingDistanceIn: num(row.workingDistanceIn),
    arcFlashBoundaryIn: num(row.arcFlashBoundaryIn),
    ppeCategory: row.ppeCategory ?? null,
    requiredArcRatingCalCm2: num(row.requiredArcRatingCalCm2),
    shockLimitedApproachIn,
    shockRestrictedApproachIn,
    shockLimitedApproachSource: shockLimitedApproachIn == null ? null : (limitedStored != null ? 'study' : 'table130_4'),
    shockRestrictedApproachSource: shockRestrictedApproachIn == null ? null : (restrictedStored != null ? 'study' : 'table130_4'),
    busName: row.busName || row.asset?.name || 'Equipment',
    equipmentType: row.asset?.equipmentType || null,
    studyDate: fmtDate(row.study?.performedDate),
    studyExpiresAt: row.study?.expiresAt || row.study?.expiryDate || null,
    facilityName: opts.facilityName || null,
    brandName: opts.brandName || null,
    peName,
    firmName,
    showIE: method === 'incident_energy' && ie != null,
    showPpeCat: method === 'ppe_category' || (ie == null && row.ppeCategory != null),
  };
}

// Render one label into the box at (x,y) of size (w,h). Uses pdfkit `doc`.
function drawArcFlashLabel(doc: any, x: number, y: number, w: number, h: number, m: any): void {
  const pad = 12;
  const headerH = 52;
  const headerColor = m.danger ? SAFETY_RED : SAFETY_ORANGE;
  const headerText = m.danger ? '#FFFFFF' : '#000000';

  // Border
  doc.lineWidth(1.5).strokeColor('#000000').rect(x, y, w, h).stroke();

  // Signal-word panel
  doc.rect(x, y, w, headerH).fill(headerColor);
  doc.fillColor(headerText).font('Helvetica-Bold').fontSize(30)
    .text(m.signalWord, x, y + 12, { width: w, align: 'center' });

  // Hazard statement
  let cy = y + headerH + 8;
  // DANGER (IE > 40 cal/cm2): NFPA 70E §130.5 — no PPE category applies above
  // 40 cal/cm²; the label must direct workers to de-energize.
  if (m.danger) {
    doc.fillColor(SAFETY_RED).font('Helvetica-Bold').fontSize(8.5)
      .text('Incident energy exceeds 40 cal/cm² — no PPE category applies. Per NFPA 70E §130.5.',
        x + pad, cy, { width: w - 2 * pad, align: 'center' });
    cy += 30;
  }
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
    .text('Arc Flash and Shock Hazard', x + pad, cy, { width: w - 2 * pad, align: 'center' });
  cy += 14;
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text('Appropriate PPE required. Follow your electrical safety program.', x + pad, cy, { width: w - 2 * pad, align: 'center' });
  cy += 18;

  // Field rows
  function row(label: string, value: string, big?: boolean) {
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), x + pad, cy);
    doc.font('Helvetica-Bold').fontSize(big ? 13 : 10).fillColor(INK)
      .text(value, x + pad, cy + 9, { width: w - 2 * pad });
    cy += big ? 30 : 26;
  }

  // [AFX-2] Updated label to use NFPA 70E 2024 §130.5(H) terminology "Arc Flash Protection Boundary (AFPB)".
  if (m.arcFlashBoundaryIn != null) row('Arc Flash Protection Boundary (AFPB)', `${m.arcFlashBoundaryIn} in`);
  if (m.showIE) {
    row('Incident energy', `${m.incidentEnergyCalCm2} cal/cm2${m.workingDistanceIn != null ? ` @ ${m.workingDistanceIn} in` : ''}`, true);
    if (m.requiredArcRatingCalCm2 != null) row('Min. arc rating of PPE', `${m.requiredArcRatingCalCm2} cal/cm2`);
  } else if (m.showPpeCat && m.ppeCategory != null) {
    row('PPE category', `${m.ppeCategory}`, true);
  }
  if (m.nominalVoltage) row('Nominal system voltage', String(m.nominalVoltage));
  // [NETA-8-8 / LEGAL-8-14] NFPA 70E §130.5(H): shock approach boundaries are
  // mandatory on the label. Values are now populated from the study or derived
  // from NFPA 70E Table 130.4 by nominal voltage. Only when the voltage is
  // outside the table's scope (or unknown) do we mark the field as needing a PE
  // entry — never a silent blank. Restricted = "avoid contact" in the 50–150 V
  // band, which the table expresses as a rule rather than a distance.
  {
    const limitedVal  = m.shockLimitedApproachIn != null
      ? `Limited ${m.shockLimitedApproachIn} in`
      : 'Limited: [confirm — voltage outside Table 130.4]';
    let restrictVal: string;
    if (m.shockRestrictedApproachIn != null) {
      restrictVal = `Restricted ${m.shockRestrictedApproachIn} in`;
    } else if (m.shockLimitedApproachSource === 'table130_4') {
      // Table 130.4 gave a limited boundary but no restricted distance -> the
      // 50–150 V "avoid contact" rule (the only in-table band without a number).
      restrictVal = 'Restricted: avoid contact (≤150 V)';
    } else {
      restrictVal = 'Restricted: [confirm — voltage outside Table 130.4]';
    }
    row('Shock approach boundary', `${limitedVal}  /  ${restrictVal}`);
    const tableDerived = m.shockLimitedApproachSource === 'table130_4' || m.shockRestrictedApproachSource === 'table130_4';
    if (tableDerived) {
      doc.font('Helvetica').fontSize(6).fillColor(MUTED)
        .text('Shock boundaries per NFPA 70E Table 130.4 — confirm against the study.', x + pad, cy);
      cy += 9;
    }
  }

  // Footer: equipment identity leads, facility name, study date, minimal brand.
  const footY = y + h - 60;
  doc.moveTo(x + pad, footY).lineTo(x + w - pad, footY).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
  let fy = footY + 6;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(m.busName, x + pad, fy, { width: w - 2 * pad });
  fy += 12;
  if (m.facilityName) { doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(m.facilityName, x + pad, fy, { width: w - 2 * pad }); fy += 11; }
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`Study date: ${m.studyDate}`, x + pad, fy);
  fy += 11;
  // INS-7: Render study expiry date; flag as EXPIRED if past.
  if (m.studyExpiresAt) {
    const expiryDate = new Date(m.studyExpiresAt);
    const isExpired = expiryDate.getTime() < Date.now();
    const expiryLabel = isExpired
      ? `Study expiry: ${expiryDate.toLocaleDateString()} ⚠ EXPIRED`
      : `Study expiry: ${expiryDate.toLocaleDateString()}`;
    doc.font(isExpired ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5)
      .fillColor(isExpired ? SAFETY_RED : MUTED)
      .text(expiryLabel, x + pad, fy, { width: w - 2 * pad });
    fy += 11;
  }
  const studyByLine = (m.firmName || m.peName)
    ? `Study by: ${[m.firmName, m.peName ? m.peName + ', PE' : null].filter(Boolean).join(' / ')}`
    : 'Study by: [PE firm name — enter in study record]';
  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(studyByLine, x + pad, fy, { width: w - 2 * pad });
  fy += 10;
  // INS-8: Disclaimer — increased to 8pt and darkened to #374151 for legibility.
  doc.font('Helvetica').fontSize(8).fillColor('#374151')
    .text(`Printed from ${m.brandName || 'ServiceCycle'} — verify against the stamped study. Per NFPA 70E 130.5(H).`, x + pad, fy, { width: w - 2 * pad });
}

module.exports = { buildLabelModel, drawArcFlashLabel, LABEL_W, LABEL_H, SAFETY_RED, SAFETY_ORANGE };

export {};

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
  const v = voltsOf(row.nominalVoltage);
  const danger = (ie != null && ie > 40) || (v != null && v > 600);
  // Method: explicit ppeMethod, else infer (IE present → incident-energy).
  let method = row.ppeMethod;
  if (method !== 'incident_energy' && method !== 'ppe_category') {
    method = ie != null ? 'incident_energy' : (row.ppeCategory != null ? 'ppe_category' : 'incident_energy');
  }
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
    shockLimitedApproachIn: num(row.shockLimitedApproachIn),
    shockRestrictedApproachIn: num(row.shockRestrictedApproachIn),
    busName: row.busName || row.asset?.name || 'Equipment',
    equipmentType: row.asset?.equipmentType || null,
    studyDate: fmtDate(row.study?.performedDate),
    facilityName: opts.facilityName || null,
    brandName: opts.brandName || null,
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
  // DANGER (IE > 40 cal/cm2 or V > 600V): NFPA 70E 130.2(B) — energized work is
  // not permitted without documented justification; the label must say so.
  if (m.danger) {
    doc.fillColor(SAFETY_RED).font('Helvetica-Bold').fontSize(8.5)
      .text('DE-ENERGIZE BEFORE WORKING — Energized work not permitted without documented justification (NFPA 70E 130.2(B))',
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

  if (m.arcFlashBoundaryIn != null) row('Arc flash boundary', `${m.arcFlashBoundaryIn} in`);
  if (m.showIE) {
    row('Incident energy', `${m.incidentEnergyCalCm2} cal/cm2${m.workingDistanceIn != null ? ` @ ${m.workingDistanceIn} in` : ''}`, true);
    if (m.requiredArcRatingCalCm2 != null) row('Min. arc rating of PPE', `${m.requiredArcRatingCalCm2} cal/cm2`);
  } else if (m.showPpeCat && m.ppeCategory != null) {
    row('PPE category', `${m.ppeCategory}`, true);
  }
  if (m.nominalVoltage) row('Nominal system voltage', String(m.nominalVoltage));
  if (m.shockLimitedApproachIn != null || m.shockRestrictedApproachIn != null) {
    const parts = [];
    if (m.shockLimitedApproachIn != null) parts.push(`Limited ${m.shockLimitedApproachIn} in`);
    if (m.shockRestrictedApproachIn != null) parts.push(`Restricted ${m.shockRestrictedApproachIn} in`);
    row('Shock approach boundary', parts.join('  /  '));
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
  doc.font('Helvetica').fontSize(6).fillColor('#94a3b8')
    .text(`Printed from ${m.brandName || 'ServiceCycle'} — verify against the stamped study. Per NFPA 70E 130.5(H).`, x + pad, fy, { width: w - 2 * pad });
}

module.exports = { buildLabelModel, drawArcFlashLabel, LABEL_W, LABEL_H, SAFETY_RED, SAFETY_ORANGE };

export {};

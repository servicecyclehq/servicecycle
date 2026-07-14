'use strict';
/**
 * W1 acceptance fixture generator (deterministic, NO AI).
 *
 * Builds a 4-page arc-flash-style study report where BUS-CHARLIE's data table
 * DELIBERATELY straddles the page 2|3 boundary: its name + first fields sit at
 * the bottom of page 2, the rest of its fields continue at the top of page 3.
 *
 * Under the OLD fixed 2-page chunk scheme ([1-2],[3-4]) CHARLIE is split across
 * two separate AI calls — half its data in each, so it is lost or mangled at the
 * seam. Under the NEW overlapping-window scheme ([1-2],[2-3],[3-4]) window [2-3]
 * contains CHARLIE whole, so the merged bus set equals a single-call baseline.
 *
 * Ground truth: exactly 5 buses — ALPHA, BRAVO, CHARLIE, DELTA, ECHO.
 *
 * Usage: node scripts/make-golden-af-pdf.js
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const OUT = path.join(__dirname, '..', '..', 'Arc Flash Samples', 'GOLDEN_af_multipage_straddle.pdf');
const GROUND_TRUTH = ['BUS-ALPHA', 'BUS-BRAVO', 'BUS-CHARLIE', 'BUS-DELTA', 'BUS-ECHO'];

function busBlock(doc, name, fields) {
  doc.font('Courier-Bold').fontSize(12).text(`BUS: ${name}`);
  doc.font('Courier').fontSize(10);
  for (const [k, v] of fields) doc.text(`   ${k}: ${v}`);
  doc.moveDown(0.5);
}

function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
  const stream = fs.createWriteStream(OUT);
  doc.pipe(stream);

  // PAGE 1 — ALPHA, BRAVO
  doc.font('Helvetica-Bold').fontSize(14).text('=== PAGE 1 OF 4 — ARC FLASH STUDY (GOLDEN FIXTURE) ===');
  doc.moveDown();
  busBlock(doc, 'BUS-ALPHA', [['Equipment', 'SWITCHGEAR'], ['Nominal Voltage', '480V'], ['Bolted Fault kA', '25'], ['Incident Energy cal/cm2', '8.1']]);
  busBlock(doc, 'BUS-BRAVO', [['Equipment', 'MCC'], ['Nominal Voltage', '480V'], ['Bolted Fault kA', '18'], ['Incident Energy cal/cm2', '5.4']]);

  // PAGE 2 — BUS-CHARLIE begins near the bottom (name + first 3 fields)
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(14).text('=== PAGE 2 OF 4 ===');
  doc.y = 560; // push the start of CHARLIE toward the bottom of the page
  doc.font('Courier-Bold').fontSize(12).text('BUS: BUS-CHARLIE');
  doc.font('Courier').fontSize(10);
  doc.text('   Equipment: SWITCHBOARD');
  doc.text('   Nominal Voltage: 208V');
  doc.text('   Bolted Fault kA: 31');

  // PAGE 3 — BUS-CHARLIE continuation (rest of its fields), then DELTA
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(14).text('=== PAGE 3 OF 4 ===');
  doc.moveDown();
  // Continuation of BUS-CHARLIE's SAME table — no repeated header — so CHARLIE is
  // a genuine single-table straddle across the 2|3 seam: its identity/header is
  // only on page 2, its remaining fields continue here on page 3.
  doc.font('Courier').fontSize(10);
  doc.text('   Arcing Current kA: 19');
  doc.text('   Clearing Time ms: 120');
  doc.text('   Working Distance in: 18');
  doc.text('   Incident Energy cal/cm2: 12.7');
  doc.text('   Arc Flash Boundary in: 44');
  doc.moveDown(0.5);
  busBlock(doc, 'BUS-DELTA', [['Equipment', 'PANELBOARD'], ['Nominal Voltage', '208V'], ['Bolted Fault kA', '12'], ['Incident Energy cal/cm2', '3.2']]);

  // PAGE 4 — ECHO
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(14).text('=== PAGE 4 OF 4 ===');
  doc.moveDown();
  busBlock(doc, 'BUS-ECHO', [['Equipment', 'TRANSFORMER_DRY'], ['Nominal Voltage', '480V'], ['Bolted Fault kA', '22'], ['Incident Energy cal/cm2', '9.9']]);

  doc.end();
  stream.on('finish', () => {
    console.log('WROTE ' + OUT);
    console.log('GROUND_TRUTH ' + JSON.stringify(GROUND_TRUTH));
  });
}

main();

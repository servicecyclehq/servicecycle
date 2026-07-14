'use strict';
export {}; // module-scope marker so tsc doesn't treat this script as global
/**
 * W1 LIVE acceptance eval — MAKES REAL AI CALLS (~4: one baseline + three chunk
 * windows). Run ONLY with Dustin present and explicitly greenlighting it.
 *
 * Compares a single-call native-PDF baseline against forced overlapping-window
 * chunked extraction on the golden straddle fixture (BUS-CHARLIE spans the 2|3
 * seam). PASS = chunking actually triggered, the chunked bus SET equals the
 * baseline bus set (no bus lost or duplicated at the boundary), and CHARLIE
 * appears exactly once — matching the W1 acceptance criterion.
 *
 * Usage: AI_PROVIDER=gemini npx tsx scripts/w1-native-eval.ts
 */
try { require('dotenv').config(); } catch { /* dotenv optional */ }
const fs = require('fs');
const path = require('path');
const { extractArcFlashDocument } = require('../lib/arcFlashExtract');

const GOLDEN = path.join(__dirname, '..', '..', 'Arc Flash Samples', 'GOLDEN_af_multipage_straddle.pdf');
const GROUND_TRUTH = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO'];

function busKey(name: string): string {
  return String(name || '').toUpperCase()
    .replace(/^BUS[-_\s]*/, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}
function busSet(res: any): string[] {
  const s = new Set<string>();
  for (const b of (res.buses || [])) { const k = busKey(b.busName); if (k) s.add(k); }
  return [...s].sort();
}

(async () => {
  const buffer = fs.readFileSync(GOLDEN);
  console.log('provider =', (process.env.AI_PROVIDER || 'anthropic'),
    '| gemini key present =', !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    '| anthropic key present =', !!process.env.ANTHROPIC_API_KEY);

  console.log('\n[1/2] BASELINE — single native-PDF call over the whole 4-page report ...');
  const baseline = await extractArcFlashDocument({ buffer, fileName: 'golden.pdf', mimeType: 'application/pdf', nativePdf: { maxPagesPerCall: 999 } });
  const bSet = busSet(baseline);
  console.log('  method =', baseline.method, '| buses =', JSON.stringify(bSet));
  if (baseline.warnings && baseline.warnings.length) console.log('  warnings =', JSON.stringify(baseline.warnings));

  console.log('\n[2/2] CHUNKED — forced overlapping windows (size 2, overlap 1) => [[1,2],[2,3],[3,4]] ...');
  const chunked = await extractArcFlashDocument({ buffer, fileName: 'golden.pdf', mimeType: 'application/pdf', nativePdf: { maxPagesPerCall: 2, overlapPages: 1 } });
  const cSet = busSet(chunked);
  console.log('  method =', chunked.method, '| buses =', JSON.stringify(cSet));
  if (chunked.warnings && chunked.warnings.length) console.log('  warnings =', JSON.stringify(chunked.warnings));

  const eq = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  const gt = [...GROUND_TRUTH].sort();
  let ok = true;
  const log: string[] = [];

  if (chunked.method !== 'native_pdf_chunked') { ok = false; log.push(`FAIL chunked method=${chunked.method} (expected native_pdf_chunked — chunking did not trigger)`); }
  else log.push('ok   chunking path actually triggered (native_pdf_chunked)');
  if (!eq(bSet, gt)) log.push(`note baseline bus set ${JSON.stringify(bSet)} != ground truth ${JSON.stringify(gt)} — model read, your call`);
  else log.push('ok   baseline bus set == ground truth (5 buses)');
  if (!eq(bSet, cSet)) { ok = false; log.push(`FAIL chunked bus set != baseline\n     baseline=${JSON.stringify(bSet)}\n     chunked =${JSON.stringify(cSet)}`); }
  else log.push('ok   chunked bus set == baseline bus set (no bus lost/duplicated at boundary)');
  const cCharlie = (chunked.buses || []).filter((b: any) => busKey(b.busName) === 'CHARLIE');
  if (cCharlie.length !== 1) { ok = false; log.push(`FAIL CHARLIE appears ${cCharlie.length}x in chunked (expected exactly 1)`); }
  else log.push('ok   CHARLIE (the straddling bus) appears exactly once in chunked');
  const cE = cCharlie[0] && cCharlie[0].incidentEnergyCalCm2;
  log.push(`info CHARLIE incidentEnergy (chunked) = ${cE}  (page-3 field; 12.7 => the straddle was captured whole)`);

  console.log('\n' + log.join('\n'));
  console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('EVAL ERROR:', e && e.message ? e.message : e); process.exit(2); });

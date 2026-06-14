/**
 * run_eval_node.js -- end-to-end eval against the REAL Node ingest pipeline
 * (lib/testReportPreview.buildTestReportPreview): deterministic parser + OCR
 * (Tesseract) + Gemini/Groq text gap-fill + the vision fallback. This is the
 * harness that measures what actually runs in production.
 *
 * Run INSIDE the server container (it has Tesseract + AI keys + DB):
 *   docker exec servicecycle-server \
 *     node node_modules/tsx/dist/cli.mjs pyextract/eval/run_eval_node.js \
 *     <corpus_dir> <accountId> [userId]
 *
 * Clean tiers are fed as PDFs (text layer); scan/photo tiers are fed as IMAGES
 * so the photo-of-paper -> OCR/vision path fires. Reports per-tier accuracy
 * plus how often the text/vision AI fallbacks contributed.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const normTxt = (s) => (s == null ? '' : String(s).normalize('NFKC').trim().toLowerCase());
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function scoreOne(gt, res) {
  const gf = gt.fields || {}, ef = res.meta || {};
  let fieldTotal = Object.keys(gf).length, fieldOk = 0;
  for (const [k, v] of Object.entries(gf)) if (ef[k] != null && normTxt(ef[k]) === normTxt(v)) fieldOk++;
  const gm = gt.measurements || [], em = (res.measurements || []).slice();
  let located = 0, phaseOk = 0, unitOk = 0, pfOk = 0;
  for (const g of gm) {
    const gv = num(g.asFoundValue);
    let mi = -1;
    for (let i = 0; i < em.length; i++) {
      if (em[i].measurementType !== g.measurementType) continue;
      const ev = num(em[i].asFoundValue);
      if (gv != null && ev != null && Math.abs(gv - ev) <= Math.max(0.5, Math.abs(gv) * 0.01)) { mi = i; break; }
    }
    if (mi < 0) continue;
    const e = em.splice(mi, 1)[0]; located++;
    if (normTxt(e.phase) === normTxt(g.phase)) phaseOk++;
    if (normTxt(e.asFoundUnit) === normTxt(g.asFoundUnit)) unitOk++;
    if ((e.passFail || '') === (g.passFail || '')) pfOk++;
  }
  return { fieldTotal, fieldOk, measTotal: gm.length, located, phaseOk, unitOk, pfOk };
}

async function main() {
  const [corpus, accountId, userId] = process.argv.slice(2);
  if (!corpus || !accountId) { console.error('usage: run_eval_node.js <corpus> <accountId> [userId]'); process.exit(2); }
  const { buildTestReportPreview } = require('../testReportPreview');
  const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
  const agg = {};
  for (const e of manifest) {
    const input = (e.tier === 'clean') ? e.pdf : (e.img || e.pdf);
    const originalName = path.basename(input);
    const mimetype = input.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
    let res;
    try {
      res = await buildTestReportPreview(fs.readFileSync(input), { accountId, userId: userId || accountId, originalName, mimetype });
    } catch (err) {
      res = { meta: {}, measurements: [], source: 'ERROR:' + ((err && err.message) || err) };
    }
    const gt = JSON.parse(fs.readFileSync(e.gt, 'utf8'));
    const s = scoreOne(gt, res);
    const t = e.tier;
    const a = agg[t] = agg[t] || { n: 0, fieldTotal: 0, fieldOk: 0, measTotal: 0, located: 0, phaseOk: 0, unitOk: 0, pfOk: 0, ai: 0, vision: 0 };
    a.n++;
    for (const k of ['fieldTotal', 'fieldOk', 'measTotal', 'located', 'phaseOk', 'unitOk', 'pfOk']) a[k] += s[k];
    if (res.aiUsed) a.ai++;
    if (res.visionUsed) a.vision++;
  }
  const pc = (x, d) => (100 * x / (d || 1)).toFixed(1) + '%';
  console.log('');
  console.log('tier    docs  field_acc  reading_found  phase_acc  unit_acc  passfail  ai/vision');
  console.log('-'.repeat(84));
  for (const t of ['clean', 'scan', 'photo']) {
    const a = agg[t]; if (!a) continue;
    console.log(`${t.padEnd(6)}  ${String(a.n).padStart(4)}  ${pc(a.fieldOk, a.fieldTotal).padStart(8)}  ${pc(a.located, a.measTotal).padStart(12)}  ${pc(a.phaseOk, a.located).padStart(8)}  ${pc(a.unitOk, a.located).padStart(7)}  ${pc(a.pfOk, a.located).padStart(7)}  ${a.ai}/${a.vision}`);
  }
  console.log('');
  console.log('ai/vision = docs where the text gap-fill / vision fallback contributed.');
  process.exit(0);
}
main();
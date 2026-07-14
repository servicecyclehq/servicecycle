'use strict';
export {}; // module-scope marker so tsc doesn't treat this script as global
/**
 * W1 boundary mechanics check (deterministic, NO AI tokens).
 *
 * Proves the SHIPPED planOverlapWindows + splitPdfByRanges keep a bus table that
 * straddles a page seam whole inside ONE window under the NEW overlap scheme,
 * and demonstrates that the OLD fixed-page scheme splits it across two windows.
 * This is the offline half of the W1 acceptance criterion — it validates the
 * cut/split/merge mechanics without spending AI calls. The live
 * baseline-vs-chunked Gemini comparison (w1-native-eval) is the other half.
 *
 * Usage: PYEXTRACT_PYTHON=python npx tsx scripts/w1-boundary-check.ts
 * Exit 0 = PASS, 1 = FAIL.
 */
const fs = require('fs');
const path = require('path');
const { planOverlapWindows } = require('../lib/arcFlashExtract');
const { splitPdfByRanges } = require('../lib/pdfSplit');
const { extractPdfPlumber } = require('../lib/pdfText');

const GOLDEN = path.join(__dirname, '..', '..', 'Arc Flash Samples', 'GOLDEN_af_multipage_straddle.pdf');

function nospace(s: string): string { return String(s || '').replace(/\s+/g, ''); }
function hasStart(t: string): boolean { return nospace(t).includes('kA:31'); }              // CHARLIE bolted fault, page 2
function hasCont(t: string): boolean { return nospace(t).includes('ArcingCurrentkA:19'); }  // CHARLIE continuation, page 3

async function windowFlags(buf: Buffer, ranges: Array<[number, number]>) {
  const subs = await splitPdfByRanges(buf, ranges);
  const flags: Array<{ range: [number, number]; start: boolean; cont: boolean }> = [];
  for (let i = 0; i < subs.length; i++) {
    const det = await extractPdfPlumber(subs[i]);
    const t = det && det.ok ? det.text : '';
    flags.push({ range: ranges[i], start: hasStart(t), cont: hasCont(t) });
  }
  return flags;
}

(async () => {
  const buf = fs.readFileSync(GOLDEN);
  let ok = true;
  const log: string[] = [];
  const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

  const oldWin = planOverlapWindows(4, 2, 0);
  const newWin = planOverlapWindows(4, 2, 1);
  if (!eq(oldWin, [[1, 2], [3, 4]])) { ok = false; log.push(`FAIL old windows = ${JSON.stringify(oldWin)} (expected [[1,2],[3,4]])`); }
  else log.push(`ok   OLD windows (overlap 0) = ${JSON.stringify(oldWin)}`);
  if (!eq(newWin, [[1, 2], [2, 3], [3, 4]])) { ok = false; log.push(`FAIL new windows = ${JSON.stringify(newWin)} (expected [[1,2],[2,3],[3,4]])`); }
  else log.push(`ok   NEW windows (overlap 1) = ${JSON.stringify(newWin)}`);

  const oldFlags = await windowFlags(buf, oldWin);
  const newFlags = await windowFlags(buf, newWin);

  const oldWhole = oldFlags.some((f) => f.start && f.cont);
  const oldSplit = oldFlags.some((f) => f.start && !f.cont) && oldFlags.some((f) => f.cont && !f.start);
  const newWhole = newFlags.some((f) => f.start && f.cont);

  log.push('OLD window flags: ' + JSON.stringify(oldFlags));
  log.push('NEW window flags: ' + JSON.stringify(newFlags));

  if (oldWhole) { ok = false; log.push('FAIL expected OLD scheme to SPLIT CHARLIE, but a window held it whole'); }
  else log.push('ok   OLD scheme splits CHARLIE across windows (no single window holds it whole)');
  if (oldSplit) log.push('ok   OLD split cleanly demonstrated (start + continuation land in distinct windows)');
  else log.push('note OLD split not cleanly separated (start/cont not in fully distinct windows) — still no whole window, claim holds');
  if (!newWhole) { ok = false; log.push('FAIL expected NEW overlap scheme to hold CHARLIE whole in one window, it did not'); }
  else log.push('ok   NEW overlap scheme holds CHARLIE whole in one window');

  console.log(log.join('\n'));
  console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  process.exit(ok ? 0 : 1);
})();

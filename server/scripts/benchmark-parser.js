#!/usr/bin/env node
/**
 * server/scripts/benchmark-parser.js
 *
 * Benchmark harness for parseTestReport() against the synthetic NETA corpus.
 *
 * Usage:
 *   node server/scripts/benchmark-parser.js [path/to/corpus.json]
 *
 * Default corpus path: server/scripts/neta_synthetic_test_reports.json
 *
 * What it measures:
 *   - Per-report: which measurements were extracted vs missed vs wrong
 *   - Per-measurementType: precision, recall, F1
 *   - Per-textQuality tier (clean / partial_ocr / garbled_ocr): accuracy breakdown
 *   - Value accuracy: extracted value within ±1% of ground-truth value
 *   - passFail accuracy: extracted verdict matches ground truth (GREEN/YELLOW/RED)
 *
 * Output: console table + JSON summary written to server/scripts/benchmark-results.json
 */

'use strict';

const path  = require('path');
const fs    = require('fs');

// Load parseTestReport from the compiled source.
// Adjust the require path if your build output differs.
const { parseTestReport } = require('../lib/testReportParse');

const corpusPath  = process.argv[2]
  ?? path.join(__dirname, 'neta_synthetic_test_reports.json');

if (!fs.existsSync(corpusPath)) {
  console.error(`Corpus not found: ${corpusPath}`);
  process.exit(1);
}

const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));

// ─── Matching logic ──────────────────────────────────────────────────────────
// A parsed measurement "matches" a ground-truth row when:
//   1. measurementType matches exactly, AND
//   2. asFoundValue is within ±1% (or both are null), AND
//   3. phase matches (or both are null)

function valueClose(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (b === 0) return Math.abs(a) < 0.01;
  return Math.abs((a - b) / b) <= 0.01;
}

function measurementMatches(parsed, truth) {
  if (parsed.measurementType !== truth.measurementType) return false;
  if (!valueClose(parsed.asFoundValue, truth.asFoundValue)) return false;
  const p = parsed.phase ?? null;
  const t = truth.phase ?? null;
  return p === t;
}

// ─── Per-report scoring ───────────────────────────────────────────────────────

const byType   = {};  // { type: { tp, fp, fn, verdictCorrect, verdictTotal } }
const byQuality = {}; // { quality: { matched, total } }
const reports  = [];

for (const record of corpus) {
  const { id, textQuality, extractedText, groundTruth } = record;
  const quality = textQuality || 'unknown';

  // Run the parser
  let parsed;
  try {
    parsed = parseTestReport(extractedText || '');
  } catch (err) {
    console.warn(`[${id}] parseTestReport threw: ${err.message}`);
    parsed = { measurements: [] };
  }

  const parsedMs  = parsed.measurements || [];
  const truthMs   = groundTruth?.measurements || [];

  // Match parsed → truth (greedy, each truth row consumed at most once)
  const consumed = new Set();
  const tp_rows  = []; // { parsed, truth }
  const fp_rows  = []; // parsed with no truth match
  const fn_rows  = []; // truth with no parsed match

  for (const pm of parsedMs) {
    let found = -1;
    for (let i = 0; i < truthMs.length; i++) {
      if (!consumed.has(i) && measurementMatches(pm, truthMs[i])) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      consumed.add(found);
      tp_rows.push({ parsed: pm, truth: truthMs[found] });
    } else {
      fp_rows.push(pm);
    }
  }
  for (let i = 0; i < truthMs.length; i++) {
    if (!consumed.has(i)) fn_rows.push(truthMs[i]);
  }

  // Verdict accuracy on matched rows
  let verdictCorrect = 0;
  for (const { parsed: pm, truth: tm } of tp_rows) {
    if (pm.passFail === tm.passFail) verdictCorrect++;
  }

  // Accumulate per-type stats
  for (const { parsed: pm } of tp_rows) {
    const t = pm.measurementType;
    if (!byType[t]) byType[t] = { tp: 0, fp: 0, fn: 0, verdictCorrect: 0, verdictTotal: 0 };
    byType[t].tp++;
  }
  for (const pm of fp_rows) {
    const t = pm.measurementType;
    if (!byType[t]) byType[t] = { tp: 0, fp: 0, fn: 0, verdictCorrect: 0, verdictTotal: 0 };
    byType[t].fp++;
  }
  for (const tm of fn_rows) {
    const t = tm.measurementType;
    if (!byType[t]) byType[t] = { tp: 0, fp: 0, fn: 0, verdictCorrect: 0, verdictTotal: 0 };
    byType[t].fn++;
  }
  for (const { parsed: pm, truth: tm } of tp_rows) {
    const t = pm.measurementType;
    byType[t].verdictTotal++;
    if (pm.passFail === tm.passFail) byType[t].verdictCorrect++;
  }

  // Accumulate per-quality stats
  if (!byQuality[quality]) byQuality[quality] = { matched: 0, total: 0 };
  byQuality[quality].matched += tp_rows.length;
  byQuality[quality].total   += truthMs.length;

  // Meta accuracy
  const parsedMeta = parsed.meta || {};
  const truthMeta  = groundTruth || {};
  const metaResults = {
    serialNumber: parsedMeta.serialNumber === truthMeta.serialNumber,
    manufacturer: (parsedMeta.manufacturer || '').toLowerCase() === (truthMeta.manufacturer || '').toLowerCase(),
    model:        parsedMeta.model === truthMeta.model,
    testDate:     (parsedMeta.testDate || '').replace(/-/g, '') === (truthMeta.testDate || '').replace(/-/g, ''),
  };

  reports.push({
    id, quality,
    tp: tp_rows.length,
    fp: fp_rows.length,
    fn: fn_rows.length,
    verdictCorrect,
    verdictTotal: tp_rows.length,
    metaResults,
    falsePositives:  fp_rows.map(m => `${m.measurementType}=${m.asFoundValue}`),
    falseNegatives:  fn_rows.map(m => `${m.measurementType}=${m.asFoundValue}`),
  });
}

// ─── Print results ────────────────────────────────────────────────────────────

const totalTp = reports.reduce((s, r) => s + r.tp, 0);
const totalFp = reports.reduce((s, r) => s + r.fp, 0);
const totalFn = reports.reduce((s, r) => s + r.fn, 0);
const totalVerdictCorrect = reports.reduce((s, r) => s + r.verdictCorrect, 0);
const totalVerdictTotal   = reports.reduce((s, r) => s + r.verdictTotal, 0);

function pct(n, d) { return d === 0 ? 'N/A' : `${((n / d) * 100).toFixed(1)}%`; }
function f1(tp, fp, fn) {
  const p = tp / (tp + fp || 1);
  const r = tp / (tp + fn || 1);
  return (p + r) === 0 ? 0 : (2 * p * r) / (p + r);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(' PARSER BENCHMARK — neta_synthetic_test_reports.json');
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`Reports: ${corpus.length}  |  Measurements in corpus: ${totalTp + totalFn}`);
console.log(`\nOverall extraction:  precision=${pct(totalTp, totalTp + totalFp)}  recall=${pct(totalTp, totalTp + totalFn)}  F1=${(f1(totalTp, totalFp, totalFn) * 100).toFixed(1)}%`);
console.log(`Verdict accuracy:    ${pct(totalVerdictCorrect, totalVerdictTotal)}  (${totalVerdictCorrect}/${totalVerdictTotal} matched rows where extracted verdict == ground-truth verdict)`);

// Per-type table
console.log('\n── Per measurement type ─────────────────────────────────────');
const typeRows = Object.entries(byType).sort((a, b) => (b[1].tp + b[1].fn) - (a[1].tp + a[1].fn));
const colW = [32, 6, 6, 6, 10, 10, 8, 12];
const header = ['Type', 'TP', 'FP', 'FN', 'Precision', 'Recall', 'F1', 'VerdictAcc'];
console.log(header.map((h, i) => h.padEnd(colW[i])).join(''));
console.log('-'.repeat(colW.reduce((a, b) => a + b, 0)));
for (const [type, s] of typeRows) {
  const row = [
    type.substring(0, 30),
    String(s.tp),
    String(s.fp),
    String(s.fn),
    pct(s.tp, s.tp + s.fp),
    pct(s.tp, s.tp + s.fn),
    `${(f1(s.tp, s.fp, s.fn) * 100).toFixed(0)}%`,
    s.verdictTotal ? pct(s.verdictCorrect, s.verdictTotal) : 'N/A',
  ];
  console.log(row.map((v, i) => String(v).padEnd(colW[i])).join(''));
}

// Per-quality tier
console.log('\n── By text quality tier ─────────────────────────────────────');
for (const [q, s] of Object.entries(byQuality)) {
  console.log(`  ${q.padEnd(16)} recall=${pct(s.matched, s.total)}  (${s.matched}/${s.total})`);
}

// Meta accuracy
const metaKeys = ['serialNumber', 'manufacturer', 'model', 'testDate'];
const metaTotals = {};
for (const k of metaKeys) metaTotals[k] = { correct: 0, total: 0 };
for (const r of reports) {
  for (const k of metaKeys) {
    metaTotals[k].total++;
    if (r.metaResults[k]) metaTotals[k].correct++;
  }
}
console.log('\n── Metadata extraction accuracy ─────────────────────────────');
for (const k of metaKeys) {
  const s = metaTotals[k];
  console.log(`  ${k.padEnd(16)} ${pct(s.correct, s.total)}  (${s.correct}/${s.total})`);
}

// Per-report detail for failures
const failures = reports.filter(r => r.fp > 0 || r.fn > 0);
if (failures.length > 0) {
  console.log('\n── Per-report failures ──────────────────────────────────────');
  for (const r of failures) {
    console.log(`  [${r.id}] quality=${r.quality}  TP=${r.tp} FP=${r.fp} FN=${r.fn}`);
    if (r.falsePositives.length) console.log(`    FP (hallucinated): ${r.falsePositives.join(', ')}`);
    if (r.falseNegatives.length) console.log(`    FN (missed): ${r.falseNegatives.join(', ')}`);
  }
}

console.log('\n═══════════════════════════════════════════════════════════\n');

// Write JSON summary
const summary = {
  runAt: new Date().toISOString(),
  corpusSize: corpus.length,
  overall: {
    tp: totalTp, fp: totalFp, fn: totalFn,
    precision: totalTp / (totalTp + totalFp || 1),
    recall:    totalTp / (totalTp + totalFn || 1),
    f1:        f1(totalTp, totalFp, totalFn),
    verdictAccuracy: totalVerdictTotal ? totalVerdictCorrect / totalVerdictTotal : null,
  },
  byType:    Object.fromEntries(typeRows.map(([t, s]) => [t, { ...s, precision: s.tp / (s.tp + s.fp || 1), recall: s.tp / (s.tp + s.fn || 1), f1: f1(s.tp, s.fp, s.fn) }])),
  byQuality: Object.fromEntries(Object.entries(byQuality).map(([q, s]) => [q, { ...s, recall: s.matched / (s.total || 1) }])),
  byMeta:    metaTotals,
  reports,
};
const outPath = path.join(__dirname, 'benchmark-results.json');
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`Results written to: ${outPath}\n`);

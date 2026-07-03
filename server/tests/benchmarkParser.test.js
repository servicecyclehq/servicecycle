/**
 * server/tests/benchmarkParser.test.js
 *
 * Benchmark harness for parseTestReport() against the synthetic NETA corpus.
 *
 * Run: node node_modules/jest/bin/jest.js --testPathPattern=benchmarkParser --verbose
 *
 * Corpus: server/scripts/neta_synthetic_test_reports.json
 * (copy the file there, or pass CORPUS_PATH env var to override)
 *
 * The test suite always passes as long as recall ≥ 60% (a deliberately low
 * floor so this runs in CI without blocking). The real value is the printed
 * table and the JSON file written to server/scripts/benchmark-results.json.
 *
 * Metrics:
 *   - Extraction recall/precision/F1 per measurementType
 *   - Extraction recall by textQuality tier (clean / partial_ocr / garbled_ocr)
 *   - Verdict accuracy (extracted passFail == ground-truth passFail)
 *   - Metadata extraction accuracy (serialNumber, manufacturer, model, testDate)
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const { parseTestReport } = require('../lib/testReportParse');

const CORPUS_PATH = process.env.CORPUS_PATH
  ?? path.join(__dirname, '../scripts/neta_synthetic_test_reports.json');

// 2026-07-03 baseline after fix cycle 1: 21.6%
// Fixed: @ N VDC/KV test-condition strip, N MIN table header strip, MM/DD/YYYY dates, trip time labels.
// Remaining wall: multi-row table extraction (1 row extracted per label, PowerDB has 3+ phases).
// Raise this floor after each parser improvement cycle.
const MIN_OVERALL_RECALL = 0.20;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function valueClose(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (b === 0) return Math.abs(a) < 0.01;
  return Math.abs((a - b) / b) <= 0.01;
}

function measurementMatches(parsed, truth) {
  if (parsed.measurementType !== truth.measurementType) return false;
  if (!valueClose(parsed.asFoundValue, truth.asFoundValue)) return false;
  return (parsed.phase ?? null) === (truth.phase ?? null);
}

function pct(n, d) {
  return d === 0 ? 'N/A' : `${((n / d) * 100).toFixed(1)}%`;
}

function f1(tp, fp, fn) {
  const p = tp / (tp + fp || 1);
  const r = tp / (tp + fn || 1);
  return (p + r) === 0 ? 0 : (2 * p * r) / (p + r);
}

// ─── Load corpus ──────────────────────────────────────────────────────────────

let corpus = [];
beforeAll(() => {
  if (!fs.existsSync(CORPUS_PATH)) {
    console.warn(`\n[benchmark] Corpus not found at ${CORPUS_PATH} — skipping.\n`);
    return;
  }
  corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
  console.log(`\n[benchmark] Loaded ${corpus.length} records from ${path.basename(CORPUS_PATH)}\n`);
});

// ─── Main benchmark ───────────────────────────────────────────────────────────

describe('parseTestReport — corpus benchmark', () => {
  test('extraction recall meets minimum threshold and prints full report', () => {
    if (!corpus.length) {
      console.warn('[benchmark] No corpus — test skipped.');
      return;
    }

    const byType    = {};
    const byQuality = {};
    const reports   = [];

    for (const record of corpus) {
      const { id, textQuality, extractedText, groundTruth } = record;
      const quality = textQuality || 'unknown';

      let parsed;
      try {
        parsed = parseTestReport(extractedText || '');
      } catch (err) {
        console.warn(`[${id}] parseTestReport threw: ${err.message}`);
        parsed = { measurements: [], meta: {} };
      }

      const parsedMs = parsed.measurements || [];
      const truthMs  = groundTruth?.measurements || [];

      // Greedy match
      const consumed = new Set();
      const tp_rows  = [];
      const fp_rows  = [];

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
      const fn_rows = truthMs.filter((_, i) => !consumed.has(i));

      let verdictCorrect = 0;
      for (const { parsed: pm, truth: tm } of tp_rows) {
        if (pm.passFail === tm.passFail) verdictCorrect++;
      }

      // Accumulate
      for (const { parsed: pm, truth: _tm } of tp_rows) {
        const t = pm.measurementType;
        if (!byType[t]) byType[t] = { tp: 0, fp: 0, fn: 0, vc: 0, vt: 0 };
        byType[t].tp++; byType[t].vt++;
      }
      for (const pm of fp_rows) {
        const t = pm.measurementType;
        if (!byType[t]) byType[t] = { tp: 0, fp: 0, fn: 0, vc: 0, vt: 0 };
        byType[t].fp++;
      }
      for (const tm of fn_rows) {
        const t = tm.measurementType;
        if (!byType[t]) byType[t] = { tp: 0, fp: 0, fn: 0, vc: 0, vt: 0 };
        byType[t].fn++;
      }
      for (const { parsed: pm, truth: tm } of tp_rows) {
        if (pm.passFail === tm.passFail) byType[pm.measurementType].vc++;
      }

      if (!byQuality[quality]) byQuality[quality] = { matched: 0, total: 0 };
      byQuality[quality].matched += tp_rows.length;
      byQuality[quality].total   += truthMs.length;

      // Meta
      const pm = parsed.meta || {};
      const tm = groundTruth || {};
      reports.push({
        id, quality,
        tp: tp_rows.length, fp: fp_rows.length, fn: fn_rows.length,
        verdictCorrect, verdictTotal: tp_rows.length,
        meta: {
          serialNumber: pm.serialNumber === tm.serialNumber,
          manufacturer: (pm.manufacturer || '').toLowerCase() === (tm.manufacturer || '').toLowerCase(),
          model:        pm.model === tm.model,
          testDate:     (pm.testDate || '') === (tm.testDate || ''),
        },
        fp_list: fp_rows.map(m => `${m.measurementType}=${m.asFoundValue}`),
        fn_list: fn_rows.map(m => `${m.measurementType}=${m.asFoundValue}`),
      });
    }

    // Totals
    const totalTp = reports.reduce((s, r) => s + r.tp, 0);
    const totalFp = reports.reduce((s, r) => s + r.fp, 0);
    const totalFn = reports.reduce((s, r) => s + r.fn, 0);
    const totalVc = reports.reduce((s, r) => s + r.verdictCorrect, 0);
    const totalVt = reports.reduce((s, r) => s + r.verdictTotal, 0);
    const overallRecall    = totalTp / (totalTp + totalFn || 1);
    const overallPrecision = totalTp / (totalTp + totalFp || 1);

    // Print banner
    const line = '═'.repeat(62);
    console.log(`\n${line}`);
    console.log(' PARSER BENCHMARK — neta_synthetic_test_reports.json');
    console.log(line);
    console.log(`\n  Reports: ${corpus.length}   Corpus measurements: ${totalTp + totalFn}`);
    console.log(`\n  Overall extraction:`);
    console.log(`    Precision  ${pct(totalTp, totalTp + totalFp)}   (${totalTp} TP / ${totalFp} FP)`);
    console.log(`    Recall     ${pct(totalTp, totalTp + totalFn)}   (${totalTp} TP / ${totalFn} FN)`);
    console.log(`    F1         ${(f1(totalTp, totalFp, totalFn) * 100).toFixed(1)}%`);
    console.log(`\n  Verdict accuracy: ${pct(totalVc, totalVt)}  (${totalVc}/${totalVt})`);

    // Per-type table
    console.log('\n  ── Per measurement type ─────────────────────────────────');
    const typeRows = Object.entries(byType).sort((a, b) => (b[1].tp + b[1].fn) - (a[1].tp + a[1].fn));
    const fmt = (v, w) => String(v).padEnd(w);
    console.log('  ' + fmt('Type', 30) + fmt('TP', 5) + fmt('FP', 5) + fmt('FN', 5) + fmt('Recall', 9) + fmt('Prec', 9) + 'VerdAcc');
    console.log('  ' + '-'.repeat(72));
    for (const [t, s] of typeRows) {
      console.log('  ' +
        fmt(t.substring(0, 28), 30) +
        fmt(s.tp, 5) + fmt(s.fp, 5) + fmt(s.fn, 5) +
        fmt(pct(s.tp, s.tp + s.fn), 9) +
        fmt(pct(s.tp, s.tp + s.fp), 9) +
        (s.vt ? pct(s.vc, s.vt) : 'N/A'));
    }

    // Per-quality
    console.log('\n  ── By text quality tier ─────────────────────────────────');
    for (const [q, s] of Object.entries(byQuality)) {
      console.log(`    ${q.padEnd(16)} recall=${pct(s.matched, s.total)}  (${s.matched}/${s.total})`);
    }

    // Meta accuracy
    const metaKeys = ['serialNumber', 'manufacturer', 'model', 'testDate'];
    const metaTot = {};
    for (const k of metaKeys) metaTot[k] = { c: 0, t: 0 };
    for (const r of reports) for (const k of metaKeys) { metaTot[k].t++; if (r.meta[k]) metaTot[k].c++; }
    console.log('\n  ── Metadata extraction accuracy ─────────────────────────');
    for (const k of metaKeys) console.log(`    ${k.padEnd(16)} ${pct(metaTot[k].c, metaTot[k].t)}  (${metaTot[k].c}/${metaTot[k].t})`);

    // Failures
    const failures = reports.filter(r => r.fp > 0 || r.fn > 0);
    if (failures.length) {
      console.log('\n  ── Per-report failures ──────────────────────────────────');
      for (const r of failures) {
        console.log(`    [${r.id}] quality=${r.quality}  TP=${r.tp} FP=${r.fp} FN=${r.fn}`);
        if (r.fp_list.length) console.log(`      FP (hallucinated): ${r.fp_list.join(', ')}`);
        if (r.fn_list.length) console.log(`      FN (missed):       ${r.fn_list.join(', ')}`);
      }
    }

    console.log(`\n${line}\n`);

    // Write JSON results
    const outPath = path.join(__dirname, '../scripts/benchmark-results.json');
    const summary = {
      runAt: new Date().toISOString(),
      corpusSize: corpus.length,
      overall: { tp: totalTp, fp: totalFp, fn: totalFn, precision: overallPrecision, recall: overallRecall, f1: f1(totalTp, totalFp, totalFn), verdictAccuracy: totalVt ? totalVc / totalVt : null },
      byType: Object.fromEntries(typeRows.map(([t, s]) => [t, { ...s, precision: s.tp / (s.tp + s.fp || 1), recall: s.tp / (s.tp + s.fn || 1), f1: f1(s.tp, s.fp, s.fn) }])),
      byQuality: Object.fromEntries(Object.entries(byQuality).map(([q, s]) => [q, { ...s, recall: s.matched / (s.total || 1) }])),
      byMeta: Object.fromEntries(metaKeys.map(k => [k, { correct: metaTot[k].c, total: metaTot[k].t }])),
      reports,
    };
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`  Results JSON → ${outPath}\n`);

    // CI assertion
    expect(overallRecall).toBeGreaterThanOrEqual(MIN_OVERALL_RECALL);
  });
});

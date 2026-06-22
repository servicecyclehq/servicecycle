/**
 * scripts/af-simulate.ts — feed a model-output JSON through the REAL ServiceCycle
 * deterministic layer (normalizeExtraction + the IEEE 1584 gap engine), without
 * calling any AI provider. Use it to (a) validate the gap engine against a known
 * extraction, or (b) simulate the pipeline with a hand/agent-produced model
 * response when the BYO-AI providers are rate-limited.
 *
 * The JSON must match the extractor's contract: { system: {...}, buses: [...] }.
 * Run: npx tsx scripts/af-simulate.ts <model-output.json>
 */
'use strict';

const fs = require('fs');
const { normalizeExtraction } = require('../lib/arcFlashExtract');
const { analyzeBusGaps, analyzeSystemGaps, summarizeIngestBands } = require('../lib/arcFlashGap');

const file = process.argv[2];
if (!file) { console.error('usage: npx tsx scripts/af-simulate.ts <model-output.json>'); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const norm = normalizeExtraction(raw);                  // real SC normalizer
const results = norm.buses.map((b: any) => analyzeBusGaps(b)); // real SC gap engine
const bands = summarizeIngestBands(results);
const sys = analyzeSystemGaps(norm.systemMeta);

const sm = norm.systemMeta || {};
const lines: string[] = [];
lines.push('# Simulated extraction -> REAL ServiceCycle gap engine\n');
lines.push(`Source JSON: ${file}`);
lines.push(`System: sourceV=${sm.sourceVoltage ?? '-'}, serviceFault=${sm.serviceFaultCurrentKA ?? '-'} kA, ` +
  `xfmr=${(sm.mainTransformer && sm.mainTransformer.kva) ?? '-'} kVA ${(sm.mainTransformer && sm.mainTransformer.primaryVoltage) ?? '?'}->${(sm.mainTransformer && sm.mainTransformer.secondaryVoltage) ?? '?'}, ` +
  `PE=${(sm.studyMeta && sm.studyMeta.peName) ?? '-'}, sw=${(sm.studyMeta && sm.studyMeta.software) ?? '-'}`);
lines.push(`System-level gaps: ${sys.complete ? 'complete' : 'missing ' + sys.missing.join(', ')}`);
lines.push(`Buses: ${norm.buses.length} | not-blocked: ${bands.readyBusCount}/${bands.totalBusCount} | overall band: ${bands.overallBand}`);
if (norm.warnings.length) lines.push(`Normalizer warnings: ${norm.warnings.join('; ')}`);
lines.push('');
lines.push('| Bus | Type | Voltage | Readiness | Conf | Still needs (must-obtain) |');
lines.push('|---|---|---|---|---|---|');
norm.buses.forEach((b: any, i: number) => {
  const g = results[i];
  const needs = (g.missingRequired || []).map((f: string) => {
    const fld = (g.fields || []).find((x: any) => x.field === f);
    return fld ? fld.label : f;
  }).join(', ') || '-';
  lines.push(`| ${b.busName} | ${b.equipmentTypeGuess || '?'} | ${b.nominalVoltage || '-'} | ${g.readiness} | ${g.confidence} | ${needs} |`);
});

const out = lines.join('\n');
console.log(out);
const outPath = process.env.AF_SIM_OUT || (file.replace(/\.json$/, '') + '.gapreport.md');
try { fs.writeFileSync(outPath, out); console.log('\nWrote ' + outPath); } catch { /* stdout is enough */ }

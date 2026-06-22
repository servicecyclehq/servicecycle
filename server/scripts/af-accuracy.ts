/**
 * scripts/af-accuracy.ts — arc-flash extraction accuracy harness.
 *
 * Runs the REAL ingest pipeline against the local sample study PDFs and dumps a
 * readable per-file readout: extraction method, system model, # buses, and the
 * deterministic IEEE 1584 gap punch-list. Use it to eyeball how well extraction
 * does on real-world studies and to spot normalizer misses.
 *
 * DUAL-PURPOSE so it is useful with OR without an AI key configured:
 *   - It ALWAYS runs the deterministic probe (pdfplumber text + table counts,
 *     rasterize page count) — no AI tokens, works anywhere.
 *   - It runs the AI extraction (text path) + a forced rasterized-vision pass
 *     when AI is enabled; with no key those steps return an empty model + a clear
 *     warning, which the report records rather than crashing.
 *
 * The sample PDFs are kept OUT of git (binaries). This script reads them from
 * the local "Arc Flash Samples" folder; it does NOT bundle or commit them.
 *
 * Run (from server/, where node + the samples folder are reachable):
 *   npx tsx scripts/af-accuracy.ts
 * Optional overrides:
 *   AF_SAMPLES_DIR=/path/to/pdfs  AF_OUT=/path/to/report.md  npx tsx scripts/af-accuracy.ts
 *
 * On the droplet (keys live there) the samples are not present in the container,
 * so the practical place to run the FULL AI pass is the Windows host with a
 * provider key temporarily set in server/.env (AI_ENABLED=true + GROQ/GEMINI/
 * ANTHROPIC key).
 */

'use strict';

require('dotenv/config'); // load server/.env so AI_ENABLED + provider keys are present when run via tsx

const fs = require('fs');
const path = require('path');

const { extractArcFlashDocument } = require('../lib/arcFlashExtract');
const { analyzeBusGaps, analyzeSystemGaps, summarizeIngestBands } = require('../lib/arcFlashGap');
const { extractPdfPlumber } = require('../lib/pdfText');
const { rasterizePdf } = require('../lib/rasterizePdf');

const SAMPLES_DIR = process.env.AF_SAMPLES_DIR || path.join(__dirname, '..', '..', 'Arc Flash Samples');
const OUT = process.env.AF_OUT || path.join(__dirname, '..', '..', 'OVERNIGHT_SAMPLES_ACCURACY.md');

const aiEnabled = String(process.env.AI_ENABLED || '').toLowerCase() === 'true';
const hasKey = !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  || process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY);

function fmt(v: any): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'object') return '`' + JSON.stringify(v) + '`';
  return String(v);
}

function busLine(b: any): string {
  return [b.busName, b.equipmentTypeGuess || b.equipmentTypeRaw, b.nominalVoltage,
    b.boltedFaultCurrentKA != null ? b.boltedFaultCurrentKA + 'kA' : null,
    b.deviceType, b.deviceRatingA != null ? b.deviceRatingA + 'A' : null,
    b.cableSize, b.clearingTimeMs != null ? b.clearingTimeMs + 'ms' : null,
  ].filter((x) => x != null && x !== '').join(' · ');
}

async function detProbe(buffer: Buffer): Promise<string> {
  const lines: string[] = [];
  try {
    const det = await extractPdfPlumber(buffer);
    if (det && det.ok) {
      const chars = (det.text || '').length;
      const tbls = Array.isArray(det.tables) ? det.tables : [];
      const rows = tbls.reduce((n: number, t: any) => n + (Array.isArray(t) ? t.length : 0), 0);
      lines.push(`- pdfplumber: **${chars.toLocaleString()} text chars**, ${tbls.length} tables, ${rows} table rows` +
        (chars >= 120 ? ' → **text path** (no vision tokens spent)' : ' → too little text, would fall to vision'));
    } else {
      lines.push('- pdfplumber: no text layer (ok=false) → vision path');
    }
  } catch (e: any) {
    lines.push('- pdfplumber probe failed: ' + (e && e.message ? e.message : e));
  }
  try {
    const pages = await rasterizePdf(buffer, { maxPages: 2 });
    lines.push(`- rasterize: produced ${pages.length} page image(s) for the vision path`);
  } catch (e: any) {
    lines.push('- rasterize probe failed: ' + (e && e.message ? e.message : e));
  }
  return lines.join('\n');
}

function renderExtract(title: string, ext: any): string {
  const out: string[] = [`#### ${title}`];
  if (!ext) { out.push('_(no result)_'); return out.join('\n'); }
  out.push(`- method: \`${ext.method}\`  ·  provider: ${fmt(ext.aiProvider)}  ·  prompt: ${fmt(ext.promptVersion)}`);
  const sm = ext.systemMeta || {};
  out.push(`- system: sourceV=${fmt(sm.sourceVoltage)}, serviceFault=${fmt(sm.serviceFaultCurrentKA)}, ` +
    `xfmr=${fmt(sm.mainTransformer && sm.mainTransformer.kva)}kVA ${fmt(sm.mainTransformer && sm.mainTransformer.primaryVoltage)}/${fmt(sm.mainTransformer && sm.mainTransformer.secondaryVoltage)}, ` +
    `PE=${fmt(sm.studyMeta && sm.studyMeta.peName)}, sw=${fmt(sm.studyMeta && sm.studyMeta.software)}`);
  const sys = analyzeSystemGaps(sm);
  out.push(`- system gaps: ${sys.complete ? 'complete' : 'missing ' + sys.missing.join(', ')}`);
  const buses = Array.isArray(ext.buses) ? ext.buses : [];
  out.push(`- **${buses.length} bus(es) extracted**`);
  if (buses.length) {
    const results = buses.map((b: any) => analyzeBusGaps(b));
    const bands = summarizeIngestBands(results);
    out.push(`- readiness roll-up: ${bands.readyBusCount}/${bands.totalBusCount} not-blocked · overall band **${bands.overallBand}**`);
    out.push('');
    out.push('| Bus | Type | Readiness | Conf | Still needs |');
    out.push('|---|---|---|---|---|');
    buses.slice(0, 40).forEach((b: any, i: number) => {
      const g = results[i];
      const needs = (g.missingRequired || []).map((f: string) => {
        const fld = (g.fields || []).find((x: any) => x.field === f);
        return fld ? fld.label : f;
      }).join(', ') || '—';
      out.push(`| ${b.busName} | ${fmt(b.equipmentTypeGuess || b.equipmentTypeRaw)} | ${g.readiness} | ${g.confidence} | ${needs} |`);
    });
    if (buses.length > 40) out.push(`| …and ${buses.length - 40} more | | | | |`);
  }
  if (ext.warnings && ext.warnings.length) {
    out.push('');
    out.push('- warnings: ' + ext.warnings.map((w: string) => '_' + w + '_').join('; '));
  }
  return out.join('\n');
}

async function runFile(file: string): Promise<string> {
  const full = path.join(SAMPLES_DIR, file);
  const out: string[] = [`### ${file}`];
  let buffer: Buffer;
  try { buffer = fs.readFileSync(full); } catch (e: any) { return `### ${file}\n_could not read: ${e && e.message}_\n`; }
  out.push(`(${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
  out.push('');
  out.push('**Deterministic probe (no AI):**');
  out.push(await detProbe(buffer));
  out.push('');

  // Text/auto path — the real pipeline auto-detects text vs vision.
  let auto: any = null;
  try { auto = await extractArcFlashDocument({ buffer, fileName: file }); }
  catch (e: any) { out.push('_auto extract threw: ' + (e && e.message ? e.message : e) + '_'); }
  out.push(renderExtract('Auto path (pipeline default)', auto));
  out.push('');

  // Forced vision path on a rasterized first page, to compare against text.
  try {
    const pages = await rasterizePdf(buffer, { maxPages: 1 });
    if (pages.length) {
      const vis = await extractArcFlashDocument({ buffer: pages[0], fileName: 'page-1.png', mimeType: 'image/png' });
      out.push(renderExtract('Forced vision path (rasterized page 1)', vis));
    } else {
      out.push('#### Forced vision path (rasterized page 1)\n_rasterize produced no pages_');
    }
  } catch (e: any) {
    out.push('#### Forced vision path (rasterized page 1)\n_threw: ' + (e && e.message ? e.message : e) + '_');
  }
  out.push('\n---\n');
  return out.join('\n');
}

async function main() {
  let files: string[] = [];
  try { files = fs.readdirSync(SAMPLES_DIR).filter((f: string) => /\.pdf$/i.test(f)).sort(); }
  catch (e: any) { console.error('Cannot read samples dir', SAMPLES_DIR, e && e.message); process.exit(1); }

  const header: string[] = [
    '# Arc-Flash Extraction Accuracy — Sample Run',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Samples dir: \`${SAMPLES_DIR}\``,
    `AI_ENABLED=${aiEnabled} · provider key present: ${hasKey}` +
      (aiEnabled && hasKey ? '  → full AI extraction ran' : '  → **AI steps are no-ops; only the deterministic probe is meaningful. Re-run with a provider key for the bus/gap readout.**'),
    '',
    `Files: ${files.length}`,
    '',
    '---',
    '',
  ];
  const parts = [header.join('\n')];
  for (const f of files) {
    console.log('Processing', f);
    parts.push(await runFile(f));
  }
  fs.writeFileSync(OUT, parts.join('\n'));
  console.log('Wrote', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });

export {}; // module scope (avoid global const collision with other scripts under tsc)

'use strict';

/**
 * Regression-lock for extract_header()'s nameplate/header field passes,
 * companion to extractorGoldenPatterns.test.js (which locks
 * extract_measurements() shapes). Two gaps found 2026-07-05 while
 * investigating the golden-set eval harness's clean-tier "Field acc" number
 * (92% -> 100%, see servicecycle-overnight-parser-2026-07-05 recap):
 *
 *   1. _cut_allcaps() truncated multi-word model/catalog numbers on
 *      ALL-CAPS PowerDB documents (report_017: "MODEL: POWERPACT PG800-LSI"
 *      -> just "POWERPACT"). The heuristic assumed an ALL-CAPS continuation
 *      word signalled a new section-header label, which can't distinguish a
 *      real label from a normal all-caps document's own multi-word catalog
 *      number. Fixed by exempting tokens that contain a digit.
 *   2. HEADER_FIELDS had no bare "type" label for the model field, so a
 *      report using PowerDB's documented "MANUFACTURER: X   TYPE: Y"
 *      nameplate convention (report_018, and PowerDB's own Form 14000 bus
 *      duct nameplate per docs/research/powerdb-templates/cable_mv_hv.md)
 *      extracted no model value at all.
 *
 * Same spawnSync-to-python pattern as extractorGoldenPatterns.test.js --
 * calls extract_header([], text) directly, no PDF rendering.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const PYEXTRACT_DIR = path.join(__dirname, '..', 'pyextract');

function resolvePython() {
  const candidates = [process.env.PYEXTRACT_PYTHON, 'python3', 'python'].filter(Boolean);
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return bin;
  }
  return null;
}

const PY = resolvePython();

const SCRIPT = [
  'import sys, json',
  'sys.stdin.reconfigure(encoding="utf-8")',
  'sys.stdout.reconfigure(encoding="utf-8")',
  `sys.path.insert(0, ${JSON.stringify(PYEXTRACT_DIR)})`,
  'from extractor import extract_header',
  'text = sys.stdin.read()',
  'out = extract_header([], text)',
  'print(json.dumps(out))',
].join('\n');

function runExtractHeader(text) {
  const res = spawnSync(PY, ['-c', SCRIPT], {
    input: text,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`extractor.py exited ${res.status}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

const describeOrSkip = PY ? describe : describe.skip;

describeOrSkip('extractor.py extract_header regression locks (2026-07-05 field-acc fixes)', () => {
  test('_cut_allcaps: a multi-word model/catalog number with a digit in the second word is NOT truncated (report_017 shape)', () => {
    const text = [
      'LOW VOLTAGE INSULATED CASE CIRCUIT BREAKER TEST REPORT',
      'NAMEPLATE DATA',
      'MANUFACTURER: SQUARE D          MODEL: POWERPACT PG800-LSI',
      'SERIAL NO: SQ20-PG8-1147        YEAR: 2020',
    ].join('\n');
    const out = runExtractHeader(text);
    expect(out.model && out.model.value).toBe('POWERPACT PG800-LSI');
    expect(out.manufacturer && out.manufacturer.value).toBe('SQUARE D');
    expect(out.serialNumber && out.serialNumber.value).toBe('SQ20-PG8-1147');
  });

  test('_cut_allcaps: still stops at a genuine mixed-case-then-uppercase section-header word (original "Ferranti Packard" contract)', () => {
    // The original docstring example for _cut_allcaps -- must still hold
    // after the digit-exemption fix, since none of these tokens carry a digit.
    const text = ['MANUFACTURER: Ferranti Packard YEAR 1958 BUSHING'].join('\n');
    const out = runExtractHeader(text);
    expect(out.manufacturer && out.manufacturer.value).toBe('Ferranti Packard');
  });

  test('bare "TYPE:" label recovers the model field on a cable report with no "MODEL:"/"CATALOG:" label (report_018 shape)', () => {
    const text = [
      'MEDIUM VOLTAGE CABLE TEST REPORT',
      'CABLE DATA',
      'MANUFACTURER: OKONITE       TYPE: OKOGUARD-URO 15KV 500 KCMIL',
      'REEL/SERIAL NO: OKN-R55082-3       YEAR: 2001',
    ].join('\n');
    const out = runExtractHeader(text);
    // "KCMIL" is a pure-alpha, no-digit, all-caps token, so _cut_allcaps()
    // correctly still stops there (matches the golden-set groundTruth's
    // "Okoguard-URO 15kV 500", which also excludes the KCMIL unit suffix).
    expect(out.model && out.model.value).toBe('OKOGUARD-URO 15KV 500');
    expect(out.manufacturer && out.manufacturer.value).toBe('OKONITE');
  });
});

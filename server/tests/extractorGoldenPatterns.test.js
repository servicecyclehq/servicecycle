'use strict';

/**
 * Regression-lock for the deterministic ingest-parser passes shipped
 * 2026-07-04 (commits c0fb562 / cc356eb / 24924b4 / 20fad65 / 388955c, see
 * docs/EVAL_BASELINE_2026-07.md). None of these had a dedicated fixture test
 * before tonight (2026-07-05) -- each was verified only via the golden-set
 * eval harness (server/scripts/eval_extraction.py), which reports an
 * aggregate recall PERCENTAGE across 20 synthetic reports, not a per-pass
 * contract. A future regex tweak could silently drop one pass back toward 0%
 * on its own report shape while the aggregate number barely moves. This file
 * locks the specific text shapes each pass targets with small, hand-written
 * fixtures (not the full synthetic corpus) so a regression fails loudly and
 * locally.
 *
 * Shells out to the bundled Python extractor (pyextract/extractor.py) and
 * calls `extract_measurements([], [], text)` directly -- no PDF rendering,
 * no cells/tables, pure text-pass testing. Production's
 * lib/testReportExtract.js shells to pyextract/run.py the same way (see that
 * file for the PYEXTRACT_PYTHON env var convention this file also honors).
 */

const { spawnSync } = require('child_process');
const path = require('path');

const PYEXTRACT_DIR = path.join(__dirname, '..', 'pyextract');

// Resolve a working python binary once per test run. CI / the droplet has
// `python3` on PATH; this repo's Windows dev box only has a bare `python`
// (no python3 shim) -- try both so the suite runs identically everywhere.
function resolvePython() {
  const candidates = [process.env.PYEXTRACT_PYTHON, 'python3', 'python'].filter(Boolean);
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return bin;
  }
  return null;
}

const PY = resolvePython();

// Reads the fixture text from stdin (encoding: 'utf8' on the Node side, so
// MΩ / µΩ / Ω survive the pipe intact) and prints extract_measurements()'s
// JSON result. sys.path is pointed at pyextract/ so `from extractor import
// ...` resolves without needing the package installed.
const SCRIPT = [
  'import sys, json',
  // Windows Python defaults stdin/stdout decoding to the system locale
  // codepage (often cp1252), not UTF-8 -- silently mangling MΩ/µΩ/Ω before
  // extractor.py's regexes ever see them. Force UTF-8 explicitly so this
  // test suite behaves identically on the Windows dev box, CI, and the
  // droplet regardless of locale.
  'sys.stdin.reconfigure(encoding="utf-8")',
  'sys.stdout.reconfigure(encoding="utf-8")',
  `sys.path.insert(0, ${JSON.stringify(PYEXTRACT_DIR)})`,
  'from extractor import extract_measurements',
  'text = sys.stdin.read()',
  'out = extract_measurements([], [], text)',
  'print(json.dumps(out))',
].join('\n');

function runExtractMeasurements(text) {
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

// Skip the whole suite (rather than fail) when no python binary is on PATH
// at all -- keeps a from-scratch `npm ci` clone (no Python toolchain) from
// red-balling this file; every environment that actually runs ingest
// (droplet, CI, this repo's own dev setup) has one of python3/python.
const describeOrSkip = PY ? describe : describe.skip;

describeOrSkip('extractor.py golden-pattern regression locks (2026-07-04 passes)', () => {
  test('_bus_inline_readings: no-parens-unit header fallback recovers all three phases (report_007 shape)', () => {
    // "BUS INSULATION RESISTANCE @ 1000 VDC" names the measurement but omits
    // a "(MΩ)" unit -- the fallback (added 24924b4) must still recover all
    // three phase values from the row's own inline "M?" unit token.
    const text = [
      'LOW VOLTAGE SWITCHGEAR TEST REPORT',
      'BUS INSULATION RESISTANCE @ 1000 VDC',
      'A-B: 850 M?      B-C: 720 M?      C-A: 910',
      'MINIMUM: >=100 MOhm      RESULT: PASS',
    ].join('\n');
    const out = runExtractMeasurements(text);
    const ir = out.filter((m) => m.measurementType === 'insulation_resistance');
    const byPhase = {};
    for (const m of ir) byPhase[m.phase] = m.asFoundValue;
    expect(byPhase['A-B']).toBe(850);
    expect(byPhase['B-C']).toBe(720);
    expect(byPhase['C-A']).toBe(910);
    // NOTE (found 2026-07-05, not fixed tonight -- see recap memory): the
    // fallback's own-row unit search can match the leading phase letter
    // ("A" in "A-B") as a bare Amps unit token before it reaches the real
    // "M?" later in the row, so `asFoundUnit` on this pass's own entries may
    // read "A" instead of "MΩ" even though `measurementType` (driven by the
    // LABEL, not the unit) is correctly "insulation_resistance" and the
    // VALUES are correct. Deliberately not asserted here so this lock
    // doesn't need updating the day someone fixes it.
  });

  test('_phase_grid_readings: unit-column mode recovers a PHASE / <unit> / EXPECTED / RESULT grid (report_007 shape)', () => {
    // The value column is labeled by UNIT ("uOhm") rather than descriptively
    // ("AS-FOUND") -- 24924b4 taught _PHASE_GRID_HDR_RE to capture that token
    // and use it directly as the row unit when no "(unit)" header line exists.
    const text = [
      'MAIN BUS JOINT RESISTANCE (DLRO)',
      'PHASE    uOhm       EXPECTED     RESULT',
      'A        118        <=100        INVESTIGATE - YELLOW',
      'B        86         <=100        PASS',
    ].join('\n');
    const out = runExtractMeasurements(text);
    const cr = out.filter((m) => m.measurementType === 'contact_resistance');
    expect(cr.length).toBe(2);
    const byPhase = {};
    for (const m of cr) byPhase[m.phase] = m.asFoundValue;
    expect(byPhase.A).toBe(118);
    expect(byPhase.B).toBe(86);
    expect(cr.every((m) => m.asFoundUnit === 'µΩ')).toBe(true);
    expect(cr.find((m) => m.phase === 'A').passFail).toBe('YELLOW');
  });

  test('_powerdb_grids IR-grid: zero-value reading + single-value-per-row rows both emit (report_004 shape)', () => {
    // report_004: H-G reads exactly 0 (a legitimate, safety-critical short-
    // circuit indication -- the pre-388955c code used `v > 0` and silently
    // dropped it). X-G carries both a 1-min and 10-min value; H-X carries
    // only a single value (10-min column blank) -- the pre-388955c emit
    // threshold was `len(run) >= 2` and dropped single-value rows entirely.
    const text = [
      'INSULATION RESISTANCE - MEGGER S1-5010 @ 5000 VDC',
      'WINDING          1 MIN (MΩ)     10 MIN (MΩ)',
      'H-G              0              --',
      'X-G              11200          26400',
      'H-X              14800',
      'MINIMUM ACCEPTABLE: >=5000 M?',
    ].join('\n');
    const out = runExtractMeasurements(text);
    const ir = out.filter((m) => m.measurementType === 'insulation_resistance');
    const values = ir.map((m) => m.asFoundValue).sort((a, b) => a - b);
    expect(values).toEqual([0, 11200, 14800, 26400]);
    // The zero reading must survive -- this is the safety-critical case.
    expect(ir.some((m) => m.asFoundValue === 0)).toBe(true);
  });

  describe('_MOHM_HDR_RE: OCR-corrupted MΩ header variants all trigger IR-grid mode', () => {
    const variants = [
      ['M?', 'WINDING          1 MIN (M?)     10 MIN (M?)'],
      ['MQ', 'WINDING          1 MIN (MQ)     10 MIN (MQ)'],
      ['M0hm', 'WINDING          1 MIN (M0hm)     10 MIN (M0hm)'],
      ['Nchm', 'WINDING          1 MIN (Nchm)     10 MIN (Nchm)'],
    ];
    test.each(variants)('"(%s)" header recovers the H-G reading pair', (_label, header) => {
      const text = [
        'INSULATION RESISTANCE @ 5000 VDC',
        header,
        'H-G            3850        6240',
      ].join('\n');
      const out = runExtractMeasurements(text);
      const ir = out.filter((m) => m.measurementType === 'insulation_resistance');
      const values = ir.map((m) => m.asFoundValue).sort((a, b) => a - b);
      expect(values).toEqual([3850, 6240]);
      expect(ir.every((m) => m.asFoundUnit === 'MΩ')).toBe(true);
    });

    test('a header WITHOUT any MΩ-alias token never enters IR-grid mode (negative control)', () => {
      const text = [
        'INSULATION RESISTANCE @ 5000 VDC',
        'WINDING          1 MIN (VDC)     10 MIN (VDC)',
        'H-G            3850        6240',
      ].join('\n');
      const out = runExtractMeasurements(text);
      const ir = out.filter((m) => m.measurementType === 'insulation_resistance');
      expect(ir.length).toBe(0);
    });
  });
});

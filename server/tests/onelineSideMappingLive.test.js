'use strict';

/**
 * LIVE regression check for the LEFT/RIGHT side-mapping fix (2026-07-23,
 * commit 6e2a812) -- runs 3 realistic synthetic one-line diagram PDFs
 * (see tests/fixtures/ab-side-mapping/, generator + EXPECTED.md alongside)
 * through the REAL extraction pipeline -- real AI calls, nothing mocked --
 * and checks the returned `side` field against the ground truth baked into
 * each PDF's own labels.
 *
 * Guarded behind RUN_LIVE_AI_TEST=1 because this makes real, billed AI API
 * calls. It must never run as part of a normal `npx jest` sweep.
 *
 * Usage:  RUN_LIVE_AI_TEST=1 npx jest onelineSideMappingLive --silent=false
 */

const fs = require('fs');
const path = require('path');
const { extractArcFlashDocument } = require('../lib/arcFlashExtract');

jest.setTimeout(90000);

const FIXDIR = path.join(__dirname, 'fixtures', 'ab-side-mapping');

const CASES = [
  {
    file: '01_northfield_dc_train_ab.pdf',
    label: 'TRAIN A / TRAIN B -- pre-existing supported form, regression check',
    expected: { 'SWGR-A': 'A', 'PDU-A1': 'A', 'SWGR-B': 'B', 'PDU-B1': 'B' },
    expectNull: ['SWGR-MAIN', 'RACK ROW A1', 'RACK ROW B1'],
  },
  {
    file: '02_meridian_health_left_right.pdf',
    label: 'bare LEFT / RIGHT -- the exact gap the fix closes',
    expected: { 'SWGR-L': 'A', 'PDU-L1': 'A', 'SWGR-R': 'B', 'PDU-R1': 'B' },
    expectNull: ['SWGR-MAIN', 'RACK ROW L1', 'RACK ROW R1'],
  },
  {
    file: '03_riverside_industrial_leftside.pdf',
    label: 'LEFT SIDE / RIGHT SIDE -- fix variant, different industry/topology',
    expected: { 'MCC-1': 'A', 'MCC-2': 'B' },
    expectNull: ['SWGR-MAIN'],
  },
];

function findBus(buses, name) {
  const target = name.trim().toUpperCase();
  return buses.find((b) => String(b.busName || '').trim().toUpperCase() === target);
}

describe('LIVE: arc-flash extractor side (A/B train) mapping on realistic one-lines', () => {
  const RUN = process.env.RUN_LIVE_AI_TEST === '1';
  const d = RUN ? describe : describe.skip;

  d('real AI extraction (billed, not mocked)', () => {
    for (const c of CASES) {
      test(`${c.file} -- ${c.label}`, async () => {
        const buffer = fs.readFileSync(path.join(FIXDIR, c.file));
        const result = await extractArcFlashDocument({ buffer, mimeType: 'application/pdf', fileName: c.file });
        const buses = result.buses || [];

        console.log(`\n--- ${c.file} (${c.label}) ---`);
        for (const b of buses) {
          console.log(`  ${b.busName}: side=${JSON.stringify(b.side)} fedFrom=${JSON.stringify(b.fedFromBusName)} type=${JSON.stringify(b.equipmentTypeGuess)}`);
        }
        if (result.warnings && result.warnings.length) console.log('  warnings:', result.warnings);

        for (const [busName, expectedSide] of Object.entries(c.expected)) {
          const bus = findBus(buses, busName);
          expect(bus).toBeDefined();
          expect(bus.side).toBe(expectedSide);
        }
        for (const busName of c.expectNull) {
          const bus = findBus(buses, busName);
          if (bus) expect(bus.side).toBeNull();
        }
      });
    }
  });
});
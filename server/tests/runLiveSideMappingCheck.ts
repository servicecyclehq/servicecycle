/**
 * LIVE regression check for the LEFT/RIGHT side-mapping fix (2026-07-23,
 * commit 6e2a812) -- plain-tsx equivalent of onelineSideMappingLive.test.js,
 * for environments where jest/ts-jest (devDependencies) aren't available.
 *
 * Why this exists: the production image's node_modules is built via
 * `npm ci` (full install) followed by `npm prune --omit=dev` inside the
 * `deps` build stage (server/Dockerfile line 71) -- so jest, ts-jest, and
 * typescript are NOT present in the deployed runtime image. `npx jest` in
 * that image tries to fetch jest live from the npm registry, which then
 * fails because the container's root filesystem is read-only (Pass-6
 * hardening, docker-compose.yml) and npm can't create its own cache dir.
 *
 * This script sidesteps both problems by using `tsx` instead of jest/ts-jest
 * to run the TypeScript directly -- tsx IS present in the runtime image (it's
 * a production dependency, since it's what actually runs the server itself;
 * see server/Dockerfile's CMD). That also makes this arguably MORE faithful
 * than the jest version: it exercises the real extraction code through the
 * exact same runtime transform (tsx/esbuild) that production uses, rather
 * than through ts-jest's separate compilation path.
 *
 * Guarded behind RUN_LIVE_AI_TEST=1 because this makes real, billed AI API
 * calls.
 *
 * Usage (inside the server container, package.json/tsx already present):
 *   RUN_LIVE_AI_TEST=1 node node_modules/tsx/dist/cli.mjs tests/runLiveSideMappingCheck.ts
 *
 * CASES below are ported verbatim from tests/onelineSideMappingLive.test.js
 * -- same fixtures, same expectations. Keep the two in sync if either changes.
 */

import fs from 'fs';
import path from 'path';
import { extractArcFlashDocument } from '../lib/arcFlashExtract';

const FIXDIR = path.join(__dirname, 'fixtures', 'ab-side-mapping');

interface Case {
  file: string;
  label: string;
  expected: Record<string, string>;
  expectNull: string[];
}

const CASES: Case[] = [
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

function findBus(buses: any[], name: string) {
  const target = name.trim().toUpperCase();
  return buses.find((b) => String(b.busName || '').trim().toUpperCase() === target);
}

async function main() {
  if (process.env.RUN_LIVE_AI_TEST !== '1') {
    console.log('Skipping: set RUN_LIVE_AI_TEST=1 to run (this makes real, billed AI calls).');
    process.exit(0);
  }

  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  for (const c of CASES) {
    console.log(`\n=== ${c.file} -- ${c.label} ===`);
    let result: any;
    try {
      const buffer = fs.readFileSync(path.join(FIXDIR, c.file));
      result = await extractArcFlashDocument({ buffer, mimeType: 'application/pdf', fileName: c.file });
    } catch (e: any) {
      console.log(`  ERROR during extraction: ${e && e.stack ? e.stack : e}`);
      fail += Object.keys(c.expected).length + c.expectNull.length;
      failures.push(`${c.file}: extraction threw -- ${e && e.message ? e.message : e}`);
      continue;
    }

    const buses = result.buses || [];
    for (const b of buses) {
      console.log(`  ${b.busName}: side=${JSON.stringify(b.side)} fedFrom=${JSON.stringify(b.fedFromBusName)} type=${JSON.stringify(b.equipmentTypeGuess)}`);
    }
    if (result.warnings && result.warnings.length) console.log('  warnings:', result.warnings);

    for (const [busName, expectedSide] of Object.entries(c.expected)) {
      const bus = findBus(buses, busName);
      if (!bus) {
        console.log(`  FAIL: ${busName} -- not found in extraction result`);
        fail++;
        failures.push(`${c.file}: ${busName} not found`);
      } else if (bus.side !== expectedSide) {
        console.log(`  FAIL: ${busName} -- expected side=${expectedSide}, got ${JSON.stringify(bus.side)}`);
        fail++;
        failures.push(`${c.file}: ${busName} expected ${expectedSide}, got ${JSON.stringify(bus.side)}`);
      } else {
        console.log(`  PASS: ${busName} -- side=${expectedSide}`);
        pass++;
      }
    }

    for (const busName of c.expectNull) {
      const bus = findBus(buses, busName);
      if (bus && bus.side != null) {
        console.log(`  FAIL: ${busName} -- expected side=null, got ${JSON.stringify(bus.side)}`);
        fail++;
        failures.push(`${c.file}: ${busName} expected null, got ${JSON.stringify(bus.side)}`);
      } else {
        console.log(`  PASS: ${busName} -- side=null (as expected)`);
        pass++;
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});

/**
 * Observational (not pass/fail) live check for a real-world one-line PDF
 * whose A/B side convention doesn't match either the per-bus text label
 * (normSide(), commit 6e2a812) or a within-page left/right split -- this
 * ABB reference diagram states the side ONCE per page in prose ("This
 * topology represents side A/B of power supply") and repeats the SAME bus
 * names (RPP 1, RPP 2, Chiller 1/2/3, CRAC, ...) across both pages.
 *
 * No hardcoded expected{} here: the schema has no per-bus "which page did
 * this come from" field, so what "correct" looks like (does the model
 * distinguish side-A's RPP 2 from side-B's RPP 2, or collapse them into
 * one?) is exactly the open question. This just runs the real extractor
 * and reports what actually comes back, plus flags any duplicate busNames.
 *
 * Usage (same override pattern as the other live check):
 *   RUN_LIVE_AI_TEST=1 node node_modules/tsx/dist/cli.mjs tests/runRealWorldSideCheck.ts
 */

import fs from 'fs';
import path from 'path';
import { extractArcFlashDocument } from '../lib/arcFlashExtract';

const FILE = path.join(__dirname, 'fixtures', 'real-world-samples', 'abb_dc_441kw_sideA_sideB.pdf');

async function main() {
  if (process.env.RUN_LIVE_AI_TEST !== '1') {
    console.log('Skipping: set RUN_LIVE_AI_TEST=1 to run (this makes a real, billed AI call).');
    process.exit(0);
  }

  const buffer = fs.readFileSync(FILE);
  console.log(`Read ${buffer.length} bytes from ${FILE}`);

  const result = await extractArcFlashDocument({
    buffer,
    mimeType: 'application/pdf',
    fileName: 'abb_dc_441kw_sideA_sideB.pdf',
  });

  const buses = result.buses || [];
  console.log(`\n${buses.length} buses returned.\n`);
  console.log('busName | side | fedFromBusName | equipmentTypeGuess | redundancyZone | sourceRole');
  console.log('-'.repeat(100));
  for (const b of buses) {
    console.log(
      `${b.busName} | ${JSON.stringify(b.side)} | ${JSON.stringify(b.fedFromBusName)} | ` +
      `${JSON.stringify(b.equipmentTypeGuess)} | ${JSON.stringify(b.redundancyZone)} | ${JSON.stringify(b.sourceRole)}`
    );
  }

  // Surface the exact ambiguity this document raises: same busName appearing
  // more than once (expected if the model correctly kept side-A's and
  // side-B's copies distinct as separate records; a count of exactly 1 per
  // repeated name would mean they got collapsed into one).
  const counts: Record<string, number> = {};
  for (const b of buses) {
    const name = String(b.busName || '').trim().toUpperCase();
    counts[name] = (counts[name] || 0) + 1;
  }
  const dupes = Object.entries(counts).filter(([, n]) => n > 1);
  console.log(`\n${dupes.length} bus name(s) appearing more than once:`);
  for (const [name, n] of dupes) {
    const entries = buses.filter((b: any) => String(b.busName || '').trim().toUpperCase() === name);
    console.log(`  ${name} x${n}: sides = ${entries.map((e: any) => JSON.stringify(e.side)).join(', ')}`);
  }

  const sideCounts: Record<string, number> = {};
  for (const b of buses) {
    const s = b.side == null ? 'null' : String(b.side);
    sideCounts[s] = (sideCounts[s] || 0) + 1;
  }
  console.log(`\nside distribution: ${JSON.stringify(sideCounts)}`);

  if (result.warnings && result.warnings.length) {
    console.log('\nwarnings:', result.warnings);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});

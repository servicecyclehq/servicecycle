#!/usr/bin/env node
/**
 * Reset-chain parity guard.
 *
 * The demo-reset delete chain is DUPLICATED in two places that must stay in sync:
 *   - server/scripts/seed-demo.js  ::  _resetDemoAccount()   (wipes the demo account's data)
 *   - server/lib/demoPrune.ts      ::  pruneAccount()        (deletes a whole tenant)
 *
 * A table whose foreign key to Asset is REQUIRED and NOT onDelete:Cascade will
 * block asset.deleteMany() with Prisma P2003 unless it is deleted first
 * (e.g. thermography_surveys_assetId_fkey). If the two chains disagree about
 * such a "blocking" table, a reseed/prune throws. That exact regression shipped
 * TWICE (2026-07-19) when the chains silently drifted, so this check FAILS when
 * they disagree on any blocking Asset-child. Optional (SetNull) and Cascade FKs
 * don't block, so they're intentionally ignored (no false positives on the
 * belt-and-suspenders deletes both chains already do).
 *
 * Pure static parse — no DB, no secrets. Exit 1 on drift.
 *   node server/scripts/check-reset-parity.js
 * Paths overridable for testing: SCHEMA_PATH / SEED_PATH / PRUNE_PATH.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..'); // server/
const SCHEMA = process.env.SCHEMA_PATH || path.join(ROOT, 'prisma', 'schema.prisma');
const SEED   = process.env.SEED_PATH   || path.join(ROOT, 'scripts', 'seed-demo.js');
const PRUNE  = process.env.PRUNE_PATH  || path.join(ROOT, 'lib', 'demoPrune.ts');

const read = (p) => fs.readFileSync(p, 'utf8');
const accessor = (m) => m.charAt(0).toLowerCase() + m.slice(1);

// Blocking Asset-children: models whose assetId FK is REQUIRED (String, not String?)
// and NOT onDelete:Cascade — these are the ones that FK-block asset.deleteMany().
function blockingAssetModels(schema) {
  const out = {}; // accessor -> model
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(schema))) {
    const name = m[1], body = m[2];
    if (name === 'Asset') continue;
    const fk = body.match(/^\s*assetId\s+String(\??)/m);
    if (!fk || fk[1] === '?') continue;                 // no FK, or optional (SetNull) -> can't block
    const rel = body.match(/^\s*\w+\s+Asset\s+@relation\(([^)]*)\)/m);
    const onDelete = rel ? (rel[1].match(/onDelete:\s*(\w+)/) || [, ''])[1] : '';
    if (onDelete === 'Cascade') continue;               // cascades with the asset -> can't block
    out[accessor(name)] = name;
  }
  return out;
}

function funcBody(src, header) {
  const start = src.indexOf(header);
  if (start < 0) throw new Error(`could not find "${header}"`);
  const rest = src.slice(start);
  const end = rest.search(/\n\}/);                       // first column-0 `}`
  if (end < 0) throw new Error(`could not bound body of "${header}"`);
  return rest.slice(0, end);
}

function deletes(body) {
  const out = [];
  const re = /prisma\.(\w+)\.deleteMany/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
}

const blocking = blockingAssetModels(read(SCHEMA));      // accessor -> Model
const blockingSet = new Set(Object.keys(blocking));

const seedDel  = deletes(funcBody(read(SEED),  'async function _resetDemoAccount'));
const pruneDel = deletes(funcBody(read(PRUNE), 'async function pruneAccount'));
const seedIdx  = seedDel.indexOf('asset');
const pruneIdx = pruneDel.indexOf('asset');
const inSeed  = (a) => seedDel.includes(a);
const inPrune = (a) => pruneDel.includes(a);

const failures = [];
const warnings = [];

for (const a of blockingSet) {
  const s = inSeed(a), p = inPrune(a);
  // (a) DRIFT — the exact regression: one chain clears it, the other doesn't. HARD FAIL.
  if (s !== p) {
    failures.push(`DRIFT: '${a}' (required FK -> Asset, blocks asset.deleteMany) is cleared in ` +
      `${s ? 'seed-demo' : 'demoPrune'} but NOT in ${s ? 'demoPrune' : 'seed-demo'}`);
    continue;
  }
  // (b) covered in NEITHER — a blocking table nobody clears is a reseed time-bomb. WARN.
  if (!s && !p) { warnings.push(`'${a}' (${blocking[a]}) — blocking Asset-child cleared in NEITHER reset (add to both, or confirm it cascades via a parent)`); continue; }
  // (c) ORDER — cleared, but AFTER asset.deleteMany in a chain. WARN (may cascade via a parent).
  if (seedIdx >= 0 && seedDel.indexOf(a) > seedIdx)  warnings.push(`seed-demo clears '${a}' AFTER asset.deleteMany`);
  if (pruneIdx >= 0 && pruneDel.indexOf(a) > pruneIdx) warnings.push(`demoPrune clears '${a}' AFTER asset.deleteMany`);
}

console.log(`blocking Asset-children (required, non-Cascade FK): ${[...blockingSet].sort().join(', ') || '(none)'}`);
console.log(`  seed-demo clears: ${[...blockingSet].filter(inSeed).sort().join(', ') || '(none)'}`);
console.log(`  demoPrune clears: ${[...blockingSet].filter(inPrune).sort().join(', ') || '(none)'}`);
if (warnings.length) { console.warn('\n⚠️  warnings:'); for (const w of warnings) console.warn('  - ' + w); }

if (failures.length) {
  console.error('\n❌ reset-chain parity FAILED:');
  for (const f of failures) console.error('  - ' + f);
  console.error('\nFix: _resetDemoAccount (seed-demo.js) and pruneAccount (demoPrune.ts) must both ' +
    'clear every blocking Asset-child before asset.deleteMany. This guards the P2003 reseed regression.');
  process.exit(1);
}
console.log('\n✅ reset-chain parity OK');

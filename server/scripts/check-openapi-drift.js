#!/usr/bin/env node
'use strict';
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// scripts/check-openapi-drift.js  (Item 4 â€” pre-deploy API-drift gate)
//
// Regenerates the OpenAPI spec from the CURRENT code (routes + registry) and
// compares it to the committed docs/openapi.json baseline. Exits non-zero when
// a BREAKING change is detected, so the deploy flow can refuse to ship an API
// that silently dropped a path / operation or reshaped a contract the client
// depends on â€” the v0.89.x cascade bug class.
//
// Two engines:
//   1. oasdiff (preferred). If `oasdiff` is on PATH it runs
//        oasdiff diff <committed> <regenerated> --fail-on ERR
//      and propagates its exit code. Install:
//        Go:    go install github.com/oasdiff/oasdiff@latest
//        binary: https://github.com/oasdiff/oasdiff/releases
//   2. Built-in structural fallback (no install needed). Flags as BREAKING:
//        - a path present in the baseline but missing now (removed endpoint)
//        - an operation (method) removed from a path
//        - a required response property removed from a 200 schema
//        - a newly-required request-body property
//
// Usage:
//   node server/scripts/check-openapi-drift.js          # fail on breaking
//   node server/scripts/check-openapi-drift.js --update # rewrite baseline (intentional change)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSpec, writeSpec, OUT } = require('./build-openapi');

const UPDATE = process.argv.includes('--update');

if (UPDATE) { writeSpec(); console.log('baseline updated.'); process.exit(0); }

if (!fs.existsSync(OUT)) {
  console.error('No baseline at', OUT, 'â€” run `npm run openapi:build` and commit it first.');
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
const { spec: current } = buildSpec();

// â”€â”€ engine 1: oasdiff, if available â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function haveOasdiff() {
  const r = spawnSync('oasdiff', ['--version'], { encoding: 'utf-8' });
  return !r.error;
}

if (haveOasdiff()) {
  const tmp = path.join(os.tmpdir(), 'servicecycle-openapi-current.json');
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
  console.log('oasdiff detected â€” running breaking-change checkâ€¦');
  const r = spawnSync('oasdiff', ['diff', OUT, tmp, '--fail-on', 'ERR', '--format', 'text'], { encoding: 'utf-8', stdio: 'inherit' });
  fs.unlinkSync(tmp);
  process.exit(r.status == null ? 1 : r.status);
}

// â”€â”€ engine 2: structural fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log('oasdiff not on PATH â€” using built-in structural drift check.');
console.log('(install oasdiff for full coverage: go install github.com/oasdiff/oasdiff@latest)\n');

const breaking = [];
const info = [];

function requiredProps(schema) {
  // pull required[] from a 200 response / requestBody json schema (best effort)
  if (!schema || typeof schema !== 'object') return [];
  let s = schema;
  // unwrap envelope { properties: { data: {...} } } one level too
  const out = new Set();
  if (Array.isArray(s.required)) s.required.forEach((k) => out.add(k));
  if (s.properties && s.properties.data && Array.isArray(s.properties.data.required)) {
    s.properties.data.required.forEach((k) => out.add('data.' + k));
  }
  return [...out];
}
function respSchema(op) {
  try { return op.responses['200'].content['application/json'].schema; } catch (_) { return null; }
}
function reqSchema(op) {
  try { return op.requestBody.content['application/json'].schema; } catch (_) { return null; }
}

for (const [p, ops] of Object.entries(baseline.paths)) {
  if (!current.paths[p]) { breaking.push('removed path: ' + p); continue; }
  for (const [method, op] of Object.entries(ops)) {
    const cur = current.paths[p][method];
    if (!cur) { breaking.push('removed operation: ' + method.toUpperCase() + ' ' + p); continue; }
    // response required props removed?
    const beforeResp = requiredProps(respSchema(op));
    const afterResp  = requiredProps(respSchema(cur));
    for (const k of beforeResp) {
      if (!afterResp.includes(k)) breaking.push('response field removed: ' + method.toUpperCase() + ' ' + p + ' :: ' + k);
    }
    // request required props added?
    const beforeReq = requiredProps(reqSchema(op));
    const afterReq  = requiredProps(reqSchema(cur));
    for (const k of afterReq) {
      if (!beforeReq.includes(k)) breaking.push('new required request field: ' + method.toUpperCase() + ' ' + p + ' :: ' + k);
    }
  }
}
// non-breaking additions (informational)
for (const p of Object.keys(current.paths)) {
  if (!baseline.paths[p]) info.push('added path: ' + p);
}

if (info.length) { console.log('Non-breaking additions (' + info.length + '):'); info.slice(0, 20).forEach((s) => console.log('  + ' + s)); console.log(''); }

if (breaking.length) {
  console.error('BREAKING API changes vs committed docs/openapi.json (' + breaking.length + '):');
  breaking.forEach((s) => console.error('  âœ— ' + s));
  console.error('\nIf intentional, run `npm run openapi:build` and commit the updated spec.');
  process.exit(1);
}
console.log('No breaking API drift vs committed baseline. âœ“');
process.exit(0);
/**
 * openapiRegistry.js — loads and caches the v1 OpenAPI 3 spec.
 *
 * Source of truth: docs/api/openapi.yaml at the repo root, mirrored into
 * server/data/openapi/v1.yaml at build time by scripts/sync-openapi.js
 * (so the file ships inside the docker build context).
 *
 * Two lookups: synced runtime path first, repo-root fallback for the
 * dev-workstation case where the operator edits the canonical .yaml and
 * forgets to re-run sync. Same candidate-chain pattern as helpRegistry.
 *
 * The parsed spec is cached on first read. v0.37.1 W5 MT-128.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SYNCED_PATH = path.join(__dirname, '..', 'data', 'openapi', 'v1.yaml');
const REPO_FALL   = path.join(__dirname, '..', '..', 'docs', 'api', 'openapi.yaml');

let _cached = null; // { spec, source, length } once loaded; null until first call

function readFirstAvailable() {
  for (const candidate of [SYNCED_PATH, REPO_FALL]) {
    try {
      const body = fs.readFileSync(candidate, 'utf-8');
      return { body, source: candidate };
    } catch (_) {
      // try next
    }
  }
  return null;
}

/**
 * Return the parsed OpenAPI spec as a plain JS object. Caches the parse
 * result on first call. Returns null if no spec file is reachable on the
 * filesystem (operator never ran openapi:sync AND the dev-fallback path
 * is also missing — unusual but possible in stripped-down deployments).
 */
function getSpec() {
  if (_cached) return _cached.spec;
  const file = readFirstAvailable();
  if (!file) {
    console.warn(`[openapiRegistry] no spec file found at ${SYNCED_PATH} or ${REPO_FALL}`);
    return null;
  }
  let parsed;
  try {
    // js-yaml v4 kept `safeLoad` as an exported function but made it THROW
    // ("Function yaml.safeLoad is removed...") instead of removing the
    // export outright, so the old `yaml.safeLoad ? ... : yaml.load(...)`
    // feature-detect always picked the throwing branch (the function
    // reference is truthy even though calling it fails). `load()` has been
    // safe-by-default since v4 -- just call it directly. Found 2026-07-08:
    // this made /docs/api 503 (getSpec() returning null) in every
    // environment since whenever js-yaml was bumped to v4.
    parsed = yaml.load(file.body);
  } catch (err) {
    console.error(`[openapiRegistry] YAML parse error from ${file.source}: ${err && err.message}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn(`[openapiRegistry] parsed spec is not an object (from ${file.source})`);
    return null;
  }
  // Cheap sanity check — bail loudly if the file isn't an OpenAPI 3.x doc.
  if (!parsed.openapi || !/^3\./.test(String(parsed.openapi))) {
    console.warn(`[openapiRegistry] spec at ${file.source} is not OpenAPI 3.x (got openapi=${parsed.openapi})`);
    return null;
  }
  _cached = { spec: parsed, source: file.source, length: file.body.length };
  console.log(`[openapiRegistry] loaded OpenAPI ${parsed.openapi} spec from ${file.source} (${file.body.length} chars)`);
  return _cached.spec;
}

/**
 * Return the raw YAML string for the /openapi.yaml endpoint. Same lookup
 * chain as getSpec(). No caching — the file is small and this endpoint
 * is rarely hit in steady-state.
 */
function getYaml() {
  const file = readFirstAvailable();
  return file ? file.body : null;
}

function _clearCache() { _cached = null; }

module.exports = { getSpec, getYaml, _clearCache };

export {};

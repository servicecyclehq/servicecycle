'use strict';

/**
 * tests/openapiRegistry.test.js
 * ------------------------------
 * v0.37.4 regression suite for lib/openapiRegistry. Locks in:
 *   - getSpec() returns a parsed OpenAPI 3.x object
 *   - getYaml() returns the raw YAML body string
 *   - parse result is cached across calls
 *
 * Depends on the synced asset at server/data/openapi/v1.yaml being
 * present. The sync script (scripts/sync-openapi.js) seeds it from
 * docs/api/openapi.yaml. If the asset is missing the suite skips
 * cleanly (same posture as the audit-2026-05-03 / aiQuota tests).
 */

const fs   = require('fs');
const path = require('path');

const SYNCED_PATH = path.join(__dirname, '..', 'data', 'openapi', 'v1.yaml');
const REPO_FALL   = path.join(__dirname, '..', '..', 'docs', 'api', 'openapi.yaml');

const HAS_SPEC = fs.existsSync(SYNCED_PATH) || fs.existsSync(REPO_FALL);

const conditionalDescribe = HAS_SPEC ? describe : describe.skip;

conditionalDescribe('openapiRegistry', () => {
  let openapi;
  beforeAll(() => {
    // Clear require cache so the module's internal cache also resets.
    delete require.cache[require.resolve('../lib/openapiRegistry')];
    openapi = require('../lib/openapiRegistry');
    openapi._clearCache();
  });

  afterEach(() => {
    openapi._clearCache();
  });

  test('getSpec returns a parsed OpenAPI 3.x object', () => {
    const spec = openapi.getSpec();
    expect(spec).toBeTruthy();
    expect(typeof spec).toBe('object');
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info).toBeTruthy();
    expect(spec.paths).toBeTruthy();
  });

  test('getYaml returns a non-empty YAML string', () => {
    const body = openapi.getYaml();
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(100);
    expect(body).toMatch(/^openapi:\s*3\./m);
  });

  test('parse result is cached across getSpec calls', () => {
    const a = openapi.getSpec();
    const b = openapi.getSpec();
    // Same object reference — the cache returned the SAME parse, not a re-parse.
    expect(a).toBe(b);
  });

  test('_clearCache forces a fresh parse', () => {
    const a = openapi.getSpec();
    openapi._clearCache();
    const b = openapi.getSpec();
    // After cache clear, the parser ran again — different object identity even
    // though the content is identical.
    expect(a).not.toBe(b);
    expect(a.openapi).toBe(b.openapi);
  });
});

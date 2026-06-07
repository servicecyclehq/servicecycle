#!/usr/bin/env node
'use strict';

/**
 * scripts/sync-openapi.js
 * -----------------------
 * Copies the canonical OpenAPI 3.x spec from `docs/api/openapi.yaml`
 * (repo root) into `server/data/openapi/v1.yaml` so it ships inside the
 * docker build context.
 *
 * Mirrors the sync-help.js + sync-ai-guide.js pattern:
 *   - Docker COPY can't follow paths outside the build context (./server).
 *   - server/.dockerignore excludes `*.md` but NOT `*.yaml`, so we keep
 *     the .yaml extension unlike the help-doc .txt rename.
 *
 * Run after editing docs/api/openapi.yaml. CI does not auto-regenerate;
 * commit the synced artifact so the build is reproducible.
 *
 * Usage:
 *   npm run openapi:sync
 */

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC       = path.join(REPO_ROOT, 'docs', 'api', 'openapi.yaml');
const DEST_DIR  = path.join(REPO_ROOT, 'server', 'data', 'openapi');
const DEST      = path.join(DEST_DIR, 'v1.yaml');

function main() {
  if (!fs.existsSync(SRC)) {
    throw new Error(`OpenAPI source missing at ${SRC}. Did docs/api/openapi.yaml move?`);
  }
  fs.mkdirSync(DEST_DIR, { recursive: true });
  const body = fs.readFileSync(SRC, 'utf-8');
  if (body.length < 500) {
    throw new Error(`${SRC} is suspiciously small (${body.length} chars). Refusing to sync — fix the source.`);
  }
  // Cheap sanity check on the spec shape so a corrupted yaml never lands.
  if (!/^openapi:\s*3\./m.test(body)) {
    throw new Error(`${SRC} does not look like an OpenAPI 3.x document (missing "openapi: 3.x" header).`);
  }
  fs.writeFileSync(DEST, body, 'utf-8');

  fs.writeFileSync(
    path.join(DEST_DIR, 'README.md'),
    [
      '# server/data/openapi',
      '',
      'Generated artifacts that ship inside the lapseiq-server docker image.',
      'Source of truth: `docs/api/openapi.yaml` at the repo root. Re-sync',
      'after every edit via `npm run openapi:sync`. Commit the synced file',
      'alongside the source so the build is reproducible.',
      '',
    ].join('\n')
  );

  console.log(`[openapi:sync] synced spec (${body.length} chars) -> server/data/openapi/v1.yaml`);
}

main();

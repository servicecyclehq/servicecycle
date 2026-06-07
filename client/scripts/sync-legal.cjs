#!/usr/bin/env node
'use strict';

/**
 * scripts/sync-legal.js
 * ---------------------
 * Copies the four customer-facing legal documents from the repo-root
 * `legal/` folder into `client/src/legal/` so vite's `?raw` import in
 * the wrapper pages resolves at docker build time.
 *
 * Why a sync, not a relative import: the docker build context for the
 * client image is `./client` (per .github/workflows/release.yml). The
 * canonical `legal/` folder lives at the repo root, OUTSIDE that
 * context — vite/rollup can't see it during the GHCR build, and the
 * client image fails with "Could not resolve ../../../legal/...".
 * The local dev build doesn't hit this because vite has access to the
 * full repo tree.
 *
 * Mirrors the same pattern as server/scripts/sbom-sync.js and
 * server/scripts/sync-ai-guide.js.
 *
 * Usage:
 *   npm run legal:sync
 *
 * Run this after every edit to legal/*-2026-05.md and commit the
 * synced copies. CI does not regenerate them — it expects the synced
 * artifacts to be in git so the docker build is reproducible.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR   = path.join(REPO_ROOT, 'legal');
const DEST_DIR  = path.join(REPO_ROOT, 'client', 'src', 'legal');

// Documents the public legal pages render.
const FILES = [
  'eula-draft-2026-05.md',
  'privacy-draft-2026-05.md',
  'terms-draft-2026-05.md',
  'sub-processors-2026-05.md',
  'demo-sandbox-notice-2026-05.md',
];

function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });

  let synced = 0;
  for (const name of FILES) {
    const src  = path.join(SRC_DIR, name);
    const dest = path.join(DEST_DIR, name);
    if (!fs.existsSync(src)) {
      throw new Error(`Legal source missing: ${src}. Did the file move or get renamed?`);
    }
    const body = fs.readFileSync(src, 'utf-8');
    if (body.length < 200) {
      throw new Error(`${name} suspiciously small (${body.length} chars). Refusing to sync.`);
    }
    fs.writeFileSync(dest, body, 'utf-8');
    synced++;
  }

  fs.writeFileSync(
    path.join(DEST_DIR, 'README.md'),
    [
      '# client/src/legal',
      '',
      'Generated copies of the canonical legal documents that live at',
      '`/legal/` in the repo root. Synced via `npm run legal:sync` from the',
      'client directory. Do NOT edit these files directly — edits will be',
      'overwritten by the next sync. Author the documents in `/legal/` and',
      'run the sync script before committing.',
      '',
      'These copies exist so vite/rollup can resolve the markdown imports',
      'when the docker build context is `./client` only (the canonical',
      "`legal/` folder is outside that context). Local dev builds don't",
      'need this — vite has access to the full repo tree.',
      '',
    ].join('\n')
  );

  console.log(`[legal:sync] copied ${synced} legal files: legal/ -> client/src/legal/`);
}

main();

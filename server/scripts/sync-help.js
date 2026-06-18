#!/usr/bin/env node
'use strict';

/**
 * scripts/sync-help.js
 * --------------------
 * Copies the 9 per-module help markdown files from `docs/help/<slug>.md`
 * (repo root) into `server/data/help/<slug>.txt` so the docker build
 * context (which is `./server`) can include them.
 *
 * Same shape and rationale as sync-ai-guide.js:
 *   - Docker COPY can't follow symlinks out of the build context.
 *   - server/.dockerignore excludes `*.md`, so we rename to .txt to
 *     dodge that exclusion without weakening it.
 *
 * Authoring stays at `docs/help/*.md` so humans read help-doc source the
 * same way they read the rest of the docs/ tree. CI does not regenerate
 * this — commit the synced artifacts so the build is reproducible.
 *
 * Usage:
 *   npm run help:sync
 */

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR   = path.join(REPO_ROOT, 'docs', 'help');
const DEST_DIR  = path.join(REPO_ROOT, 'server', 'data', 'help');

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    throw new Error(`Help source missing at ${SRC_DIR}. Did docs/help/ move?`);
  }

  fs.mkdirSync(DEST_DIR, { recursive: true });

  const entries = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.md'));
  if (entries.length === 0) {
    throw new Error(`No .md files in ${SRC_DIR}. Help sync would produce an empty image — aborting.`);
  }

  let total = 0;
  for (const fname of entries) {
    const src  = path.join(SRC_DIR, fname);
    const body = fs.readFileSync(src, 'utf-8');
    if (body.length < 200) {
      throw new Error(`${fname} is suspiciously small (${body.length} chars). Refusing to sync — fix the source.`);
    }
    const destName = fname.replace(/\.md$/, '.txt');
    fs.writeFileSync(path.join(DEST_DIR, destName), body, 'utf-8');
    total += body.length;
  }

  // Operator-facing sidecar so anyone poking around in server/data/help/
  // knows the files are generated, not hand-edited.
  fs.writeFileSync(
    path.join(DEST_DIR, 'README.md'),
    [
      '# server/data/help',
      '',
      'Generated artifacts that ship inside the servicecycle-server docker image.',
      'Source of truth: `docs/help/*.md` at the repo root. Re-sync after every',
      'edit via `npm run help:sync`. Commit the synced files alongside source.',
      '',
      'The `.txt` extension dodges the `*.md` exclude in `server/.dockerignore`',
      'without weakening the rule for stray notes elsewhere in the build context.',
      '',
    ].join('\n')
  );

  console.log(`[help:sync] synced ${entries.length} modules (${total} chars total) -> server/data/help/`);
}

main();

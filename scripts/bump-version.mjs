#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// bump-version.mjs — bump client + server package versions in lockstep (patch).
//
// WHY: the from-source demo deploy (docker-compose.yml) does NOT inject
// SERVICECYCLE_VERSION, so the version-skew "Reload now" banner only works when
// the package version actually moves on each deploy AND the client build-id
// (baked as v<pkg.version>) matches what the server reports at /api/config
// (which falls back to 'v'+<server pkg.version> when the env var is unset).
// Keeping both packages EQUAL and INCREMENTED each deploy makes the banner fire
// for any tab still on the old bundle, and prevents a false banner on fresh
// loads. This routes around the basic-auth-gated /sw.js (the banner polls /api).
//
// USAGE (run as step 0 of every deploy, before the deploy commit):
//   node scripts/bump-version.mjs        (or:  npm run bump)
// then `git commit` (the 4 version files are already staged) and deploy.
// ─────────────────────────────────────────────────────────────────────────────
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readVersion = (d) =>
  JSON.parse(readFileSync(join(root, d, 'package.json'), 'utf8')).version;
const parse = (v) => v.split('.').map((n) => parseInt(n, 10));

const client = parse(readVersion('client'));
const server = parse(readVersion('server'));
// Take the higher of the two so a prior drift never causes a downgrade.
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const [maj, min, pat] = cmp(client, server) >= 0 ? client : server;
const next = `${maj}.${min}.${pat + 1}`;

for (const dir of ['client', 'server']) {
  console.log(`bumping ${dir} -> ${next}`);
  execSync(`npm version ${next} --no-git-tag-version --allow-same-version`, {
    cwd: join(root, dir),
    stdio: 'inherit',
  });
}

// Stage the version files so the deploy commit includes them automatically.
execSync(
  'git add client/package.json client/package-lock.json server/package.json server/package-lock.json',
  { cwd: root, stdio: 'inherit' },
);

console.log(`\n✓ client + server bumped to ${next} and staged. Commit + deploy as usual.`);

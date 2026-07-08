'use strict';

// scripts/verify-ignore-scripts-build.js
// -----------------------------------------------------------------------
// One-shot functional check for the 2026-07-08 ignore-scripts=true change
// (server/.npmrc). Exercises the three production dependencies whose
// install/postinstall scripts get skipped by ignore-scripts and are instead
// re-run explicitly via `npm rebuild <pkgs> --foreground-scripts` in the
// Dockerfile (see server/Dockerfile comment on the `npm ci` line):
//   - sharp            (native libvips binary)
//   - tsx / esbuild     (tsx's transform engine binary)
//   - @prisma/client    (query-engine binary, needs a real DB round trip)
//
// Not wired into any npm script or CI job -- this is a throwaway
// verification tool, run once by hand (via `docker compose run`) against a
// freshly built image before deploying the ignore-scripts change, then safe
// to delete or leave inert.
//
// Exits 0 with "ALL_OK" on success, exits 1 and prints which check failed
// otherwise.

async function main() {
  const sharp = require('sharp');
  // tsx's package.json "exports" map only exposes the "./cli" subpath
  // specifier (require.resolve('tsx/cli')) for package-name resolution --
  // the Dockerfile's actual CMD deliberately bypasses that and requires the
  // raw file path (node_modules/tsx/dist/cli.mjs) directly, which sidesteps
  // "exports" restrictions entirely. Check existence the same way the real
  // boot path does, via fs, rather than require.resolve.
  const fs = require('fs');
  const tsxCliPath = require.resolve('tsx/package.json').replace('package.json', 'dist/cli.mjs');
  if (!fs.existsSync(tsxCliPath)) throw new Error('tsx cli.mjs missing at ' + tsxCliPath);
  console.log('TSX_RESOLVE_OK', tsxCliPath);

  const png = await sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();
  console.log('SHARP_OK bytes=' + png.length);

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw`SELECT 1 as ok`;
    console.log('PRISMA_OK', JSON.stringify(rows));
  } finally {
    await prisma.$disconnect();
  }

  console.log('ALL_OK');
}

main().catch((err) => {
  console.error('VERIFY_FAILED', err);
  process.exit(1);
});

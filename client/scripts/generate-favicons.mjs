// generate-favicons.mjs -- regenerate the root favicon binaries from the
// canonical ServiceCycle mark in public/favicon.svg (petrol tile + cyan->lime
// maintenance pulse). Replaces the stale ServiceCycle-template binaries.
//
//   npm i --no-save png-to-ico   (sharp is already a devDependency)
//   node scripts/generate-favicons.mjs
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const svg = readFileSync(path.join(pub, 'favicon.svg'));

async function png(size, outName) {
  const out = path.join(pub, outName);
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out);
  console.log('wrote', outName);
}

await png(16, 'favicon-16.png');
await png(32, 'favicon-32.png');
await png(48, 'favicon-48.png');
await png(180, 'apple-touch-icon.png');

// Multi-size .ico from freshly rendered 16/32/48 buffers.
const bufs = await Promise.all([16, 32, 48].map((s) =>
  sharp(svg, { density: 384 }).resize(s, s).png().toBuffer()
));
const ico = await pngToIco(bufs);
writeFileSync(path.join(pub, 'favicon.ico'), ico);
console.log('wrote favicon.ico', ico.length, 'bytes');

// generate-pwa-icons.mjs — render public/icons/icon.svg to the PNG sizes the
// PWA manifest needs (Safari/iOS doesn't accept SVG manifest icons).
//
// PLACEHOLDER ICON: the current icon.svg is a stand-in (dark slate rounded
// square + white lightning bolt) pending real logo selection. When the logo
// lands, replace public/icons/icon.svg and re-run:
//
//   node scripts/generate-pwa-icons.mjs
//
// sharp is a devDependency used only by this script (never bundled).
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.join(here, '..', 'public', 'icons');
const svg = readFileSync(path.join(iconsDir, 'icon.svg'));

for (const size of [192, 512]) {
  const out = path.join(iconsDir, `icon-${size}.png`);
  await sharp(svg, { density: 300 })
    .resize(size, size)
    .png()
    .toFile(out);
  console.log(`wrote ${out}`);
}

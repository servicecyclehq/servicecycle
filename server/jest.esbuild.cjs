// Jest transformer backed by esbuild (already a dependency; same engine tsx
// uses at runtime). Strips TypeScript types and converts ESM import/export to
// CommonJS so Jest can load the server's .ts modules. No type-checking — that
// stays with `npm run type-check` (tsc --noEmit).
const esbuild = require('esbuild');

module.exports = {
  process(src, filename) {
    const loader = filename.endsWith('.tsx') ? 'tsx'
      : filename.endsWith('.ts') ? 'ts'
      : filename.endsWith('.jsx') ? 'jsx'
      : 'js';
    const result = esbuild.transformSync(src, {
      loader,
      format: 'cjs',
      target: 'node20',
      sourcemap: 'inline',
      sourcefile: filename,
    });
    return { code: result.code, map: result.map };
  },
};

/**
 * tests/chipTokens.test.js
 * ------------------------
 * Tripwire for DEMO_FIXES 1.3 / 3.2 (pill/badge text contrast).
 *
 * Root cause of the original bug: client/src/index.css declared the
 * --chip-*-fg/bg tokens TWICE at the same :root / [data-theme="dark"]
 * specificity. The later block won the cascade, so the 2026-06-11 "A2"
 * WCAG-AA darkening of the light-mode chip inks was silently dead code and
 * the pills kept rendering the lighter 500/600-series values (#dc2626 red,
 * #d97706 amber, ...) the punch list called out as low-contrast/harsh.
 *
 * Two invariants, no DB and no DOM needed (reads the stylesheet as text,
 * same pattern as seedCoherence.test.js):
 *   1. Every --chip-* token is declared exactly ONCE per theme scope, so a
 *      re-introduced duplicate can never silently shadow the real values.
 *   2. Every declared fg/bg pair clears WCAG AA (>= 4.5:1) in both themes.
 */

const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '..', '..', 'client', 'src', 'index.css');
const css = fs.readFileSync(CSS_PATH, 'utf8');

// Strip comments so commented-out declarations can neither trip the
// duplicate check nor satisfy the presence check.
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Collect --chip-* declarations with the scope of the nearest preceding
 *  :root / [data-theme="dark"] block header. The chip tokens live in
 *  top-level theme blocks (not @media), so this text-level scoping is exact
 *  for the shapes this file actually uses. */
function chipDecls(src) {
  const headers = [];
  const hre = /(:root|\[data-theme="dark"\])\s*\{/g;
  let h;
  while ((h = hre.exec(src))) headers.push({ idx: h.index, scope: h[1] === ':root' ? 'light' : 'dark' });
  const decls = [];
  const dre = /(--chip-[a-z][a-z-]*-(?:fg|bg))\s*:\s*([^;]+);/g;
  let m;
  while ((m = dre.exec(src))) {
    let scope = 'unknown';
    for (const hd of headers) { if (hd.idx < m.index) scope = hd.scope; else break; }
    decls.push({ token: m[1], value: m[2].trim(), scope });
  }
  return decls;
}

// ── WCAG relative luminance / contrast ──────────────────────────────────────
function parseColor(v) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (hex) {
    let s = hex[1];
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16), a: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v.trim());
  if (rgba) return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] == null ? 1 : +rgba[4] };
  return null;
}
// Translucent chip bgs paint over the theme surface; composite before measuring.
const SURFACE = { light: { r: 255, g: 255, b: 255 }, dark: { r: 19, g: 23, b: 31 } }; // #fff / #13171f (--color-card)
function composite(c, scope) {
  if (c.a >= 1) return c;
  const s = SURFACE[scope] || SURFACE.light;
  return { r: c.r * c.a + s.r * (1 - c.a), g: c.g * c.a + s.g * (1 - c.a), b: c.b * c.a + s.b * (1 - c.a), a: 1 };
}
function luminance(c) {
  const lin = (u) => { const x = u / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}
function contrast(fg, bg) {
  const l1 = luminance(fg); const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const decls = chipDecls(cssNoComments);

describe('chip token declarations (DEMO_FIXES 1.3/3.2)', () => {
  test('every --chip-* token is declared exactly once per theme scope', () => {
    const seen = new Map();
    for (const d of decls) {
      const key = `${d.scope}:${d.token}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
    expect(dupes).toEqual([]);
  });

  test('the full chip palette exists in both scopes', () => {
    const colors = ['red', 'amber', 'orange', 'green', 'blue', 'slate', 'slate-soft', 'purple'];
    const missing = [];
    for (const scope of ['light', 'dark']) {
      for (const c of colors) {
        for (const part of ['fg', 'bg']) {
          if (!decls.some((d) => d.scope === scope && d.token === `--chip-${c}-${part}`)) {
            missing.push(`${scope}:--chip-${c}-${part}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('every fg/bg pair clears WCAG AA (>= 4.5:1) in both themes', () => {
    const failures = [];
    for (const scope of ['light', 'dark']) {
      const inScope = decls.filter((d) => d.scope === scope);
      const bases = [...new Set(inScope.map((d) => d.token.replace(/-(fg|bg)$/, '')))];
      for (const base of bases) {
        // Cascade semantics: the LAST declaration in source order wins, so
        // measure the pair the browser will actually paint.
        const fgD = inScope.filter((d) => d.token === `${base}-fg`).pop();
        const bgD = inScope.filter((d) => d.token === `${base}-bg`).pop();
        if (!fgD || !bgD) continue; // presence covered by the test above
        const fg = parseColor(fgD.value);
        const bg = parseColor(bgD.value);
        expect(fg).not.toBeNull();
        expect(bg).not.toBeNull();
        const ratio = contrast(composite(fg, scope), composite(bg, scope));
        if (ratio < 4.5) failures.push(`${scope} ${base}: ${fgD.value} on ${bgD.value} = ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });
});

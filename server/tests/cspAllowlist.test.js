'use strict';

/**
 * L6: CSP allowlist for *.servicecycle.app on connect-src, img-src, font-src.
 *
 * Static-source assertion. The cspDirectives object lives in server/index.ts
 * which is the boot file (not safely require-able in a unit test because it
 * binds the port). We read the source and assert the literal allowlist
 * entries are present — same pattern as the F010 audit test in
 * audit-2026-05-03.test.js.
 *
 * If you refactor cspDirectives into its own module, replace this with a
 * direct require + deep-equality check.
 */

const fs = require('fs');
const path = require('path');

describe('L6: CSP allowlist *.servicecycle.app on connect-src / img-src / font-src', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'index.ts'),
    'utf8',
  );

  // Find the cspDirectives = { ... } block so we don't false-positive on a
  // stray comment or unrelated reference further down the file.
  const blockMatch = src.match(/const\s+cspDirectives\s*=\s*\{([\s\S]*?)\};/);
  const block = blockMatch ? blockMatch[1] : '';

  test('cspDirectives block present in server/index.ts', () => {
    expect(block.length).toBeGreaterThan(0);
  });

  test('imgSrc includes https://*.servicecycle.app', () => {
    expect(block).toMatch(/imgSrc[\s\S]*?'https:\/\/\*\.servicecycle\.com'/);
  });

  test('connectSrc includes https://*.servicecycle.app', () => {
    expect(block).toMatch(/connectSrc[\s\S]*?'https:\/\/\*\.servicecycle\.com'/);
  });

  test('fontSrc includes https://*.servicecycle.app', () => {
    expect(block).toMatch(/fontSrc[\s\S]*?'https:\/\/\*\.servicecycle\.com'/);
  });

  test("scriptSrc deliberately stays 'self' only — no marketing JS", () => {
    // Pull just the scriptSrc line so a future addition to other directives
    // doesn't poison the assertion.
    const line = block.match(/scriptSrc[^\n]*/)[0];
    expect(line).toMatch(/'self'/);
    expect(line).not.toMatch(/servicecycle\.com|lapseiq\.com/);
  });

  test('no stale lapseiq.com hosts survive in the CSP block', () => {
    expect(block).not.toMatch(/lapseiq\.com/);
  });
});

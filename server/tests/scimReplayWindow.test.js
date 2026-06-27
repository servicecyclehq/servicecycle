'use strict';

/**
 * DD-8-5 — SCIM signature replay-window semantics.
 *
 * isFreshTimestamp is the freshness gate behind the SCIM webhook. The footgun
 * being guarded against is an operator setting SCIM_WEBHOOK_TOLERANCE_MS=0
 * (mis-read as "no limit") which DISABLES the window. The route-level clamp
 * (ssoScim.ts) refuses to honor a sub-floor value silently; here we lock in the
 * underlying helper's contract so a reviewer can see exactly what "disabled"
 * means and that a fresh/stale timestamp is judged correctly when a real window
 * is in force.
 */

const path = require('path');
const { isFreshTimestamp } = require(path.join(__dirname, '..', 'lib', 'scim.ts'));

describe('scim isFreshTimestamp (DD-8-5)', () => {
  const NOW = Date.now();

  test('a timestamp inside the window is fresh', () => {
    expect(isFreshTimestamp(NOW - 1000, 900000)).toBe(true);
  });

  test('a timestamp outside the window is stale', () => {
    expect(isFreshTimestamp(NOW - 2_000_000, 900000)).toBe(false);
  });

  test('null/non-finite timestamp is stale when a window is enforced', () => {
    expect(isFreshTimestamp(null, 900000)).toBe(false);
    expect(isFreshTimestamp(Number.NaN, 900000)).toBe(false);
  });

  test('tolerance <= 0 means the window is DISABLED (always fresh) — the footgun', () => {
    // This is precisely why ssoScim.ts refuses to pass 0 silently: 0 here is an
    // open door. The route clamps sub-floor values up and only honors an
    // explicit SCIM_WEBHOOK_TOLERANCE_DISABLE=true.
    expect(isFreshTimestamp(NOW - 10_000_000, 0)).toBe(true);
    expect(isFreshTimestamp(null, -1)).toBe(true);
  });
});

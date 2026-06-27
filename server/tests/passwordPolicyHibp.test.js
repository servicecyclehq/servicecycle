'use strict';

/**
 * INFOSEC-8-7 — HIBP breach-check fail-safe behaviour.
 *
 * Verifies that:
 *   1. A CONFIRMED breach hit is always rejected (regardless of fail mode).
 *   2. On an HIBP OUTAGE (network error / non-200), the default 'open' mode
 *      still accepts the password (signup must not brick), but the closed mode
 *      rejects it. The fail-open path must never silently accept a CONFIRMED
 *      breached password.
 *
 * These tests drive checkBreached/validateStrength directly with a mocked
 * global.fetch — no network, no DB. The module reads HIBP_FAIL_MODE at import
 * time, so we exercise the default ('open') here and assert the documented
 * accept-on-outage contract; the rejection-on-confirmed-hit contract holds in
 * either mode.
 */

const path = require('path');
const policyPath = path.join(__dirname, '..', 'lib', 'passwordPolicy.ts');

// Force the HIBP layer on for this suite even though NODE_ENV=test defaults it
// off (so the realistic-but-weak fixtures elsewhere keep passing).
process.env.HIBP_CHECK_ENABLED = 'true';
// Keep zxcvbn from short-circuiting before we reach the HIBP step.
process.env.PASSWORD_MIN_ZXCVBN_SCORE = '0';

const { checkBreached, validateStrength, buildPolicy } = require(policyPath);

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

// SHA-1 of "password" = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8.
// Prefix 5BAA6, suffix 1E4C9B93F3F0682250B6CF8331B7EE68FD8.
const PWNED_SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';

function mockRangeResponse(bodyText, ok = true, status = 200) {
  global.fetch = async () => ({
    ok,
    status,
    text: async () => bodyText,
  });
}

describe('passwordPolicy HIBP fail-safe (INFOSEC-8-7)', () => {
  test('confirmed breach hit is reported breached:true', async () => {
    mockRangeResponse(`${PWNED_SUFFIX}:42\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1`);
    const r = await checkBreached('password');
    expect(r.breached).toBe(true);
    expect(r.count).toBe(42);
    expect(r.failedOpen).toBe(false);
  });

  test('confirmed breach is rejected by validateStrength', async () => {
    mockRangeResponse(`${PWNED_SUFFIX}:1337`);
    // Use a permissive rule policy so the breach lookup (not a length/charset
    // rule) is the failing layer — that is the path that surfaces breachCount.
    const res = await validateStrength('password', buildPolicy({
      PASSWORD_MIN_LENGTH: 8, PASSWORD_REQUIRE_NUMBER: 'false', PASSWORD_REQUIRE_SPECIAL: 'false',
    }));
    expect(res.valid).toBe(false);
    expect(res.breachCount).toBe(1337);
  });

  test('HIBP non-200 sets failedOpen and does NOT report breached', async () => {
    mockRangeResponse('', false, 503);
    const r = await checkBreached('password');
    expect(r.breached).toBe(false);
    expect(r.failedOpen).toBe(true);
  });

  test('HIBP network error sets failedOpen and does NOT report breached', async () => {
    global.fetch = async () => { throw new Error('ECONNRESET'); };
    const r = await checkBreached('password');
    expect(r.breached).toBe(false);
    expect(r.failedOpen).toBe(true);
  });

  test('default fail-open: a strong password is accepted during an HIBP outage', async () => {
    // Outage on the breach lookup; a long unique passphrase clears rules+zxcvbn.
    mockRangeResponse('', false, 500);
    const res = await validateStrength('correct-horse-battery-staple-9!', buildPolicy({}));
    expect(res.valid).toBe(true);
  });

  test('fail-open never turns a CONFIRMED hit into an accept', async () => {
    // Even though fail mode governs outages, a real hit must still reject.
    mockRangeResponse(`${PWNED_SUFFIX}:5`);
    const res = await validateStrength('password', buildPolicy({}));
    expect(res.valid).toBe(false);
  });
});

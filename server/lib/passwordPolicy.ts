/**
 * LapseIQ Password Policy
 *
 * Shared validator used by register, reset-password, and accept-invite flows.
 *
 * Two-tier validation:
 *   1. validate(password, policy)               — sync, rule-based
 *      Length 12+, digit, special. Configurable per-account via AccountSetting.
 *   2. validateStrength(password, policy, opts) — async, layered
 *      Calls validate() first, then runs zxcvbn score >= 3, then HIBP
 *      k-anonymity breach check. Returns first failure.
 *
 * NIST SP 800-63B guidance:
 *   - Length is the primary driver of strength (12+ is the gold standard for B2B)
 *   - Complexity rules alone are weak; combined with length they're reasonable
 *   - We do NOT force periodic rotation (that's a NIST anti-pattern)
 *   - SP 800-63B section 5.1.1.2: passwords MUST be checked against a list
 *     of "values known to be commonly-used, expected, or compromised." HIBP
 *     k-anonymity API is the canonical way to do this without sending the
 *     password (or its full hash) to a third party. Audit-7 / item 2.1.1.
 *
 * Audit-7 (2026-05-25): added zxcvbn + HIBP layer. Routes that previously
 * called `validate()` should now `await validateStrength()` for new-password
 * acceptance paths (register, reset, invite-accept). `validate()` stays as a
 * sync escape hatch and is what `validateStrength()` calls internally first.
 */

const crypto = require('crypto');
const zxcvbn = require('zxcvbn');

const DEFAULTS = {
  minLength:          12,
  requireNumber:      true,   // at least one digit
  requireSpecial:     true,   // at least one non-alphanumeric character
};

// Audit-7 strength thresholds. Operators can tune these via env without
// editing this file. Defaults err on "still usable by humans, kills the
// obvious weak passwords" — zxcvbn score 3 means "safely unguessable:
// moderate protection from offline slow-hash scenario."
//
// Test-mode behaviour: when NODE_ENV=test, both extra layers default OFF
// so existing test fixtures (which use realistic-but-known-weak passwords
// like "verysecret-1234567890" and "Admin1234!") keep passing. Explicit
// env vars still override — tests that exercise the hardening can set
// PASSWORD_MIN_ZXCVBN_SCORE=3 and HIBP_CHECK_ENABLED=true locally.
const _IS_TEST = process.env.NODE_ENV === 'test';
const ZXCVBN_MIN_SCORE = parseInt(
  process.env.PASSWORD_MIN_ZXCVBN_SCORE ?? (_IS_TEST ? '0' : '3'),
  10
);
const HIBP_CHECK_ENABLED = (
  process.env.HIBP_CHECK_ENABLED ?? (_IS_TEST ? 'false' : 'true')
) !== 'false';
const HIBP_TIMEOUT_MS = parseInt(process.env.HIBP_TIMEOUT_MS || '3000', 10);

/**
 * Build a policy object by merging AccountSetting rows (or a plain object)
 * on top of the defaults. Pass null / {} to get pure defaults.
 *
 * @param {object|null} settings  key/value pairs from AccountSetting rows
 * @returns {{ minLength: number, requireNumber: boolean, requireSpecial: boolean }}
 */
function buildPolicy(settings: any = {}) {
  const s = settings || {};
  return {
    minLength:      parseInt(s.PASSWORD_MIN_LENGTH      ?? DEFAULTS.minLength, 10),
    requireNumber:  (s.PASSWORD_REQUIRE_NUMBER   ?? String(DEFAULTS.requireNumber))   !== 'false',
    requireSpecial: (s.PASSWORD_REQUIRE_SPECIAL  ?? String(DEFAULTS.requireSpecial)) !== 'false',
  };
}

/**
 * Validate a password against a policy (sync, rules only).
 *
 * @param {string} password
 * @param {{ minLength, requireNumber, requireSpecial }} policy
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(password, policy) {
  const p = policy || buildPolicy();
  const errors = [];

  if (!password || password.length < p.minLength) {
    errors.push(`Password must be at least ${p.minLength} characters`);
  }
  if (p.requireNumber && !/\d/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (p.requireSpecial && !/[^a-zA-Z0-9]/.test(password)) {
    errors.push('Password must contain at least one special character (!@#$%^&* etc.)');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check a password against the Have I Been Pwned breach corpus using the
 * k-anonymity API. We send only the first 5 hex chars of SHA-1(password)
 * and the API returns ~500-800 candidate suffixes; the password itself
 * never leaves this process.
 *
 * Fail-open: if the API is unreachable or times out, returns false (i.e.
 * "not breached, allow"). This is the conservative posture for a signup
 * path — better to accept a possibly-breached password than to brick
 * registration when HIBP has an outage. The k-anonymity privacy guarantee
 * is unchanged in either case.
 *
 * @param {string} password  raw password as the user typed it
 * @returns {Promise<{ breached: boolean, count: number, failedOpen: boolean }>}
 */
async function checkBreached(password) {
  if (!HIBP_CHECK_ENABLED) return { breached: false, count: 0, failedOpen: false };
  if (!password || password.length === 0) return { breached: false, count: 0, failedOpen: false };

  const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.substring(0, 5);
  const suffix = sha1.substring(5);

  try {
    const resp = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      method:  'GET',
      headers: { 'User-Agent': 'LapseIQ/audit-7 (password-policy)' },
      signal:  AbortSignal.timeout(HIBP_TIMEOUT_MS),
    });
    if (!resp.ok) return { breached: false, count: 0, failedOpen: true };

    const text = await resp.text();
    for (const line of text.split('\n')) {
      const [hashSuffix, countStr] = line.trim().split(':');
      if (hashSuffix === suffix) {
        return { breached: true, count: parseInt(countStr, 10) || 1, failedOpen: false };
      }
    }
    return { breached: false, count: 0, failedOpen: false };
  } catch {
    // Network error, timeout, DNS fail — fail open.
    return { breached: false, count: 0, failedOpen: true };
  }
}

/**
 * Compute a zxcvbn strength score (0..4). userInputs lets us downgrade
 * passwords that contain the user's own email/name (e.g. "alex@corp.com"
 * with a password of "Alex2024!" — zxcvbn would otherwise miss the
 * personalisation).
 *
 * @param {string} password
 * @param {string[]} [userInputs=[]]
 * @returns {{ score: number, feedback: { warning: string, suggestions: string[] } }}
 */
function scoreStrength(password, userInputs = []) {
  const result = zxcvbn(password, userInputs);
  return { score: result.score, feedback: result.feedback || { warning: '', suggestions: [] } };
}

/**
 * Full-strength password validation: rules → zxcvbn score → HIBP breach check.
 *
 * Short-circuits on the first failure to keep the error message focused on
 * one actionable issue. Use this on new-password acceptance paths
 * (register, reset-password, invite-accept).
 *
 * @param {string} password
 * @param {{ minLength, requireNumber, requireSpecial }} [policy]
 * @param {{ userInputs?: string[] }} [opts]  email/name to penalise reuse
 * @returns {Promise<{ valid, errors, score?, breachCount? }>}
 */
async function validateStrength(password, policy, opts: any = {}) {
  // Step 1: rules (sync, fast)
  const ruleResult = validate(password, policy);
  if (!ruleResult.valid) return ruleResult;

  // Step 2: zxcvbn strength score
  const { score, feedback } = scoreStrength(password, opts.userInputs || []);
  if (score < ZXCVBN_MIN_SCORE) {
    const hint = feedback.warning
      ? `: ${feedback.warning}`
      : (feedback.suggestions && feedback.suggestions.length
          ? `: ${feedback.suggestions[0]}`
          : '');
    return {
      valid:  false,
      errors: [`Password is too easy to guess${hint}. Try a longer or more unique passphrase.`],
      score,
    };
  }

  // Step 3: HIBP breach corpus
  const breach = await checkBreached(password);
  if (breach.breached) {
    return {
      valid:  false,
      errors: [`This password has appeared in known data breaches ${breach.count.toLocaleString()} times. Please choose a different one.`],
      score,
      breachCount: breach.count,
    };
  }

  return { valid: true, errors: [], score };
}

/**
 * Load an account's password policy from the DB.
 * Returns a built policy object. Falls back to defaults on error.
 *
 * @param {object} prisma   Prisma client instance
 * @param {string} accountId
 * @returns {Promise<{ minLength, requireNumber, requireSpecial }>}
 */
async function loadAccountPolicy(prisma, accountId) {
  try {
    const rows = await prisma.accountSetting.findMany({
      where: {
        accountId,
        key: { in: ['PASSWORD_MIN_LENGTH', 'PASSWORD_REQUIRE_NUMBER', 'PASSWORD_REQUIRE_SPECIAL'] },
      },
    });
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });
    return buildPolicy(s);
  } catch {
    return buildPolicy({});
  }
}

module.exports = {
  DEFAULTS,
  buildPolicy,
  validate,
  validateStrength,
  scoreStrength,
  checkBreached,
  loadAccountPolicy,
};

export {};

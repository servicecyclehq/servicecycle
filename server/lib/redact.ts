/**
 * Log-redaction helpers for PII.
 *
 * Audit-7 / item 3.1.3: the GDPR-survival pass on the audit log (v0.67.x)
 * addressed structured-row PII. This module covers the OTHER surface --
 * free-form console / logger output that quoted user emails verbatim,
 * notably the auth.js login-lockout warn line and the alertEngine cron
 * digest progress logs. Goal: log entries are still actionable for an
 * operator triaging an incident, but a raw log dump no longer enumerates
 * every customer email.
 *
 * Format choices:
 *   - Email: first letter + asterisks + domain --> "d***@gmail.com".
 *     Keeps the domain visible (useful for "are these all from the same
 *     workspace?" pattern matching) while making per-user recovery from
 *     the log alone infeasible.
 *   - Token: shows the leading 4 chars + ellipsis + trailing 4 chars
 *     for traceability with the DB row, never enough to reconstruct.
 *   - Generic redactPii(): walks an object shallowly and rewrites
 *     `email` / `token` / `refreshToken` / `password` keys. Useful when
 *     dumping a partial request body for debugging.
 *
 * Bypass for tests / local debug: REDACT_PII=false disables masking so
 * jest fixture comparisons or local development can see raw values.
 * Defaults to ON (true) in all environments including test -- tests that
 * assert on log content should mask their fixtures the same way prod
 * will.
 */

const REDACT_ENABLED = (process.env.REDACT_PII ?? 'true') !== 'false';

function redactEmail(email) {
  if (!REDACT_ENABLED) return email;
  if (typeof email !== 'string' || !email.includes('@')) return email;
  const [local, domain] = email.split('@', 2);
  if (!local || !domain) return email;
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.min(local.length - 1, 6))}@${domain}`;
}

function redactToken(token) {
  if (!REDACT_ENABLED) return token;
  if (typeof token !== 'string' || token.length < 12) return '***';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

const SENSITIVE_KEYS = new Set([
  'email', 'password', 'token', 'refreshToken', 'twoFactorSecret',
  'passwordHash', 'passwordResetToken', 'apiKey', 'authorization',
]);

function redactPii(obj) {
  if (!REDACT_ENABLED) return obj;
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    const kLower = k.toLowerCase();
    if (kLower === 'email' && typeof v === 'string') {
      out[k] = redactEmail(v);
    } else if (SENSITIVE_KEYS.has(k) || SENSITIVE_KEYS.has(kLower)) {
      out[k] = typeof v === 'string' ? redactToken(v) : '[redacted]';
    } else if (v && typeof v === 'object') {
      out[k] = redactPii(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { redactEmail, redactToken, redactPii };

export {};

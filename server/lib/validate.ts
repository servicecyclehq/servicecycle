/**
 * (B6) zod schema validation helper.
 *
 * Usage in route handlers:
 *
 *   const { z } = require('zod');
 *   const { validateBody } = require('../lib/validate');
 *
 *   const LoginSchema = z.object({
 *     email:    z.string().email().max(254),
 *     password: z.string().min(1).max(200),
 *   });
 *
 *   router.post('/login', credentialLimiter, async (req, res) => {
 *     const parsed = validateBody(req, res, LoginSchema);
 *     if (!parsed) return; // helper already sent the 400
 *     const { email, password } = parsed;
 *     // ... existing handler ...
 *   });
 *
 * The helper sends a 400 response with a `field` hint pointing at the FIRST
 * failing field so the operator's error log gets a single actionable line
 * rather than a full Zod error tree. Returns null when validation fails so
 * the caller can early-return; returns the parsed object on success.
 *
 * We intentionally do NOT use zod everywhere — only on:
 *   - auth + password endpoints (untrusted, anonymous traffic)
 *   - the highest-traffic write endpoints (POST /contracts, PUT /contracts/:id)
 *   - admin-only write endpoints that mutate identity (POST /users)
 *
 * Read endpoints and infrequent admin tools are deliberately not validated
 * here — overdoing it lengthens diffs and makes future schema changes painful.
 */

function validateBody(req, res, schema) {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) return result.data;

  // Surface ONE error — Zod returns a list, but operator logs (and the
  // user-facing 400 toast) are easier to read when we name a single field.
  const firstIssue = result.error.issues[0];
  const field = firstIssue?.path?.join('.') || 'body';
  const reason = firstIssue?.message || 'Invalid value';

  res.status(400).json({
    success: false,
    error:   `Invalid ${field}: ${reason}`,
    field,                                // machine-readable for client form highlighting
  });
  return null;
}

// ── Shared schema helpers ───────────────────────────────────────────────────
// Centralizing these here so every route validates UUIDs and empty-string
// numerics the same way.

const { z } = require('zod');

/**
 * Format-only UUID validator. zod's built-in `.uuid()` enforces a strict
 * version-4 layout, which rejects the all-zero seed UUIDs we use in dev
 * (`00000000-0000-0000-0000-000000000020`) — the third group's first nibble
 * is `0`, not 1-5, so v4 strictness fails. Real-world `crypto.randomUUID()`
 * keeps producing v4 IDs that pass this regex unchanged.
 */
const UuidStr = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'Invalid UUID format'
  );

/**
 * Preprocess that maps empty strings to `undefined` so `.optional()` matches.
 * The SPA serializes blank form inputs as `""`; without this, every optional
 * numeric/date field on a contract would need to be filled or the POST 400s.
 */
const emptyToUndef = (v) => (v === '' ? undefined : v);

module.exports = { validateBody, UuidStr, emptyToUndef };

export {};

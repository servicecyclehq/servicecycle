/**
 * safeSearch.js — sanitiser for free-text values passed into Prisma
 * `contains` / `startsWith` / `endsWith` string matchers.
 *
 * Why this exists (v0.37.1 W5 MT-131):
 *   Prisma's string filters compile to Postgres LIKE / ILIKE, which treat
 *   `%` and `_` as wildcards. Prisma does NOT escape user-supplied values
 *   before substitution. A hostile caller can ship `%_%_%_%_%_%_%_%_%`
 *   into a `?vendor=` query param and force Postgres into a deep pattern
 *   scan that holds the connection for orders of magnitude longer than a
 *   normal search — a pattern-DoS surface.
 *
 *   Pass-6 Lens-3 (Cluster D) flagged this against the public API
 *   `/api/v1/contracts?vendor=` endpoint. This helper closes the gap
 *   wherever else we pipe free-text into `contains:`.
 *
 * Behaviour:
 *   - Drops `%` and `_` outright (we don't need them — vendor names,
 *     contract numbers, product names don't legitimately contain them).
 *   - Drops backslash because that's the Postgres escape char and
 *     accepting it would just shift the problem.
 *   - Hard-caps the length at 80 chars by default; callers can override
 *     for the rare legitimately-long field.
 *   - Trims leading/trailing whitespace; collapses runs of whitespace
 *     to a single space so " foo   bar " and "foo bar" match the same
 *     contracts (intuitive matching behaviour).
 *
 * Returns the sanitised string, or null if the input wasn't a string or
 * sanitised to empty. Callers should treat null as "no filter".
 */

'use strict';

const DEFAULT_MAX = 80;

function sanitiseLikeValue(raw, maxLen = DEFAULT_MAX) {
  if (typeof raw !== 'string') return null;
  // Strip LIKE/ILIKE wildcards + the backslash escape char.
  let v = raw.replace(/[%_\\]/g, '');
  // Collapse whitespace + trim.
  v = v.replace(/\s+/g, ' ').trim();
  if (!v) return null;
  // Cap the length so we never push pathological-length inputs to the DB.
  if (v.length > maxLen) v = v.slice(0, maxLen);
  return v;
}

module.exports = { sanitiseLikeValue };

export {};

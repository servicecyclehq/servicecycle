'use strict';

/**
 * apiIdempotency.ts -- Phase 3 #7 idempotency for public-API writes.
 *
 * A CMMS retrying a POST (network blip, at-least-once delivery) must not create
 * a duplicate work order. The caller passes `Idempotency-Key: <opaque>`; we
 * store the response keyed by (accountId, key) and replay it verbatim on retry.
 * The unique constraint on (accountId, idempotencyKey) also makes the store-step
 * race-safe: a concurrent double-submit that slips past the pre-check collides
 * on insert and is swallowed.
 *
 * [2026-07-08 audit item 7 / W1-L2] The key was previously scoped to
 * (accountId, key) ONLY -- not method+path. Since every write endpoint shares
 * the SAME idempotency_keys table, an account that reused one Idempotency-Key
 * value across two different endpoints (e.g. first a work-order create, later
 * an unrelated telemetry batch ingest) would have the SECOND call silently
 * replay the FIRST call's cached response -- the wrong result for a request
 * that was never actually a retry. findStored() now takes the caller's own
 * method+path and refuses to replay a stored row recorded for a different
 * method/path: instead of serving the wrong cached body, it hands back a 409
 * conflict shape that existing callers already propagate verbatim (they do
 * `res.status(prior.statusCode).json(prior.responseBody)`), so this is a
 * behavior-only change with no call-site restructuring required beyond
 * passing method+path in. Body-content hashing (a key reused against the
 * SAME method+path but a materially different body) is NOT covered here --
 * that would need a new DB column (bodyHash) and a migration, which is out of
 * scope for this pass; noted as a follow-up.
 *
 *   normalizeKey(req)                                          -> string | null
 *   findStored(prisma, accountId, key, method?, path?)         -> { statusCode, responseBody } | null
 *   store(prisma, { accountId, key, method, path, statusCode, body }) -> void (best-effort)
 */

const MAX_KEY_LEN = 200;

function normalizeKey(req: any): string | null {
  const raw = req.headers['idempotency-key'];
  if (!raw) return null;
  const k = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!k) return null;
  return k.slice(0, MAX_KEY_LEN);
}

async function findStored(prisma: any, accountId: string, key: string | null, method?: string, path?: string) {
  if (!key) return null;
  try {
    const row = await prisma.apiIdempotencyKey.findUnique({
      where: { accountId_idempotencyKey: { accountId, idempotencyKey: key } },
      select: { statusCode: true, responseBody: true, method: true, path: true },
    });
    if (!row) return null;
    if (method && path && (row.method !== method || row.path !== path)) {
      // Same key, different request shape -- never replay someone else's
      // cached response. Callers already forward whatever { statusCode,
      // responseBody } we return verbatim, so this reuses that exact path
      // to surface a clean 409 instead of the wrong cached result.
      return {
        statusCode: 409,
        responseBody: {
          success: false,
          error: 'This Idempotency-Key was already used for a different request. Use a new key for a new request.',
        },
      };
    }
    return { statusCode: row.statusCode, responseBody: row.responseBody };
  } catch (_) {
    return null; // never let the idempotency store block the real request
  }
}

async function store(
  prisma: any,
  { accountId, key, method, path, statusCode, body }:
    { accountId: string; key: string | null; method: string; path: string; statusCode: number; body: any },
) {
  if (!key) return;
  try {
    await prisma.apiIdempotencyKey.create({
      data: { accountId, idempotencyKey: key, method, path, statusCode, responseBody: body },
    });
  } catch (_) {
    // Unique-collision on a concurrent insert (or any write error) is non-fatal:
    // the first writer's row already holds the canonical response.
  }
}

module.exports = { normalizeKey, findStored, store };

export {};

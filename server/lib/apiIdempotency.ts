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
 *   normalizeKey(req)                          -> string | null
 *   findStored(prisma, accountId, key)         -> { statusCode, responseBody } | null
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

async function findStored(prisma: any, accountId: string, key: string | null) {
  if (!key) return null;
  try {
    const row = await prisma.apiIdempotencyKey.findUnique({
      where: { accountId_idempotencyKey: { accountId, idempotencyKey: key } },
      select: { statusCode: true, responseBody: true },
    });
    return row || null;
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

/**
 * THIRD-PARTY PROVENANCE
 * Uses `jose` (panva/jose, MIT, (c) 2018 Filip Skokan, https://github.com/panva/jose)
 * for JWKS fetch + id_token/JWT validation. OIDC behavior is verified against Ory
 * Polis (Apache-2.0, https://github.com/ory/polis). No upstream source is vendored.
 * See docs/THIRD_PARTY_PROVENANCE.md and NOTICE.
 */

'use strict';

/**
 * lib/ssoIdToken.ts
 * -----------------
 * OIDC id_token validation for the SSO callback.
 *
 * Guards (spec: "full ID-token validation; guard alg-confusion"):
 *  - alg PINNED to asymmetric algorithms; `none` and HS* are rejected outright
 *    (the classic alg-confusion attack verifies an RS256 token with the public
 *    key as an HMAC secret — pinning to asymmetric algs closes it).
 *  - signature verified against Polis's JWKS (fetched from discovery).
 *  - issuer + expiry enforced; audience enforced when an expected aud is given.
 *  - nonce binding enforced: id_token.nonce MUST equal the value we stashed in
 *    SsoLoginState for this login — closes token injection/replay.
 *
 * Uses `jose` (panva, MIT) — the same maintainer as the openid-client Polis
 * itself pins. Polis advertises RS256 (see openid-configuration.json fixture).
 */

const { jwtVerify, createRemoteJWKSet, decodeProtectedHeader } = require('jose');

// Asymmetric algs only. Deliberately excludes 'none' and all HS* (symmetric)
// to block alg-confusion.
const ALLOWED_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

const _jwksCache = new Map<string, any>();
function getJwks(jwksUri: string) {
  let ks = _jwksCache.get(jwksUri);
  if (!ks) {
    ks = createRemoteJWKSet(new URL(jwksUri));
    _jwksCache.set(jwksUri, ks);
  }
  return ks;
}

/**
 * Validate an id_token. Throws (with err.code) on any failure. Returns the
 * verified claims on success.
 */
async function validateIdToken(args: {
  idToken: string;
  jwksUri: string;
  expectedIss: string;
  expectedNonce: string;
  expectedAud?: string;        // optional: enforced only when provided
  clockToleranceSec?: number;
}): Promise<any> {
  const { idToken, jwksUri, expectedIss, expectedNonce, expectedAud, clockToleranceSec = 30 } = args;
  if (!idToken || typeof idToken !== 'string') {
    const e: any = new Error('id_token missing'); e.code = 'IDTOKEN_MISSING'; throw e;
  }
  // Defense-in-depth alg check before verification (jwtVerify also enforces it).
  let header: any;
  try { header = decodeProtectedHeader(idToken); } catch { header = null; }
  if (!header || !ALLOWED_ALGS.includes(header.alg)) {
    const e: any = new Error(`id_token alg not allowed: ${header && header.alg}`); e.code = 'IDTOKEN_ALG'; throw e;
  }

  let payload: any;
  try {
    ({ payload } = await jwtVerify(idToken, getJwks(jwksUri), {
      algorithms: ALLOWED_ALGS,
      issuer: expectedIss,
      ...(expectedAud ? { audience: expectedAud } : {}),
      clockTolerance: clockToleranceSec,
    }));
  } catch (err: any) {
    const e: any = new Error(`id_token verification failed: ${err && err.code ? err.code : err && err.message}`);
    e.code = 'IDTOKEN_INVALID';
    e.cause = err;
    throw e;
  }

  if (!expectedNonce || payload.nonce !== expectedNonce) {
    const e: any = new Error('id_token nonce mismatch'); e.code = 'IDTOKEN_NONCE'; throw e;
  }
  return payload;
}

module.exports = { validateIdToken, ALLOWED_ALGS };

export {};

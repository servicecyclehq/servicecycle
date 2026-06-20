'use strict';

/**
 * lib/ssoPkce.ts
 * --------------
 * PKCE (RFC 7636, S256) + CSRF state/nonce generation for the OAuth flow.
 * Pure crypto, no I/O — unit-tested directly.
 */

const crypto = require('crypto');

/** High-entropy URL-safe random token (default 32 bytes -> 43 base64url chars). */
function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** PKCE code_verifier: 32 random bytes, base64url (43 chars, within 43..128). */
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** PKCE code_challenge = base64url(SHA256(verifier)) for method S256. */
function codeChallengeFromVerifier(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Create a fresh {state, nonce, codeVerifier, codeChallenge} bundle. */
function createPkceBundle(): { state: string; nonce: string; codeVerifier: string; codeChallenge: string } {
  const codeVerifier = generateCodeVerifier();
  return {
    state: randomToken(32),
    nonce: randomToken(32),
    codeVerifier,
    codeChallenge: codeChallengeFromVerifier(codeVerifier),
  };
}

module.exports = { randomToken, generateCodeVerifier, codeChallengeFromVerifier, createPkceBundle };

export {};

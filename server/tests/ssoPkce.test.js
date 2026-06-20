/**
 * Unit tests for lib/ssoPkce — PKCE S256 + state/nonce generation.
 * Pure; runs in the esbuild "unit" jest project.
 */
const crypto = require('crypto');
const { randomToken, generateCodeVerifier, codeChallengeFromVerifier, createPkceBundle } = require('../lib/ssoPkce');

describe('PKCE S256', () => {
  test('code_challenge = base64url(sha256(verifier))', () => {
    const v = generateCodeVerifier();
    const expected = crypto.createHash('sha256').update(v).digest('base64url');
    expect(codeChallengeFromVerifier(v)).toBe(expected);
  });

  test('verifier is URL-safe and within RFC 7636 length bounds', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });

  test('challenge contains no base64 padding/url-unsafe chars', () => {
    const c = codeChallengeFromVerifier(generateCodeVerifier());
    expect(c).not.toMatch(/[+/=]/);
  });
});

describe('randomToken + bundle', () => {
  test('randomToken is high-entropy and unique', () => {
    const a = randomToken(); const b = randomToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  test('createPkceBundle yields matching verifier/challenge + distinct state/nonce', () => {
    const bundle = createPkceBundle();
    expect(codeChallengeFromVerifier(bundle.codeVerifier)).toBe(bundle.codeChallenge);
    expect(bundle.state).not.toBe(bundle.nonce);
    expect(bundle.state.length).toBeGreaterThanOrEqual(43);
  });
});

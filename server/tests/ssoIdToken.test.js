/**
 * Unit tests for lib/ssoIdToken — id_token validation (alg-confusion guard +
 * nonce binding + iss/exp). Uses a locally-generated RSA key served over a tiny
 * JWKS endpoint, so it's a REAL signature verification with no Polis.
 * Runs in the esbuild "unit" jest project.
 */
const http = require('http');
const { generateKeyPair, exportJWK, SignJWT } = require('jose');
const { validateIdToken } = require('../lib/ssoIdToken');

const ISS = 'http://polis.test';
const AUD = 'acct_test';
let server, port, priv;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  priv = privateKey;
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key'; jwk.alg = 'RS256'; jwk.use = 'sig';
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));

const jwksUri = () => `http://localhost:${port}/jwks`;

async function signToken({ nonce = 'N1', iss = ISS, aud = AUD, exp = '5m', extra = {} } = {}) {
  return new SignJWT({ nonce, email: 'u@a.com', ...extra })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp)
    .sign(priv);
}

describe('validateIdToken — happy path', () => {
  test('valid token with matching nonce passes', async () => {
    const token = await signToken({ nonce: 'abc' });
    const claims = await validateIdToken({ idToken: token, jwksUri: jwksUri(), expectedIss: ISS, expectedNonce: 'abc', expectedAud: AUD });
    expect(claims.nonce).toBe('abc');
    expect(claims.email).toBe('u@a.com');
  });
});

describe('validateIdToken — rejects', () => {
  test('nonce mismatch -> IDTOKEN_NONCE', async () => {
    const token = await signToken({ nonce: 'real' });
    await expect(validateIdToken({ idToken: token, jwksUri: jwksUri(), expectedIss: ISS, expectedNonce: 'WRONG', expectedAud: AUD }))
      .rejects.toMatchObject({ code: 'IDTOKEN_NONCE' });
  });

  test('wrong issuer -> IDTOKEN_INVALID', async () => {
    const token = await signToken({ iss: 'http://evil.test' });
    await expect(validateIdToken({ idToken: token, jwksUri: jwksUri(), expectedIss: ISS, expectedNonce: 'N1', expectedAud: AUD }))
      .rejects.toMatchObject({ code: 'IDTOKEN_INVALID' });
  });

  test('expired token -> IDTOKEN_INVALID', async () => {
    // Well past the 30s clock tolerance.
    const token = await signToken({ exp: Math.floor(Date.now() / 1000) - 600 });
    await expect(validateIdToken({ idToken: token, jwksUri: jwksUri(), expectedIss: ISS, expectedNonce: 'N1', expectedAud: AUD }))
      .rejects.toMatchObject({ code: 'IDTOKEN_INVALID' });
  });

  test('alg "none" -> IDTOKEN_ALG (alg-confusion guard)', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ nonce: 'N1', iss: ISS, aud: AUD })).toString('base64url');
    const noneToken = `${header}.${payload}.`;
    await expect(validateIdToken({ idToken: noneToken, jwksUri: jwksUri(), expectedIss: ISS, expectedNonce: 'N1' }))
      .rejects.toMatchObject({ code: 'IDTOKEN_ALG' });
  });

  test('HS256 token -> IDTOKEN_ALG (symmetric alg rejected)', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ nonce: 'N1', iss: ISS, aud: AUD })).toString('base64url');
    const fakeSig = Buffer.from('whatever').toString('base64url');
    const hsToken = `${header}.${payload}.${fakeSig}`;
    await expect(validateIdToken({ idToken: hsToken, jwksUri: jwksUri(), expectedIss: ISS, expectedNonce: 'N1' }))
      .rejects.toMatchObject({ code: 'IDTOKEN_ALG' });
  });

  test('missing token -> IDTOKEN_MISSING', async () => {
    await expect(validateIdToken({ idToken: '', jwksUri: jwksUri(), expectedIss: ISS, expectedNonce: 'N1' }))
      .rejects.toMatchObject({ code: 'IDTOKEN_MISSING' });
  });
});

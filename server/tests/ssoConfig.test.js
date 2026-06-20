/**
 * Unit tests for lib/ssoConfig — the fail-closed SSO env gate.
 * Pure (no DB/server); runs in the esbuild "unit" jest project.
 */
const { isSsoEnabled, missingSsoEnv, getSsoConfig, REQUIRED_WHEN_ENABLED } = require('../lib/ssoConfig');

const SSO_KEYS = ['SSO_ENABLED', 'POLIS_BASE_URL', 'POLIS_EXTERNAL_URL', 'POLIS_API_KEY',
  'POLIS_PRODUCT', 'SSO_CALLBACK_URL', 'SCIM_WEBHOOK_SECRET', 'SSO_JIT_PROVISIONING', 'POLIS_TIMEOUT_MS'];

let saved;
beforeEach(() => { saved = {}; SSO_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); });
afterEach(() => { SSO_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

describe('ssoConfig — disabled by default', () => {
  test('isSsoEnabled false when SSO_ENABLED unset', () => {
    expect(isSsoEnabled()).toBe(false);
  });
  test('missingSsoEnv is empty when disabled (nothing required)', () => {
    expect(missingSsoEnv()).toEqual([]);
  });
  test('getSsoConfig throws SSO_DISABLED when off', () => {
    expect.assertions(1);
    try { getSsoConfig(); } catch (e) { expect(e.code).toBe('SSO_DISABLED'); }
  });
});

describe('ssoConfig — fail closed when enabled but misconfigured', () => {
  test('every required var is reported missing when only SSO_ENABLED is set', () => {
    process.env.SSO_ENABLED = 'true';
    expect(missingSsoEnv().sort()).toEqual([...REQUIRED_WHEN_ENABLED].sort());
  });
  test('blank (whitespace) values count as missing', () => {
    process.env.SSO_ENABLED = 'true';
    process.env.POLIS_BASE_URL = '   ';
    process.env.POLIS_API_KEY = 'k';
    process.env.SCIM_WEBHOOK_SECRET = 's';
    process.env.SSO_CALLBACK_URL = 'https://app/api/sso/callback';
    expect(missingSsoEnv()).toContain('POLIS_BASE_URL');
  });
  test('getSsoConfig throws SSO_MISCONFIGURED when a required var is missing', () => {
    process.env.SSO_ENABLED = 'true';
    process.env.POLIS_BASE_URL = 'http://polis:5225';
    expect.assertions(1);
    try { getSsoConfig(); } catch (e) { expect(e.code).toBe('SSO_MISCONFIGURED'); }
  });
});

describe('ssoConfig — fully configured', () => {
  beforeEach(() => {
    process.env.SSO_ENABLED = 'true';
    process.env.POLIS_BASE_URL = 'http://polis:5225/';
    process.env.POLIS_API_KEY = 'secret-key';
    process.env.SCIM_WEBHOOK_SECRET = 'whsec';
    process.env.SSO_CALLBACK_URL = 'https://app.example.com/api/sso/callback';
  });
  test('missingSsoEnv empty', () => { expect(missingSsoEnv()).toEqual([]); });
  test('getSsoConfig returns a complete, normalized config', () => {
    const c = getSsoConfig();
    expect(c.baseUrl).toBe('http://polis:5225');         // trailing slash stripped
    expect(c.externalUrl).toBe('http://polis:5225');      // defaults to baseUrl
    expect(c.apiKey).toBe('secret-key');
    expect(c.product).toBe('servicecycle');               // default
    expect(c.callbackUrl).toBe('https://app.example.com/api/sso/callback');
    expect(c.scimWebhookSecret).toBe('whsec');
    expect(c.jitProvisioning).toBe(false);                // default off
    expect(c.requestTimeoutMs).toBe(8000);                // default
  });
  test('JIT + external URL + timeout overrides honored', () => {
    process.env.SSO_JIT_PROVISIONING = 'true';
    process.env.POLIS_EXTERNAL_URL = 'https://sso.example.com';
    process.env.POLIS_TIMEOUT_MS = '3000';
    const c = getSsoConfig();
    expect(c.jitProvisioning).toBe(true);
    expect(c.externalUrl).toBe('https://sso.example.com');
    expect(c.requestTimeoutMs).toBe(3000);
  });
  test('timeout floor enforced (>=1000)', () => {
    process.env.POLIS_TIMEOUT_MS = '10';
    expect(getSsoConfig().requestTimeoutMs).toBe(1000);
  });
});

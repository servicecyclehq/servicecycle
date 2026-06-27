'use strict';

/**
 * POP-8-3 (supporting) — heartbeat URL resolution.
 *
 * The fail-LOUD startup guard for unconfigured cron monitoring lives in
 * index.ts; this suite locks in the heartbeat module's slug/URL contract so the
 * monitoring it enables actually targets the right healthchecks.io endpoint
 * (and stays a clean no-op when nothing is configured — the very condition the
 * startup guard now warns about).
 */

const path = require('path');
const { hcSlug, urlFor } = require(path.join(__dirname, '..', 'lib', 'heartbeat.ts'));

describe('heartbeat slug + url resolution (POP-8-3)', () => {
  const KEY = 'HEALTHCHECKS_PING_KEY';
  const OVERRIDE = 'HEALTHCHECKS_URL_ALERTENGINE';
  const savedKey = process.env[KEY];
  const savedOverride = process.env[OVERRIDE];

  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY]; else process.env[KEY] = savedKey;
    if (savedOverride === undefined) delete process.env[OVERRIDE]; else process.env[OVERRIDE] = savedOverride;
  });

  test('camelCase cron names become valid healthchecks slugs', () => {
    expect(hcSlug('alertEngine')).toBe('alert-engine');
    expect(hcSlug('webhookDlqRetry')).toBe('webhook-dlq-retry');
    expect(hcSlug('backup')).toBe('backup');
  });

  test('no monitoring configured → urlFor returns null (clean no-op)', () => {
    delete process.env[KEY];
    delete process.env[OVERRIDE];
    expect(urlFor('alertEngine', 'success')).toBeNull();
  });

  test('project key derives the slugged ping URL with start/fail suffixes', () => {
    delete process.env[OVERRIDE];
    process.env[KEY] = 'abc123def456ghi789jkl0';
    expect(urlFor('alertEngine', 'success')).toBe('https://hc-ping.com/abc123def456ghi789jkl0/alert-engine');
    expect(urlFor('alertEngine', 'start')).toBe('https://hc-ping.com/abc123def456ghi789jkl0/alert-engine/start');
    expect(urlFor('alertEngine', 'fail')).toBe('https://hc-ping.com/abc123def456ghi789jkl0/alert-engine/fail');
  });

  test('per-check URL override beats the project key', () => {
    process.env[KEY] = 'abc123def456ghi789jkl0';
    process.env[OVERRIDE] = 'https://hc-ping.com/00000000-0000-0000-0000-000000000000';
    expect(urlFor('alertEngine', 'success')).toBe('https://hc-ping.com/00000000-0000-0000-0000-000000000000');
    expect(urlFor('alertEngine', 'fail')).toBe('https://hc-ping.com/00000000-0000-0000-0000-000000000000/fail');
  });
});

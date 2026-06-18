/**
 * webhook.ssrf.test.js — T1-N1 Pass-6 SSRF guard unit tests
 *
 * Tests the pre-DNS hostname denylist and post-DNS IP range checks in
 * validateWebhookUrl(). The DNS lookup is mocked so these are fast + hermetic.
 */

'use strict';

jest.mock('dns', () => ({
  promises: {
    lookup: jest.fn(),
  },
}));

const dns = require('dns').promises;
const { validateWebhookUrl, pinnedLookup } = require('../lib/webhook');

// Default: most tests use a safe public IP so DNS resolves fine.
function mockDns(addresses) {
  dns.lookup.mockResolvedValue(
    Array.isArray(addresses)
      ? addresses.map(a => ({ address: a, family: a.includes(':') ? 6 : 4 }))
      : [{ address: addresses, family: 4 }]
  );
}

beforeEach(() => {
  dns.lookup.mockReset();
});

// ── Pre-DNS hostname denylist (T1-N1) ─────────────────────────────────────────

describe('HOST_DENYLIST — pre-DNS rejection', () => {
  test('rejects metadata.google.internal before DNS lookup', async () => {
    // DNS should never be called — the denylist fires first.
    const result = await validateWebhookUrl('https://metadata.google.internal/computeMetadata/v1/');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('cloud-metadata-host');
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  test('rejects metadata.azure.com before DNS lookup', async () => {
    const result = await validateWebhookUrl('https://metadata.azure.com/metadata/instance');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('cloud-metadata-host');
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  test('rejects bare "metadata" hostname before DNS lookup', async () => {
    const result = await validateWebhookUrl('https://metadata/');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('cloud-metadata-host');
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  test('rejects mixed-case Metadata.Google.Internal (case-insensitive denylist)', async () => {
    const result = await validateWebhookUrl('https://Metadata.Google.Internal/');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('cloud-metadata-host');
    expect(dns.lookup).not.toHaveBeenCalled();
  });
});

// ── Post-DNS IP range checks ──────────────────────────────────────────────────

describe('post-DNS private IP rejection', () => {
  test('rejects http://169.254.169.254/ (link-local AWS/GCP metadata)', async () => {
    // This is an IP directly — caught by isPrivateAddress(host) before DNS.
    const result = await validateWebhookUrl('https://169.254.169.254/latest/meta-data/');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('private-ip');
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  test('rejects IPv6-mapped 169.254.169.254 (::ffff:169.254.169.254)', async () => {
    mockDns(['::ffff:169.254.169.254']);
    const result = await validateWebhookUrl('https://evil-alias.example.com/');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('private-ip');
  });

  test('rejects when ANY resolved address is private (not only all)', async () => {
    // DNS returns [public, metadata] — must reject because at least one is private.
    mockDns(['1.2.3.4', '169.254.169.254']);
    const result = await validateWebhookUrl('https://multi-record.example.com/');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('private-ip');
  });
});

// ── Positive case: safe public URL ───────────────────────────────────────────

describe('positive case', () => {
  test('accepts a safe HTTPS URL with a public IP', async () => {
    mockDns(['93.184.216.34']); // example.com
    const result = await validateWebhookUrl('https://example.com/servicecycle-webhook');
    expect(result.valid).toBe(true);
  });
});

// ── Protocol + credential rejections ─────────────────────────────────────────

describe('protocol + credential rejections', () => {
  test('rejects http:// (non-HTTPS)', async () => {
    const result = await validateWebhookUrl('http://example.com/webhook');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('https-required');
  });

  test('rejects URL with embedded credentials', async () => {
    const result = await validateWebhookUrl('https://user:pass@example.com/webhook');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('credentials-in-url');
  });
});

// ── F-SSRF-REBIND: validated addresses returned + pinned at connect ───────────

describe('DNS-rebinding pinning (F-SSRF-REBIND)', () => {
  test('validateWebhookUrl returns the vetted public addresses', async () => {
    mockDns(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
    const result = await validateWebhookUrl('https://example.com/hook');
    expect(result.valid).toBe(true);
    expect(result.addresses).toEqual(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
  });

  test('pinnedLookup yields the vetted IP regardless of hostname (single)', (done) => {
    pinnedLookup(['203.0.113.7'])('attacker-rebind.example', {}, (err, addr, fam) => {
      expect(err).toBeNull();
      expect(addr).toBe('203.0.113.7');   // NOT whatever DNS would now return
      expect(fam).toBe(4);
      done();
    });
  });

  test('pinnedLookup returns full vetted list when {all:true}', (done) => {
    pinnedLookup(['203.0.113.7', '203.0.113.8'])('h', { all: true }, (err, list) => {
      expect(err).toBeNull();
      expect(list).toEqual([
        { address: '203.0.113.7', family: 4 },
        { address: '203.0.113.8', family: 4 },
      ]);
      done();
    });
  });

  test('pinnedLookup errors when there is no vetted address (fail closed)', (done) => {
    pinnedLookup([])('h', {}, (err) => {
      expect(err).toBeInstanceOf(Error);
      done();
    });
  });
});

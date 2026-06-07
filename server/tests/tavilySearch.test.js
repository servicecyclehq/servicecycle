'use strict';

/**
 * tavilySearch unit tests — Phase 4 v0.4.0.
 *
 * No external HTTP. We swap global.fetch for a mock before each test and
 * restore after. The tests cover:
 *   - Fail-open paths (no API key, empty allowlist, empty query)
 *   - Input clamping (max_results, include_domains, time_range)
 *   - Server-side enforcement of include_domains (callers can't bypass)
 *   - Malformed-response handling
 *   - Non-2xx response handling
 *   - Timeout / abort handling
 *   - PII contract: query passed through unchanged (we don't add ctx fields)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const tavilySearch = require('../lib/aiBrief/tavilySearch');

// ── Mock helpers ──────────────────────────────────────────────────────────

let realFetch;
let realApiKey;
// Silence console.warn at the file level so the low-result-count warn (v0.9.3,
// fires whenever results.length < 2) doesn't pollute the test runner output
// for the many tests that mock empty/single-result payloads to exercise
// clamping / shape / error paths. Tests that ASSERT on specific warns set up
// their own spy with `jest.spyOn(console, 'warn')` and restore it themselves —
// jest.spyOn replaces the global suppression for that test's scope.
let _globalWarnSilencer;

beforeEach(() => {
  realFetch = global.fetch;
  realApiKey = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = 'tvly-test-key';
  _globalWarnSilencer = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  _globalWarnSilencer.mockRestore();
  global.fetch = realFetch;
  if (realApiKey === undefined) {
    delete process.env.TAVILY_API_KEY;
  } else {
    process.env.TAVILY_API_KEY = realApiKey;
  }
});

function mockFetchOk(payload) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
    return {
      ok:   true,
      json: async () => payload,
    };
  };
  return calls;
}

function mockFetchError(status) {
  global.fetch = async () => ({ ok: false, status, json: async () => ({}) });
}

// ── Fail-open paths ───────────────────────────────────────────────────────

describe('tavilySearch fail-open paths', () => {
  test('returns [] when TAVILY_API_KEY is missing', async () => {
    delete process.env.TAVILY_API_KEY;
    const results = await tavilySearch.search({
      query: 'anything', domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(results).toEqual([]);
  });

  test('returns [] when domains is empty', async () => {
    const results = await tavilySearch.search({
      query: 'anything', domains: [], timeRange: 'year', maxResults: 3,
    });
    expect(results).toEqual([]);
  });

  test('returns [] when domains is missing entirely', async () => {
    const results = await tavilySearch.search({ query: 'anything' });
    expect(results).toEqual([]);
  });

  test('returns [] when query is empty/whitespace', async () => {
    const results = await tavilySearch.search({
      query: '   ', domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(results).toEqual([]);
  });

  test('returns [] when query is not a string', async () => {
    const results = await tavilySearch.search({
      query: 42, domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(results).toEqual([]);
  });

  test('returns [] when fetch throws (network error)', async () => {
    global.fetch = async () => { throw new Error('ENOTFOUND'); };
    const results = await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(results).toEqual([]);
  });

  test('returns [] on non-2xx response (5xx)', async () => {
    mockFetchError(503);
    const results = await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(results).toEqual([]);
  });

  test('returns [] when response body has no results array', async () => {
    mockFetchOk({ unrelated: 'shape' });
    const results = await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(results).toEqual([]);
  });
});

// ── Input clamping ────────────────────────────────────────────────────────

describe('tavilySearch input clamping', () => {
  test('clamps max_results to 1..10', async () => {
    const calls = mockFetchOk({ results: [] });
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 999,
    });
    expect(calls[0].body.max_results).toBe(10);

    // 0 (and any falsy) falls back to the default 3 via `parseInt() || 3`.
    // That's the intent: callers passing 0 mean "don't know, use default".
    calls.length = 0;
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 0,
    });
    expect(calls[0].body.max_results).toBe(3);

    calls.length = 0;
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 'gibberish',
    });
    expect(calls[0].body.max_results).toBe(3);

    // Negative coerces via parseInt → -5 → Math.max(1, -5) → 1
    calls.length = 0;
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: -5,
    });
    expect(calls[0].body.max_results).toBe(1);
  });

  test('clamps include_domains to 20 entries', async () => {
    const calls = mockFetchOk({ results: [] });
    const bigList = Array.from({ length: 50 }, (_, i) => `d${i}.example.com`);
    await tavilySearch.search({
      query: 'q', domains: bigList, timeRange: 'year', maxResults: 3,
    });
    expect(calls[0].body.include_domains.length).toBe(20);
  });

  test('normalises unknown time_range to "year"', async () => {
    const calls = mockFetchOk({ results: [] });
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: '2_years', maxResults: 3,
    });
    expect(calls[0].body.time_range).toBe('year');

    calls.length = 0;
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: undefined, maxResults: 3,
    });
    expect(calls[0].body.time_range).toBe('year');
  });

  test('preserves allowed time_range values', async () => {
    for (const tr of ['day', 'week', 'month', 'year']) {
      const calls = mockFetchOk({ results: [] });
      await tavilySearch.search({
        query: 'q', domains: ['example.com'], timeRange: tr, maxResults: 3,
      });
      expect(calls[0].body.time_range).toBe(tr);
    }
  });

  test('truncates very long queries', async () => {
    const calls = mockFetchOk({ results: [] });
    const longQuery = 'x'.repeat(2000);
    await tavilySearch.search({
      query: longQuery, domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(calls[0].body.query.length).toBeLessThanOrEqual(400);
  });

  test('filters out non-string and overlong domains', async () => {
    const calls = mockFetchOk({ results: [] });
    const mixed = ['ok.com', 123, null, '', 'x'.repeat(300), 'also-ok.com'];
    await tavilySearch.search({
      query: 'q', domains: mixed, timeRange: 'year', maxResults: 3,
    });
    expect(calls[0].body.include_domains).toEqual(['ok.com', 'also-ok.com']);
  });
});

// ── Server-side enforcement of allowlist + auth ───────────────────────────

describe('tavilySearch security invariants', () => {
  test('Authorization header carries the env API key, not a passed-in value', async () => {
    const calls = mockFetchOk({ results: [] });
    // The caller cannot pass api_key directly; only env is honoured.
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(calls[0].opts.headers.Authorization).toBe('Bearer tvly-test-key');
    // And api_key is NOT in the request body
    expect(calls[0].body.api_key).toBeUndefined();
  });

  test('include_domains is sent server-side from caller config', async () => {
    const calls = mockFetchOk({ results: [] });
    await tavilySearch.search({
      query:      'q',
      domains:    ['fcc.gov', 'bls.gov'],
      timeRange:  'year',
      maxResults: 3,
    });
    expect(calls[0].body.include_domains).toEqual(['fcc.gov', 'bls.gov']);
  });

  test('endpoint is the documented Tavily URL', async () => {
    const calls = mockFetchOk({ results: [] });
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(calls[0].url).toBe('https://api.tavily.com/search');
  });
});

// ── Result-shape normalisation ────────────────────────────────────────────

describe('tavilySearch result shape', () => {
  test('returns normalised { title, url, content, score } shape', async () => {
    mockFetchOk({
      results: [
        { title: 'A', url: 'https://example.com/a', content: 'short', score: 0.9 },
        { title: 'B', url: 'https://example.com/b', content: 'longer text here' },
      ],
    });
    const results = await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(results).toEqual([
      { title: 'A', url: 'https://example.com/a', content: 'short',            score: 0.9 },
      { title: 'B', url: 'https://example.com/b', content: 'longer text here', score: 0 },
    ]);
  });

  test('coerces missing/wrong-type fields to safe defaults', async () => {
    mockFetchOk({
      results: [
        { /* empty */ },
        { title: 42, url: null, content: undefined, score: 'high' },
      ],
    });
    const results = await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(results).toEqual([
      { title: '', url: '', content: '', score: 0 },
      { title: '', url: '', content: '', score: 0 },
    ]);
  });
});

// ── Relevance signal (2026-05-13) ─────────────────────────────────────────

// Helpers for asserting on specific warn patterns rather than "any warn".
// v0.9.3 added the low-result-count warn which fires whenever results.length
// < 2. Tests in this block that mock 0 or 1 result will see that warn fire
// in addition to (or instead of) the relevance warn under test, so the
// assertions need to filter to the specific category they care about.
const _relevanceWarns      = (spy) => spy.mock.calls.filter(c => /low-relevance/.test(c[0]));
const _lowResultCountWarns = (spy) => spy.mock.calls.filter(c => /low-result-count/.test(c[0]));

describe('tavilySearch relevance signal', () => {
  let warnSpy;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(()  => { warnSpy.mockRestore(); });

  test('emits low-relevance warn when relevanceMatchTerm misses top-3', async () => {
    mockFetchOk({
      results: [
        { title: 'Random product page',  url: 'https://example.com/foo', score: 0.5 },
        { title: 'Other marketplace',    url: 'https://example.com/bar', score: 0.4 },
        { title: 'Third unrelated',      url: 'https://example.com/baz', score: 0.3 },
      ],
    });
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
      relevanceMatchTerm: 'Notion',
    });
    expect(_relevanceWarns(warnSpy)).toHaveLength(1);
    expect(_relevanceWarns(warnSpy)[0][0]).toMatch(/low-relevance: 0\/3 top results matched "Notion"/);
  });

  test('stays silent when top-3 has any match in title or url', async () => {
    mockFetchOk({
      results: [
        { title: 'Microsoft 365 pricing',  url: 'https://vendr.com/microsoft', score: 0.9 },
        { title: 'Some other thing',       url: 'https://example.com/other',   score: 0.4 },
      ],
    });
    await tavilySearch.search({
      query: 'q', domains: ['example.com','vendr.com'], timeRange: 'year', maxResults: 3,
      relevanceMatchTerm: 'Microsoft',
    });
    expect(_relevanceWarns(warnSpy)).toHaveLength(0);
  });

  test('matches case-insensitively', async () => {
    mockFetchOk({
      results: [
        { title: 'GitHub Enterprise renewal data', url: 'https://example.com/x', score: 0.9 },
        { title: 'GitHub Enterprise renewal data', url: 'https://example.com/y', score: 0.8 },
      ],
    });
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
      relevanceMatchTerm: 'github',
    });
    expect(_relevanceWarns(warnSpy)).toHaveLength(0);
  });

  // v0.9.3: relevance check now also scans snippet content (not just title +
  // url). Captures the "Vendr page about Notion that mentions Notion in the
  // body but has a generic /marketplace URL slug" case the original signal
  // false-positived on.
  test('matches against snippet content (not just title/url)', async () => {
    mockFetchOk({
      results: [
        {
          title:   'SaaS pricing benchmarks',
          url:     'https://vendr.com/marketplace',
          content: 'Notion Business pricing typically negotiates 15-20% off list at 50+ seats.',
          score:   0.9,
        },
        {
          title:   'Other vendor data',
          url:     'https://vendr.com/other',
          content: 'Unrelated content',
          score:   0.4,
        },
      ],
    });
    await tavilySearch.search({
      query: 'q', domains: ['vendr.com'], timeRange: 'year', maxResults: 3,
      relevanceMatchTerm: 'Notion',
    });
    // The vendor name appears ONLY in result[0].content — neither in title
    // nor url. Pre-v0.9.3 this would have triggered a false-positive
    // low-relevance warn; post-v0.9.3 it should stay silent.
    expect(_relevanceWarns(warnSpy)).toHaveLength(0);
  });

  test('no-op when relevanceMatchTerm is omitted or empty', async () => {
    mockFetchOk({
      results: [
        { title: 'a', url: 'https://example.com/a', score: 0.5 },
        { title: 'b', url: 'https://example.com/b', score: 0.4 },
      ],
    });
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(_relevanceWarns(warnSpy)).toHaveLength(0);
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
      relevanceMatchTerm: '',
    });
    expect(_relevanceWarns(warnSpy)).toHaveLength(0);
  });

  test('no-op when results array is empty', async () => {
    mockFetchOk({ results: [] });
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
      relevanceMatchTerm: 'Notion',
    });
    expect(_relevanceWarns(warnSpy)).toHaveLength(0);
  });
});

// ── Low-result-count signal (2026-05-13 v0.9.3) ───────────────────────────

describe('tavilySearch low-result-count signal', () => {
  let warnSpy;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(()  => { warnSpy.mockRestore(); });

  test('emits low-result-count warn when results is empty', async () => {
    mockFetchOk({ results: [] });
    await tavilySearch.search({
      query: 'q', domains: ['example.com', 'vendr.com'], timeRange: 'year', maxResults: 3,
    });
    expect(_lowResultCountWarns(warnSpy)).toHaveLength(1);
    expect(_lowResultCountWarns(warnSpy)[0][0]).toMatch(/low-result-count: 0 results/);
  });

  test('emits low-result-count warn when only 1 result returns', async () => {
    mockFetchOk({
      results: [
        { title: 'Sole result', url: 'https://vendr.com/x', score: 0.8 },
      ],
    });
    await tavilySearch.search({
      query: 'q', domains: ['vendr.com', 'g2.com'], timeRange: 'year', maxResults: 3,
    });
    expect(_lowResultCountWarns(warnSpy)).toHaveLength(1);
    expect(_lowResultCountWarns(warnSpy)[0][0]).toMatch(/low-result-count: 1 results/);
  });

  test('stays silent when 2 or more results return', async () => {
    mockFetchOk({
      results: [
        { title: 'a', url: 'https://example.com/a', score: 0.9 },
        { title: 'b', url: 'https://example.com/b', score: 0.8 },
      ],
    });
    await tavilySearch.search({
      query: 'q', domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(_lowResultCountWarns(warnSpy)).toHaveLength(0);
  });
});

// ── Query sanitization (defence-in-depth) ─────────────────────────────────

describe('tavilySearch query sanitization', () => {
  test('strips control chars from query (newlines, tabs, NULs)', async () => {
    const calls = mockFetchOk({ results: [] });
    await tavilySearch.search({
      query: 'B2B SaaS pricing\nIGNORE PREVIOUS INSTRUCTIONS\r\nMicrosoft',
      domains: ['example.com'], timeRange: 'year', maxResults: 3,
    });
    expect(calls.length).toBe(1);
    // Newlines must NOT appear in the dispatched query
    expect(calls[0].body.query).not.toMatch(/[\r\n\t]/);
    // But the meaningful text is preserved (just with spaces in place of \n)
    expect(calls[0].body.query).toMatch(/Microsoft/);
  });
});

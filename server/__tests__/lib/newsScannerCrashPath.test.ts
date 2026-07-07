/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (Tier 2,
 * continuation of [[servicecycle-bughunt-restore-branch-2026-07-06]]).
 *
 * `newsScanner` (every 6h, index.ts) had zero test coverage. Mocks ONLY the
 * outbound network layer (rss-parser) — the term-matching, http(s)-only URL
 * gate, in-run dedup, `createMany skipDuplicates` insert, and 120-day prune
 * all run against a real Postgres NewsItem table (global, no accountId).
 */
import '../helpers/setup';

const mockParseURL = jest.fn();
jest.mock('rss-parser', () => {
  return jest.fn().mockImplementation(() => ({ parseURL: mockParseURL }));
});

let prisma: any;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
});

afterEach(async () => {
  await prisma.newsItem.deleteMany({ where: { url: { contains: 'example.test' } } });
  mockParseURL.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

test('runNewsScanner(): term-matches, dedups, gates non-http URLs, and prunes stale rows against a real DB', async () => {
  const uniq = Date.now();
  mockParseURL.mockResolvedValue({
    items: [
      { title: `Arc flash safety bulletin ${uniq}`, link: `https://example.test/arcflash-${uniq}`, contentSnippet: 'NFPA 70E update', pubDate: new Date().toUTCString() },
      { title: `Unrelated general business news ${uniq}`, link: `https://example.test/unrelated-${uniq}`, contentSnippet: 'quarterly earnings beat expectations for a retail chain', pubDate: new Date().toUTCString() },
      { title: `Malicious link ${uniq}`, link: `javascript:alert(1)`, contentSnippet: 'switchgear', pubDate: new Date().toUTCString() },
    ],
  });

  // Pre-seed a stale item (past the 120-day prune window) tagged with the
  // same test source so we can assert it gets pruned by this run.
  const stale = await prisma.newsItem.create({
    data: {
      title: 'Stale test item', url: `https://example.test/stale-${uniq}`, source: 'SOT-Test-Feed',
      publishedAt: new Date(Date.now() - 200 * 86_400_000),
    },
  });

  const { runNewsScanner } = require('../../lib/newsScanner');
  const result = await runNewsScanner();

  expect(result.feedErrors).toBe(0);
  expect(result.inserted).toBeGreaterThanOrEqual(1);
  expect(result.pruned).toBeGreaterThanOrEqual(1);

  const matched = await prisma.newsItem.findUnique({ where: { url: `https://example.test/arcflash-${uniq}` } });
  expect(matched).toBeTruthy();
  expect(matched.matchedTerm).toBeTruthy();

  const unmatched = await prisma.newsItem.findUnique({ where: { url: `https://example.test/unrelated-${uniq}` } });
  expect(unmatched).toBeNull(); // no MATCH_TERMS hit -> never inserted

  const malicious = await prisma.newsItem.findFirst({ where: { title: { contains: 'Malicious link' } } });
  expect(malicious).toBeNull(); // javascript: URL gated out before insert

  const staleGone = await prisma.newsItem.findUnique({ where: { id: stale.id } });
  expect(staleGone).toBeNull();

  await prisma.newsItem.deleteMany({ where: { url: { contains: uniq.toString() } } });
});

export {};

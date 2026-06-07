/**
 * lib/newsScanner.ts
 * ------------------
 * Regulatory / industry news scanner for the GLOBAL NewsItem table.
 *
 * Polls a small curated list of public RSS feeds (OSHA newsroom + electrical
 * trade press), keeps only items matching electrical-maintenance/compliance
 * terms (NFPA 70B/70E/110, NETA, arc flash, switchgear...), and stores them
 * in news_items. News is industry-wide, not tenant data — NewsItem carries
 * no accountId and the unique `url` column makes inserts idempotent across
 * runs (createMany + skipDuplicates).
 *
 * Architecture inherited from the deleted LapseIQ vendor-news scanner:
 * rss-parser with a 10s per-feed timeout, Promise.allSettled + per-feed
 * try/catch so one dead feed never kills the run, http(s)-only URL gate
 * (defense against a hostile feed emitting javascript: links that would
 * render as <a href> in the SPA), and a prune pass at the end. The AI
 * classification, per-account vendor matching, and per-user watch terms are
 * intentionally gone — category here is fixed per feed and matching is a
 * static term list.
 *
 * NEWS_SCANNER_ENABLED defaults to true; set NEWS_SCANNER_ENABLED=false in
 * .env to disable outbound RSS polling (air-gapped / strict-egress installs).
 *
 * Designed to be called by a cron job in index.ts (6h cadence per the schema
 * note) and live via POST /api/news/refresh (manager+).
 */

const Parser = require('rss-parser');
import prisma from './prisma';

const SCANNER_ENABLED = process.env.NEWS_SCANNER_ENABLED !== 'false';

// ── Feed registry ─────────────────────────────────────────────────────────────
// All public RSS, probed 2026-06-07:
//   OSHA newsreleases.xml      → 200 application/rss+xml  (valid RSS 2.0)
//   ecmweb.com/rss.xml         → 200 application/rss+xml  (valid RSS 2.0)
//   csemag.com/feed/           → 200 application/rss+xml  (valid RSS 2.0)
//   plantengineering.com/feed/ → 200 application/rss+xml  (valid RSS 2.0)
//   nfpa.org/rss               → 500; /rss.xml and /news-and-research/rss
//                                drop the connection — NFPA has no working
//                                public RSS endpoint, so the 'standards'
//                                category currently has NO feed. Standards
//                                awareness stays on the manual
//                                StandardRevisionAlert workflow until NFPA
//                                publishes a feed again.
//
// category maps straight onto NewsItem.category
// (regulatory | standards | safety | industry).
const FEEDS: { url: string; source: string; category: string }[] = [
  { url: 'https://www.osha.gov/news/newsreleases.xml', source: 'OSHA Newsroom',                  category: 'regulatory' },
  { url: 'https://www.ecmweb.com/rss.xml',             source: 'EC&M',                           category: 'industry'   },
  { url: 'https://www.csemag.com/feed/',               source: 'Consulting-Specifying Engineer', category: 'industry'   },
  { url: 'https://www.plantengineering.com/feed/',     source: 'Plant Engineering',              category: 'industry'   },
];

// ── Match terms ───────────────────────────────────────────────────────────────
// Case-insensitive, whole-word(ish) match against title + summary. Word
// boundaries matter: a plain substring test on 'neta' would hit "planetary"
// and "internet". Ordered most-specific-first so matchedTerm (stored for the
// category-chip tooltip) names the sharpest hit, not the catch-all
// 'electrical'.
//
// The same filter applies to every feed. It bites hardest on the OSHA feed
// (their newsroom covers all industries — only electrical-ish releases
// survive); the trade feeds are already electrical-industry so "any term
// hits" is naturally permissive there.
const MATCH_TERMS = [
  'NFPA 70B',
  'NFPA 70E',
  'NFPA 110',
  'arc flash',
  'circuit breaker',
  'infrared inspection',
  'thermography',
  'switchgear',
  'transformer',
  'electrocution',
  'lockout',
  'generator',
  'preventive maintenance',
  'NETA',
  'electrical',
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TERM_MATCHERS = MATCH_TERMS.map((term) => ({
  term,
  re: new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i'),
}));

// First matching term, or null when nothing hits.
function findMatchedTerm(haystack: string): string | null {
  for (const { term, re } of TERM_MATCHERS) {
    if (re.test(haystack)) return term;
  }
  return null;
}

// ── Retention ─────────────────────────────────────────────────────────────────
// Items older than 120 days are pruned at the end of every run; the same
// window gates inserts so a feed replaying ancient archives can't refill
// what the prune just removed.
const MAX_AGE_MS = 120 * 24 * 60 * 60 * 1000;

// ── Core scanner ──────────────────────────────────────────────────────────────

/**
 * Fetch all feeds, filter by match terms, insert new items, prune old ones.
 * @returns {{ fetched: number, inserted: number, pruned: number, feedErrors: number }}
 */
async function runNewsScanner() {
  if (!SCANNER_ENABLED) {
    console.log('[newsScanner] Disabled via NEWS_SCANNER_ENABLED=false — skipping.');
    return { fetched: 0, inserted: 0, pruned: 0, feedErrors: 0 };
  }
  console.log('[newsScanner] Starting scan…');

  const parser = new Parser({ timeout: 10_000, maxRedirects: 3 });
  let feedErrors = 0;

  // Per-feed error isolation: each fetch catches its own failure so a dead
  // feed contributes an empty item list (and a feedErrors tick), never a
  // rejected run. allSettled is belt-and-braces on top of the try/catch.
  const settled = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        return { feed, items: parsed.items || [] };
      } catch (e: any) {
        feedErrors++;
        console.warn(`[newsScanner] Feed failed (${feed.source}): ${e.message}`);
        return { feed, items: [] };
      }
    })
  );

  const now = new Date();
  const oldestAllowed = now.getTime() - MAX_AGE_MS;

  let fetched = 0;
  const seenUrls = new Set<string>(); // in-run dedup (a story syndicated across feeds)
  const rows: any[] = [];

  for (const r of settled) {
    if (r.status !== 'fulfilled') { feedErrors++; continue; }
    const { feed, items } = r.value;
    fetched += items.length;

    for (const item of items) {
      const url = item.link || item.guid || '';
      // http(s)-only gate — a hostile feed's javascript: URL must never
      // reach the DB (it would render as a clickable <a href> in the SPA).
      if (!url || !/^https?:\/\//i.test(url)) continue;
      if (seenUrls.has(url)) continue;

      // publishedAt: pubDate → isoDate → now (some feeds omit dates).
      let publishedAt = now;
      const rawDate = item.pubDate || item.isoDate;
      if (rawDate) {
        const d = new Date(rawDate);
        if (!Number.isNaN(d.getTime())) publishedAt = d;
      }
      if (publishedAt.getTime() < oldestAllowed) continue; // would be pruned anyway

      const title = String(item.title || '').trim().slice(0, 500);
      if (!title) continue;
      const summaryRaw = String(item.contentSnippet || item.summary || '').trim();
      const summary = summaryRaw ? summaryRaw.slice(0, 500) : null;

      const matchedTerm = findMatchedTerm(`${title} ${summaryRaw}`);
      if (!matchedTerm) continue;

      seenUrls.add(url);
      rows.push({
        title,
        url,
        source: feed.source,
        category: feed.category,
        summary,
        matchedTerm,
        publishedAt,
      });
    }
  }

  // Insert: url is UNIQUE on news_items, so skipDuplicates makes the whole
  // batch idempotent across runs — re-fetched items are silently skipped,
  // no per-row exists() round-trips needed.
  let inserted = 0;
  if (rows.length > 0) {
    const result = await prisma.newsItem.createMany({ data: rows, skipDuplicates: true });
    inserted = result.count;
  }

  // Prune items older than 120 days to keep the table lean.
  const { count: pruned } = await prisma.newsItem.deleteMany({
    where: { publishedAt: { lt: new Date(oldestAllowed) } },
  });

  console.log(`[newsScanner] Done — fetched: ${fetched}, inserted: ${inserted}, pruned: ${pruned}, feedErrors: ${feedErrors}`);
  return { fetched, inserted, pruned, feedErrors };
}

module.exports = { runNewsScanner, FEEDS, MATCH_TERMS };

export {};

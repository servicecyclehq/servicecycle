/**
 * tavilySearch — Tavily REST API wrapper for the AI renewal brief.
 *
 * Single export: `search({ query, domains, timeRange, maxResults })`.
 * Returns an array of structured results (possibly empty).
 *
 * Phase 4 — v0.4.0.
 *
 * ── Fail-open contract ──────────────────────────────────────────────
 * Returns [] on ANY error: no API key, empty domain allowlist, network
 * timeout, non-2xx response, malformed JSON, AbortError, or the global
 * Tavily daily budget exhausted (v0.33.0+, demo-mode only). The brief
 * endpoint always falls back to the template's no-reference branch
 * when this returns empty — we never block a user-facing AI brief on
 * a flaky external service.
 *
 * ── Security invariants (roadmap §6.2, amended 2026-05-13) ──────────
 *  - TAVILY_API_KEY only from process.env, never from request body.
 *  - include_domains enforced server-side from the template config —
 *    callers cannot inject arbitrary domains.
 *  - Query is the template's static `searchQuery` field optionally
 *    suffixed with sanitized vendor+product names by the caller (see
 *    the "tighten query" comment in routes/contracts.js for the
 *    sanitizer). The wrapper still applies a hard 400-char clamp +
 *    rejects newlines/control chars as defence-in-depth. The shift
 *    from "vendor-free queries" to "sanitized vendor-suffixed
 *    queries" is intentional — generic queries were surfacing
 *    competitor marketplace pages instead of product-specific data
 *    (Notion case 2026-05-12). Vendor names are operator-controlled,
 *    not end-user-controlled, so the trust gradient is favourable.
 *  - Short timeout (4s) so a slow Tavily can't slow brief generation
 *    meaningfully.
 *  - max_results clamped to 1-10 regardless of caller input.
 *  - include_domains clamped to first 20 entries regardless of caller.
 *  - v0.33.0 (Pass-5 F-DEMO-01): global Tavily daily-budget guard.
 *    Pre-existing per-user brief_search cap was 2/day, but with
 *    DEMO_MAX_ACCOUNTS=1000 a scripted signup loop could still drain
 *    the Tavily free tier (1000/mo) in ~40 minutes. The process-wide
 *    counter in lib/aiBudgetGuard.js soft-stops the demo at the
 *    configured budget (default 30/day → ~900/mo) without blocking
 *    brief generation — the brief still ships using the template's
 *    no-reference branch.
 *
 * ── Optional relevance signal ──────────────────────────────────────
 * Callers can pass `relevanceMatchTerm` (e.g. the vendor name). When
 * supplied and the top-3 results contain NO substring match against
 * that term in title, url, OR snippet content, the wrapper emits a
 * one-line structured warn so operators / dev can spot consistently-
 * irrelevant search hits without parsing every brief output. Not used
 * for any fail/retry decision — purely observational. The content
 * scan was added v0.9.3 — Tavily sometimes returns pages that mention
 * the vendor only in the body (not the URL slug or page title), and
 * those used to false-positive the "low relevance" warn.
 *
 * ── Low-result-count signal ─────────────────────────────────────────
 * Separately from the relevance signal: when Tavily returns 0 or 1
 * result against a non-empty allowlist, the wrapper emits a different
 * one-line warn. That's the operator signal for "this template's
 * domain allowlist is probably too narrow / stale" rather than the
 * "results came back but for the wrong vendor" case. Added v0.9.3.
 *
 * ── Tavily API ──────────────────────────────────────────────────────
 * POST https://api.tavily.com/search
 *   Authorization: Bearer ${TAVILY_API_KEY}
 *   Body: { query, search_depth, include_domains[], max_results, time_range }
 *
 * Response (relevant fields):
 *   { results: [{ title, url, content, score }, ...] }
 *
 * Tavily's time_range accepts: day | week | month | year. Anything
 * else normalises to 'year' here.
 */

'use strict';

const budgetGuard = require('../aiBudgetGuard');

const TAVILY_URL          = 'https://api.tavily.com/search';
const TIMEOUT_MS          = 4000;
const ALLOWED_TIME_RANGES = new Set(['day', 'week', 'month', 'year']);
const DOMAIN_CAP          = 20;
const MAX_RESULTS_CAP     = 10;
const QUERY_MAX_CHARS     = 400;

// v0.33.0: budget-exhausted log is throttled to once per hour per
// process so a high-traffic demo doesn't fill the log file with the
// same message; the operator only needs to know "Tavily is rate-
// limited today, briefs are still going out but without enrichment."
let _lastBudgetLogAt = 0;

/**
 * search({ query, domains, timeRange, maxResults }) → Promise<Result[]>
 *
 * Result shape: { title, url, content, score }
 *
 * Never throws. Logs a single console.warn on real errors (not on
 * "API key missing" or "empty allowlist" — those are normal
 * configurations and shouldn't produce log noise on every brief).
 */
async function search({ query, domains, timeRange, maxResults, relevanceMatchTerm }: any = {}) {
  const apiKey = process.env.TAVILY_API_KEY;

  // ── Early-exit short-circuits ──────────────────────────────────
  // Each of these is a normal configuration ("operator hasn't set
  // a Tavily key" / "template doesn't ship a domain list") — return
  // [] silently, no log.
  if (!apiKey) return [];
  if (!Array.isArray(domains) || domains.length === 0) return [];
  if (typeof query !== 'string' || query.trim() === '') return [];

  // ── Global demo-day budget guard (v0.33.0, F-DEMO-01) ───────────
  // No-op on self-host (DEMO_MODE !== 'true'). On demo, gates the
  // call against the shared Tavily free-tier budget so a malicious
  // signup loop can't drain the monthly allowance in one afternoon.
  // Fail-open: when budget is exhausted we behave like "Tavily had
  // no results" — the template's no-reference branch still ships.
  const guard = budgetGuard.checkAndConsume('tavily');
  if (!guard.ok) {
    if (Date.now() - _lastBudgetLogAt > 3_600_000) {
      _lastBudgetLogAt = Date.now();
      console.warn(`[tavilySearch] daily-budget exhausted (${guard.callsToday}/${guard.budget}); failing open without enrichment until UTC rollover`);
    }
    return [];
  }

  // ── Clamp inputs (defence-in-depth) ─────────────────────────────
  // Hard-reject newlines / control chars in the query string — these
  // shouldn't appear via the sanitized vendor suffix but the wrapper
  // is the right place to enforce the invariant. Replace, don't
  // reject: an over-zealous reject path would suppress queries that
  // are otherwise benign.
  const safeQuery   = String(query).trim().replace(/[\r\n\t\x00-\x1F\x7F]/g, ' ').slice(0, QUERY_MAX_CHARS);
  const safeDomains = domains
    .filter((d) => typeof d === 'string' && d.length > 0 && d.length < 254)
    .slice(0, DOMAIN_CAP);
  const safeMaxResults = Math.min(
    Math.max(1, parseInt(maxResults, 10) || 3),
    MAX_RESULTS_CAP,
  );
  const safeTimeRange = ALLOWED_TIME_RANGES.has(timeRange) ? timeRange : 'year';

  if (safeDomains.length === 0) return [];

  const body = {
    query:           safeQuery,
    search_depth:    'basic',
    include_domains: safeDomains,
    max_results:     safeMaxResults,
    time_range:      safeTimeRange,
  };

  // ── Bounded request with abort timeout ──────────────────────────
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(TAVILY_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization:   `Bearer ${apiKey}`,
      },
      body:   JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`[tavilySearch] non-ok status ${res.status} (failing open, returning [])`);
      return [];
    }

    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];

    const mapped = results.map((r) => ({
      title:   typeof r?.title   === 'string' ? r.title   : '',
      url:     typeof r?.url     === 'string' ? r.url     : '',
      content: typeof r?.content === 'string' ? r.content : '',
      score:   typeof r?.score   === 'number' ? r.score   : 0,
    }));

    // ── Low-result-count signal ──────────────────────────────────
    // 0 or 1 result against a non-empty allowlist usually means the
    // template's domain list is too narrow (or stale) for the
    // particular vendor / product being briefed. Emit a distinct warn
    // so operators can tell "allowlist too narrow" apart from
    // "results returned but for the wrong vendor" (the relevance warn
    // below). Threshold is < 2 because Tavily's max_results cap for
    // briefs is 3 — getting 1 back is meaningful, getting 0 is
    // definitely worth a log line.
    if (mapped.length < 2) {
      console.warn(`[tavilySearch] low-result-count: ${mapped.length} results from ${safeDomains.length}-domain allowlist — query="${safeQuery.slice(0,120)}" domains=[${safeDomains.slice(0,5).join(',')}${safeDomains.length > 5 ? ',…' : ''}]`);
    }

    // ── Optional relevance signal ─────────────────────────────────
    // When the caller supplies a `relevanceMatchTerm` (typically the
    // vendor name) and the top-3 results contain NO substring match
    // against that term in title, url, or snippet content, emit a
    // structured warn so recurring "search returned but for the wrong
    // vendor" cases are visible without parsing brief outputs.
    // Substring match is case-insensitive. The content scan was added
    // v0.9.3 — Tavily sometimes returns pages that mention the vendor
    // only in the body (not the URL slug or page title), and those
    // used to false-positive this warn. No fail/retry consequence —
    // purely observational.
    if (typeof relevanceMatchTerm === 'string' && relevanceMatchTerm.trim().length > 1 && mapped.length > 0) {
      const term = relevanceMatchTerm.trim().toLowerCase();
      const top3 = mapped.slice(0, 3);
      const anyMatch = top3.some(r => `${r.title} ${r.url} ${r.content}`.toLowerCase().includes(term));
      if (!anyMatch) {
        const urls = top3.map(r => r.url).filter(Boolean).join(' | ');
        console.warn(`[tavilySearch] low-relevance: 0/${top3.length} top results matched "${relevanceMatchTerm}" — query="${safeQuery.slice(0,120)}" urls=[${urls}]`);
      }
    }

    return mapped;
  } catch (err) {
    clearTimeout(timeoutId);
    // AbortError is the timeout case — log it but at warn-not-error
    // level since it's expected when Tavily is slow / down.
    if (err && err.name === 'AbortError') {
      console.warn(`[tavilySearch] timeout after ${TIMEOUT_MS}ms (failing open, returning [])`);
    } else {
      console.warn(`[tavilySearch] error: ${err && err.message} (failing open, returning [])`);
    }
    return [];
  }
}

module.exports = { search, TIMEOUT_MS, ALLOWED_TIME_RANGES };

export {};

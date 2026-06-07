'use strict';

/**
 * negotiationAnalysis.js — LapseIQ topic layer for the debate engine
 *
 * Bridges the generic analysisEngine.js to LapseIQ's contract data model.
 * Responsibilities:
 *   1. Build the debate context from a Prisma-loaded contract (via buildContext)
 *   2. Enrich context with vendor news, license utilization, and line items
 *   3. Assemble the topic = { context, personas } for analysisEngine.runDebate
 *   4. Check and serve from result cache (fiscal-quarter TTL, context-hash invalidation)
 *   5. Store debate results and expose cache invalidation
 *
 * Cache design (v0.87.0+):
 *   - Two-layer: in-process Map (hot) + DB-backed NegotiationCache table (warm)
 *   - On server restart the Map is empty; DB fills it on first access per contract
 *   - TTL = end of current calendar quarter
 *   - Invalidation: context hash changes when endDate / notes / price / qty /
 *     utilization changes; explicit invalidate() deletes from both layers
 *   - fromCache flag in return value drives the UI "View" vs "Run" button state
 *
 * Prisma include required for the contract arg (same as aiBrief/buildContext.js):
 *   vendor: { select: { name, cotermComplexity, cotermNotes, notes, contacts: true } }
 *   tags: true
 *   parentContract: { select: { product, startDate, endDate, costPerLicense, quantity } }
 *   renewals: { select: { product, startDate, endDate, costPerLicense, quantity } }
 *
 * v0.82.0 — enriched buildDebateContext: vendor news (last 90 days),
 *   license utilization (seatsLicensed + seatsActivelyInUse), and
 *   non-archived line items fetched in parallel and injected into internalNotes.
 * v0.87.0 — DB-backed cache persistence via NegotiationCache table.
 */

const crypto  = require('crypto');
import prisma from './prisma';
const { buildContext }         = require('./aiBrief/buildContext');
const { sanitizeUntrustedText } = require('./promptSanitize');
const { runDebate }            = require('./analysisEngine');
const customerAdvocate         = require('./analysisPersonas/customerAdvocate');
const marketAnalyst            = require('./analysisPersonas/marketAnalyst');
const riskAssessor             = require('./analysisPersonas/riskAssessor');
const vendorAdvocate           = require('./analysisPersonas/vendorAdvocate');
const synthesisDirector        = require('./analysisPersonas/synthesisDirector');

function sx(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  return sanitizeUntrustedText(v).text;
}

// Fix CP1252-as-Latin1 double-encoding artifacts in AI-generated text.
// These arise when UTF-8 bytes were mis-read as Latin-1 and re-encoded.
// Applied on the cache read-path so existing DB rows get cleaned on serve.
function fixMojibake(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\u00e2\u20ac\u201d/g, '\u2014')  // em-dash
    .replace(/\u00e2\u20ac\u201c/g, '\u2013')  // en-dash
    .replace(/\u00e2\u2020\u2019/g, '\u2192')  // right arrow
    .replace(/\u00e2\u20ac\u00a6/g, '\u2026'); // ellipsis
}
function fixMojibakeDeep(obj) {
  if (typeof obj === 'string') return fixMojibake(obj);
  if (Array.isArray(obj))     return obj.map(fixMojibakeDeep);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fixMojibakeDeep(v)]));
  }
  return obj;
}

function fmtDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Cache — two-layer: in-process Map (hot) + DB NegotiationCache (warm)
// ---------------------------------------------------------------------------

/**
 * _cache: contractId → { hash: string, result: object, validUntil: number (ms) }
 *
 * Hot layer: sub-millisecond reads, no network latency.
 * Warm layer (DB): survives server restarts; loaded into hot layer on first hit.
 */
const _cache = new Map();

/**
 * calendarQuarterEnd — returns the last millisecond of the current calendar
 * quarter. Quarter-end aligns with when vendor quota pressure peaks and when
 * negotiation windows open, making it a natural TTL boundary.
 *
 * Future: replace with fiscalQuarterEnd(vendor.fiscal_year_end) once the
 * Vendor.fiscal_year_end field ships (see docs/BACKLOG.md).
 */
function calendarQuarterEnd() {
  const now   = new Date();
  const month = now.getMonth(); // 0–11
  // Quarter-end months: Mar(2), Jun(5), Sep(8), Dec(11)
  const quarterEndMonth = Math.floor(month / 3) * 3 + 2;
  // new Date(year, quarterEndMonth + 1, 0) = last day of quarterEndMonth
  return new Date(now.getFullYear(), quarterEndMonth + 1, 0, 23, 59, 59, 999);
}

/**
 * contextHash — short deterministic fingerprint of the fields that, if changed,
 * should invalidate the cached debate. Context-hash invalidation covers the
 * most common editing patterns without requiring explicit cache-busting calls.
 */
function contextHash(contract) {
  const parts = [
    contract.endDate      ? new Date(contract.endDate).toISOString()      : '',
    contract.cancelByDate ? new Date(contract.cancelByDate).toISOString() : '',
    contract.notes         || '',
    contract.vendor?.notes || '',
    String(contract.quantity           ?? ''),
    String(contract.costPerLicense     ?? ''),
    contract.autoRenewal ? '1' : '0',
    // v0.82.0: include utilization so a seat-count update busts the cache
    String(contract.seatsLicensed      ?? ''),
    String(contract.seatsActivelyInUse ?? ''),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * _checkCache — checks hot Map first; on miss falls back to DB warm layer.
 * Loads DB entry into hot Map on hit so subsequent calls are instant.
 * Returns the cached result object, or null on miss/expiry/hash mismatch.
 */
async function _checkCache(contractId, hash) {
  // Hot layer
  const entry = _cache.get(contractId);
  if (entry) {
    if (entry.hash !== hash || Date.now() > entry.validUntil) return null;
    return fixMojibakeDeep(entry.result);
  }

  // Warm layer (DB)
  try {
    const row = await prisma.negotiationCache.findUnique({ where: { contractId } });
    if (!row) return null;
    if (row.contextHash !== hash) return null;
    if (Date.now() > new Date(row.validUntil).getTime()) return null;

    // Promote to hot layer
    _cache.set(contractId, {
      hash:       row.contextHash,
      result:     row.result,          // Prisma Json field — already parsed
      validUntil: new Date(row.validUntil).getTime(),
    });
    return fixMojibakeDeep(row.result);
  } catch (dbErr) {
    // Non-fatal: DB miss → run fresh debate
    console.warn(`[negotiationAnalysis] DB cache lookup failed for ${contractId}:`, dbErr.message);
    return null;
  }
}

/**
 * _storeCache — writes to hot Map AND upserts to DB.
 * DB write is fire-and-forget on purpose: a DB failure should never block
 * the caller from receiving the freshly computed result.
 */
async function _storeCache(contractId, accountId, hash, result) {
  const validUntil = calendarQuarterEnd();

  // Hot layer (synchronous — always succeeds)
  _cache.set(contractId, { hash, result, validUntil: validUntil.getTime() });

  // Warm layer (DB — best-effort)
  try {
    await prisma.negotiationCache.upsert({
      where:  { contractId },
      update: { contextHash: hash, result, validUntil, updatedAt: new Date() },
      create: { contractId, accountId, contextHash: hash, result, validUntil },
    });
  } catch (dbErr) {
    console.warn(`[negotiationAnalysis] DB cache upsert failed for ${contractId}:`, dbErr.message);
  }
}

/**
 * invalidateNegotiationAnalysis — call this when a user explicitly re-runs the debate
 * or when contract data is updated via a route that should force a fresh run.
 * The contextHash handles silent invalidation; this handles forced invalidation.
 */
async function invalidateNegotiationAnalysis(contractId) {
  _cache.delete(contractId);

  try {
    await prisma.negotiationCache.deleteMany({ where: { contractId } });
  } catch (dbErr) {
    console.warn(`[negotiationAnalysis] DB cache delete failed for ${contractId}:`, dbErr.message);
  }

  console.log(`[negotiationAnalysis] cache invalidated — contract ${contractId}`);
}

/**
 * getNegotiationAnalysisStatus — returns metadata about a contract's current cache
 * state without returning the full result. Used by the negotiate route to
 * render the "View" vs "Run" button state in the UI.
 *
 * Async since v0.87.0: falls back to DB warm layer on Map miss (handles post-restart
 * state where the hot Map is empty but the DB has a valid cached debate).
 */
async function getNegotiationAnalysisStatus(contractId, contract) {
  const hash  = contextHash(contract);

  // Hot layer — synchronous fast path
  const entry = _cache.get(contractId);
  if (entry && entry.hash === hash && Date.now() <= entry.validUntil) {
    return {
      cached:      true,
      generatedAt: entry.result.generatedAt,
      validUntil:  new Date(entry.validUntil).toISOString(),
      verdict:     entry.result.verdictResult?.verdict ?? null,
      score:       entry.result.verdictResult?.score   ?? null,
      tier:        entry.result.verdictResult?.tier    ?? null,
    };
  }

  // Warm layer — DB fallback
  try {
    const row = await prisma.negotiationCache.findUnique({ where: { contractId } });
    if (row && row.contextHash === hash && Date.now() <= new Date(row.validUntil).getTime()) {
      // Promote to hot layer
      _cache.set(contractId, {
        hash:       row.contextHash,
        result:     row.result,
        validUntil: new Date(row.validUntil).getTime(),
      });
      return {
        cached:      true,
        generatedAt: (row.result as any).generatedAt,
        validUntil:  row.validUntil.toISOString(),
        verdict:     (row.result as any).verdictResult?.verdict ?? null,
        score:       (row.result as any).verdictResult?.score   ?? null,
        tier:        (row.result as any).verdictResult?.tier    ?? null,
      };
    }
  } catch (dbErr) {
    console.warn(`[negotiationAnalysis] getNegotiationAnalysisStatus DB error for ${contractId}:`, dbErr.message);
  }

  return { cached: false };
}

// ---------------------------------------------------------------------------
// Context enrichment — v0.82.0
// ---------------------------------------------------------------------------

/**
 * buildDebateContext — extends buildContext() with debate-specific enrichment.
 *
 * Fetches vendor news, line items, and active alerts in parallel alongside
 * the base context, then injects them into internalNotes as structured blocks.
 * The persona prompts already acknowledge this ("Internal Notes may contain
 * utilization or vendor context") so no prompt changes are needed.
 *
 * @param {object} contract - Prisma-loaded contract (all relations included)
 * @returns {Promise<object>} enriched context object
 */
async function buildDebateContext(contract) {
  const ctx = buildContext(contract);

  // v0.82.0: parallel fetch of enrichment data
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const [vendorNews, lineItems, alerts] = await Promise.all([
    contract.vendorId
      ? prisma.vendorNews.findMany({
          where:   { accountId: contract.accountId, vendorId: contract.vendorId, publishedAt: { gte: ninetyDaysAgo } },
          select:  { title: true, source: true, summary: true, category: true, publishedAt: true },
          orderBy: { publishedAt: 'desc' },
          take:    20,
        })
      : [],

    prisma.contractLineItem.findMany({
      where:   { contractId: contract.id, archivedAt: null },
      select:  {
        sku: true, productName: true,
        originalCount: true, originalCostPerUnit: true,
        plannedNewCount: true, plannedNewCostPerUnit: true,
        notes: true,
      },
      orderBy: { sortOrder: 'asc' },
    }),

    prisma.alert.findMany({
      where:   { contractId: contract.id, accountId: contract.accountId, status: { in: ['pending', 'sent'] } },
      select:  { alertType: true, daysBeforeEnd: true, scheduledAt: true, status: true },
      orderBy: { scheduledAt: 'asc' },
      take:    20,
    }),
  ]);

  // Build enrichment suffix
  const sections = [];

  // License utilization (contract fields — no extra query needed)
  const seatsLicensed = contract.seatsLicensed    ?? null;
  const seatsInUse    = contract.seatsActivelyInUse ?? null;
  const utilizationPct = (seatsLicensed && seatsInUse)
    ? Math.round((seatsInUse / seatsLicensed) * 100) : null;
  if (seatsLicensed !== null || seatsInUse !== null) {
    const parts = [];
    if (seatsLicensed   !== null) parts.push(`${seatsLicensed} seats licensed`);
    if (seatsInUse      !== null) parts.push(`${seatsInUse} in active use`);
    if (utilizationPct  !== null) parts.push(`${utilizationPct}% utilization`);
    sections.push(`[UTILIZATION] ${parts.join(', ')}`);
  }

  // Annual uplift
  if (contract.annualUpliftPercent != null) {
    sections.push(`[ANNUAL UPLIFT] Expected price increase at renewal: ${parseFloat(contract.annualUpliftPercent)}%`);
  }

  // Line items
  if (lineItems.length) {
    const li = ['[LINE ITEMS]'];
    for (const item of lineItems) {
      const unitPrice = item.originalCostPerUnit ? `$${parseFloat(String(item.originalCostPerUnit)).toFixed(2)}/unit` : '';
      li.push(`  ${sx(item.productName) || 'Unknown'}${item.sku ? ` (${item.sku})` : ''}: ${item.originalCount}x ${unitPrice}`.trimEnd());
      if (item.plannedNewCount != null) {
        const newUnit = item.plannedNewCostPerUnit ? `$${parseFloat(String(item.plannedNewCostPerUnit)).toFixed(2)}/unit` : '';
        li.push(`    → Planned: ${item.plannedNewCount}x ${newUnit}`.trimEnd());
      }
    }
    sections.push(li.join('\n'));
  }

  // Active alerts
  if (alerts.length) {
    const al = ['[ACTIVE ALERTS]'];
    for (const a of alerts) {
      const when = a.daysBeforeEnd ? `${a.daysBeforeEnd}d before end` : fmtDate(a.scheduledAt);
      al.push(`  ${a.alertType} — ${when} [${a.status}]`);
    }
    sections.push(al.join('\n'));
  }

  // Vendor news
  if (vendorNews.length) {
    const nw = [`[VENDOR NEWS — last 90 days (${vendorNews.length} items)]`];
    for (const n of vendorNews) {
      nw.push(`  [${(n.category || 'news').toUpperCase()}] ${fmtDate(n.publishedAt)}: ${sx(n.title)} (${sx(n.source)})`);
      if (n.summary) nw.push(`    ${sx(n.summary)}`);
    }
    sections.push(nw.join('\n'));
  } else {
    sections.push('[VENDOR NEWS] No vendor news catalog entries in the last 90 days.');
  }

  // Append enrichment to internalNotes
  if (sections.length) {
    const enrichment = sections.join('\n\n');
    ctx.internalNotes = ctx.internalNotes
      ? `${ctx.internalNotes}\n\n${enrichment}`
      : enrichment;
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * runNegotiationAnalysis — orchestrates the full 5-persona debate for a contract.
 *
 * @param {object} contract - Prisma-loaded contract with required relations
 * @param {function} aiCall - async ({ system, user, maxTokens, settings, cacheSystem }) => { text }
 * @param {object}  [settings={}] - AI settings from the instance (provider, key, model, etc.)
 * @param {object}  [opts={}]
 * @param {boolean} [opts.forceRefresh=false] - skip cache and run a fresh debate
 *
 * @returns {Promise<object>} Full debate result + fromCache flag + cacheValidUntil
 *
 * Return shape:
 * {
 *   advocate:        object,   // CustomerAdvocate JSON
 *   analyst:         object,   // MarketAnalyst JSON
 *   assessor:        object,   // RiskAssessor JSON
 *   vendor:          object,   // VendorAdvocate JSON
 *   verdictResult:   object,   // { verdict, score, scores, tier, override_rule, ... }
 *   confidenceFlags: string[], // LOW_MARKET_CONFIDENCE | LOW_RISK_CONFIDENCE | ...
 *   synthesis:       object,   // SynthesisDirector board output
 *   generatedAt:     string,   // ISO timestamp
 *   fromCache:       boolean,
 *   cacheValidUntil: string,   // ISO timestamp (null if fromCache=false)
 * }
 */
async function runNegotiationAnalysis(contract, aiCall, settings: any = {}, opts: any = {}) {
  const contractId = contract.id;
  const accountId  = contract.accountId;
  const hash       = contextHash(contract);

  // Cache check (two-layer: Map → DB)
  if (!opts.forceRefresh) {
    const cached = await _checkCache(contractId, hash);
    if (cached) {
      const entry = _cache.get(contractId);
      console.log(`[negotiationAnalysis] cache hit — contract ${contractId} verdict=${cached.verdictResult?.verdict}`);
      return {
        ...cached,
        fromCache:       true,
        cacheValidUntil: entry ? new Date(entry.validUntil).toISOString() : null,
      };
    }
  }

  console.log(`[negotiationAnalysis] running debate — contract ${contractId}`);
  // v0.82.0: buildDebateContext is now async (fetches vendor news + line items)
  const ctx = await buildDebateContext(contract);

  const topic = {
    context: ctx,
    personas: {
      customerAdvocate,
      marketAnalyst,
      riskAssessor,
      vendorAdvocate,
      synthesisDirector,
    },
  };

  const result = await runDebate(topic, aiCall, settings);

  // Store in both cache layers
  await _storeCache(contractId, accountId, hash, result);
  const entry = _cache.get(contractId);

  console.log(`[negotiationAnalysis] debate complete — contract ${contractId} verdict=${result.verdictResult?.verdict} cached until ${entry ? new Date(entry.validUntil).toLocaleDateString() : '?'}`);

  return {
    ...result,
    fromCache:       false,
    cacheValidUntil: null, // first run — client doesn't need this
  };
}

module.exports = {
  runNegotiationAnalysis,
  invalidateNegotiationAnalysis,
  getNegotiationAnalysisStatus,
  calendarQuarterEnd, // exported for test + the future fiscal-quarter TTL module
};

export {};

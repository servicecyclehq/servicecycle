'use strict';

/**
 * installedBaseIntel.ts — Installed-Base Intelligence (IBI).
 *
 * Three account-scoped rollups over data the platform already records:
 *
 *   1. FLEET BENCHMARKS — every asset's latest test readings placed inside a
 *      comparison pool of like units (same equipmentType + measurementType +
 *      unit), expressed as a percentile plus a trend arrow.
 *   2. MODERNIZATION PIPELINE — assets ranked by the stored
 *      Asset.modernizationRiskScore (written daily by the
 *      lib/modernizationAlerts.ts cron), with the score's actual inputs
 *      surfaced as drivers and repair-cost / spare-lead-time exposure attached.
 *   3. ATTACH-RATE FUNNEL — identified findings → quoted → converted/resolved
 *      over a caller-chosen window, with the definition of each stage embedded
 *      so the UI can show "what counts" verbatim.
 *
 * FRAMING POSTURE (recorded product policy — do not weaken):
 *   Benchmarks are FLEET CONTEXT, not engineering judgment. No computed PPE,
 *   no remaining-life guarantees, no "replace now" imperatives. Percentiles
 *   describe the data pool; condition decisions belong to qualified engineers.
 *   Pools below MIN_POOL_SIZE are flagged "small comparison pool — directional
 *   only" instead of implying false precision. The caveat strings below ship
 *   to the client verbatim so the recorded posture and the rendered posture
 *   cannot drift apart.
 *
 * NORMALIZATION — REUSED, NOT REINVENTED:
 *   measurementType strings are already canonical at ingest
 *   (lib/testReportParse.ts MEASUREMENT_VOCAB → lib/commitTestReport.ts is the
 *   single writer for PDF/Doble/email paths, and the seeds write the same
 *   vocabulary). Worse-direction per metric and the trend threshold are
 *   IMPORTED from lib/commitTestReport.ts (BAD_DIRECTION / TREND_PCT — the
 *   exact constants behind the ingest-time "trending up/down N% since last
 *   test" ADVISORY flags), so a benchmark trend arrow and an ingest trend
 *   deficiency can never disagree. Units are NOT converted here: pools are
 *   split by the recorded unit string, so a MΩ pool never mixes with a GΩ
 *   pool (presentation choice — no second normalization engine).
 *
 * Pure/testable core + thin prisma orchestrators (buildDriftDetector pattern):
 * every build*From* function takes plain arrays; the exported build* functions
 * take (prisma, accountId, opts) so routes stay thin and tests need no DB.
 */

const { BAD_DIRECTION, TREND_PCT } = require('./commitTestReport');

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;

// ── Presentation constants (documented choices, not standards) ───────────────

// Pools smaller than this get thinPool=true → "small comparison pool —
// directional only" badge instead of a confident-looking percentile.
const MIN_POOL_SIZE = 8;

// Watch/Plan/Act banding for the modernization pipeline. These mirror the
// alert tiers already documented in lib/modernizationAlerts.ts (0.50 watch
// list / 0.70 planning advisory / 0.85 high urgency). Presentation choices for
// grouping a continuous score — not published-standard thresholds.
const PIPELINE_BANDS = { watch: 0.5, plan: 0.7, act: 0.85 };

// Row caps — generous vs. current fleet scale; page if the fleet outgrows them.
const MAX_MEASUREMENT_ROWS = 20_000;
const MAX_FUNNEL_ROWS = 5_000;
const MAX_PIPELINE_ASSETS = 5_000;

// Shipped-verbatim caveats (see FRAMING POSTURE above).
const BENCHMARK_CAVEAT =
  'Percentiles describe this fleet’s recorded test-data pool — comparable units grouped by ' +
  'equipment type, measurement, and unit. They are fleet context, not an engineering judgment ' +
  'about any unit’s condition. Small pools are flagged as directional only. Condition decisions ' +
  'belong to qualified engineers.';

const PIPELINE_CAVEAT =
  'Modernization scores rank renewal exposure for budget planning, using the same daily scoring ' +
  'engine that drives modernization alerts (asset age vs IEEE/NFPA/NETA base-life references, ' +
  'NFPA 70B condition rating, OEM end-of-support dates). They are fleet context — not a ' +
  'remaining-life guarantee, a condition assessment, or a directive to replace equipment. ' +
  'Condition decisions belong to qualified engineers.';

const ESTIMATE_BASIS =
  'Estimated $ sums the owner-recorded repair-cost estimate (parts + labor + downtime) once per ' +
  'distinct asset carrying at least one finding in the period. Findings on assets without a ' +
  'recorded estimate contribute $0, so the figure is a floor, not a quote. Estimates are planning ' +
  'inputs recorded by your team — not engineering assessments or offers of work.';

// "What counts" per funnel stage — rendered as tooltips by the UI.
const FUNNEL_STAGES = [
  {
    key: 'identified',
    label: 'Identified',
    definition:
      'Deficiencies (findings) recorded in the period — from test-report ingest, field capture, ' +
      'inspections, or manual entry. Count = findings created in the window; assets = distinct ' +
      'assets carrying at least one of those findings. Estimated $ is defined under "estimate basis".',
  },
  {
    key: 'quoted',
    label: 'Quoted',
    definition:
      'Quote requests created in the period (drafts excluded). "On identified assets" counts quote ' +
      'requests whose asset also had a finding identified in the same period — the attach signal. ' +
      'Quote amounts live in free-text quote notes, so this stage reports counts, not dollars.',
  },
  {
    key: 'converted',
    label: 'Converted / resolved',
    definition:
      'Movement to resolution inside the period: quote requests accepted by the customer, and ' +
      'findings marked resolved. Either can close out work identified in an earlier period, so ' +
      'this stage can exceed the current window’s identified count.',
  },
];

// ── Small pure helpers ────────────────────────────────────────────────────────

function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function assetLabel(a: any): string {
  if (!a) return 'Asset';
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType || 'Asset');
}

// Unit pool key: trimmed as-recorded string. Deliberately NO conversion — see
// module header. Empty/missing units pool together as '(no unit)'.
function normUnit(u: any): string {
  const s = String(u == null ? '' : u).trim();
  return s || '(no unit)';
}

/**
 * Mean-rank percentile of `v` inside `pool`, oriented so that HIGHER
 * percentile = healthier relative to the pool:
 *
 *   percentile = (worseCount + 0.5 × tieCount) / n × 100
 *
 * where "worse" follows the ingest-layer BAD_DIRECTION for the metric:
 *   direction 'down' (lower is worse, e.g. insulation resistance): worse = x < v
 *   direction 'up'   (higher is worse, e.g. contact resistance):   worse = x > v
 *   unknown direction: ranked ascending by value with NO health claim — the
 *   caller marks these rows orientation 'value_order'.
 *
 * tieCount includes the value itself, so a pool of one yields the 50th
 * percentile (and is thin-flagged anyway). Ties share a symmetric rank.
 */
function percentileRank(pool: number[], v: number, direction: string | null = null): number {
  const n = Array.isArray(pool) ? pool.length : 0;
  if (n === 0) return 50;
  let worse = 0;
  let tie = 0;
  for (const x of pool) {
    if (x === v) { tie++; continue; }
    if (direction === 'up' ? x > v : x < v) worse++;
  }
  if (tie === 0) tie = 1; // defensive: v should be a pool member
  return Math.round(((worse + 0.5 * tie) / n) * 100);
}

/**
 * Trend classification between an asset's latest and prior reading of the
 * same metric+phase. SAME math as the ingest trend flag in
 * lib/commitTestReport.ts (pct vs |prior|, TREND_PCT threshold, BAD_DIRECTION
 * orientation): 'degrading' here ⇔ ingest would have raised the "trending …
 * still in spec, monitor" ADVISORY.
 * Returns null when there is no prior, prior is 0, or the metric has no
 * known worse-direction.
 */
function classifyTrend(latest: any, prior: any, direction: string | null): string | null {
  const v = num(latest);
  const p = num(prior);
  if (v == null || p == null || p === 0 || (direction !== 'up' && direction !== 'down')) return null;
  const pct = ((v - p) / Math.abs(p)) * 100;
  if (direction === 'up' ? pct >= TREND_PCT : pct <= -TREND_PCT) return 'degrading';
  if (direction === 'up' ? pct <= -TREND_PCT : pct >= TREND_PCT) return 'improving';
  return 'stable';
}

/** Watch/Plan/Act band for a modernization score (see PIPELINE_BANDS). */
function bandForScore(score: any): string | null {
  const s = num(score);
  if (s == null) return null;
  if (s >= PIPELINE_BANDS.act) return 'act';
  if (s >= PIPELINE_BANDS.plan) return 'plan';
  if (s >= PIPELINE_BANDS.watch) return 'watch';
  return 'healthy';
}

// ── 1. Fleet benchmarks (pure core) ──────────────────────────────────────────

/**
 * rows: [{ assetId, assetLabel, siteName, equipmentType, measurementType,
 *          phase, unit, value, at }] in any order (value numeric, at Date/ISO).
 *
 * Returns { rows, pools, summary }:
 *   rows  — one per (asset, metric, unit): the asset's representative latest
 *           value, its percentile inside the pool of like units, trend, pool
 *           size + thin flag.
 *   pools — one per (equipmentType, metric, unit): size, min/median/max.
 *
 * Representative value per asset+metric: the WORST phase (per BAD_DIRECTION)
 * when the metric has a known direction — matching how a reviewer reads a
 * three-phase result — else the most recent reading across phases.
 */
function buildBenchmarksFromRows(rawRows: any[]): any {
  const rows = (rawRows || [])
    .map((r: any) => ({ ...r, value: num(r.value), atMs: new Date(r.at).getTime() }))
    .filter((r: any) => r.value != null && Number.isFinite(r.atMs) && r.assetId && r.measurementType);
  rows.sort((a: any, b: any) => b.atMs - a.atMs); // newest first

  // Latest + prior per (asset | metric | unit | phase).
  const series = new Map<string, any>();
  for (const r of rows) {
    const unit = normUnit(r.unit);
    const key = `${r.assetId}|${r.measurementType}|${unit}|${r.phase || ''}`;
    let s = series.get(key);
    if (!s) {
      s = { assetId: r.assetId, assetLabel: r.assetLabel, siteName: r.siteName ?? null,
            equipmentType: r.equipmentType ?? null, measurementType: r.measurementType,
            unit, phase: r.phase || null, latest: r.value, latestAtMs: r.atMs, prior: null, priorAtMs: null };
      series.set(key, s);
    } else if (s.prior == null && r.atMs < s.latestAtMs) {
      s.prior = r.value;
      s.priorAtMs = r.atMs;
    }
  }

  // Collapse phases → one representative row per (asset | metric | unit).
  const byAssetMetric = new Map<string, any>();
  for (const s of series.values()) {
    const key = `${s.assetId}|${s.measurementType}|${s.unit}`;
    const dir = BAD_DIRECTION[s.measurementType] || null;
    let g = byAssetMetric.get(key);
    if (!g) { g = { phases: [] }; byAssetMetric.set(key, g); }
    g.phases.push({ ...s, direction: dir, trend: classifyTrend(s.latest, s.prior, dir) });
  }

  const outRows: any[] = [];
  for (const g of byAssetMetric.values()) {
    const dir = g.phases[0].direction;
    let rep = g.phases[0];
    for (const p of g.phases) {
      if (dir === 'up') { if (p.latest > rep.latest) rep = p; }        // higher = worse
      else if (dir === 'down') { if (p.latest < rep.latest) rep = p; } // lower = worse
      else if (p.latestAtMs > rep.latestAtMs) rep = p;                 // no direction: most recent
    }
    // Asset-level trend: any phase degrading wins; else any improving; else stable.
    const trends = g.phases.map((p: any) => p.trend).filter(Boolean);
    const trend = trends.includes('degrading') ? 'degrading'
      : trends.includes('improving') ? 'improving'
      : trends.length ? 'stable' : null;
    const deltaPct = (rep.prior != null && rep.prior !== 0)
      ? Math.round(((rep.latest - rep.prior) / Math.abs(rep.prior)) * 1000) / 10
      : null;
    outRows.push({
      assetId: rep.assetId, assetLabel: rep.assetLabel, siteName: rep.siteName,
      equipmentType: rep.equipmentType, measurementType: rep.measurementType, unit: rep.unit,
      phase: rep.phase, latestValue: rep.latest, latestAt: new Date(rep.latestAtMs),
      priorValue: rep.prior, priorAt: rep.priorAtMs ? new Date(rep.priorAtMs) : null,
      deltaPct, trend, phasesInPool: g.phases.length,
      direction: dir,
      orientation: dir === 'down' ? 'higher_is_better' : dir === 'up' ? 'lower_is_better' : 'value_order',
    });
  }

  // Pools per (equipmentType | metric | unit) → percentile each row.
  const poolMap = new Map<string, any>();
  for (const r of outRows) {
    const key = `${r.equipmentType || ''}|${r.measurementType}|${r.unit}`;
    let p = poolMap.get(key);
    if (!p) {
      p = { key, equipmentType: r.equipmentType, measurementType: r.measurementType, unit: r.unit, values: [] };
      poolMap.set(key, p);
    }
    p.values.push(r.latestValue);
  }
  const pools: any[] = [];
  for (const p of poolMap.values()) {
    const sorted = [...p.values].sort((a, b) => a - b);
    const n = sorted.length;
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    pools.push({
      key: p.key, equipmentType: p.equipmentType, measurementType: p.measurementType, unit: p.unit,
      poolSize: n, thinPool: n < MIN_POOL_SIZE, min: sorted[0], median, max: sorted[n - 1],
    });
  }
  for (const r of outRows) {
    const key = `${r.equipmentType || ''}|${r.measurementType}|${r.unit}`;
    const p = poolMap.get(key);
    r.poolKey = key;
    r.poolSize = p.values.length;
    r.thinPool = p.values.length < MIN_POOL_SIZE;
    r.percentile = percentileRank(p.values, r.latestValue, r.direction);
  }

  // Worst-context-first: lowest percentile leads (thin pools sort after solid
  // ones at the same percentile so directional rows don't lead the table).
  outRows.sort((a, b) => (a.percentile - b.percentile) || (Number(a.thinPool) - Number(b.thinPool)) || String(a.assetLabel).localeCompare(String(b.assetLabel)));
  pools.sort((a, b) => b.poolSize - a.poolSize || a.key.localeCompare(b.key));

  const summary = {
    assets: new Set(outRows.map((r) => r.assetId)).size,
    metricRows: outRows.length,
    pools: pools.length,
    thinPools: pools.filter((p) => p.thinPool).length,
    degrading: outRows.filter((r) => r.trend === 'degrading').length,
    improving: outRows.filter((r) => r.trend === 'improving').length,
    stable: outRows.filter((r) => r.trend === 'stable').length,
  };

  return { rows: outRows, pools, summary };
}

// ── 2. Modernization pipeline (pure core) ────────────────────────────────────

// Mirror of lib/modernizationAlerts.ts EQUIP_TO_CLASS — that table is not
// exported (module-scope const) and this module must not edit that file.
// Used ONLY for the fallback path below when the daily cron has not stamped a
// score yet; the score itself always comes from the one true function
// computeModernizationRiskScore. KEEP IN SYNC — do not diverge.
const EQUIP_TO_CLASS_MIRROR: any = {
  TRANSFORMER_LIQUID: 'transformer_liquid_filled',
  TRANSFORMER_DRY: 'transformer_dry_type',
  SWITCHGEAR: 'switchgear_mv',
  SWITCHBOARD: 'switchgear_lv',
  PANELBOARD: 'switchgear_lv',
  CIRCUIT_BREAKER: 'breaker_lv_mccb',
  PROTECTION_RELAY: 'relay_microprocessor',
  MCC: 'mcc',
  UPS_BATTERY: 'ups',
  BATTERY_SYSTEM: 'battery_vrla',
  TRANSFER_SWITCH: 'ats',
};

/**
 * assets: plain rows with { id, equipmentType, manufacturer, model,
 * serialNumber, siteName, installDate, governingCondition, endOfSupport,
 * obsolescenceStatus, modernizationRiskScore, repairCostEstimate,
 * spareLeadTimeWeeks, redundancyStatus, criticalityScore }.
 *
 * Score precedence: the STORED modernizationRiskScore (daily cron output) is
 * the product's source of truth. When it is null (fresh DB before the 09:00
 * UTC cron) and the asset has an installDate or endOfSupport, we compute the
 * identical number through the exported computeModernizationRiskScore so the
 * report is never empty-by-accident; scoreSource says which happened.
 *
 * Drivers = the engine's actual inputs (lib/modernizationAlerts.ts:93-108):
 * OEM end-of-support date when present (5-year normalization path), else
 * age vs condition-adjusted base life. impliedExpectedLifeYears = age/score,
 * the exact algebraic inverse of the heuristic — no second model.
 */
function buildModernizationPipelineFromAssets(assets: any[], now: Date = new Date()): any {
  const rows: any[] = [];
  let notScored = 0;

  for (const a of assets || []) {
    const install = a.installDate ? new Date(a.installDate) : null;
    const ageYears = install ? (now.getTime() - install.getTime()) / YEAR_MS : null;
    const eos = a.endOfSupport ? new Date(a.endOfSupport) : null;

    let score = num(a.modernizationRiskScore);
    let scoreSource = score != null ? 'stored' : null;
    if (score == null && (eos || ageYears != null)) {
      // Lazy require: keeps this module import-light for unit tests and avoids
      // pulling the email stack unless the fallback actually runs.
      const { computeModernizationRiskScore } = require('./modernizationAlerts');
      score = computeModernizationRiskScore(
        EQUIP_TO_CLASS_MIRROR[a.equipmentType] ?? 'transformer_dry_type',
        ageYears ?? 0,
        a.governingCondition ?? 'C2',
        eos,
      );
      scoreSource = 'computed_fallback';
    }
    if (score == null) { notScored++; continue; }

    const roundedScore = Math.round(score * 100) / 100;
    rows.push({
      assetId: a.id,
      assetLabel: assetLabel(a),
      siteName: a.siteName ?? null,
      equipmentType: a.equipmentType ?? null,
      score: roundedScore,
      band: bandForScore(score),
      scoreSource,
      drivers: {
        path: eos ? 'oem_end_of_support' : 'age_condition_heuristic',
        installDate: install,
        ageYears: ageYears != null ? Math.round(ageYears * 10) / 10 : null,
        governingCondition: a.governingCondition ?? null,
        endOfSupport: eos,
        obsolescenceStatus: a.obsolescenceStatus ?? null,
        // Heuristic path is score = age / (baseLife × conditionMultiplier), so
        // the condition-adjusted expected life the engine used is age/score.
        impliedExpectedLifeYears: (!eos && ageYears != null && score > 0)
          ? Math.round((ageYears / score) * 10) / 10 : null,
      },
      repairCostEstimate: num(a.repairCostEstimate),
      spareLeadTimeWeeks: a.spareLeadTimeWeeks ?? null,
      redundancyStatus: a.redundancyStatus ?? null,
      criticalityScore: a.criticalityScore ?? null,
    });
  }

  rows.sort((a, b) => b.score - a.score || String(a.assetLabel).localeCompare(String(b.assetLabel)));
  const banded = rows.filter((r) => r.band !== 'healthy');

  const sumCost = (list: any[]) => list.reduce((acc, r) => acc + (r.repairCostEstimate || 0), 0);
  const summary = {
    assetsTotal: (assets || []).length,
    scored: rows.length,
    notScored,
    act: rows.filter((r) => r.band === 'act').length,
    plan: rows.filter((r) => r.band === 'plan').length,
    watch: rows.filter((r) => r.band === 'watch').length,
    healthy: rows.filter((r) => r.band === 'healthy').length,
    // Exposure attached to the banded (watch+) pipeline. Cost is the sum of
    // owner-recorded repair-cost estimates where present — a floor, not a quote.
    pipelineCostKnown: Math.round(sumCost(banded)),
    pipelineCostAssets: banded.filter((r) => r.repairCostEstimate != null).length,
    longLeadInPipeline: banded.filter((r) => (r.spareLeadTimeWeeks ?? 0) >= 12).length,
  };

  return {
    generatedAt: now,
    caveat: PIPELINE_CAVEAT,
    bands: { ...PIPELINE_BANDS },
    summary,
    rows: banded,
    healthyRows: rows.length - banded.length,
  };
}

// ── 3. Attach-rate funnel (pure core) ────────────────────────────────────────

/**
 * deficiencies: [{ id, assetId, severity, createdAt, resolvedAt,
 *                  asset: { repairCostEstimate } }]  (created OR resolved in window)
 * quoteRequests: [{ id, assetId, status, createdAt, resolvedAt }]
 */
function buildAttachRateFromData(input: any, opts: any = {}): any {
  const now: Date = opts.now ? new Date(opts.now) : new Date();
  const days: number = Math.min(365, Math.max(7, Math.trunc(Number(opts.days) || 90)));
  const since = new Date(now.getTime() - days * DAY_MS);
  const defs = input?.deficiencies || [];
  const qrs = input?.quoteRequests || [];

  const inWindow = (d: any) => d != null && new Date(d).getTime() >= since.getTime();

  // Stage 1 — identified.
  const identifiedDefs = defs.filter((d: any) => inWindow(d.createdAt));
  const bySeverity: any = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };
  const identifiedAssetIds = new Set<string>();
  const estByAsset = new Map<string, number | null>();
  for (const d of identifiedDefs) {
    if (bySeverity[d.severity] != null) bySeverity[d.severity]++;
    if (d.assetId) {
      identifiedAssetIds.add(d.assetId);
      if (!estByAsset.has(d.assetId)) estByAsset.set(d.assetId, num(d.asset?.repairCostEstimate));
    }
  }
  let estimatedUsd = 0;
  let assetsWithEstimate = 0;
  for (const v of estByAsset.values()) {
    if (v != null) { estimatedUsd += v; assetsWithEstimate++; }
  }

  // Stage 2 — quoted (drafts are unsent by definition; excluded).
  const quotedQrs = qrs.filter((q: any) => q.status !== 'draft' && inWindow(q.createdAt));
  const quotedOnIdentified = quotedQrs.filter((q: any) => q.assetId && identifiedAssetIds.has(q.assetId));
  const quotedAssetIds = new Set(quotedOnIdentified.map((q: any) => q.assetId));

  // Stage 3 — converted / resolved.
  const acceptedQrs = qrs.filter((q: any) => q.status === 'accepted' && inWindow(q.resolvedAt));
  const resolvedDefs = defs.filter((d: any) => inWindow(d.resolvedAt));

  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);

  return {
    generatedAt: now,
    days,
    since,
    estimateBasis: ESTIMATE_BASIS,
    definitions: FUNNEL_STAGES,
    stages: {
      identified: {
        findings: identifiedDefs.length,
        bySeverity,
        assets: identifiedAssetIds.size,
        estimatedUsd: Math.round(estimatedUsd),
        assetsWithEstimate,
        assetsWithoutEstimate: identifiedAssetIds.size - assetsWithEstimate,
      },
      quoted: {
        quoteRequests: quotedQrs.length,
        onIdentifiedAssets: quotedOnIdentified.length,
        identifiedAssetsQuoted: quotedAssetIds.size,
      },
      converted: {
        quotesAccepted: acceptedQrs.length,
        findingsResolved: resolvedDefs.length,
      },
    },
    rates: {
      // Of the assets with findings this period, the share that also has a
      // (non-draft) quote request from this period.
      attachRatePct: pct(quotedAssetIds.size, identifiedAssetIds.size),
      // Of this period's quote requests, the share accepted within the period.
      acceptRatePct: pct(acceptedQrs.length, quotedQrs.length),
    },
  };
}

// ── Prisma orchestrators (thin; tenancy is the caller-supplied accountId) ────

const MEASUREMENT_SELECT = {
  measurementType: true, phase: true, asFoundValue: true, asFoundUnit: true, createdAt: true,
  workOrder: {
    select: {
      assetId: true,
      asset: {
        select: {
          id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true,
          site: { select: { name: true } },
        },
      },
    },
  },
};

function measurementToRow(m: any): any {
  const a = m.workOrder?.asset;
  return {
    assetId: a?.id ?? m.workOrder?.assetId,
    assetLabel: assetLabel(a),
    siteName: a?.site?.name ?? null,
    equipmentType: a?.equipmentType ?? null,
    measurementType: m.measurementType,
    phase: m.phase,
    unit: m.asFoundUnit,
    value: m.asFoundValue,
    at: m.createdAt,
  };
}

async function buildFleetBenchmarks(prisma: any, accountId: string, opts: any = {}) {
  const where: any = {
    accountId,
    deletedAt: null,
    asFoundValue: { not: null },
    workOrder: { asset: { archivedAt: null } },
  };
  if (opts.measurementType) where.measurementType = String(opts.measurementType);
  if (opts.equipmentType) where.workOrder = { asset: { archivedAt: null, equipmentType: opts.equipmentType } };

  const measurements = await prisma.testMeasurement.findMany({
    where,
    select: MEASUREMENT_SELECT,
    orderBy: { createdAt: 'desc' },
    take: MAX_MEASUREMENT_ROWS,
  });

  const built = buildBenchmarksFromRows(measurements.map(measurementToRow));
  return {
    generatedAt: new Date(),
    caveat: BENCHMARK_CAVEAT,
    thinPoolThreshold: MIN_POOL_SIZE,
    ...built,
  };
}

async function buildAssetBenchmarks(prisma: any, accountId: string, assetId: string) {
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, accountId },
    select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true, site: { select: { name: true } } },
  });
  if (!asset) {
    const e: any = new Error('Asset not found.');
    e.code = 'ASSET_NOT_FOUND';
    throw e;
  }
  // Pool context requires the whole fleet of like units, so build fleet-wide
  // (scoped to this asset's equipmentType) and filter rows to the asset.
  const fleet = await buildFleetBenchmarks(prisma, accountId, { equipmentType: asset.equipmentType });
  const rows = fleet.rows.filter((r: any) => r.assetId === assetId);
  const poolKeys = new Set(rows.map((r: any) => r.poolKey));
  return {
    generatedAt: fleet.generatedAt,
    caveat: fleet.caveat,
    thinPoolThreshold: fleet.thinPoolThreshold,
    asset: { id: asset.id, label: assetLabel(asset), equipmentType: asset.equipmentType, siteName: asset.site?.name ?? null },
    rows,
    pools: fleet.pools.filter((p: any) => poolKeys.has(p.key)),
  };
}

async function buildModernizationPipeline(prisma: any, accountId: string) {
  const assets = await prisma.asset.findMany({
    where: { accountId, archivedAt: null },
    select: {
      id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true,
      installDate: true, governingCondition: true, endOfSupport: true, obsolescenceStatus: true,
      modernizationRiskScore: true, repairCostEstimate: true, spareLeadTimeWeeks: true,
      redundancyStatus: true, criticalityScore: true,
      site: { select: { name: true } },
    },
    take: MAX_PIPELINE_ASSETS,
  });
  return buildModernizationPipelineFromAssets(
    assets.map((a: any) => ({ ...a, siteName: a.site?.name ?? null })),
  );
}

async function buildAttachRate(prisma: any, accountId: string, opts: any = {}) {
  const now = new Date();
  const days = Math.min(365, Math.max(7, Math.trunc(Number(opts.days) || 90)));
  const since = new Date(now.getTime() - days * DAY_MS);
  const [deficiencies, quoteRequests] = await Promise.all([
    prisma.deficiency.findMany({
      where: {
        accountId,
        OR: [{ createdAt: { gte: since } }, { resolvedAt: { gte: since } }],
        asset: { archivedAt: null },
      },
      select: {
        id: true, assetId: true, severity: true, createdAt: true, resolvedAt: true,
        asset: { select: { repairCostEstimate: true } },
      },
      take: MAX_FUNNEL_ROWS,
    }),
    prisma.quoteRequest.findMany({
      where: {
        accountId,
        OR: [{ createdAt: { gte: since } }, { resolvedAt: { gte: since } }],
      },
      select: { id: true, assetId: true, status: true, createdAt: true, resolvedAt: true },
      take: MAX_FUNNEL_ROWS,
    }),
  ]);
  return buildAttachRateFromData({ deficiencies, quoteRequests }, { days, now });
}

module.exports = {
  // constants (re-exported ingest constants prove reuse in tests)
  MIN_POOL_SIZE, PIPELINE_BANDS, TREND_PCT, BAD_DIRECTION,
  BENCHMARK_CAVEAT, PIPELINE_CAVEAT, ESTIMATE_BASIS, FUNNEL_STAGES,
  // pure core
  percentileRank, classifyTrend, bandForScore,
  buildBenchmarksFromRows, buildModernizationPipelineFromAssets, buildAttachRateFromData,
  // prisma orchestrators
  buildFleetBenchmarks, buildAssetBenchmarks, buildModernizationPipeline, buildAttachRate,
};

export {};

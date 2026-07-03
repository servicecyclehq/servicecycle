'use strict';

/**
 * lib/installedBaseIntel — pure-core unit tests (no server, no DB).
 *
 * Covers: percentile math (n=1, ties, orientation), thin-pool flag, trend
 * classification (and that it reuses the ingest constants from
 * lib/commitTestReport), Watch/Plan/Act banding boundaries, benchmark build
 * from fixture rows, modernization pipeline (stored score, heuristic fallback,
 * OEM end-of-support path, not-scored), and the attach-rate funnel from
 * fixture data (stage definitions embedded, window clamping).
 */

const ibi = require('../lib/installedBaseIntel');
const { BAD_DIRECTION, TREND_PCT } = require('../lib/commitTestReport');

// ── constant reuse (normalization must not fork) ──────────────────────────────

describe('ingest-constant reuse', () => {
  test('TREND_PCT and BAD_DIRECTION are the commitTestReport objects', () => {
    expect(ibi.TREND_PCT).toBe(TREND_PCT);
    expect(ibi.BAD_DIRECTION).toBe(BAD_DIRECTION);
    // Sanity on the two directions the benchmarks lean on hardest.
    expect(BAD_DIRECTION.insulation_resistance).toBe('down');
    expect(BAD_DIRECTION.contact_resistance).toBe('up');
  });

  test('caveats and stage definitions are exported for the UI', () => {
    expect(ibi.BENCHMARK_CAVEAT).toMatch(/fleet context/i);
    expect(ibi.PIPELINE_CAVEAT).toMatch(/qualified engineers/i);
    expect(ibi.ESTIMATE_BASIS).toMatch(/floor, not a quote/i);
    expect(ibi.FUNNEL_STAGES.map((s) => s.key)).toEqual(['identified', 'quoted', 'converted']);
    for (const s of ibi.FUNNEL_STAGES) expect(s.definition.length).toBeGreaterThan(40);
  });
});

// ── percentileRank ────────────────────────────────────────────────────────────

describe('percentileRank', () => {
  test('pool of one is the 50th percentile', () => {
    expect(ibi.percentileRank([42], 42, 'down')).toBe(50);
    expect(ibi.percentileRank([42], 42, 'up')).toBe(50);
    expect(ibi.percentileRank([42], 42, null)).toBe(50);
  });

  test('ties share a symmetric mean rank', () => {
    expect(ibi.percentileRank([5, 5], 5, 'down')).toBe(50);
    // [1, 5, 5, 9] — a 5 has one worse (1), two tied → (1 + 1)/4 = 50
    expect(ibi.percentileRank([1, 5, 5, 9], 5, 'down')).toBe(50);
  });

  test("orientation: 'down' means higher value = higher percentile", () => {
    const pool = [100, 200, 300, 400];
    expect(ibi.percentileRank(pool, 400, 'down')).toBe(88); // (3 + .5)/4
    expect(ibi.percentileRank(pool, 100, 'down')).toBe(13); // (0 + .5)/4
  });

  test("orientation: 'up' means lower value = higher percentile", () => {
    const pool = [10, 20, 30, 40];
    expect(ibi.percentileRank(pool, 10, 'up')).toBe(88);
    expect(ibi.percentileRank(pool, 40, 'up')).toBe(13);
  });

  test('bounded 0–100 on small pools', () => {
    const p = ibi.percentileRank([1, 2], 2, 'down');
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(100);
  });
});

// ── classifyTrend ─────────────────────────────────────────────────────────────

describe('classifyTrend', () => {
  test('down-is-bad metric dropping ≥ TREND_PCT% → degrading', () => {
    expect(ibi.classifyTrend(800, 1000, 'down')).toBe('degrading'); // -20%
    expect(ibi.classifyTrend(1200, 1000, 'down')).toBe('improving');
    expect(ibi.classifyTrend(950, 1000, 'down')).toBe('stable'); // -5%
  });

  test('up-is-bad metric rising ≥ TREND_PCT% → degrading', () => {
    expect(ibi.classifyTrend(120, 100, 'up')).toBe('degrading');
    expect(ibi.classifyTrend(80, 100, 'up')).toBe('improving');
    expect(ibi.classifyTrend(110, 100, 'up')).toBe('stable');
  });

  test('threshold is exactly TREND_PCT (boundary counts)', () => {
    expect(ibi.classifyTrend(100 - TREND_PCT, 100, 'down')).toBe('degrading');
    expect(ibi.classifyTrend(100 + TREND_PCT, 100, 'up')).toBe('degrading');
  });

  test('no prior / zero prior / unknown direction → null', () => {
    expect(ibi.classifyTrend(100, null, 'down')).toBeNull();
    expect(ibi.classifyTrend(100, 0, 'down')).toBeNull();
    expect(ibi.classifyTrend(100, 90, null)).toBeNull();
  });
});

// ── bandForScore ──────────────────────────────────────────────────────────────

describe('bandForScore', () => {
  test('Watch/Plan/Act boundaries (0.50 / 0.70 / 0.85)', () => {
    expect(ibi.bandForScore(0.49)).toBe('healthy');
    expect(ibi.bandForScore(0.5)).toBe('watch');
    expect(ibi.bandForScore(0.69)).toBe('watch');
    expect(ibi.bandForScore(0.7)).toBe('plan');
    expect(ibi.bandForScore(0.84)).toBe('plan');
    expect(ibi.bandForScore(0.85)).toBe('act');
    expect(ibi.bandForScore(1.4)).toBe('act');
    expect(ibi.bandForScore(null)).toBeNull();
  });
});

// ── buildBenchmarksFromRows ───────────────────────────────────────────────────

function irRow(assetId, value, at, phase = 'A', extra = {}) {
  return {
    assetId, assetLabel: `SWGR ${assetId}`, siteName: 'Plant 1',
    equipmentType: 'SWITCHGEAR', measurementType: 'insulation_resistance',
    phase, unit: 'MΩ', value, at, ...extra,
  };
}

describe('buildBenchmarksFromRows', () => {
  const T0 = '2025-06-01T00:00:00Z';
  const T1 = '2026-06-01T00:00:00Z';

  test('pool of 8 like units: no thin flag, worst value = lowest percentile', () => {
    const rows = [];
    for (let i = 1; i <= 8; i++) rows.push(irRow(`a${i}`, i * 100, T1));
    const out = ibi.buildBenchmarksFromRows(rows);
    expect(out.pools).toHaveLength(1);
    expect(out.pools[0].poolSize).toBe(8);
    expect(out.pools[0].thinPool).toBe(false);
    const worst = out.rows.find((r) => r.assetId === 'a1'); // 100 MΩ, down-is-bad
    const best = out.rows.find((r) => r.assetId === 'a8');
    expect(worst.percentile).toBeLessThan(best.percentile);
    expect(worst.thinPool).toBe(false);
    expect(worst.orientation).toBe('higher_is_better');
    // worst-context-first sort
    expect(out.rows[0].assetId).toBe('a1');
  });

  test('pool below 8 comparable units is thin-flagged', () => {
    const rows = [irRow('a1', 100, T1), irRow('a2', 200, T1)];
    const out = ibi.buildBenchmarksFromRows(rows);
    expect(out.pools[0].poolSize).toBe(2);
    expect(out.pools[0].thinPool).toBe(true);
    expect(out.rows.every((r) => r.thinPool)).toBe(true);
    expect(out.summary.thinPools).toBe(1);
  });

  test('representative value is the WORST phase for a directional metric', () => {
    const rows = [
      irRow('a1', 900, T1, 'A'),
      irRow('a1', 300, T1, 'B'), // worst (down-is-bad)
      irRow('a1', 700, T1, 'C'),
      irRow('a2', 500, T1, 'A'),
    ];
    const out = ibi.buildBenchmarksFromRows(rows);
    const a1 = out.rows.find((r) => r.assetId === 'a1');
    expect(a1.latestValue).toBe(300);
    expect(a1.phase).toBe('B');
    expect(a1.phasesInPool).toBe(3);
    // Pool is per-ASSET representatives, not per-measurement.
    expect(out.pools[0].poolSize).toBe(2);
  });

  test('trend comes from the prior reading of the same metric+phase', () => {
    const rows = [
      irRow('a1', 1000, T0, 'A'),
      irRow('a1', 700, T1, 'A'), // -30% on a down-is-bad metric → degrading
      irRow('a2', 500, T0, 'A'),
      irRow('a2', 520, T1, 'A'), // +4% → stable
      irRow('a3', 500, T1, 'A'), // no prior → null
    ];
    const out = ibi.buildBenchmarksFromRows(rows);
    expect(out.rows.find((r) => r.assetId === 'a1').trend).toBe('degrading');
    expect(out.rows.find((r) => r.assetId === 'a2').trend).toBe('stable');
    expect(out.rows.find((r) => r.assetId === 'a3').trend).toBeNull();
    expect(out.summary.degrading).toBe(1);
    // Only latest values enter the pool (priors never inflate poolSize).
    expect(out.pools[0].poolSize).toBe(3);
    const a1 = out.rows.find((r) => r.assetId === 'a1');
    expect(a1.priorValue).toBe(1000);
    expect(a1.deltaPct).toBe(-30);
  });

  test('metric without a known worse-direction gets value_order + no trend claim', () => {
    const rows = [
      { assetId: 'b1', assetLabel: 'CB b1', equipmentType: 'CIRCUIT_BREAKER', measurementType: 'trip_unit_ltd', phase: null, unit: 's', value: 8, at: T1 },
      { assetId: 'b1', assetLabel: 'CB b1', equipmentType: 'CIRCUIT_BREAKER', measurementType: 'trip_unit_ltd', phase: null, unit: 's', value: 4, at: T0 },
    ];
    const out = ibi.buildBenchmarksFromRows(rows);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].orientation).toBe('value_order');
    expect(out.rows[0].trend).toBeNull();
    expect(out.rows[0].percentile).toBe(50); // n=1 pool
    expect(out.rows[0].thinPool).toBe(true);
  });

  test('units are pooled as recorded — MΩ and GΩ never mix', () => {
    const rows = [
      irRow('a1', 100, T1),
      irRow('a2', 0.2, T1, 'A', { unit: 'GΩ' }),
    ];
    const out = ibi.buildBenchmarksFromRows(rows);
    expect(out.pools).toHaveLength(2);
    expect(out.pools.every((p) => p.poolSize === 1)).toBe(true);
  });

  test('empty input → empty shapes, zero summary', () => {
    const out = ibi.buildBenchmarksFromRows([]);
    expect(out.rows).toEqual([]);
    expect(out.pools).toEqual([]);
    expect(out.summary.assets).toBe(0);
  });
});

// ── buildModernizationPipelineFromAssets ─────────────────────────────────────

describe('buildModernizationPipelineFromAssets', () => {
  const NOW = new Date('2026-07-03T00:00:00Z');
  const base = { manufacturer: 'GE', model: 'X', serialNumber: 'S', siteName: 'Plant 1' };

  test('stored score is authoritative and banded', () => {
    const out = ibi.buildModernizationPipelineFromAssets([
      { ...base, id: 'a1', equipmentType: 'SWITCHGEAR', modernizationRiskScore: 0.9, governingCondition: 'C2' },
    ], NOW);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].score).toBe(0.9);
    expect(out.rows[0].band).toBe('act');
    expect(out.rows[0].scoreSource).toBe('stored');
    expect(out.caveat).toBe(ibi.PIPELINE_CAVEAT);
    expect(out.bands).toEqual({ watch: 0.5, plan: 0.7, act: 0.85 });
  });

  test('null stored score falls back to the real scoring engine (age/condition path)', () => {
    // 30-year-old C3 switchgear: base 30y × 0.5 → adjusted 15y → score ≈ 2.0
    const out = ibi.buildModernizationPipelineFromAssets([
      { ...base, id: 'a2', equipmentType: 'SWITCHGEAR', modernizationRiskScore: null,
        installDate: '1996-07-03T00:00:00Z', governingCondition: 'C3' },
    ], NOW);
    const r = out.rows[0];
    expect(r.scoreSource).toBe('computed_fallback');
    expect(r.band).toBe('act');
    expect(r.score).toBeGreaterThan(1.8);
    expect(r.drivers.path).toBe('age_condition_heuristic');
    expect(r.drivers.ageYears).toBeCloseTo(30, 0);
    expect(r.drivers.governingCondition).toBe('C3');
    // implied expected life = age/score = the engine's condition-adjusted base life
    expect(r.drivers.impliedExpectedLifeYears).toBeCloseTo(15, 0);
  });

  test('OEM end-of-support overrides the heuristic (5-year normalization)', () => {
    // The engine measures remaining support from the REAL clock (Date.now()),
    // so anchor the fixture there: 1 year out → 1 - 1/5 = 0.8.
    const eos = new Date(Date.now() + 365 * 86400000);
    const out = ibi.buildModernizationPipelineFromAssets([
      { ...base, id: 'a3', equipmentType: 'CIRCUIT_BREAKER', modernizationRiskScore: null,
        installDate: '2024-01-01T00:00:00Z', governingCondition: 'C1', endOfSupport: eos.toISOString() },
    ], NOW);
    const r = out.rows[0];
    expect(r.drivers.path).toBe('oem_end_of_support');
    expect(r.score).toBeCloseTo(0.8, 1);
    expect(r.band).toBe('plan');
    expect(r.drivers.impliedExpectedLifeYears).toBeNull();
  });

  test('no score, no installDate, no EOS → notScored; healthy rows excluded from list', () => {
    const out = ibi.buildModernizationPipelineFromAssets([
      { ...base, id: 'a4', equipmentType: 'MCC', modernizationRiskScore: null },
      { ...base, id: 'a5', equipmentType: 'MCC', modernizationRiskScore: 0.2 },
      { ...base, id: 'a6', equipmentType: 'MCC', modernizationRiskScore: 0.75, repairCostEstimate: '120000', spareLeadTimeWeeks: 20 },
    ], NOW);
    expect(out.summary.notScored).toBe(1);
    expect(out.summary.healthy).toBe(1);
    expect(out.summary.plan).toBe(1);
    expect(out.rows.map((r) => r.assetId)).toEqual(['a6']); // healthy a5 not listed
    expect(out.summary.pipelineCostKnown).toBe(120000);
    expect(out.summary.pipelineCostAssets).toBe(1);
    expect(out.summary.longLeadInPipeline).toBe(1);
  });

  test('rows rank by score descending', () => {
    const out = ibi.buildModernizationPipelineFromAssets([
      { ...base, id: 'lo', equipmentType: 'MCC', modernizationRiskScore: 0.55 },
      { ...base, id: 'hi', equipmentType: 'MCC', modernizationRiskScore: 1.1 },
      { ...base, id: 'mid', equipmentType: 'MCC', modernizationRiskScore: 0.8 },
    ], NOW);
    expect(out.rows.map((r) => r.assetId)).toEqual(['hi', 'mid', 'lo']);
  });
});

// ── buildAttachRateFromData ───────────────────────────────────────────────────

describe('buildAttachRateFromData', () => {
  const NOW = new Date('2026-07-03T00:00:00Z');
  const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

  const fixture = {
    deficiencies: [
      // identified in window (assets X and Y)
      { id: 'd1', assetId: 'X', severity: 'IMMEDIATE', createdAt: day(10), resolvedAt: null, asset: { repairCostEstimate: '50000' } },
      { id: 'd2', assetId: 'X', severity: 'ADVISORY', createdAt: day(40), resolvedAt: day(5), asset: { repairCostEstimate: '50000' } },
      { id: 'd3', assetId: 'Y', severity: 'RECOMMENDED', createdAt: day(80), resolvedAt: null, asset: { repairCostEstimate: null } },
      // identified BEFORE the window but resolved inside it
      { id: 'd4', assetId: 'Z', severity: 'RECOMMENDED', createdAt: day(200), resolvedAt: day(3), asset: { repairCostEstimate: '9000' } },
    ],
    quoteRequests: [
      { id: 'q1', assetId: 'X', status: 'quoted', createdAt: day(8), resolvedAt: null },       // quoted, on identified
      { id: 'q2', assetId: 'Y', status: 'draft', createdAt: day(8), resolvedAt: null },        // draft → excluded
      { id: 'q3', assetId: 'W', status: 'accepted', createdAt: day(120), resolvedAt: day(6) }, // accepted in window
      { id: 'q4', assetId: 'V', status: 'requested', createdAt: day(2), resolvedAt: null },    // quoted, NOT on identified
    ],
  };

  test('stage counts, estimate floor, and rates from fixture data', () => {
    const out = ibi.buildAttachRateFromData(fixture, { days: 90, now: NOW });
    expect(out.days).toBe(90);

    // identified: d1–d3 created in window; X counted once for $.
    expect(out.stages.identified.findings).toBe(3);
    expect(out.stages.identified.assets).toBe(2);
    expect(out.stages.identified.bySeverity).toEqual({ IMMEDIATE: 1, RECOMMENDED: 1, ADVISORY: 1 });
    expect(out.stages.identified.estimatedUsd).toBe(50000);
    expect(out.stages.identified.assetsWithEstimate).toBe(1);
    expect(out.stages.identified.assetsWithoutEstimate).toBe(1);

    // quoted: q1 + q4 (q2 draft excluded, q3 created outside window).
    expect(out.stages.quoted.quoteRequests).toBe(2);
    expect(out.stages.quoted.onIdentifiedAssets).toBe(1);
    expect(out.stages.quoted.identifiedAssetsQuoted).toBe(1);

    // converted: q3 accepted in window; d2 + d4 resolved in window.
    expect(out.stages.converted.quotesAccepted).toBe(1);
    expect(out.stages.converted.findingsResolved).toBe(2);

    // rates: 1 of 2 identified assets quoted; 1 of 2 quotes accepted.
    expect(out.rates.attachRatePct).toBe(50);
    expect(out.rates.acceptRatePct).toBe(50);

    // definitions + estimate basis ride along for the UI tooltips.
    expect(out.definitions).toBe(ibi.FUNNEL_STAGES);
    expect(out.estimateBasis).toBe(ibi.ESTIMATE_BASIS);
  });

  test('empty period → zero stages, null rates (no divide-by-zero)', () => {
    const out = ibi.buildAttachRateFromData({ deficiencies: [], quoteRequests: [] }, { days: 90, now: NOW });
    expect(out.stages.identified.findings).toBe(0);
    expect(out.stages.identified.estimatedUsd).toBe(0);
    expect(out.rates.attachRatePct).toBeNull();
    expect(out.rates.acceptRatePct).toBeNull();
  });

  test('window clamps to 7–365 days', () => {
    expect(ibi.buildAttachRateFromData({}, { days: 1, now: NOW }).days).toBe(7);
    expect(ibi.buildAttachRateFromData({}, { days: 4000, now: NOW }).days).toBe(365);
    expect(ibi.buildAttachRateFromData({}, { now: NOW }).days).toBe(90);
  });
});

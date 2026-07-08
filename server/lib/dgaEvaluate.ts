/**
 * dgaEvaluate.ts — #28 transformer-oil DGA interpretation.
 *
 * Implements the classic IEEE C57.104 dissolved-gas Condition method (the
 * widely-used four-condition individual-gas + TDCG table) to turn a set of gas
 * concentrations (ppm) into an overall condition, an ieeeStatus (1..4), a
 * traffic-light ResultRating, and a coarse key-gas fault hint. The asset's
 * overall condition is the WORST individual gas (incl. TDCG).
 *
 * NOTE: the 2019 edition refines this with O2/N2-ratio + age percentile tables;
 * the four-condition table here is the stable, vendor-agnostic baseline and is
 * flagged for NETA/engineer review before any production reliance (same posture
 * as the seeded interval matrix). Acetylene is additionally treated as significant
 * on its own: any Duval D1/D2 arcing signature raises the traffic light to at least
 * YELLOW even when the absolute condition is 1 (acetylene is the key arcing gas).
 *
 * Combustible gases counted in TDCG: H2, CH4, C2H2, C2H4, C2H6, CO. (CO2 is
 * tracked but excluded from TDCG per the standard.)
 */

export type GasKey = 'h2' | 'ch4' | 'c2h2' | 'c2h4' | 'c2h6' | 'co' | 'co2' | 'o2' | 'n2';
export type Gases = Partial<Record<GasKey, number>>;

// Upper bound (inclusive) of each Condition band, in ppm. Condition 4 = above C3.
// Source: IEEE C57.104-2008 Table 1 individual-gas / TDCG four-condition table.
// Acetylene (C2H2) is 1/9/35 ppm per Table 1 — REVERTED 2026-07-08 (acquisition-
// audit finding, dgaEvaluate.ts:34) from an incorrect 35/50/80 that a 2026-06-28
// revision introduced on a false premise: that each gas's Condition-1 limit must
// sum to the Condition-1 TDCG of 720 (100+120+35+50+65+350=720). IEEE C57.104
// Table 1 does not define individual-gas limits that way — the TDCG row is an
// independently-screened value, not a sum of the per-gas C1 limits, and the
// standard's own published acetylene limits are 1/9/35. Acetylene is the key gas
// for arcing faults (see keyGasFault below), so the inflated 35/50/80 set silently
// under-called a genuine high-energy arcing signature by ~2 condition levels.
const LIMITS: Record<string, [number, number, number]> = {
  // gas: [C1 max, C2 max, C3 max]
  h2:   [100, 700, 1800],
  ch4:  [120, 400, 1000],
  c2h2: [1, 9, 35],
  c2h4: [50, 100, 200],
  c2h6: [65, 100, 150],
  co:   [350, 570, 1400],
  co2:  [2500, 4000, 10000],
  tdcg: [720, 1920, 4630],
};

const TDCG_GASES: GasKey[] = ['h2', 'ch4', 'c2h2', 'c2h4', 'c2h6', 'co'];

/** Condition (1..4) for one value against its [C1,C2,C3] band. */
function conditionFor(value: number, band: [number, number, number]): number {
  if (value <= band[0]) return 1;
  if (value <= band[1]) return 2;
  if (value <= band[2]) return 3;
  return 4;
}

export interface DgaEvaluation {
  tdcg: number;
  // [Resolved 2026-07-05, Dustin's call: "reports, if certified/stamped, need
  // to take precedence... we're a data org, not an engineering firm."] tdcg
  // above is now the AUTHORITATIVE value used for the condition screen below:
  // the report's own stated TDCG when the caller supplies one and it parses
  // as a valid non-negative number, else the recomputed sum (unchanged prior
  // behavior). computedTdcg is always the recomputed sum regardless of source,
  // so a real disagreement between what the lab stated and what we'd compute
  // from the individual gases is never silently thrown away -- see
  // tdcgDiscrepancyPct.
  tdcgSource: 'reported' | 'computed';
  computedTdcg: number;
  // % difference between a reported TDCG and the recomputed sum, vs the
  // recomputed sum's magnitude. null when there's no reported value to
  // compare, or the recomputed sum is 0 (division undefined).
  tdcgDiscrepancyPct: number | null;
  overallCondition: number;            // 1..4 (worst gas incl. TDCG)
  ieeeStatus: number;                  // mirror of overallCondition (1..4)
  resultRating: 'GREEN' | 'YELLOW' | 'RED';
  perGas: Record<string, { value: number; condition: number }>;
  faultCode: string | null;           // coarse key-gas hint (PD/T1/T2/T3/D1/D2)
  faultLabel: string | null;
  // [W8] A gas missing from the input (lab didn't test it, or ingest failed to
  // capture it) is treated as 0 ppm by the TDCG sum below with nothing
  // distinguishing "confirmed zero" from "never measured" -- a genuinely
  // partial panel can understate TDCG and look like a clean Condition-1 oil
  // when one of the 6 combustible gases was simply never reported. Callers
  // (routes/dgaIngest.ts) surface this so TDCG is never presented as if it
  // came from a complete panel when it didn't.
  missingGases: GasKey[];
}

/** Coarse key-gas fault hint. Deliberately conservative; a full Duval triangle
 *  is future work. Acetylene present => arcing; otherwise thermal by ethylene.
 *
 *  [NETA-8-3] Thermal faults are distinguished by the gas that DOMINATES, per the
 *  IEEE key-gas method:
 *    - T3 (>700C): ethylene (C2H4) is the principal gas.
 *    - T2 (300-700C): ethylene present but not dominant (mid C2H4), with CH4.
 *    - T1 (<300C): methane (CH4) principal, some H2, ethylene LOW (C2H4 < 50).
 *  The previous ordering tested `ch4 >= 120` for T2 BEFORE the T1 branch, so a
 *  low-temperature CH4-dominant fault (the T1 signature) was always captured by
 *  T2 and T1 was unreachable. T1 is now checked on the low-ethylene path so it
 *  can fire. */
function keyGasFault(g: Gases): { code: string; label: string } | null {
  const c2h2 = g.c2h2 ?? 0, c2h4 = g.c2h4 ?? 0, ch4 = g.ch4 ?? 0, h2 = g.h2 ?? 0;
  if (c2h2 >= 2) {
    // Arcing: high-energy (D2) when ethylene also elevated, else low-energy (D1).
    return c2h4 >= 100 ? { code: 'D2', label: 'High-energy arcing' } : { code: 'D1', label: 'Low-energy discharge' };
  }
  if (c2h4 >= 100) return { code: 'T3', label: 'Thermal fault >700C' };
  // Mid ethylene => 300-700C overheating (T2). Below the ethylene threshold a
  // CH4-dominant signature is a sub-300C thermal fault (T1).
  if (c2h4 >= 50) return { code: 'T2', label: 'Thermal fault 300-700C' };
  if (ch4 >= 120) {
    // Low ethylene + elevated methane = low-temperature thermal fault (<300C).
    return { code: 'T1', label: 'Thermal fault <300C' };
  }
  if (h2 >= 100) return { code: 'PD', label: 'Partial discharge' };
  return null;
}

export function evaluateDga(g: Gases, reportedTdcg?: number | null): DgaEvaluation {
  const missingGases = TDCG_GASES.filter((k) => g[k] == null);
  const computedTdcg = TDCG_GASES.reduce((s, k) => s + (g[k] ?? 0), 0);
  const hasReported = reportedTdcg != null && Number.isFinite(reportedTdcg) && (reportedTdcg as number) >= 0;
  const tdcg = hasReported ? (reportedTdcg as number) : computedTdcg;
  const tdcgSource: 'reported' | 'computed' = hasReported ? 'reported' : 'computed';
  const tdcgDiscrepancyPct = hasReported && computedTdcg > 0
    ? Math.round((Math.abs((reportedTdcg as number) - computedTdcg) / computedTdcg) * 1000) / 10
    : null;
  const perGas: Record<string, { value: number; condition: number }> = {};
  let worst = 1;

  for (const k of Object.keys(LIMITS)) {
    if (k === 'tdcg') continue;
    const v = g[k as GasKey];
    if (v == null) continue;
    const cond = conditionFor(v, LIMITS[k]);
    perGas[k] = { value: v, condition: cond };
    // [NETA-8-10] CO2 is INFORMATIONAL per IEEE C57.104 (a cellulose-aging
    // indicator, not a fault gas) and is excluded from TDCG; it must likewise not
    // drive the transformer's overall condition. Report its band in perGas, but
    // do not let it raise `worst`.
    if (k === 'co2') continue;
    if (cond > worst) worst = cond;
  }
  const tdcgCond = conditionFor(tdcg, LIMITS.tdcg);
  perGas.tdcg = { value: tdcg, condition: tdcgCond };
  if (tdcgCond > worst) worst = tdcgCond;

  const fault = keyGasFault(g);

  // Absolute four-condition traffic light from the worst individual gas / TDCG.
  let resultRating: 'GREEN' | 'YELLOW' | 'RED' = worst <= 1 ? 'GREEN' : worst === 2 ? 'YELLOW' : 'RED';
  // Acetylene-significance override: detectable acetylene (Duval D1/D2 arcing) is the
  // single most safety-significant fault gas. Even when every gas is within Condition 1
  // ABSOLUTE limits, newly-present acetylene warrants at least a YELLOW caution + resample.
  // This nudges ONLY the traffic light — overallCondition/ieeeStatus stay true to the
  // absolute four-condition screen, so it neither fabricates a Condition 2 nor auto-
  // escalates the ingest deficiency (which is gated on overallCondition, not resultRating).
  if (resultRating === 'GREEN' && (fault?.code === 'D1' || fault?.code === 'D2')) {
    resultRating = 'YELLOW';
  }

  return {
    tdcg,
    tdcgSource,
    computedTdcg,
    tdcgDiscrepancyPct,
    overallCondition: worst,
    ieeeStatus: worst,
    resultRating,
    perGas,
    faultCode: fault?.code ?? null,
    faultLabel: fault?.label ?? null,
    missingGases,
  };
}

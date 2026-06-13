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
 * as the seeded interval matrix).
 *
 * Combustible gases counted in TDCG: H2, CH4, C2H2, C2H4, C2H6, CO. (CO2 is
 * tracked but excluded from TDCG per the standard.)
 */

export type GasKey = 'h2' | 'ch4' | 'c2h2' | 'c2h4' | 'c2h6' | 'co' | 'co2' | 'o2' | 'n2';
export type Gases = Partial<Record<GasKey, number>>;

// Upper bound (inclusive) of each Condition band, in ppm. Condition 4 = above C3.
// Source: IEEE C57.104 individual-gas / TDCG condition table.
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
  overallCondition: number;            // 1..4 (worst gas incl. TDCG)
  ieeeStatus: number;                  // mirror of overallCondition (1..4)
  resultRating: 'GREEN' | 'YELLOW' | 'RED';
  perGas: Record<string, { value: number; condition: number }>;
  faultCode: string | null;           // coarse key-gas hint (PD/T1/T2/T3/D1/D2)
  faultLabel: string | null;
}

/** Coarse key-gas fault hint. Deliberately conservative; a full Duval triangle
 *  is future work. Acetylene present => arcing; otherwise thermal by ethylene. */
function keyGasFault(g: Gases): { code: string; label: string } | null {
  const c2h2 = g.c2h2 ?? 0, c2h4 = g.c2h4 ?? 0, ch4 = g.ch4 ?? 0, h2 = g.h2 ?? 0;
  if (c2h2 >= 2) {
    // Arcing: high-energy (D2) when ethylene also elevated, else low-energy (D1).
    return c2h4 >= 100 ? { code: 'D2', label: 'High-energy arcing' } : { code: 'D1', label: 'Low-energy discharge' };
  }
  if (c2h4 >= 100) return { code: 'T3', label: 'Thermal fault >700C' };
  if (c2h4 >= 50 || ch4 >= 120) return { code: 'T2', label: 'Thermal fault 300-700C' };
  if (h2 >= 100 && ch4 >= 120) return { code: 'T1', label: 'Thermal fault <300C' };
  if (h2 >= 100) return { code: 'PD', label: 'Partial discharge' };
  return null;
}

export function evaluateDga(g: Gases): DgaEvaluation {
  const tdcg = TDCG_GASES.reduce((s, k) => s + (g[k] ?? 0), 0);
  const perGas: Record<string, { value: number; condition: number }> = {};
  let worst = 1;

  for (const k of Object.keys(LIMITS)) {
    if (k === 'tdcg') continue;
    const v = g[k as GasKey];
    if (v == null) continue;
    const cond = conditionFor(v, LIMITS[k]);
    perGas[k] = { value: v, condition: cond };
    if (cond > worst) worst = cond;
  }
  const tdcgCond = conditionFor(tdcg, LIMITS.tdcg);
  perGas.tdcg = { value: tdcg, condition: tdcgCond };
  if (tdcgCond > worst) worst = tdcgCond;

  const fault = keyGasFault(g);
  return {
    tdcg,
    overallCondition: worst,
    ieeeStatus: worst,
    resultRating: worst <= 1 ? 'GREEN' : worst === 2 ? 'YELLOW' : 'RED',
    perGas,
    faultCode: fault?.code ?? null,
    faultLabel: fault?.label ?? null,
  };
}

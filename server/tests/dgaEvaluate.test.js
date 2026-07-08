// Regression-lock for the 2026-07-05 TDCG capture-and-prefer fix.
// Dustin's call: "reports, if certified/stamped, need to take precedence...
// we're a data org, not an engineering firm." A report's own stated TDCG
// should be used over our recomputed sum when present and valid, but a real
// disagreement must still surface, never be silently dropped either way.
const { evaluateDga } = require('../lib/dgaEvaluate');

describe('evaluateDga — TDCG source + discrepancy', () => {
  test('no reportedTdcg → falls back to computed sum, unchanged prior behavior', () => {
    const g = { h2: 50, ch4: 40, c2h2: 0, c2h4: 10, c2h6: 5, co: 100 };
    const e = evaluateDga(g);
    expect(e.tdcgSource).toBe('computed');
    expect(e.tdcg).toBe(205);
    expect(e.computedTdcg).toBe(205);
    expect(e.tdcgDiscrepancyPct).toBeNull();
  });

  test('reportedTdcg present and close to computed → used as tdcg, no discrepancy flagged', () => {
    const g = { h2: 50, ch4: 40, c2h2: 0, c2h4: 10, c2h6: 5, co: 100 }; // sum = 205
    const e = evaluateDga(g, 210);
    expect(e.tdcgSource).toBe('reported');
    expect(e.tdcg).toBe(210);
    expect(e.computedTdcg).toBe(205);
    expect(e.tdcgDiscrepancyPct).toBeLessThan(10);
  });

  test('reportedTdcg present and far from computed → still used, but discrepancy flagged', () => {
    const g = { h2: 50, ch4: 40, c2h2: 0, c2h4: 10, c2h6: 5, co: 100 }; // sum = 205
    const e = evaluateDga(g, 500); // lab tested a wider gas list than we captured
    expect(e.tdcgSource).toBe('reported');
    expect(e.tdcg).toBe(500);
    expect(e.computedTdcg).toBe(205);
    expect(e.tdcgDiscrepancyPct).toBeGreaterThanOrEqual(10);
  });

  test('invalid reportedTdcg (negative/NaN) → silently falls back to computed, does not crash', () => {
    const g = { h2: 50, ch4: 40, c2h2: 0, c2h4: 10, c2h6: 5, co: 100 };
    const eNeg = evaluateDga(g, -5);
    expect(eNeg.tdcgSource).toBe('computed');
    expect(eNeg.tdcg).toBe(205);
    const eNaN = evaluateDga(g, NaN);
    expect(eNaN.tdcgSource).toBe('computed');
    expect(eNaN.tdcg).toBe(205);
  });

  test('missingGases still reported alongside a report-stated TDCG (partial panel + stated total can coexist)', () => {
    const g = { h2: 50, ch4: 40 }; // several gases never reported
    const e = evaluateDga(g, 300);
    expect(e.missingGases.length).toBeGreaterThan(0);
    expect(e.tdcgSource).toBe('reported');
    expect(e.tdcg).toBe(300);
  });
});

// Regression-lock for the 2026-07-08 acquisition-audit P0 fix: acetylene (C2H2)
// Condition thresholds were incorrectly changed to [35,50,80] ppm on the false
// premise that individual-gas limits must sum to the Condition-1 TDCG value.
// IEEE C57.104-2008 Table 1's actual acetylene limits are [1,9,35] ppm. Getting
// this wrong under-calls a genuine high-energy arcing signature by ~2 condition
// levels, so this suite pins the exact IEEE band edges, not just "some value".
describe('evaluateDga — acetylene (C2H2) IEEE C57.104 Condition thresholds [1,9,35]', () => {
  test('1 ppm C2H2 (at the Condition-1 ceiling) scores Condition 1', () => {
    const e = evaluateDga({ h2: 0, ch4: 0, c2h2: 1, c2h4: 0, c2h6: 0, co: 0 });
    expect(e.perGas.c2h2.condition).toBe(1);
    expect(e.overallCondition).toBe(1);
  });

  test('2 ppm C2H2 (just above the Condition-1 ceiling) scores Condition 2', () => {
    const e = evaluateDga({ h2: 0, ch4: 0, c2h2: 2, c2h4: 0, c2h6: 0, co: 0 });
    expect(e.perGas.c2h2.condition).toBe(2);
    expect(e.overallCondition).toBe(2);
  });

  test('9 ppm C2H2 (at the Condition-2 ceiling) scores Condition 2', () => {
    const e = evaluateDga({ h2: 0, ch4: 0, c2h2: 9, c2h4: 0, c2h6: 0, co: 0 });
    expect(e.perGas.c2h2.condition).toBe(2);
  });

  test('10 ppm C2H2 (just above the Condition-2 ceiling) scores Condition 3', () => {
    const e = evaluateDga({ h2: 0, ch4: 0, c2h2: 10, c2h4: 0, c2h6: 0, co: 0 });
    expect(e.perGas.c2h2.condition).toBe(3);
    expect(e.overallCondition).toBe(3);
  });

  test('35 ppm C2H2 (at the Condition-3 ceiling) scores Condition 3 — NOT Condition 1', () => {
    // This is the exact acquisition-audit example: 30-35 ppm C2H2 is a real
    // high-energy arcing concern (Condition 3) and must never be scored
    // Condition 1 the way the wrong [35,50,80] band did.
    const e = evaluateDga({ h2: 0, ch4: 0, c2h2: 35, c2h4: 0, c2h6: 0, co: 0 });
    expect(e.perGas.c2h2.condition).toBe(3);
    expect(e.overallCondition).toBe(3);
  });

  test('36 ppm C2H2 (just above the Condition-3 ceiling) scores Condition 4', () => {
    const e = evaluateDga({ h2: 0, ch4: 0, c2h2: 36, c2h4: 0, c2h6: 0, co: 0 });
    expect(e.perGas.c2h2.condition).toBe(4);
    expect(e.overallCondition).toBe(4);
  });

  test('30 ppm C2H2 (the audit\'s worked example) scores Condition 3, not the old wrong Condition 1', () => {
    const e = evaluateDga({ h2: 0, ch4: 0, c2h2: 30, c2h4: 0, c2h6: 0, co: 0 });
    expect(e.perGas.c2h2.condition).toBe(3);
    expect(e.overallCondition).toBe(3);
    expect(e.resultRating).toBe('RED'); // Condition 3 => worst >= 3 => RED
  });
});

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

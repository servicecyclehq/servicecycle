// Regression-lock for the 2026-07-05 TDCG capture fix in dgaParse.ts.
const { parseDgaText } = require('../lib/dgaParse');

describe('parseDgaText — TDCG capture', () => {
  test('captures a report-stated "TDCG" figure', () => {
    const text = 'Hydrogen 50 ppm\nMethane 40 ppm\nTDCG 205 ppm';
    const { reportedTdcg } = parseDgaText(text);
    expect(reportedTdcg).toBe(205);
  });

  test('captures "Total Dissolved Combustible Gas" spelled out', () => {
    const text = 'Total Dissolved Combustible Gas: 312 ppm';
    const { reportedTdcg } = parseDgaText(text);
    expect(reportedTdcg).toBe(312);
  });

  test('no TDCG mentioned → null, does not crash', () => {
    const text = 'Hydrogen 50 ppm\nMethane 40 ppm';
    const { reportedTdcg } = parseDgaText(text);
    expect(reportedTdcg).toBeNull();
  });

  test('gas parsing unaffected by the new TDCG capture', () => {
    const text = 'Hydrogen 50 ppm\nMethane 40 ppm\nTDCG 205 ppm';
    const { gases } = parseDgaText(text);
    expect(gases.h2).toBe(50);
    expect(gases.ch4).toBe(40);
  });
});

'use strict';

// P0 ingest-safety fixes + domain validators (2026-07-03).
// Pure logic: the confidence gate, the domain consistency validators, and the
// AI reading-confidence stamp. Heavy deps (prisma, ai) are mocked so this stays
// a fast pure-lib suite with no DB / no env / no network.

jest.mock('../lib/prisma', () => ({ default: {} }));
jest.mock('../lib/ai', () => ({ complete: jest.fn(), completeWithImage: jest.fn(), parseJSON: jest.fn() }));

const { evaluateIngestGate } = require('../lib/ingestConfidenceGate');
const { checkDomainConsistency } = require('../lib/domainValidators');
const { _mapMeasurements, AI_READING_CONFIDENCE } = require('../lib/aiTestReportExtract');

// Minimal preview with a single high-confidence asset MATCH so the gate's
// create-path (inferEquipmentTypeResult) is never exercised.
function preview(measurements, extra = {}) {
  return {
    meta: { model: 'ModelX', manufacturer: 'MakerY' },
    assetMatch: { id: 'asset-1', label: 'Unit 1', confidence: 'high' },
    assetCandidates: [],
    measurements,
    source: 'pdfplumber',
    pageCount: 1,
    ...extra,
  };
}

describe('confidence gate — P0 fixes', () => {
  test('clean deterministic readings auto-commit green', () => {
    const g = evaluateIngestGate(preview([
      { measurementType: 'insulation_resistance', asFoundValue: 1000, confidence: 0.95, passFail: 'GREEN' },
    ]));
    expect(g.band).toBe('green');
    expect(g.autoCommit).toBe(true);
  });

  test('AI-sourced CRITICAL reading forces review regardless of threshold', () => {
    const g = evaluateIngestGate(preview([
      { measurementType: 'contact_resistance', phase: 'A', asFoundValue: 250, confidence: AI_READING_CONFIDENCE, source: 'ai', critical: true, passFail: 'GREEN' },
    ]), { threshold: 0.1 }); // even a very loose floor must not let it through
    expect(g.autoCommit).toBe(false);
    expect(g.band).toBe('red');
    expect(g.reasons.join(' ')).toMatch(/AI-recovered critical/i);
  });

  test('non-numeric confidence fails loud (does not silently sail green)', () => {
    const g = evaluateIngestGate(preview([
      { measurementType: 'insulation_resistance', asFoundValue: 1000, confidence: 'ai', passFail: 'GREEN' },
    ]));
    expect(g.autoCommit).toBe(false);
    expect(g.band).not.toBe('green');
    expect(g.reasons.join(' ')).toMatch(/unscoreable confidence/i);
  });

  test('numeric AI reading below the floor routes to review', () => {
    const g = evaluateIngestGate(preview([
      { measurementType: 'insulation_resistance', asFoundValue: 1000, confidence: AI_READING_CONFIDENCE, source: 'ai', passFail: 'GREEN' },
    ]));
    expect(g.autoCommit).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/below the confidence floor/i);
  });

  test('silent-empty guard: zero readings is a review item, not a clean no-op', () => {
    const g = evaluateIngestGate(preview([], { pageCount: 4 }));
    expect(g.autoCommit).toBe(false);
    expect(g.band).toBe('red');
    expect(g.reasons.join(' ')).toMatch(/No readings could be extracted/i);
  });

  test('low-coverage scan (few readings across many pages) is flagged', () => {
    const g = evaluateIngestGate(preview([
      { measurementType: 'insulation_resistance', asFoundValue: 1000, confidence: 0.95, passFail: 'GREEN' },
      { measurementType: 'insulation_resistance', asFoundValue: 1100, confidence: 0.95, passFail: 'GREEN' },
    ], { source: 'pdfjs', pageCount: 12 }));
    expect(g.autoCommit).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/scan\/mixed PDF/i);
  });

  test('cross-pass disagreement is surfaced', () => {
    const g = evaluateIngestGate(preview([
      { measurementType: 'contact_resistance', phase: 'A', asFoundValue: 250, confidence: 0.95, passFail: 'GREEN', crossPassDisagreement: true },
    ]));
    expect(g.autoCommit).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/disagreed on the value/i);
  });
});

describe('domain validators — internal consistency', () => {
  test('pole imbalance catches the dropped-decimal outlier', () => {
    const f = checkDomainConsistency([
      { measurementType: 'contact_resistance', phase: 'A', asFoundValue: 4.1 },
      { measurementType: 'contact_resistance', phase: 'B', asFoundValue: 4.3 },
      { measurementType: 'contact_resistance', phase: 'C', asFoundValue: 42 },
    ]);
    expect(f.map((x) => x.code)).toContain('contact_resistance_pole_imbalance');
  });

  test('balanced poles produce no finding', () => {
    const f = checkDomainConsistency([
      { measurementType: 'contact_resistance', phase: 'A', asFoundValue: 250 },
      { measurementType: 'contact_resistance', phase: 'B', asFoundValue: 255 },
      { measurementType: 'contact_resistance', phase: 'C', asFoundValue: 248 },
    ]);
    expect(f).toEqual([]);
  });

  test('acetylene high value flags for review (arcing-or-misread)', () => {
    const f = checkDomainConsistency([
      { measurementType: 'dissolved_gas', label: 'C2H2 Acetylene', asFoundValue: 210 },
    ]);
    expect(f.map((x) => x.code)).toContain('c2h2_implausible');
  });

  test('TDCG mismatch vs component-gas sum flags', () => {
    const f = checkDomainConsistency([
      { measurementType: 'dissolved_gas', label: 'H2 Hydrogen', asFoundValue: 100 },
      { measurementType: 'dissolved_gas', label: 'CH4 Methane', asFoundValue: 50 },
      { measurementType: 'dissolved_gas', label: 'C2H4 Ethylene', asFoundValue: 30 },
      { measurementType: 'dissolved_gas', label: 'C2H6 Ethane', asFoundValue: 20 },
      { measurementType: 'dissolved_gas', label: 'TDCG Total Dissolved Combustible Gas', asFoundValue: 999 },
    ]);
    expect(f.map((x) => x.code)).toContain('tdcg_mismatch');
  });

  test('report-verdict cross-check flags PASS-vs-computed-FAIL disagreement', () => {
    const f = checkDomainConsistency(
      [{ measurementType: 'insulation_resistance', asFoundValue: 1, passFail: 'RED' }],
      { reportVerdict: 'pass' },
    );
    expect(f.map((x) => x.code)).toContain('verdict_mismatch');
  });

  test('PI recompute flags a printed PI that disagrees with IR ratio', () => {
    const f = checkDomainConsistency([
      { measurementType: 'insulation_resistance', label: 'IR 1 min', asFoundValue: 100 },
      { measurementType: 'insulation_resistance', label: 'IR 10 min', asFoundValue: 200 },
      { measurementType: 'polarization_index', label: 'PI', asFoundValue: 5.0 }, // real ratio = 2.0
    ]);
    expect(f.map((x) => x.code)).toContain('pi_mismatch');
  });

  test('completeness flags a transformer report missing insulation resistance', () => {
    const f = checkDomainConsistency(
      [{ measurementType: 'turns_ratio_measured', asFoundValue: 1.0 }],
      { meta: { equipmentType: 'transformer' } },
    );
    expect(f.map((x) => x.code)).toContain('incomplete_report');
  });
});

describe('AI reading confidence stamp', () => {
  test('_mapMeasurements stamps a numeric confidence, not the string "ai"', () => {
    const rows = _mapMeasurements([
      { measurementType: 'insulation_resistance', label: 'IR', asFoundValue: 1000, asFoundUnit: 'MOhm' },
    ]);
    expect(rows).toHaveLength(1);
    expect(typeof rows[0].confidence).toBe('number');
    expect(rows[0].confidence).toBe(AI_READING_CONFIDENCE);
    expect(rows[0].source).toBe('ai');
  });
});

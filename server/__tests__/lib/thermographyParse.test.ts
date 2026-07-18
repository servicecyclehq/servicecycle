/**
 * lib/thermographyParse — #29 NFPA 70B §7.4 survey-header + hot-spot extraction.
 *
 * Pure parser (no DB): asserts the best-effort header extraction against the
 * FLIR/Fluke/Testo-shaped lines the patterns were written for, and asserts the
 * degrade-don't-throw contract on unrecognized text.
 */

const { parseThermographyText, parseSurveyHeader } = require('../../lib/thermographyParse');

const FLIR_REPORT = [
  'Infrared Survey Report',
  'Date: 2026-03-14',
  'Camera: FLIR T540 (s/n 12345)',
  'Emissivity: 0.95   Reflected: 22.0 C',
  'Ambient temperature: 24.5 °C',
  'Relative humidity: 45%',
  'Load at time of survey: 78%',
  'Thermographer: Jane Roe, NETA Level II',
  '',
  'Findings:',
  '1. Panel 3, Phase B lug — deltaT 22C vs similar component',
  '2. MCC-2 starter contactor  dT: 6 C between phases',
  '3. Feeder breaker F-12 — 30 C over ambient',
].join('\n');

describe('parseThermographyText — header', () => {
  const { header, confidence } = parseThermographyText(FLIR_REPORT);

  it('reads the camera make and model', () => {
    expect(header.cameraMake).toBe('FLIR');
    expect(header.cameraModel).toBe('T540');
  });

  it('reads the atmospheric/optical frame', () => {
    expect(header.emissivity).toBe(0.95);
    expect(header.ambientTempC).toBe(24.5);
    expect(header.reflectedTempC).toBe(22.0);
    expect(header.humidityPct).toBe(45);
  });

  it('reads load at scan time (NETA/HSB ≥40% rule needs it recorded)', () => {
    expect(header.loadPercent).toBe(78);
  });

  it('reads the thermographer and certification level', () => {
    expect(header.thermographerName).toBe('Jane Roe');
    expect(header.thermographerQual).toMatch(/Level II/i);
  });

  it('reports a confidence for every field it filled', () => {
    for (const k of Object.keys(header)) {
      if (header[k] !== null) expect(confidence[k]).toBeGreaterThan(0);
    }
  });
});

describe('parseThermographyText — hot-spots', () => {
  const { hotspots, surveyDate } = parseThermographyText(FLIR_REPORT);

  it('finds every line carrying a temperature rise', () => {
    expect(hotspots).toHaveLength(3);
    expect(hotspots.map((h: any) => h.deltaT)).toEqual([22, 6, 30]);
  });

  it('carries the reference frame per hot-spot (ambient vs similar)', () => {
    expect(hotspots[0].reference).toBe('similar');
    expect(hotspots[2].reference).toBe('ambient');
  });

  it('mirrors location into component for the finding column', () => {
    expect(hotspots[0].component).toBe(hotspots[0].location);
    expect(hotspots[0].component).toMatch(/Panel 3/);
  });

  it('extracts the survey date', () => {
    expect(surveyDate).toBe('2026-03-14');
  });
});

describe('parseThermographyText — degradation contract', () => {
  it('does not throw on unrecognized text and returns an all-null header', () => {
    const r = parseThermographyText('this report contains nothing useful at all');
    expect(r.hotspots).toEqual([]);
    expect(r.header.cameraMake).toBeNull();
    expect(r.header.emissivity).toBeNull();
  });

  it('does not throw on empty / non-string input', () => {
    expect(() => parseThermographyText('')).not.toThrow();
    expect(() => parseThermographyText(null as any)).not.toThrow();
    expect(() => parseSurveyHeader(undefined as any)).not.toThrow();
  });

  it('rejects an out-of-range emissivity rather than storing it', () => {
    // "95" (a percentage) is not a valid 0..1 emissivity — better null than wrong.
    expect(parseSurveyHeader('Emissivity: 95').header.emissivity).toBeNull();
  });

  it('reads a reference delta when the report states one', () => {
    const r = parseThermographyText('Breaker B2 deltaT 18C vs 4C reference');
    expect(r.hotspots[0].referenceDeltaT).toBe(4);
  });
});

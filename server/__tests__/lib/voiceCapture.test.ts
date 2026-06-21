/**
 * Voice field-entry parser (lib/voiceCapture) — deterministic NLU.
 *
 * "Breaker 42, IR normal, 68" → a structured measurement proposal. The asset's
 * own number must never be mistaken for the measured value.
 */
import '../helpers/setup';
const { parseVoiceReading, hintTokens } = require('../../lib/voiceCapture');

describe('parseVoiceReading', () => {
  test('the canonical example: "Breaker 42, IR normal, 68"', () => {
    const r = parseVoiceReading('Breaker 42, IR normal, 68');
    expect(r.assetHint).toBe('breaker 42');
    expect(r.measurementType).toBe('insulation_resistance');
    expect(r.unit).toBe('MΩ');
    expect(r.value).toBe(68);          // NOT 42 (the asset number)
    expect(r.passFail).toBe('GREEN');  // "normal" → pass
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('"IR temp 85" disambiguates to temperature, not insulation resistance', () => {
    const r = parseVoiceReading('IR temp 85');
    expect(r.measurementType).toBe('temperature');
    expect(r.unit).toBe('°C');
    expect(r.value).toBe(85);
  });

  test('contact resistance with explicit micro-ohm unit', () => {
    const r = parseVoiceReading('contact resistance 250 microohms');
    expect(r.measurementType).toBe('contact_resistance');
    expect(r.unit).toBe('μΩ');
    expect(r.value).toBe(250);
  });

  test('failure result + decimal value', () => {
    const r = parseVoiceReading('Transformer 3 insulation resistance fail 0.8');
    expect(r.assetHint).toBe('transformer 3');
    expect(r.passFail).toBe('RED');
    expect(r.value).toBe(0.8);
  });

  test('spelled-out numbers ("sixty eight")', () => {
    expect(parseVoiceReading('insulation resistance sixty eight').value).toBe(68);
    expect(parseVoiceReading('power factor one point two percent').value).toBe(1.2);
  });

  test('marginal → YELLOW; load current → amps', () => {
    const r = parseVoiceReading('load current 412 amps marginal');
    expect(r.measurementType).toBe('load_current');
    expect(r.unit).toBe('A');
    expect(r.value).toBe(412);
    expect(r.passFail).toBe('YELLOW');
  });

  test('empty / unrecognized → all-null, zero confidence', () => {
    const r = parseVoiceReading('');
    expect(r.measurementType).toBeNull();
    expect(r.value).toBeNull();
    expect(r.passFail).toBeNull();
    expect(r.confidence).toBe(0);
  });

  test('hintTokens drops 1-char noise', () => {
    expect(hintTokens('Breaker 42')).toEqual(['breaker', '42']);
    expect(hintTokens('A 7')).toEqual(['7']);
  });
});

export {};

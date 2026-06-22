/**
 * Unit tests for the Slice 11 arc-flash timeline assembler.
 */
import { buildTimeline } from '../../lib/arcFlashTimeline';

describe('buildTimeline', () => {
  const input = {
    studyAssets: [
      { busName: 'MCC-7', incidentEnergyCalCm2: 8.4, labelSeverity: 'warning', printedAt: '2026-03-01T00:00:00Z', study: { performedDate: '2024-01-01T00:00:00Z', peName: 'A. Engineer' } },
      { busName: 'MCC-7', incidentEnergyCalCm2: 12.1, labelSeverity: 'warning', study: { performedDate: '2025-06-01T00:00:00Z' } },
    ],
    deviceTests: [{ testType: 'as_found_as_left', result: 'pass', driftFlagged: true, createdAt: '2026-05-01T00:00:00Z' }],
    devices: [{ label: 'Main breaker', deviceType: 'breaker', sensorRatingA: 800, source: 'field', settingsCollectedAt: '2025-07-15T00:00:00Z' }],
  };

  test('merges all sources and sorts newest-first', () => {
    const ev = buildTimeline(input);
    const types = ev.map(e => e.type);
    expect(types).toContain('study');
    expect(types).toContain('label_printed');
    expect(types).toContain('device_test');
    expect(types).toContain('device_collected');
    // newest first: the 2026-05 drift test before the 2025 study
    const dates = ev.map(e => new Date(e.date).getTime());
    for (let i = 1; i < dates.length; i++) expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
  });

  test('study event carries incident energy + severity', () => {
    const ev = buildTimeline(input);
    const study = ev.find(e => e.type === 'study');
    expect(study?.detail).toMatch(/cal\/cm/);
    expect(study?.severity).toBe('warning');
  });

  test('drift test is flagged severity danger', () => {
    const ev = buildTimeline(input);
    const test = ev.find(e => e.type === 'device_test');
    expect(test?.severity).toBe('danger');
    expect(test?.detail).toMatch(/DRIFT/);
  });

  test('empty input -> empty timeline', () => {
    expect(buildTimeline({})).toEqual([]);
  });
});

// Telemetry-derived load-growth signal (light arc-flash re-study trigger).
const { isLoadChannel, assessLoadGrowth } = require('../lib/telemetryLoadGrowth');

describe('isLoadChannel', () => {
  test('matches load units and load-ish keys/labels', () => {
    expect(isLoadChannel({ unit: 'A' })).toBe(true);
    expect(isLoadChannel({ unit: 'kW' })).toBe(true);
    expect(isLoadChannel({ key: 'feeder_current', unit: '' })).toBe(true);
    expect(isLoadChannel({ label: 'Main Bus Load' })).toBe(true);
  });
  test('ignores non-load channels', () => {
    expect(isLoadChannel({ key: 'winding_temp', unit: 'C' })).toBe(false);
    expect(isLoadChannel({ key: 'vibration', unit: 'mm/s' })).toBe(false);
  });
});

describe('assessLoadGrowth', () => {
  test('needs enough readings', () => {
    expect(assessLoadGrowth([{ value: 100, recordedAt: '2026-01-01' }]).ok).toBe(false);
  });

  test('computes oldest-window vs newest-window growth %', () => {
    const readings = [];
    // oldest 5 ~100A, newest 5 ~120A → +20%
    for (let i = 0; i < 5; i++) readings.push({ value: 100, recordedAt: `2026-01-0${i + 1}` });
    for (let i = 0; i < 5; i++) readings.push({ value: 120, recordedAt: `2026-02-0${i + 1}` });
    const r = assessLoadGrowth(readings);
    expect(r.ok).toBe(true);
    expect(r.baseline).toBe(100);
    expect(r.current).toBe(120);
    expect(r.growthPct).toBe(20);
  });

  test('orders by time regardless of input order; flat load = ~0%', () => {
    const readings = [
      { value: 50, recordedAt: '2026-03-01' },
      { value: 50, recordedAt: '2026-01-01' },
      { value: 50, recordedAt: '2026-02-01' },
      { value: 50, recordedAt: '2026-01-15' },
      { value: 50, recordedAt: '2026-02-15' },
      { value: 50, recordedAt: '2026-03-15' },
    ];
    const r = assessLoadGrowth(readings, { windowSize: 2 });
    expect(r.ok).toBe(true);
    expect(r.growthPct).toBe(0);
  });

  test('zero/negative baseline is rejected (no divide-by-zero)', () => {
    const readings = Array.from({ length: 6 }, (_, i) => ({ value: i < 3 ? 0 : 10, recordedAt: `2026-0${i + 1}-01` }));
    expect(assessLoadGrowth(readings, { windowSize: 3 }).ok).toBe(false);
  });
});

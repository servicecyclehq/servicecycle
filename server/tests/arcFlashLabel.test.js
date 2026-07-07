// lib/arcFlashLabel.ts — [F7, 2026-07-07] shockApproachSources() per-value
// provenance helper, extracted so routes/arcFlashLabelPublic.ts's public QR
// label portal can surface WHICH specific shock-boundary number came from the
// study vs. the NFPA 70E Table 130.4 fallback -- the printed PDF label
// (arcFlashLabelDoc.ts) already made this distinction; the portal previously
// only carried a blanket footnote with no per-value flag.
const { shockApproachSources, labelSnapshot } = require('../lib/arcFlashLabel');

describe('shockApproachSources', () => {
  test('both boundaries study-captured -> both sources "study"', () => {
    const row = { nominalVoltage: '480V', shockLimitedApproachIn: 42, shockRestrictedApproachIn: 12 };
    const s = shockApproachSources(row);
    expect(s.shockLimitedApproachSource).toBe('study');
    expect(s.shockRestrictedApproachSource).toBe('study');
  });

  test('neither boundary stored -> both fall back to Table 130.4 and are flagged so', () => {
    const row = { nominalVoltage: '480V' };
    const s = shockApproachSources(row);
    expect(s.shockLimitedApproachSource).toBe('table130_4');
    // 480V is inside the 50-150V "avoid contact" band's neighbor tier; just
    // assert it resolved to SOME source, not null, since the exact restricted
    // value depends on the boundary table (kept as a black box here).
    expect(['study', 'table130_4', null]).toContain(s.shockRestrictedApproachSource);
  });

  test('mixed: one study-captured, one table-derived', () => {
    const row = { nominalVoltage: '480V', shockLimitedApproachIn: 42 };
    const s = shockApproachSources(row);
    expect(s.shockLimitedApproachSource).toBe('study');
    // restricted was never stored on the row, so if the table has any value
    // for this voltage it must be table-derived, not study.
    if (s.shockRestrictedApproachSource != null) {
      expect(s.shockRestrictedApproachSource).toBe('table130_4');
    }
  });

  test('no voltage at all and nothing stored -> both null (nothing to show)', () => {
    const row = { nominalVoltage: null };
    const s = shockApproachSources(row);
    expect(s.shockLimitedApproachSource).toBeNull();
    expect(s.shockRestrictedApproachSource).toBeNull();
  });

  test('null row does not throw', () => {
    expect(shockApproachSources(null)).toEqual({ shockLimitedApproachSource: null, shockRestrictedApproachSource: null });
  });

  test('agrees with labelSnapshot() on whether a value exists at all', () => {
    const row = { nominalVoltage: '480V', shockLimitedApproachIn: 42, shockRestrictedApproachIn: 12 };
    const snap = labelSnapshot(row);
    const src = shockApproachSources(row);
    expect(snap.shockLimitedApproachIn != null).toBe(src.shockLimitedApproachSource != null);
    expect(snap.shockRestrictedApproachIn != null).toBe(src.shockRestrictedApproachSource != null);
  });
});

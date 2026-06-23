// Unit tests for sanitizeHiddenFeatures — the allowlist that guards the
// PUT /api/users/me/hidden-features route. Covers the grant-gated page
// features AND the infoTips UI-view preference (which is NOT grant-gated).
const { sanitizeHiddenFeatures, UI_PREF_KEYS, ALL_FEATURES } = require('../lib/featureFlags');

describe('sanitizeHiddenFeatures', () => {
  test('drops non-object / nullish input', () => {
    expect(sanitizeHiddenFeatures(null)).toEqual({});
    expect(sanitizeHiddenFeatures(undefined)).toEqual({});
    expect(sanitizeHiddenFeatures('nope')).toEqual({});
    expect(sanitizeHiddenFeatures(42)).toEqual({});
  });

  test('drops unknown keys and non-boolean values', () => {
    const out = sanitizeHiddenFeatures(
      { bogus: true, export: 'yes', assets_write: 1 },
      { export: true, assets_write: true },
    );
    expect(out).toEqual({});
  });

  test('can only HIDE a granted page feature', () => {
    // granted → may hide
    expect(sanitizeHiddenFeatures({ export: true }, { export: true })).toEqual({ export: true });
    // not granted → hide request is ignored
    expect(sanitizeHiddenFeatures({ export: true }, { export: false })).toEqual({});
    expect(sanitizeHiddenFeatures({ export: true }, {})).toEqual({});
  });

  test('can always UN-hide a page feature regardless of grant', () => {
    expect(sanitizeHiddenFeatures({ export: false }, {})).toEqual({ export: false });
  });

  test('infoTips is a UI pref — toggleable either way without a grant', () => {
    expect(UI_PREF_KEYS).toContain('infoTips');
    expect(sanitizeHiddenFeatures({ infoTips: true }, {})).toEqual({ infoTips: true });
    expect(sanitizeHiddenFeatures({ infoTips: false }, {})).toEqual({ infoTips: false });
  });

  test('infoTips coexists with grant-gated features', () => {
    const out = sanitizeHiddenFeatures(
      { infoTips: true, export: true, alerts: true },
      { export: true, alerts: false },
    );
    expect(out).toEqual({ infoTips: true, export: true });
  });

  test('every ALL_FEATURES key round-trips an un-hide', () => {
    for (const f of ALL_FEATURES) {
      expect(sanitizeHiddenFeatures({ [f]: false }, {})).toEqual({ [f]: false });
    }
  });
});

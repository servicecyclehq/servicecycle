'use strict';

/**
 * Scaffold test for the 'edms' account-feature key (2026-07-05, EDMS Phase 1
 * prep -- see docs/scoping/EDMS_MODULE_SCOPE_2026-07-04.md). No routes or UI
 * are gated on this flag yet; this only locks the resolution contract so
 * Phase 2 can rely on it: default OFF, and the same env/setting override
 * mechanism every other account feature already uses.
 */

const { computeAccountFeatures, ACCOUNT_FEATURE_KEYS, ACCOUNT_FEATURE_DEFAULTS } =
  require('../lib/accountFeatures');

describe('accountFeatures: edms key scaffold', () => {
  test('edms is present in the canonical key list', () => {
    expect(ACCOUNT_FEATURE_KEYS).toContain('edms');
  });

  test('edms defaults to OFF', () => {
    expect(ACCOUNT_FEATURE_DEFAULTS.edms).toBe(false);
    expect(computeAccountFeatures({}).edms).toBe(false);
  });

  test('edms can be flipped on via a per-account setting', () => {
    expect(computeAccountFeatures({ 'feature.edms': 'true' }).edms).toBe(true);
    expect(computeAccountFeatures({ 'feature.edms': 'false' }).edms).toBe(false);
  });

  test('edms can be flipped on via ACCOUNT_FEATURE_EDMS env override', () => {
    const prev = process.env.ACCOUNT_FEATURE_EDMS;
    try {
      process.env.ACCOUNT_FEATURE_EDMS = 'true';
      expect(computeAccountFeatures({}).edms).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ACCOUNT_FEATURE_EDMS;
      else process.env.ACCOUNT_FEATURE_EDMS = prev;
    }
  });
});

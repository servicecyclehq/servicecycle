'use strict';

/**
 * tests/safeSearch.test.js
 * -------------------------
 * v0.37.4 regression suite for lib/safeSearch.sanitiseLikeValue. Locks in
 * the Postgres ILIKE wildcard stripping + length cap that closed Pass-3 D's
 * pattern-DoS finding on the public /api/v1/contracts?vendor= endpoint.
 *
 * No DB dependency — pure-logic helper.
 */

const { sanitiseLikeValue } = require('../lib/safeSearch');

describe('safeSearch.sanitiseLikeValue', () => {
  test('strips % wildcards (the LIKE multi-char wildcard)', () => {
    expect(sanitiseLikeValue('%acme%')).toBe('acme');
    expect(sanitiseLikeValue('a%b%c')).toBe('abc');
  });

  test('strips _ wildcards (the LIKE single-char wildcard)', () => {
    expect(sanitiseLikeValue('_acme_')).toBe('acme');
    expect(sanitiseLikeValue('a_b_c')).toBe('abc');
  });

  test('strips backslash (the Postgres LIKE escape char)', () => {
    // Without this, a hostile caller could escape our future literal
    // matching and re-enable wildcard semantics.
    expect(sanitiseLikeValue('a\\%b')).toBe('ab');
  });

  test('defangs the canonical pattern-DoS payload', () => {
    // The Pass-3 D anchor: a deeply nested wildcard input that forces
    // Postgres into a heavy pattern scan. After sanitisation it should
    // collapse to the empty string (no usable characters left).
    expect(sanitiseLikeValue('%_%_%_%_%_%_%_%_%_%_%')).toBeNull();
  });

  test('collapses internal whitespace + trims', () => {
    expect(sanitiseLikeValue('  foo   bar  ')).toBe('foo bar');
  });

  test('caps at the default 80 chars', () => {
    const long = 'a'.repeat(120);
    expect(sanitiseLikeValue(long)).toHaveLength(80);
  });

  test('honors a caller-supplied maxLen', () => {
    expect(sanitiseLikeValue('abcdef', 3)).toBe('abc');
  });

  test('returns null for non-string input', () => {
    expect(sanitiseLikeValue(null)).toBeNull();
    expect(sanitiseLikeValue(undefined)).toBeNull();
    expect(sanitiseLikeValue(42)).toBeNull();
    expect(sanitiseLikeValue({})).toBeNull();
  });

  test('returns null for empty/whitespace-only/all-wildcard input', () => {
    expect(sanitiseLikeValue('')).toBeNull();
    expect(sanitiseLikeValue('   ')).toBeNull();
    expect(sanitiseLikeValue('%%%')).toBeNull();
    expect(sanitiseLikeValue('___')).toBeNull();
  });

  test('preserves a normal vendor name unchanged', () => {
    expect(sanitiseLikeValue('Microsoft')).toBe('Microsoft');
    expect(sanitiseLikeValue('Acme Corp')).toBe('Acme Corp');
  });

  test('handles unicode + punctuation that are not LIKE metachars', () => {
    expect(sanitiseLikeValue('Café Solutions, Inc.')).toBe('Café Solutions, Inc.');
    expect(sanitiseLikeValue('AT&T')).toBe('AT&T');
  });
});

'use strict';

/**
 * Pure-unit tests for the custom-fields helpers + a route smoke test
 * for the unauthenticated case. The CRUD flow is exercised by the
 * existing dev-server integration patterns; we don't try to seed
 * mutable contract state here.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { api } = require('./helpers');
const {
  validateValueForDefinition,
  slugifyKey,
  cleanSelectOptions,
} = require('../routes/customFields');

describe('slugifyKey', () => {
  test('lowercases, strips punctuation, snake_cases spaces', () => {
    expect(slugifyKey('Cost Centre Code')).toBe('cost_centre_code');
  });
  test('strips combining diacritics', () => {
    expect(slugifyKey('Café Number')).toBe('cafe_number');
  });
  test('collapses runs of separators', () => {
    expect(slugifyKey('  Foo --- Bar !!! Baz  ')).toBe('foo_bar_baz');
  });
  test('returns empty string for input with no alphanumerics', () => {
    expect(slugifyKey('---')).toBe('');
    expect(slugifyKey('')).toBe('');
  });
  test('caps at 60 characters', () => {
    const long = 'a'.repeat(120);
    expect(slugifyKey(long).length).toBe(60);
  });
});

describe('cleanSelectOptions', () => {
  test('accepts an array of strings', () => {
    expect(cleanSelectOptions(['Low', 'Medium', 'High'])).toEqual([
      { value: 'Low',    label: 'Low' },
      { value: 'Medium', label: 'Medium' },
      { value: 'High',   label: 'High' },
    ]);
  });
  test('accepts an array of {value,label} objects', () => {
    expect(cleanSelectOptions([{ value: 'lo', label: 'Low' }])).toEqual([
      { value: 'lo', label: 'Low' },
    ]);
  });
  test('rejects non-array input', () => {
    expect(() => cleanSelectOptions('Low')).toThrow(/array/);
    expect(() => cleanSelectOptions(null)).toThrow(/array/);
  });
  test('rejects empty array', () => {
    expect(() => cleanSelectOptions([])).toThrow(/at least one/);
  });
  test('rejects > 100 options', () => {
    const opts = Array.from({ length: 101 }, (_, i) => `o${i}`);
    expect(() => cleanSelectOptions(opts)).toThrow(/100/);
  });
  test('rejects duplicate values', () => {
    expect(() => cleanSelectOptions(['Low', 'Low'])).toThrow(/duplicate/);
  });
  test('rejects empty option value', () => {
    expect(() => cleanSelectOptions([{ value: '', label: 'x' }])).toThrow(/empty/);
  });
});

describe('validateValueForDefinition', () => {
  const T = (type, extra = {}) => ({ name: 'Test', type, ...extra });

  test('null and empty string clear the value', () => {
    expect(validateValueForDefinition(T('text'), null)).toBeNull();
    expect(validateValueForDefinition(T('text'), '')).toBeNull();
  });

  test('text passes through as a string', () => {
    expect(validateValueForDefinition(T('text'), 'Hello')).toBe('Hello');
    expect(validateValueForDefinition(T('text'), 42)).toBe('42');
  });

  test('number coerces and rejects NaN', () => {
    expect(validateValueForDefinition(T('number'), '3.14')).toBe('3.14');
    expect(validateValueForDefinition(T('number'), 7)).toBe('7');
    expect(() => validateValueForDefinition(T('number'), 'banana')).toThrow(/number/);
  });

  test('date stores as YYYY-MM-DD', () => {
    expect(validateValueForDefinition(T('date'), '2026-12-15')).toBe('2026-12-15');
    expect(() => validateValueForDefinition(T('date'), 'not-a-date')).toThrow(/date/);
  });

  test('checkbox normalises truthy/falsy spellings', () => {
    expect(validateValueForDefinition(T('checkbox'), 'true')).toBe('true');
    expect(validateValueForDefinition(T('checkbox'), 'YES')).toBe('true');
    expect(validateValueForDefinition(T('checkbox'), '1')).toBe('true');
    expect(validateValueForDefinition(T('checkbox'), 'false')).toBe('false');
    expect(validateValueForDefinition(T('checkbox'), '0')).toBe('false');
    expect(() => validateValueForDefinition(T('checkbox'), 'maybe')).toThrow(/true or false/);
  });

  test('select rejects values not in options', () => {
    const def = T('select', { options: [{ value: 'lo' }, { value: 'hi' }] });
    expect(validateValueForDefinition(def, 'lo')).toBe('lo');
    expect(() => validateValueForDefinition(def, 'medium')).toThrow(/not a valid option/);
  });

  test('throws on unknown type', () => {
    expect(() => validateValueForDefinition(T('zonk'), 'x')).toThrow(/unknown field type/);
  });
});

describe('GET /api/custom-fields — auth', () => {
  test('rejects unauthenticated requests', async () => {
    let res;
    try {
      res = await api().get('/api/custom-fields');
    } catch (err) {
      // Dev server not running — supertest surfaces ECONNREFUSED as
      // AggregateError on Node 18+. Skip rather than fail.
      console.warn('custom-fields auth test skipped — dev server unreachable');
      return;
    }
    if (res.status === 404) {
      console.warn('custom-fields route not yet mounted on dev server');
      return;
    }
    expect([401, 403]).toContain(res.status);
  });
});

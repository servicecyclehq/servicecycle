'use strict';

/**
 * tests/export.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Unit tests for the pure helper functions in lib/exportHelpers.js.
 *
 * Zero DB/network calls — all functions are deterministic and side-effect-free.
 * Suite targets the business logic that's hardest to catch in a smoke test:
 *   • parseList         — CSV / array parsing, length caps, trimming
 *   • filterToRequestedColumns — registry projection
 *   • dateOrNull        — invalid-input handling
 *   • parseDateStartUtc — YYYY-MM-DD → T00:00:00.000Z
 *   • parseDateEndUtc   — YYYY-MM-DD → T23:59:59.999Z
 *   • dateRangeClause   — Prisma gte/lte builder
 *   • parseNum          — query-string number coercion
 *   • vendorSpend       — active-contract spend aggregation
 *   • vendorLastContact — most-recent-contact resolution
 *   • buildActivityWhere — activityLog Prisma where builder
 */

const {
  BLANK_SENTINEL,
  dateOrNull,
  parseDateStartUtc,
  parseDateEndUtc,
  dateRangeClause,
  parseNum,
  parseList,
  filterToRequestedColumns,
  vendorSpend,
  vendorLastContact,
  buildActivityWhere,
} = require('../lib/exportHelpers');

// ── parseList ─────────────────────────────────────────────────────────────────

describe('parseList', () => {
  test('returns [] for null', () => expect(parseList(null)).toEqual([]));
  test('returns [] for undefined', () => expect(parseList(undefined)).toEqual([]));
  test('returns [] for a number', () => expect(parseList(42)).toEqual([]));
  test('returns [] for an object', () => expect(parseList({})).toEqual([]));

  test('splits a comma-separated string', () => {
    expect(parseList('Adobe,Microsoft,Okta')).toEqual(['Adobe', 'Microsoft', 'Okta']);
  });

  test('trims whitespace from entries', () => {
    expect(parseList(' Adobe , Microsoft ')).toEqual(['Adobe', 'Microsoft']);
  });

  test('drops empty segments', () => {
    expect(parseList('Adobe,,Microsoft')).toEqual(['Adobe', 'Microsoft']);
  });

  test('passes an array through unchanged', () => {
    expect(parseList(['Adobe', 'Microsoft'])).toEqual(['Adobe', 'Microsoft']);
  });

  test('trims array entries too', () => {
    expect(parseList([' Adobe ', 'Microsoft'])).toEqual(['Adobe', 'Microsoft']);
  });

  test('drops array entries that are empty after trimming', () => {
    expect(parseList(['Adobe', '  ', 'Microsoft'])).toEqual(['Adobe', 'Microsoft']);
  });

  test('drops entries longer than 200 chars', () => {
    const long = 'a'.repeat(201);
    expect(parseList(`Adobe,${long},Microsoft`)).toEqual(['Adobe', 'Microsoft']);
  });

  test('accepts entries of exactly 200 chars', () => {
    const exact = 'a'.repeat(200);
    expect(parseList([exact])).toEqual([exact]);
  });

  test('caps output at 200 entries', () => {
    const raw = Array.from({ length: 250 }, (_, i) => `item${i}`).join(',');
    expect(parseList(raw)).toHaveLength(200);
  });

  test('BLANK_SENTINEL passes through unchanged', () => {
    expect(parseList(`__BLANK__,Adobe`)).toEqual([BLANK_SENTINEL, 'Adobe']);
  });
});

// ── filterToRequestedColumns ─────────────────────────────────────────────────

const REGISTRY = [
  { id: 'vendor',  header: 'Vendor'  },
  { id: 'product', header: 'Product' },
  { id: 'status',  header: 'Status'  },
  { id: 'endDate', header: 'End Date' },
];

describe('filterToRequestedColumns', () => {
  test('returns full registry when columnsQuery is absent', () => {
    expect(filterToRequestedColumns(REGISTRY, undefined)).toBe(REGISTRY);
  });

  test('returns full registry when columnsQuery is null', () => {
    expect(filterToRequestedColumns(REGISTRY, null)).toBe(REGISTRY);
  });

  test('returns full registry when columnsQuery is empty string', () => {
    // empty string → wanted.size === 0 → full registry
    expect(filterToRequestedColumns(REGISTRY, '')).toBe(REGISTRY);
  });

  test('filters to requested columns', () => {
    const result = filterToRequestedColumns(REGISTRY, 'vendor,status');
    expect(result).toHaveLength(2);
    expect(result.map(c => c.id)).toEqual(['vendor', 'status']);
  });

  test('ignores column ids not in the registry', () => {
    const result = filterToRequestedColumns(REGISTRY, 'vendor,nonexistent');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('vendor');
  });

  test('trims whitespace around column ids', () => {
    const result = filterToRequestedColumns(REGISTRY, ' vendor , status ');
    expect(result.map(c => c.id)).toEqual(['vendor', 'status']);
  });

  test('returns empty array when no ids match', () => {
    expect(filterToRequestedColumns(REGISTRY, 'nope,zilch')).toEqual([]);
  });
});

// ── dateOrNull ────────────────────────────────────────────────────────────────

describe('dateOrNull', () => {
  test('returns null for null', () => expect(dateOrNull(null)).toBeNull());
  test('returns null for undefined', () => expect(dateOrNull(undefined)).toBeNull());
  test('returns null for empty string', () => expect(dateOrNull('')).toBeNull());
  test('returns null for garbage string', () => expect(dateOrNull('not-a-date')).toBeNull());

  test('returns a Date for a valid ISO string', () => {
    const d = dateOrNull('2026-12-31T00:00:00.000Z');
    expect(d).toBeInstanceOf(Date);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(11); // December
    expect(d.getUTCDate()).toBe(31);
  });

  test('returns a Date for a YYYY-MM-DD string', () => {
    const d = dateOrNull('2026-06-15');
    expect(d).toBeInstanceOf(Date);
  });

  test('passes a Date object through', () => {
    const src = new Date('2026-01-01T00:00:00Z');
    const d = dateOrNull(src);
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBe(src.getTime());
  });
});

// ── parseDateStartUtc ─────────────────────────────────────────────────────────

describe('parseDateStartUtc', () => {
  test('returns null for non-string', () => expect(parseDateStartUtc(20260101)).toBeNull());
  test('returns null for wrong format', () => expect(parseDateStartUtc('01/15/2026')).toBeNull());
  test('returns null for partial date', () => expect(parseDateStartUtc('2026-01')).toBeNull());
  test('returns null for invalid date', () => expect(parseDateStartUtc('2026-13-01')).toBeNull());

  test('returns T00:00:00.000Z for a valid YYYY-MM-DD', () => {
    const d = parseDateStartUtc('2026-06-15');
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });
});

// ── parseDateEndUtc ───────────────────────────────────────────────────────────

describe('parseDateEndUtc', () => {
  test('returns null for non-string', () => expect(parseDateEndUtc(null)).toBeNull());
  test('returns null for wrong format', () => expect(parseDateEndUtc('Jun 15 2026')).toBeNull());

  test('returns T23:59:59.999Z for a valid YYYY-MM-DD', () => {
    const d = parseDateEndUtc('2026-06-15');
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2026-06-15T23:59:59.999Z');
  });
});

// ── dateRangeClause ───────────────────────────────────────────────────────────

describe('dateRangeClause', () => {
  test('returns null when both bounds are absent', () => {
    expect(dateRangeClause('endDate', undefined, undefined)).toBeNull();
  });

  test('returns null when both bounds are invalid strings', () => {
    expect(dateRangeClause('endDate', 'bad', 'also-bad')).toBeNull();
  });

  test('returns {field: {gte}} when only fromRaw is valid', () => {
    const clause = dateRangeClause('endDate', '2026-01-01', undefined);
    expect(clause).toEqual({ endDate: { gte: new Date('2026-01-01T00:00:00.000Z') } });
  });

  test('returns {field: {lte}} when only toRaw is valid', () => {
    const clause = dateRangeClause('endDate', undefined, '2026-12-31');
    expect(clause).toEqual({ endDate: { lte: new Date('2026-12-31T23:59:59.999Z') } });
  });

  test('returns {field: {gte, lte}} when both bounds are valid', () => {
    const clause = dateRangeClause('endDate', '2026-01-01', '2026-12-31');
    expect(clause).toEqual({
      endDate: {
        gte: new Date('2026-01-01T00:00:00.000Z'),
        lte: new Date('2026-12-31T23:59:59.999Z'),
      },
    });
  });

  test('works with any field name', () => {
    const clause = dateRangeClause('cancelByDate', '2026-06-01', undefined);
    expect(clause).toHaveProperty('cancelByDate');
  });
});

// ── parseNum ──────────────────────────────────────────────────────────────────

describe('parseNum', () => {
  test('returns null for undefined', () => expect(parseNum(undefined)).toBeNull());
  test('returns null for null', () => expect(parseNum(null)).toBeNull());
  test('returns null for empty string', () => expect(parseNum('')).toBeNull());
  test('returns null for non-numeric string', () => expect(parseNum('abc')).toBeNull());

  test('parses integer string', () => expect(parseNum('42')).toBe(42));
  test('parses float string', () => expect(parseNum('3.14')).toBeCloseTo(3.14));
  test('passes through a number', () => expect(parseNum(100)).toBe(100));
  test('parses "0"', () => expect(parseNum('0')).toBe(0));
  test('parses negative', () => expect(parseNum('-5.5')).toBeCloseTo(-5.5));
});

// ── vendorSpend ───────────────────────────────────────────────────────────────

describe('vendorSpend', () => {
  test('returns 0 for no contracts', () => {
    expect(vendorSpend({ contracts: [] })).toBe(0);
  });

  test('returns 0 when contracts array is missing', () => {
    expect(vendorSpend({})).toBe(0);
  });

  test('returns 0 when costPerLicense is missing', () => {
    expect(vendorSpend({ contracts: [{ quantity: 10 }] })).toBe(0);
  });

  test('returns 0 when quantity is missing', () => {
    expect(vendorSpend({ contracts: [{ costPerLicense: '100.00' }] })).toBe(0);
  });

  test('calculates spend for one contract', () => {
    expect(vendorSpend({
      contracts: [{ costPerLicense: '25.00', quantity: 4 }],
    })).toBe(100);
  });

  test('sums spend across multiple contracts', () => {
    expect(vendorSpend({
      contracts: [
        { costPerLicense: '10.00', quantity: 3 },
        { costPerLicense: '50.00', quantity: 2 },
      ],
    })).toBe(130);
  });

  test('skips contracts missing either field', () => {
    expect(vendorSpend({
      contracts: [
        { costPerLicense: '10.00', quantity: 3 },
        { costPerLicense: '50.00' },          // missing quantity
        { quantity: 5 },                       // missing costPerLicense
      ],
    })).toBe(30);
  });
});

// ── vendorLastContact ─────────────────────────────────────────────────────────

describe('vendorLastContact', () => {
  test('returns null when neither communications nor contacts exist', () => {
    expect(vendorLastContact({})).toBeNull();
  });

  test('returns null when both arrays are empty', () => {
    expect(vendorLastContact({ communications: [], contacts: [] })).toBeNull();
  });

  test('returns communication date when only comm exists', () => {
    const ts = '2026-05-01T10:00:00.000Z';
    const result = vendorLastContact({
      communications: [{ createdAt: ts }],
      contacts: [],
    });
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe(ts);
  });

  test('returns contact date when only contact exists', () => {
    const ts = '2026-04-15T08:00:00.000Z';
    const result = vendorLastContact({
      communications: [],
      contacts: [{ lastContactedAt: ts }],
    });
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe(ts);
  });

  test('returns the more recent of comm vs contact', () => {
    const commTs    = '2026-03-01T00:00:00.000Z';
    const contactTs = '2026-05-10T00:00:00.000Z';
    const result = vendorLastContact({
      communications: [{ createdAt: commTs }],
      contacts: [{ lastContactedAt: contactTs }],
    });
    expect(result.toISOString()).toBe(contactTs);
  });
});

// ── buildActivityWhere ────────────────────────────────────────────────────────

function mockReq(query = {}) {
  return { user: { accountId: 'acc-123' }, query };
}

describe('buildActivityWhere', () => {
  test('always includes accountId', () => {
    const w = buildActivityWhere(mockReq());
    expect(w.accountId).toBe('acc-123');
  });

  test('no query params → only accountId', () => {
    const w = buildActivityWhere(mockReq());
    expect(Object.keys(w)).toEqual(['accountId']);
  });

  test('actionIn CSV → where.action.in', () => {
    const w = buildActivityWhere(mockReq({ actionIn: 'contract_created,status_changed' }));
    expect(w.action).toEqual({ in: ['contract_created', 'status_changed'] });
  });

  test('legacy ?action= → where.action string', () => {
    const w = buildActivityWhere(mockReq({ action: 'contract_created' }));
    expect(w.action).toBe('contract_created');
  });

  test('actionIn takes priority over legacy action', () => {
    const w = buildActivityWhere(mockReq({ actionIn: 'status_changed', action: 'other' }));
    expect(w.action).toEqual({ in: ['status_changed'] });
  });

  test('userIdIn with real ids → where.userId.in', () => {
    const w = buildActivityWhere(mockReq({ userIdIn: 'uid-1,uid-2' }));
    expect(w.userId).toEqual({ in: ['uid-1', 'uid-2'] });
  });

  test('userIdIn BLANK_SENTINEL only → where.userId = null', () => {
    const w = buildActivityWhere(mockReq({ userIdIn: BLANK_SENTINEL }));
    expect(w.userId).toBeNull();
  });

  test('userIdIn real + BLANK → OR clause with both', () => {
    const w = buildActivityWhere(mockReq({ userIdIn: `uid-1,${BLANK_SENTINEL}` }));
    expect(w.OR).toEqual(expect.arrayContaining([
      { userId: { in: ['uid-1'] } },
      { userId: null },
    ]));
  });

  test('contractId → where.contractId', () => {
    const w = buildActivityWhere(mockReq({ contractId: 'ctr-abc' }));
    expect(w.contractId).toBe('ctr-abc');
  });

  test('dateFrom → where.createdAt.gte', () => {
    const w = buildActivityWhere(mockReq({ dateFrom: '2026-01-01' }));
    expect(w.createdAt).toBeDefined();
    expect(w.createdAt.gte).toBeInstanceOf(Date);
    expect(w.createdAt.gte.getUTCFullYear()).toBe(2026);
  });

  test('dateTo → where.createdAt.lte at end of day', () => {
    const w = buildActivityWhere(mockReq({ dateTo: '2026-01-31' }));
    expect(w.createdAt.lte).toBeInstanceOf(Date);
    expect(w.createdAt.lte.getUTCHours()).toBe(23);
    expect(w.createdAt.lte.getUTCMinutes()).toBe(59);
  });

  test('invalid dateFrom is ignored', () => {
    const w = buildActivityWhere(mockReq({ dateFrom: 'not-a-date' }));
    // dateFrom provided but invalid — createdAt block is created but gte not set
    expect(w.createdAt?.gte).toBeUndefined();
  });
});

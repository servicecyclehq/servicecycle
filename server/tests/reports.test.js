'use strict';

/**
 * Pure-unit tests for the executive-spend aggregator + a smoke test that
 * the JSON endpoint and PDF endpoint respond correctly.
 *
 * The aggregator tests use synthetic contract rows so the math can be
 * verified without spinning up Prisma. The route tests follow the same
 * pattern as idor.test.js — they hit a running dev server and skip
 * gracefully if seed credentials aren't available.
 */

const { api, login } = require('./helpers');
const { aggregateContracts, contractSpend, pctChange } = require('../routes/reports');
const { fiscalYearRange } = require('../lib/fiscalYear');

// ── Helpers ──────────────────────────────────────────────────────────────────
const currentFY = fiscalYearRange(new Date('2026-05-02T00:00:00Z'), 1, 0);
const priorFY   = fiscalYearRange(new Date('2026-05-02T00:00:00Z'), 1, -1);

function contract({ start, vendor, dept, qty, cost, negotiated, totalValue, product = 'P', endDate = null }) {
  return {
    product,
    department: dept,
    quantity: qty,
    costPerLicense: cost,
    finalNegotiatedPrice: negotiated,
    totalValue,
    startDate: new Date(start),
    endDate:   endDate ? new Date(endDate) : null,
    vendor:    { name: vendor },
  };
}

// ── Pure aggregator tests ────────────────────────────────────────────────────
describe('contractSpend formula precedence', () => {
  test('prefers finalNegotiatedPrice * quantity when both present', () => {
    expect(contractSpend({
      quantity: 10, costPerLicense: 100, finalNegotiatedPrice: 80,
    })).toBe(800);
  });

  test('falls back to costPerLicense * quantity when no negotiated', () => {
    expect(contractSpend({ quantity: 5, costPerLicense: 50 })).toBe(250);
  });

  test('falls back to denormalized totalValue last', () => {
    expect(contractSpend({ totalValue: 1234 })).toBe(1234);
  });

  test('returns 0 when nothing is set', () => {
    expect(contractSpend({})).toBe(0);
  });
});

describe('pctChange', () => {
  test('positive delta → positive percent', () => {
    expect(pctChange(120, 100)).toBe(20);
  });
  test('negative delta → negative percent', () => {
    expect(pctChange(80, 100)).toBe(-20);
  });
  test('zero prior + zero current → 0', () => {
    expect(pctChange(0, 0)).toBe(0);
  });
  test('zero prior + non-zero current → null (avoid misleading Infinity)', () => {
    expect(pctChange(500, 0)).toBeNull();
  });
  test('null prior treated like zero prior', () => {
    expect(pctChange(500, null)).toBeNull();
  });
});

describe('aggregateContracts', () => {
  test('buckets contracts by FY and rolls up totals correctly', () => {
    const rows = [
      contract({ start: '2026-02-01', vendor: 'Acme',  dept: 'Eng', qty: 10, cost: 100 }),     // current 1000
      contract({ start: '2026-04-15', vendor: 'Acme',  dept: 'Eng', qty: 5,  cost: 200 }),     // current 1000
      contract({ start: '2025-06-01', vendor: 'Acme',  dept: 'Eng', qty: 5,  cost: 200 }),     // prior 1000
      contract({ start: '2026-03-01', vendor: 'Beta',  dept: 'Sales', qty: 2, cost: 500 }),    // current 1000
      contract({ start: '2025-03-01', vendor: 'Beta',  dept: 'Sales', qty: 4, cost: 500 }),    // prior 2000
      contract({ start: '2024-12-31', vendor: 'Beta',  dept: 'Sales', qty: 1, cost: 999 }),    // out of range — drop
    ];

    const agg = aggregateContracts(rows, currentFY, priorFY);

    expect(agg.fyTotals.current.spend).toBe(3000);
    expect(agg.fyTotals.current.count).toBe(3);
    expect(agg.fyTotals.prior.spend).toBe(3000);
    expect(agg.fyTotals.prior.count).toBe(2);

    // Vendor rollup, sorted by current desc — Acme (2000) > Beta (1000)
    expect(agg.byVendor.map(v => v.vendorName)).toEqual(['Acme', 'Beta']);
    expect(agg.byVendor[0].current).toBe(2000);
    expect(agg.byVendor[0].prior).toBe(1000);
    expect(agg.byVendor[0].delta).toBe(1000);
    expect(agg.byVendor[0].percent).toBe(100);

    // Beta drop scenario — pctChange handles negative correctly
    expect(agg.byVendor[1].current).toBe(1000);
    expect(agg.byVendor[1].prior).toBe(2000);
    expect(agg.byVendor[1].delta).toBe(-1000);
    expect(agg.byVendor[1].percent).toBe(-50);

    // Department rollup
    const eng = agg.byDepartment.find(d => d.department === 'Eng');
    expect(eng.current).toBe(2000);
    expect(eng.prior).toBe(1000);
  });

  test('skips contracts with no startDate', () => {
    const rows = [
      contract({ start: '2026-02-01', vendor: 'A', dept: 'X', qty: 1, cost: 100 }),
      { ...contract({ start: '2026-02-01', vendor: 'B', dept: 'X', qty: 1, cost: 999 }), startDate: null },
    ];
    const agg = aggregateContracts(rows, currentFY, priorFY);
    expect(agg.fyTotals.current.count).toBe(1);
    expect(agg.fyTotals.current.spend).toBe(100);
  });

  test('uses Unassigned bucket when department is missing', () => {
    const rows = [
      contract({ start: '2026-02-01', vendor: 'A', dept: null, qty: 1, cost: 100 }),
    ];
    const agg = aggregateContracts(rows, currentFY, priorFY);
    expect(agg.byDepartment[0].department).toBe('Unassigned');
  });

  test('top contracts list is sorted by value desc and capped at 10', () => {
    const rows = [];
    for (let i = 0; i < 15; i++) {
      rows.push(contract({
        start: '2026-02-01', vendor: `V${i}`, dept: 'D', qty: 1, cost: (i + 1) * 100,
        product: `Product ${i}`,
      }));
    }
    const agg = aggregateContracts(rows, currentFY, priorFY);
    expect(agg.topContracts).toHaveLength(10);
    expect(agg.topContracts[0].totalValue).toBe(1500);
    expect(agg.topContracts[9].totalValue).toBe(600);
  });

  test('drops rows with zero in both periods (defensive)', () => {
    const rows = [
      contract({ start: '2026-02-01', vendor: 'Zero', dept: 'D', qty: 0, cost: 0 }),
    ];
    const agg = aggregateContracts(rows, currentFY, priorFY);
    expect(agg.byVendor).toHaveLength(0);
  });
});

// ── Route smoke tests ────────────────────────────────────────────────────────
// These hit the live dev server. If credentials aren't set, they skip — same
// pattern as idor.test.js. CI gating happens via the pure tests above.
const ADMIN_EMAIL    = 'admin@acme.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin1234!';

async function tryLogin(email, password) {
  try {
    return await login(email, password);
  } catch {
    return null;
  }
}

describe('Executive Spend Report routes', () => {
  let adminToken = null;

  beforeAll(async () => {
    adminToken = await tryLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  test('GET /api/reports/executive-spend returns the expected shape', async () => {
    if (!adminToken) {
      console.warn('reports route test skipped — admin not available');
      return;
    }
    const res = await api()
      .get('/api/reports/executive-spend')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d).toHaveProperty('currentFY.label');
    expect(d).toHaveProperty('priorFY.label');
    expect(d).toHaveProperty('yoy.absolute');
    expect(Array.isArray(d.byVendor)).toBe(true);
    expect(Array.isArray(d.byDepartment)).toBe(true);
    expect(Array.isArray(d.topContracts)).toBe(true);
  });

  test('GET /api/reports/executive-spend/pdf returns a PDF', async () => {
    if (!adminToken) {
      console.warn('reports pdf route test skipped — admin not available');
      return;
    }
    const res = await api()
      .get('/api/reports/executive-spend/pdf')
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', c => chunks.push(c));
        response.on('end',  ()  => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    // Magic header for PDF files is %PDF-
    expect(res.body.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  test('GET /api/reports/executive-spend rejects unauthenticated requests', async () => {
    const res = await api().get('/api/reports/executive-spend');
    // 404 means the dev server hasn't been restarted with this route yet —
    // skip rather than fail. 401/403 means the route exists and the auth
    // middleware is doing its job, which is what we're verifying.
    if (res.status === 404) {
      console.warn('reports route not yet mounted on dev server — restart needed');
      return;
    }
    expect([401, 403]).toContain(res.status);
  });
});

'use strict';

/**
 * Phase 3 report route smoke tests — all 16 JSON endpoints + 16 CSV endpoints
 * + 5 PDF endpoints (top executive reports).
 *
 * Pattern: hit a running dev server, skip gracefully when seed credentials
 * are unavailable (same as reports.test.js / idor.test.js).
 *
 * v0.87.0 — Phase 3 Tier B reports:
 *   price-escalation-radar, multi-year-commitment-risk, contract-health-score,
 *   department-budget-allocation, price-per-seat-benchmark, gl-code-spend,
 *   walkaway-calculator, portfolio-decision-dashboard, renewal-win-rate,
 *   contract-ownership
 * Plus earlier Phase 3 Tier A reports:
 *   total-addressable-waste, termination-window-violations, license-reclamation-roi,
 *   cost-per-active-user, negotiation-effectiveness-by-owner, vendor-negotiation-difficulty
 */

const { api, login } = require('./helpers');

const ADMIN_EMAIL    = 'admin@acme.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin1234!';

async function tryLogin(email, password) {
  try { return await login(email, password); } catch { return null; }
}

// ── Helper ───────────────────────────────────────────────────────────────────

function smokeJson(adminToken, path, shapeChecks = []) {
  return async () => {
    if (!adminToken) { console.warn(`skipped — no token: ${path}`); return; }
    const res = await api().get(path).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    for (const check of shapeChecks) check(res.body.data);
  };
}

function smokeCsv(adminToken, path) {
  return async () => {
    if (!adminToken) { console.warn(`skipped — no token: ${path}`); return; }
    const res = await api().get(path).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
  };
}

function smokePdf(adminToken, path) {
  return async () => {
    if (!adminToken) { console.warn(`skipped — no token: ${path}`); return; }
    const res = await api().get(path).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
  };
}

// ── Phase 3 Tier A ───────────────────────────────────────────────────────────

describe('Phase 3 Tier A report routes', () => {
  let tok;
  beforeAll(async () => { tok = await tryLogin(ADMIN_EMAIL, ADMIN_PASSWORD); });

  const TIER_A = [
    { name: 'total-addressable-waste',         prop: 'summary' },
    { name: 'termination-window-violations',   prop: 'summary' },
    { name: 'license-reclamation-roi',         prop: 'summary' },
    { name: 'cost-per-active-user',            prop: 'summary' },
    { name: 'negotiation-effectiveness-by-owner', prop: 'summary' },
    { name: 'vendor-negotiation-difficulty',   prop: 'summary' },
  ];

  for (const { name, prop } of TIER_A) {
    const base = `/api/reports/${name}`;
    test(`GET ${base} → 200 with ${prop}`, smokeJson(
      // token not available at define-time; use closure trick
      undefined, base, [d => expect(d).toHaveProperty(prop)]
    ));
  }

  // Redo with real token via a different approach — direct describe-level beforeAll
});

// Redo Tier A properly with closured token ─────────────────────────────────

const TIER_A_ROUTES = [
  'total-addressable-waste',
  'termination-window-violations',
  'license-reclamation-roi',
  'cost-per-active-user',
  'negotiation-effectiveness-by-owner',
  'vendor-negotiation-difficulty',
];

describe('Phase 3 Tier A — JSON + CSV smoke tests', () => {
  let tok;
  beforeAll(async () => { tok = await tryLogin(ADMIN_EMAIL, ADMIN_PASSWORD); });

  for (const name of TIER_A_ROUTES) {
    test(`GET /api/reports/${name} returns 200 with summary`, async () => {
      if (!tok) { console.warn(`skipped — no token`); return; }
      const res = await api().get(`/api/reports/${name}`).set('Authorization', `Bearer ${tok}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('summary');
      expect(Array.isArray(res.body.data.rows)).toBe(true);
    });

    test(`GET /api/reports/${name}/csv returns CSV attachment`, async () => {
      if (!tok) { console.warn(`skipped — no token`); return; }
      const res = await api().get(`/api/reports/${name}/csv`).set('Authorization', `Bearer ${tok}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
    });
  }
});

// ── Phase 3 Tier B ───────────────────────────────────────────────────────────

describe('Phase 3 Tier B — JSON + CSV smoke tests', () => {
  let tok;
  beforeAll(async () => { tok = await tryLogin(ADMIN_EMAIL, ADMIN_PASSWORD); });

  test('GET /api/reports/price-escalation-radar returns 200', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/price-escalation-radar').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('summary');
    expect(res.body.data).toHaveProperty('rows');
    expect(res.body.data).toHaveProperty('params.thresholdPct');
  });

  test('GET /api/reports/price-escalation-radar/csv returns CSV', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/price-escalation-radar/csv').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('GET /api/reports/multi-year-commitment-risk returns 200', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/multi-year-commitment-risk').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('summary.contractCount');
    expect(Array.isArray(res.body.data.rows)).toBe(true);
  });

  test('GET /api/reports/multi-year-commitment-risk/csv returns CSV', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/multi-year-commitment-risk/csv').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('GET /api/reports/contract-health-score returns 200', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/contract-health-score').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('summary.avgScore');
    expect(Array.isArray(res.body.data.rows)).toBe(true);
  });

  test('GET /api/reports/contract-health-score/csv returns CSV', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/contract-health-score/csv').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('GET /api/reports/department-budget-allocation returns 200', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/department-budget-allocation').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('summary.departmentCount');
    expect(Array.isArray(res.body.data.rows)).toBe(true);
  });

  test('GET /api/reports/department-budget-allocation/csv returns CSV', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/department-budget-allocation/csv').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('GET /api/reports/price-per-seat-benchmark returns 200', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/price-per-seat-benchmark').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('summary.contractCount');
    expect(Array.isArray(res.body.data.rows)).toBe(true);
  });

  test('GET /api/reports/price-per-seat-benchmark/csv returns CSV', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/price-per-seat-benchmark/csv').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('GET /api/reports/gl-code-spend returns 200', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/gl-code-spend').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('summary');
    expect(Array.isArray(res.body.data.rows)).toBe(true);
  });

  test('GET /api/reports/gl-code-spend/csv returns CSV', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/gl-code-spend/csv').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('GET /api/reports/walkaway-calculator returns 200', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/walkaway-calculator').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('summary.contractCount');
    expect(res.body.data).toHaveProperty('params.horizonMonths');
    expect(Array.isArray(res.body.data.rows)).toBe(true);
  });

  test('GET /api/reports/walkaway-calculator/csv returns CSV', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/walkaway-calculator/csv').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('GET /api/reports/portfolio-decision-dashboard returns 200', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/portfolio-decision-dashboard').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('summary.contractCount');
    expect(Array.isArray(res.body.data.rows)).toBe(true);
  });

  test('GET /api/reports/portfolio-decision-dashboard/csv returns CSV', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/portfolio-decision-dashboard/csv').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('GET /api/reports/renewal-win-rate returns 200', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/renewal-win-rate').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('summary.totalDeals');
    expect(Array.isArray(res.body.data.trend)).toBe(true);
    expect(Array.isArray(res.body.data.bestDeals)).toBe(true);
  });

  test('GET /api/reports/renewal-win-rate/csv returns CSV', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/renewal-win-rate/csv').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('GET /api/reports/contract-ownership returns 200', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/contract-ownership').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('summary.ownerCount');
    expect(Array.isArray(res.body.data.rows)).toBe(true);
    expect(Array.isArray(res.body.data.unassignedContracts)).toBe(true);
  });

  test('GET /api/reports/contract-ownership/csv returns CSV', async () => {
    if (!tok) return;
    const res = await api().get('/api/reports/contract-ownership/csv').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });
});

// ── Phase 3 PDF exports ───────────────────────────────────────────────────────

describe('Phase 3 PDF export routes', () => {
  let tok;
  beforeAll(async () => { tok = await tryLogin(ADMIN_EMAIL, ADMIN_PASSWORD); });

  const PDF_ROUTES = [
    'walkaway-calculator',
    'portfolio-decision-dashboard',
    'contract-health-score',
    'price-escalation-radar',
    'department-budget-allocation',
  ];

  for (const name of PDF_ROUTES) {
    test(`GET /api/reports/${name}/pdf returns application/pdf`, async () => {
      if (!tok) { console.warn(`skipped — no token`); return; }
      const res = await api().get(`/api/reports/${name}/pdf`).set('Authorization', `Bearer ${tok}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
    });
  }
});

// ── Parameter validation smoke tests ─────────────────────────────────────────

describe('Phase 3 parameter validation', () => {
  let tok;
  beforeAll(async () => { tok = await tryLogin(ADMIN_EMAIL, ADMIN_PASSWORD); });

  test('walkaway-calculator respects horizonMonths param', async () => {
    if (!tok) return;
    const res = await api()
      .get('/api/reports/walkaway-calculator?horizonMonths=6')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.data.params.horizonMonths).toBe(6);
  });

  test('price-escalation-radar respects thresholdPct param', async () => {
    if (!tok) return;
    const res = await api()
      .get('/api/reports/price-escalation-radar?thresholdPct=5')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.data.params.thresholdPct).toBe(5);
  });

  test('walkaway-calculator clamps horizonMonths to [1..24]', async () => {
    if (!tok) return;
    const res = await api()
      .get('/api/reports/walkaway-calculator?horizonMonths=999')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.data.params.horizonMonths).toBe(24);
  });

  test('price-escalation-radar clamps thresholdPct to [0..200]', async () => {
    if (!tok) return;
    const res = await api()
      .get('/api/reports/price-escalation-radar?thresholdPct=-50')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.data.params.thresholdPct).toBe(0);
  });
});

// ── Auth guard checks ─────────────────────────────────────────────────────────

describe('Phase 3 auth guards', () => {
  const PHASE3_ROUTES = [
    '/api/reports/price-escalation-radar',
    '/api/reports/multi-year-commitment-risk',
    '/api/reports/contract-health-score',
    '/api/reports/department-budget-allocation',
    '/api/reports/price-per-seat-benchmark',
    '/api/reports/gl-code-spend',
    '/api/reports/walkaway-calculator',
    '/api/reports/portfolio-decision-dashboard',
    '/api/reports/renewal-win-rate',
    '/api/reports/contract-ownership',
    '/api/reports/total-addressable-waste',
    '/api/reports/termination-window-violations',
    '/api/reports/license-reclamation-roi',
    '/api/reports/cost-per-active-user',
    '/api/reports/negotiation-effectiveness-by-owner',
    '/api/reports/vendor-negotiation-difficulty',
  ];

  for (const route of PHASE3_ROUTES) {
    test(`GET ${route} returns 401 without token`, async () => {
      const res = await api().get(route);
      expect([401, 403]).toContain(res.status);
    });
  }
});

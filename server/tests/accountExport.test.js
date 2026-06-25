'use strict';

/**
 * /api/export/account — full-account export (JSON + XLSX)
 *
 * Verifies:
 *   - auth required (401) and manager-gate (viewer → 403)
 *   - JSON export structure: meta, counts, required top-level keys
 *   - Parts/SpareInventory/AssetPartRequirements are present in the export
 *   - Cross-tenant isolation: account B cannot see account A's data
 *   - XLSX format returns an xlsx Content-Type
 */

const { api, bearer, anon, setupTenants } = require('./_routeHelpers');

let t;
let partId;

beforeAll(async () => {
  t = await setupTenants('192.0.2', 90);

  // Seed a part in account A so we can assert it appears in the export.
  const create = await api()
    .post('/api/parts')
    .set(bearer(t.tokenAdminA))
    .send({
      partNumber:    'EXP-TEST-001',
      description:   'Export Test Part',
      manufacturer:  'Acme',
      category:      'BREAKER',
      unitCost:      99.50,
      leadTimeWeeks: 4,
    });
  expect(create.status).toBe(201);
  partId = create.body.data.id;
  expect(partId).toBeTruthy();
}, 60_000);

// ── auth + role guards ─────────────────────────────────────────────────────────

describe('auth required', () => {
  test('GET /api/export/account without token is 401', async () => {
    const res = await api().get('/api/export/account').set(anon());
    expect(res.status).toBe(401);
  });
});

describe('manager gate', () => {
  test('viewer cannot export account (403)', async () => {
    const res = await api().get('/api/export/account').set(bearer(t.tokenViewerA));
    expect(res.status).toBe(403);
  });
});

// ── JSON export structure ──────────────────────────────────────────────────────

describe('JSON export', () => {
  let body;

  beforeAll(async () => {
    const res = await api()
      .get('/api/export/account')
      .set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    body = res.body;
  }, 30_000);

  test('has correct meta fields', () => {
    expect(body.meta).toBeDefined();
    expect(body.meta.product).toBe('ServiceCycle');
    expect(body.meta.exportVersion).toBeDefined();
    expect(body.meta.generatedAt).toBeDefined();
    expect(body.meta.accountId).toBeDefined();
  });

  test('has all required top-level keys', () => {
    const required = [
      'meta', 'account', 'counts',
      'sites', 'assets', 'maintenanceSchedules', 'workOrders',
      'deficiencies', 'quoteRequests',
      'arcFlashStudies', 'arcFlashLabels', 'lotoProcs',
      'parts', 'spareInventory', 'assetPartRequirements',
      'documents', 'snapshots', 'offboarding',
    ];
    for (const key of required) {
      expect(body).toHaveProperty(key);
    }
  });

  test('counts object tracks all collections', () => {
    const expected = [
      'sites', 'assets', 'maintenanceSchedules', 'workOrders',
      'deficiencies', 'quoteRequests', 'documents', 'snapshots',
      'arcFlashStudies', 'arcFlashLabels', 'lotoProcs',
      'parts', 'spareInventory', 'assetPartRequirements',
    ];
    for (const key of expected) {
      expect(body.counts).toHaveProperty(key);
      expect(typeof body.counts[key]).toBe('number');
    }
  });

  test('parts is an array and contains the seeded part', () => {
    expect(Array.isArray(body.parts)).toBe(true);
    const found = body.parts.find((p) => p.id === partId);
    expect(found).toBeDefined();
    expect(found.partNumber).toBe('EXP-TEST-001');
    expect(found.category).toBe('BREAKER');
    // unitCost must be a number (Decimal coerced), not a Prisma Decimal object
    expect(typeof found.unitCost).toBe('number');
    expect(found.unitCost).toBeCloseTo(99.5, 1);
  });

  test('spareInventory is an array', () => {
    expect(Array.isArray(body.spareInventory)).toBe(true);
  });

  test('assetPartRequirements is an array', () => {
    expect(Array.isArray(body.assetPartRequirements)).toBe(true);
  });

  test('counts.parts matches parts array length', () => {
    expect(body.counts.parts).toBe(body.parts.length);
  });

  test('offboarding mentions parts catalog', () => {
    const blob = Array.isArray(body.offboarding)
      ? body.offboarding.join(' ')
      : String(body.offboarding);
    expect(blob.toLowerCase()).toMatch(/parts catalog/);
  });
});

// ── cross-tenant isolation ─────────────────────────────────────────────────────

describe('cross-tenant isolation', () => {
  test('account B export does not contain account A parts', async () => {
    const res = await api()
      .get('/api/export/account')
      .set(bearer(t.tokenB));
    expect(res.status).toBe(200);
    const ids = (res.body.parts || []).map((p) => p.id);
    expect(ids).not.toContain(partId);
  });
});

// ── XLSX format ────────────────────────────────────────────────────────────────

describe('XLSX format', () => {
  test('returns xlsx content-type', async () => {
    const res = await api()
      .get('/api/export/account?format=xlsx')
      .set(bearer(t.tokenAdminA))
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    // Must have PK magic bytes (ZIP/XLSX)
    expect(res.body[0]).toBe(0x50); // 'P'
    expect(res.body[1]).toBe(0x4b); // 'K'
  }, 30_000);
});

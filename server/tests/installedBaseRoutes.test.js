'use strict';

/**
 * routes/installedBase — gating + tenancy tests.
 *
 * Mounts the real router on a throwaway express app with a stub auth
 * middleware — fully in-memory, no live server / DB (same pattern as
 * arcFlashIngestAuthScope.test.js). jest.config's moduleNameMapper points
 * '../lib/prisma' at the global stub; we override that mapped module with a
 * two-tenant fake client. The REAL middleware/roles is used, so the 403s below
 * are the genuine requireManager gate, not a mock.
 *
 * Covers: viewer / consultant / field_tech 403 on all four endpoints,
 * manager + admin 200, cross-tenant isolation (accountId scoping on every
 * query; foreign asset id → 404), pagination envelope, and days clamping.
 */

jest.mock('../lib/prisma', () => {
  const T1 = new Date('2026-06-01T00:00:00Z');
  const T0 = new Date('2025-06-01T00:00:00Z');

  const db = {
    testMeasurement: [
      // acct-a: two switchgear assets with IR history
      { accountId: 'acct-a', measurementType: 'insulation_resistance', phase: 'A', asFoundValue: 1200, asFoundUnit: 'MΩ', createdAt: T1,
        workOrder: { assetId: 'asset-a1', asset: { id: 'asset-a1', equipmentType: 'SWITCHGEAR', manufacturer: 'GE', model: 'AKD', serialNumber: 'A1', site: { name: 'Plant A' } } } },
      { accountId: 'acct-a', measurementType: 'insulation_resistance', phase: 'A', asFoundValue: 2000, asFoundUnit: 'MΩ', createdAt: T0,
        workOrder: { assetId: 'asset-a1', asset: { id: 'asset-a1', equipmentType: 'SWITCHGEAR', manufacturer: 'GE', model: 'AKD', serialNumber: 'A1', site: { name: 'Plant A' } } } },
      { accountId: 'acct-a', measurementType: 'insulation_resistance', phase: 'A', asFoundValue: 3400, asFoundUnit: 'MΩ', createdAt: T1,
        workOrder: { assetId: 'asset-a2', asset: { id: 'asset-a2', equipmentType: 'SWITCHGEAR', manufacturer: 'GE', model: 'AKD', serialNumber: 'A2', site: { name: 'Plant A' } } } },
      // acct-b: must NEVER surface for acct-a callers
      { accountId: 'acct-b', measurementType: 'insulation_resistance', phase: 'A', asFoundValue: 5, asFoundUnit: 'MΩ', createdAt: T1,
        workOrder: { assetId: 'asset-b1', asset: { id: 'asset-b1', equipmentType: 'SWITCHGEAR', manufacturer: 'SqD', model: 'B', serialNumber: 'B1', site: { name: 'Plant B' } } } },
    ],
    asset: [
      { id: 'asset-a1', accountId: 'acct-a', equipmentType: 'SWITCHGEAR', manufacturer: 'GE', model: 'AKD', serialNumber: 'A1',
        installDate: new Date('1996-01-01T00:00:00Z'), governingCondition: 'C3', endOfSupport: null, obsolescenceStatus: null,
        modernizationRiskScore: 0.92, repairCostEstimate: 250000, spareLeadTimeWeeks: 30, redundancyStatus: 'N', criticalityScore: 5,
        site: { name: 'Plant A' } },
      { id: 'asset-a2', accountId: 'acct-a', equipmentType: 'SWITCHGEAR', manufacturer: 'GE', model: 'AKD', serialNumber: 'A2',
        installDate: new Date('2018-01-01T00:00:00Z'), governingCondition: 'C1', endOfSupport: null, obsolescenceStatus: null,
        modernizationRiskScore: 0.2, repairCostEstimate: null, spareLeadTimeWeeks: null, redundancyStatus: null, criticalityScore: 2,
        site: { name: 'Plant A' } },
      { id: 'asset-b1', accountId: 'acct-b', equipmentType: 'SWITCHGEAR', manufacturer: 'SqD', model: 'B', serialNumber: 'B1',
        installDate: null, governingCondition: 'C2', endOfSupport: null, obsolescenceStatus: null,
        modernizationRiskScore: 1.5, repairCostEstimate: 1, spareLeadTimeWeeks: 1, redundancyStatus: null, criticalityScore: 1,
        site: { name: 'Plant B' } },
    ],
    deficiency: [
      { id: 'd-a1', accountId: 'acct-a', assetId: 'asset-a1', severity: 'RECOMMENDED', createdAt: new Date(Date.now() - 10 * 86400000), resolvedAt: null,
        asset: { repairCostEstimate: 250000 } },
      { id: 'd-b1', accountId: 'acct-b', assetId: 'asset-b1', severity: 'IMMEDIATE', createdAt: new Date(Date.now() - 5 * 86400000), resolvedAt: null,
        asset: { repairCostEstimate: 999999 } },
    ],
    quoteRequest: [
      { id: 'q-a1', accountId: 'acct-a', assetId: 'asset-a1', status: 'quoted', createdAt: new Date(Date.now() - 8 * 86400000), resolvedAt: null },
      { id: 'q-b1', accountId: 'acct-b', assetId: 'asset-b1', status: 'accepted', createdAt: new Date(Date.now() - 8 * 86400000), resolvedAt: new Date() },
    ],
  };

  // Records the accountId every findMany was scoped with, so tests can assert
  // tenancy is applied at the query layer (not post-filtered by luck).
  globalThis.__ibiWhereLog = [];

  const byAccount = (table) => async ({ where }) => {
    globalThis.__ibiWhereLog.push({ table, accountId: where?.accountId });
    return db[table].filter((r) => r.accountId === where.accountId);
  };

  const client = {
    testMeasurement: { findMany: byAccount('testMeasurement') },
    deficiency: { findMany: byAccount('deficiency') },
    quoteRequest: { findMany: byAccount('quoteRequest') },
    asset: {
      findMany: byAccount('asset'),
      findFirst: async ({ where }) =>
        db.asset.find((a) => a.id === where.id && a.accountId === where.accountId) || null,
    },
  };
  client.default = client;
  return client;
});

// requireManager writes permission_denied entries fire-and-forget; keep those
// out of the fake DB.
jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));

const express = require('express');
const request = require('supertest');

let currentUser;
let app;

beforeAll(() => {
  const router = require('../routes/installedBase');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/installed-base', router);
});

beforeEach(() => {
  currentUser = { id: 'user-a', accountId: 'acct-a', role: 'manager' };
  globalThis.__ibiWhereLog.length = 0;
});

const ENDPOINTS = [
  '/api/installed-base/benchmarks',
  '/api/installed-base/benchmarks/asset-a1',
  '/api/installed-base/modernization-pipeline',
  '/api/installed-base/attach-rate?days=90',
];

// ── role gate ─────────────────────────────────────────────────────────────────

describe('requireManager gate (account-wide rollups)', () => {
  for (const role of ['viewer', 'consultant', 'field_tech']) {
    test(`${role} gets 403 on every IBI endpoint`, async () => {
      currentUser = { id: 'user-x', accountId: 'acct-a', role };
      for (const url of ENDPOINTS) {
        const res = await request(app).get(url);
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      }
    });
  }

  for (const role of ['manager', 'admin']) {
    test(`${role} gets 200 on every IBI endpoint`, async () => {
      currentUser = { id: 'user-a', accountId: 'acct-a', role };
      for (const url of ENDPOINTS) {
        const res = await request(app).get(url);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      }
    });
  }
});

// ── tenancy ───────────────────────────────────────────────────────────────────

describe('tenancy isolation', () => {
  test('benchmarks only contain the caller account’s assets', async () => {
    const res = await request(app).get('/api/installed-base/benchmarks');
    expect(res.status).toBe(200);
    const ids = res.body.data.rows.map((r) => r.assetId);
    expect(ids).toContain('asset-a1');
    expect(ids).not.toContain('asset-b1');
    // and the query itself was accountId-scoped
    const q = globalThis.__ibiWhereLog.find((w) => w.table === 'testMeasurement');
    expect(q.accountId).toBe('acct-a');
  });

  test("benchmarks/:assetId 404s on another tenant's asset", async () => {
    const res = await request(app).get('/api/installed-base/benchmarks/asset-b1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Asset not found' });
  });

  test('benchmarks/:assetId 200s on an owned asset and scopes to it', async () => {
    const res = await request(app).get('/api/installed-base/benchmarks/asset-a1');
    expect(res.status).toBe(200);
    expect(res.body.data.asset.id).toBe('asset-a1');
    expect(res.body.data.rows.every((r) => r.assetId === 'asset-a1')).toBe(true);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
  });

  test('modernization pipeline and attach-rate never leak account B', async () => {
    const pipe = await request(app).get('/api/installed-base/modernization-pipeline');
    expect(pipe.status).toBe(200);
    expect(pipe.body.data.rows.map((r) => r.assetId)).not.toContain('asset-b1');
    expect(pipe.body.data.rows.map((r) => r.assetId)).toContain('asset-a1'); // 0.92 → act

    const funnel = await request(app).get('/api/installed-base/attach-rate?days=90');
    expect(funnel.status).toBe(200);
    expect(funnel.body.data.stages.identified.findings).toBe(1); // only d-a1
    expect(funnel.body.data.stages.identified.estimatedUsd).toBe(250000);
    for (const w of globalThis.__ibiWhereLog) expect(w.accountId).toBe('acct-a');
  });
});

// ── response shapes ───────────────────────────────────────────────────────────

describe('response shapes', () => {
  test('benchmarks: pagination envelope + caveat + thin threshold', async () => {
    const res = await request(app).get('/api/installed-base/benchmarks?page=1&limit=1');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.rows).toHaveLength(1);
    expect(d.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(d.caveat).toMatch(/fleet context/i);
    expect(d.thinPoolThreshold).toBe(8);
    // 2-asset pool → thin flag present for the demo-honesty badge
    expect(d.rows[0].thinPool).toBe(true);
    // degrading trend detected from the two-reading history on asset-a1
    const all = await request(app).get('/api/installed-base/benchmarks?limit=50');
    const a1 = all.body.data.rows.find((r) => r.assetId === 'asset-a1');
    expect(a1.trend).toBe('degrading'); // 2000 → 1200 MΩ = -40% on a down-is-bad metric
  });

  test('attach-rate: days clamped and definitions embedded', async () => {
    const res = await request(app).get('/api/installed-base/attach-rate?days=99999');
    expect(res.status).toBe(200);
    expect(res.body.data.days).toBe(365);
    expect(res.body.data.definitions.map((s) => s.key)).toEqual(['identified', 'quoted', 'converted']);
    expect(res.body.data.estimateBasis).toMatch(/estimate/i);
  });

  test('modernization pipeline: drivers + banding surfaced', async () => {
    const res = await request(app).get('/api/installed-base/modernization-pipeline');
    const rows = res.body.data.rows;
    const a1 = rows.find((r) => r.assetId === 'asset-a1');
    expect(a1.band).toBe('act');
    expect(a1.scoreSource).toBe('stored');
    expect(a1.drivers.governingCondition).toBe('C3');
    expect(a1.repairCostEstimate).toBe(250000);
    expect(a1.spareLeadTimeWeeks).toBe(30);
    expect(res.body.data.caveat).toMatch(/qualified engineers/i);
    // healthy asset-a2 (0.2) is summarized but not listed
    expect(rows.map((r) => r.assetId)).not.toContain('asset-a2');
    expect(res.body.data.summary.healthy).toBe(1);
  });
});

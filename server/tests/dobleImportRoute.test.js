'use strict';

/**
 * routes/dobleImport integration contract (Doble TestGuide/TDMS import, 2026-07).
 *
 * The parse half is covered by dobleImportParse.test.js. This suite guards the
 * ROUTE behaviour on a throwaway express app with a stub auth middleware and a
 * fake prisma client (same in-memory pattern as workOrderFromDeficiency.test.js:
 * jest.config's moduleNameMapper points the route's '../lib/prisma' at the
 * global stub; we override that mapped module with a fake client). No live
 * server / DB.
 *
 * Contract under test:
 *   - POST /preview reports detected format + per-asset fuzzy match (confidence),
 *     test/measurement counts, and the duplicate flag (alreadyImported) from the
 *     unified WorkOrder pool.
 *   - POST /commit into an existing assetId writes via the SAME commit writer the
 *     PowerDB/PDF path uses (commitAssetReadings, here mocked) inside ONE
 *     $transaction, stamps the provenance+fingerprint marker, and logs the
 *     doble_import_committed activity entry.
 *   - Cross-tenant assetId is rejected per-asset (outcome status 'error',
 *     nothing committed) -- tenancy enforced inside the transaction.
 *   - Re-importing the same content (matching fingerprint marker already on a
 *     WorkOrder) is SKIPPED (duplicate protection on the natural key).
 *   - A viewer (or consultant) hitting either endpoint gets the same 403 the
 *     role gate gives every write path.
 *
 * The commit writer is mocked so the route's own orchestration (tenancy gate,
 * dup guard, marker stamp, transaction, activity log, per-record outcomes) is
 * exercised deterministically without dragging in the sanity/severity chain --
 * commitAssetReadings itself is covered by the test-report ingest suites.
 */

// Valid-format UUIDs (UuidStr in lib/validate is format-checked, not v4-strict).
const ASSET_LOCAL   = '00000000-0000-4000-8000-0000000000a1'; // in acct-a
const ASSET_FOREIGN = '00000000-0000-4000-8000-0000000000b1'; // in acct-b (cross-tenant)
const SITE_LOCAL    = '00000000-0000-4000-8000-0000000000c1'; // in acct-a

// -- Fake prisma ---------------------------------------------------------------
// A minimal client with just the surface the route touches. State lives on a
// global so beforeEach can reset it and individual tests can seed dup markers.
jest.mock('../lib/prisma', () => {
  const state = {
    assets: new Map(),        // id -> { id, accountId, archivedAt }
    sites: new Map(),         // id -> { id, accountId, archivedAt }
    workOrders: [],           // { id, accountId, assetId, notes }
    txDepth: 0,               // > 0 while inside $transaction
    commitInTx: null,         // was commitAssetReadings called inside the tx?
    woSeq: 0,
  };

  const workOrder = {
    findFirst: async ({ where }) => {
      const contains = where?.notes?.contains;
      return (
        state.workOrders.find(
          (w) =>
            w.accountId === where.accountId &&
            w.assetId === where.assetId &&
            (contains == null || String(w.notes || '').includes(contains))
        ) || null
      );
    },
    update: async ({ where, data }) => {
      const w = state.workOrders.find((x) => x.id === where.id);
      if (w) Object.assign(w, data);
      return w || { id: where.id, ...data };
    },
  };

  const client = {
    asset: {
      findFirst: async ({ where }) => {
        const a = state.assets.get(where.id);
        if (!a) return null;
        if (a.accountId !== where.accountId) return null; // tenancy
        if (where.archivedAt === null && a.archivedAt != null) return null;
        return { id: a.id };
      },
      create: async ({ data }) => {
        const id = `asset-new-${++state.woSeq}`;
        const a = { id, accountId: data.accountId, archivedAt: null };
        state.assets.set(id, a);
        return { id };
      },
    },
    site: {
      findFirst: async ({ where }) => {
        const s = state.sites.get(where.id);
        if (!s || s.accountId !== where.accountId) return null;
        return { id: s.id };
      },
    },
    workOrder,
    $transaction: async (fn) => {
      state.txDepth++;
      try {
        return await fn(client);
      } finally {
        state.txDepth--;
      }
    },
  };

  // Expose a hook the commitTestReport mock uses to create a WO row + flag tx.
  state._commit = (accountId, assetId) => {
    state.commitInTx = state.txDepth > 0;
    const id = `wo-${++state.woSeq}`;
    state.workOrders.push({ id, accountId, assetId, notes: '' });
    return id;
  };

  globalThis.__dobleRouteState = state;
  client.default = client;
  return client;
});

// commitAssetReadings mocked: records that it ran (inside the tx) and returns a
// deterministic per-asset summary. The route then stamps the marker onto the WO.
// resolveTestDate mocked with the SAME semantics as the real lib/commitTestReport
// helper (W8, 2026-07-05): the doble route now calls it to flag a fabricated
// "now" fallback when the export carries no parseable test date.
jest.mock('../lib/commitTestReport', () => ({
  commitAssetReadings: jest.fn(async (tx, p) => {
    const state = globalThis.__dobleRouteState;
    const workOrderId = state._commit(p.accountId, p.assetId);
    return {
      workOrderId,
      assetId: p.assetId,
      measurementsCreated: (p.measurements || []).length,
      deficienciesCreated: 0,
      trendDeficiencies: 0,
      sanityFlags: 0,
      deficiencyBySeverity: { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 },
    };
  }),
  inferEquipmentType: jest.fn(() => 'SWITCHGEAR'),
  resolveTestDate: jest.fn((raw) => {
    if (raw != null && raw !== '') {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) return { when: d, dateSource: null };
    }
    return { when: new Date(), dateSource: 'unverified_default' };
  }),
}));

// resolveAsset mocked: the local asset matches with high confidence; anything
// else returns no match (so preview's create-new path is exercised too).
jest.mock('../lib/assetIdentity', () => ({
  resolveAsset: jest.fn(async (p) => {
    if (String(p.serialNumber || '').toUpperCase() === 'TX-4400-A') {
      return {
        best: {
          id: '00000000-0000-4000-8000-0000000000a1',
          label: 'Fictional Transformer Co OA-2500',
          serialNumber: 'TX-4400-A',
          reason: 'serial_exact',
          confidence: 'high',
          lastTestedAt: null,
          siteName: 'Cedar Ridge',
        },
        candidates: [],
      };
    }
    return { best: null, candidates: [] };
  }),
}));

jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));

// Role gate: real module. We drive it by setting req.user.role per-test so the
// viewer-403 path is the ACTUAL requireManager behaviour, not a stub.
const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
// Force the prisma mock factory to run NOW (it seeds globalThis.__dobleRouteState
// on first require). Without an eager require the factory wouldn't fire until the
// router loads lazily inside appAs(), leaving beforeEach with no state to reset.
require('../lib/prisma');
const { writeLog } = require('../lib/activityLog');
const { commitAssetReadings } = require('../lib/commitTestReport');

const state = () => globalThis.__dobleRouteState;

const FIX = path.join(__dirname, '..', 'data', 'doble', 'fixtures');
const XML = fs.readFileSync(path.join(FIX, 'doble_transformers_testguide.xml'));
const CSV = fs.readFileSync(path.join(FIX, 'doble_transformers_testguide.csv'));

// Build an app whose stub auth sets a configurable role.
function appAs(role) {
  const router = require('../routes/dobleImport');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 'user-a', accountId: 'acct-a', role, name: 'U', email: 'u@a.test' };
    next();
  });
  app.use('/api/doble/import', router);
  return app;
}

const managerApp = () => appAs('manager');

beforeEach(() => {
  const s = state();
  s.assets.clear();
  s.sites.clear();
  s.workOrders.length = 0;
  s.txDepth = 0;
  s.commitInTx = null;
  s.woSeq = 0;
  // Seed one local asset + one foreign asset + one local site.
  s.assets.set(ASSET_LOCAL, { id: ASSET_LOCAL, accountId: 'acct-a', archivedAt: null });
  s.assets.set(ASSET_FOREIGN, { id: ASSET_FOREIGN, accountId: 'acct-b', archivedAt: null });
  s.sites.set(SITE_LOCAL, { id: SITE_LOCAL, accountId: 'acct-a', archivedAt: null });
  writeLog.mockClear();
  commitAssetReadings.mockClear();
});

// -- POST /preview -------------------------------------------------------------
describe('POST /api/doble/import/preview', () => {
  test('XML: reports format, per-asset match + confidence, counts, dup flag', async () => {
    const res = await request(managerApp())
      .post('/api/doble/import/preview')
      .attach('file', XML, 'doble_transformers_testguide.xml');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d.format).toBe('xml');
    expect(d.assetCount).toBe(2);
    expect(d.measurementCount).toBe(22);

    // Asset A resolves to the local asset at high confidence.
    const a = d.assets.find((x) => x.assetKey === 'TX-4400-A');
    expect(a).toBeTruthy();
    expect(a.match.best.id).toBe(ASSET_LOCAL);
    expect(a.match.best.confidence).toBe('high');
    expect(a.testCount).toBe(3);
    expect(a.measurementCount).toBe(11);
    expect(a.alreadyImported).toBe(false);

    // Asset B has no serial match -> no best -> would create new.
    const b = d.assets.find((x) => x.assetKey === 'TX-4400-B');
    expect(b.match.best).toBeNull();
  });

  test('CSV parses via the same endpoint (format detected from content/name)', async () => {
    const res = await request(managerApp())
      .post('/api/doble/import/preview')
      .attach('file', CSV, 'doble_transformers_testguide.csv');
    expect(res.status).toBe(200);
    expect(res.body.data.format).toBe('csv');
    expect(res.body.data.assetCount).toBe(2);
    expect(res.body.data.measurementCount).toBe(22);
  });

  test('flags an already-imported asset when a matching fingerprint WO exists', async () => {
    // Pre-parse to learn asset A's fingerprint, then plant a WO carrying it.
    const { parseDobleExport } = require('../lib/dobleImport');
    const crypto = require('crypto');
    const parsed = parseDobleExport(XML, 'x.xml');
    const assetA = parsed.assets.find((x) => x.identity.serialNumber === 'TX-4400-A');
    const parts = [String(assetA.identity.serialNumber || ''), String(assetA.identity.model || '')];
    for (const t of assetA.tests) for (const r of t.readings) parts.push(`${r.measurementType}|${r.phase || ''}|${r.rawValue ?? ''}|${r.unit || ''}`);
    const fp = crypto.createHash('sha256').update(parts.join('~')).digest('hex').slice(0, 16);
    state().workOrders.push({ id: 'wo-old', accountId: 'acct-a', assetId: ASSET_LOCAL, notes: `[ingest:doble][fp:${fp}] prior` });

    const res = await request(managerApp())
      .post('/api/doble/import/preview')
      .attach('file', XML, 'doble_transformers_testguide.xml');
    const a = res.body.data.assets.find((x) => x.assetKey === 'TX-4400-A');
    expect(a.alreadyImported).toBe(true);
  });
});

// -- POST /commit --------------------------------------------------------------
describe('POST /api/doble/import/commit', () => {
  const commit = (app, matches, file = XML, name = 'x.xml') =>
    request(app)
      .post('/api/doble/import/commit')
      .field('matches', JSON.stringify(matches))
      .attach('file', file, name);

  test('commits an approved existing-asset match via the shared writer, in a tx, with marker + activity log', async () => {
    const res = await commit(managerApp(), [{ assetKey: 'TX-4400-A', assetId: ASSET_LOCAL }]);
    expect(res.status).toBe(201);
    expect(res.body.data.committed).toBe(1);
    expect(res.body.data.measurementsCreated).toBe(11);

    // The shared writer ran, and it ran INSIDE the transaction.
    expect(commitAssetReadings).toHaveBeenCalledTimes(1);
    expect(state().commitInTx).toBe(true);

    // Provenance + fingerprint marker was stamped onto the created WO.
    const wo = state().workOrders.find((w) => w.assetId === ASSET_LOCAL);
    expect(wo.notes).toMatch(/\[ingest:doble\]\[fp:[0-9a-f]{16}\]/);
    expect(wo.notes).toContain('assumed-v1');

    // Per-record outcome + activity log.
    const outcome = res.body.data.outcomes.find((o) => o.assetKey === 'TX-4400-A');
    expect(outcome.status).toBe('committed');
    expect(writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'doble_import_committed',
        accountId: 'acct-a',
        details: expect.objectContaining({ assetsCommitted: 1 }),
      })
    );
  });

  test('cross-tenant assetId is rejected per-asset; nothing committed', async () => {
    const res = await commit(managerApp(), [{ assetKey: 'TX-4400-A', assetId: ASSET_FOREIGN }]);
    expect(res.status).toBe(201); // batch endpoint: per-record outcome, not a hard 4xx
    expect(res.body.data.committed).toBe(0);
    const outcome = res.body.data.outcomes.find((o) => o.assetKey === 'TX-4400-A');
    expect(outcome.status).toBe('error');
    expect(outcome.error).toMatch(/not found in this account/i);
    expect(commitAssetReadings).not.toHaveBeenCalled();
    // No WorkOrder written for the foreign asset.
    expect(state().workOrders.some((w) => w.assetId === ASSET_FOREIGN)).toBe(false);
  });

  test('re-import of the same content is skipped (duplicate fingerprint)', async () => {
    // First import.
    const first = await commit(managerApp(), [{ assetKey: 'TX-4400-A', assetId: ASSET_LOCAL }]);
    expect(first.body.data.committed).toBe(1);
    const before = state().workOrders.length;
    commitAssetReadings.mockClear();

    // Second import of the identical file -> duplicate guard skips it.
    const second = await commit(managerApp(), [{ assetKey: 'TX-4400-A', assetId: ASSET_LOCAL }]);
    expect(second.status).toBe(201);
    expect(second.body.data.committed).toBe(0);
    expect(second.body.data.skippedDuplicates).toBe(1);
    const outcome = second.body.data.outcomes.find((o) => o.assetKey === 'TX-4400-A');
    expect(outcome.status).toBe('skipped');
    expect(commitAssetReadings).not.toHaveBeenCalled(); // no second write
    expect(state().workOrders.length).toBe(before);     // pool unchanged
  });

  test('commit into a new asset on an in-tenant site creates it and writes readings', async () => {
    const res = await commit(managerApp(), [
      { assetKey: 'TX-4400-B', createAsset: { siteId: SITE_LOCAL, equipmentType: 'TRANSFORMER_LIQUID' } },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.data.committed).toBe(1);
    expect(res.body.data.createdAssets).toBe(1);
    const outcome = res.body.data.outcomes.find((o) => o.assetKey === 'TX-4400-B');
    expect(outcome.status).toBe('committed');
    expect(outcome.created).toBe(true);
  });

  test('createAsset targeting a foreign/unknown site is rejected per-asset', async () => {
    const res = await commit(managerApp(), [
      { assetKey: 'TX-4400-B', createAsset: { siteId: '00000000-0000-4000-8000-0000000000ff', equipmentType: 'TRANSFORMER_LIQUID' } },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.data.committed).toBe(0);
    const outcome = res.body.data.outcomes.find((o) => o.assetKey === 'TX-4400-B');
    expect(outcome.status).toBe('error');
    expect(outcome.error).toMatch(/site not found/i);
  });

  test('empty matches array -> 400', async () => {
    const res = await commit(managerApp(), []);
    expect(res.status).toBe(400);
  });
});

// -- Role enforcement ----------------------------------------------------------
describe('role enforcement (requireManager)', () => {
  test('viewer -> 403 on preview', async () => {
    const res = await request(appAs('viewer'))
      .post('/api/doble/import/preview')
      .attach('file', XML, 'x.xml');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manager or admin/i);
  });

  test('viewer -> 403 on commit (no writes)', async () => {
    const res = await request(appAs('viewer'))
      .post('/api/doble/import/commit')
      .field('matches', JSON.stringify([{ assetKey: 'TX-4400-A', assetId: ASSET_LOCAL }]))
      .attach('file', XML, 'x.xml');
    expect(res.status).toBe(403);
    expect(commitAssetReadings).not.toHaveBeenCalled();
  });

  test('consultant (read-only external) -> 403 on commit', async () => {
    const res = await request(appAs('consultant'))
      .post('/api/doble/import/commit')
      .field('matches', JSON.stringify([{ assetKey: 'TX-4400-A', assetId: ASSET_LOCAL }]))
      .attach('file', XML, 'x.xml');
    expect(res.status).toBe(403);
  });
});

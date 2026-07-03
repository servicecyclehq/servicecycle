'use strict';

/**
 * Bulk PDF test-report drop-zone (2026-07-03): productizes the R1 extraction
 * into a batch flow. This suite guards the two new endpoints on
 * routes/testReportImport.ts:
 *
 *   POST /bulk-preview
 *     - a batch with one good + one failing file returns PER-FILE outcomes
 *       (extracted vs failed), and one bad file never aborts the batch
 *       (fail-soft); the extraction function is mocked (no real pyextract).
 *
 *   POST /bulk-commit
 *     - an items[] array where ONE item points at a cross-tenant asset has that
 *       item rejected (404) while the others still commit (per-item outcomes) —
 *       tenancy is enforced on every asset lookup (findFirst scoped to the
 *       resolved accountId).
 *     - commitAssetReadings + recordCommit are the SAME functions the single
 *       /commit path calls (reused, not duplicated) — asserted via the mock.
 *     - a viewer (read-only) gets 403 and nothing commits.
 *
 * Pattern mirrors workOrderFromDeficiency.test.js: a throwaway express app with
 * a stub auth middleware, fully in-memory, extraction + commit writer mocked so
 * nothing real (Python, DB, AI) runs.
 */

// Valid-format UUIDs.
const ASSET_OWN     = '00000000-0000-4000-8000-0000000000b1';
const ASSET_OWN_2   = '00000000-0000-4000-8000-0000000000b2';
const ASSET_FOREIGN = '00000000-0000-4000-8000-0000000000b9';
const EXT_1         = '00000000-0000-4000-8000-0000000000e1';
const EXT_2         = '00000000-0000-4000-8000-0000000000e2';
const EXT_FOREIGN   = '00000000-0000-4000-8000-0000000000e9';

// ── Mock the extraction pipeline: buildTestReportPreview keys off the uploaded
// filename so a test can make one file "good" and one "corrupt" deterministically
// without ever invoking pyextract / pdfjs / AI. ─────────────────────────────────
const buildTestReportPreview = jest.fn(async (buffer, opts) => {
  const name = (opts && opts.originalName) || '';
  if (/bad|corrupt/i.test(name)) {
    throw new Error('simulated unreadable PDF');
  }
  return {
    meta: { serialNumber: 'SN-' + name, testDate: '2026-06-01', vendor: 'Acme NETA', techName: 'Tech' },
    assetMatch: { id: ASSET_OWN, label: 'Matched Asset', reason: 'serial_exact' },
    assetCandidates: [{ id: ASSET_OWN, label: 'Matched Asset', serialNumber: 'SN-1' }],
    measurements: [
      { measurementType: 'insulation_resistance', label: 'Insulation Resistance', phase: 'A', asFoundValue: 1200, asFoundUnit: 'MΩ', passFail: 'GREEN' },
      // one row carrying a plausibility note → surfaces as a plausibilityFlag
      { measurementType: 'contact_resistance', label: 'Contact Resistance', phase: 'B', asFoundValue: 999999, asFoundUnit: 'µΩ', passFail: 'RED', sanityNote: 'contact resistance implausibly high' },
    ],
    sections: [],
    assetSections: 1,
    source: 'pdfplumber',
    ocr: false,
    aiUsed: false,
    summary: { total: 2, red: 1, yellow: 0, green: 1, deficienciesToCreate: 1 },
    truncated: false,
    pageCount: 1,
    pagesScanned: 1,
    extractionId: EXT_1,
    priorImport: null,
  };
});
jest.mock('../lib/testReportPreview', () => ({ buildTestReportPreview }));

// ── Mock the shared commit writer + telemetry (the SAME functions /commit uses).
const commitAssetReadings = jest.fn(async (_db, p) => ({
  workOrderId: 'wo-' + p.assetId, assetId: p.assetId,
  measurementsCreated: (p.measurements || []).length, deficienciesCreated: 1,
  trendDeficiencies: 0, sanityFlags: 0, deficiencyBySeverity: { IMMEDIATE: 1, RECOMMENDED: 0, ADVISORY: 0 },
}));
class HttpableError extends Error { constructor(status, message) { super(message); this.httpStatus = status; } }
jest.mock('../lib/commitTestReport', () => ({
  commitAssetReadings,
  HttpableError,
  // These are imported elsewhere in the route module; provide inert stand-ins.
  commitPreviewSections: jest.fn(),
  inferEquipmentType: jest.fn(),
  inferEquipmentTypeResult: jest.fn(),
  hasUsableReading: jest.fn(() => true),
  BAD_DIRECTION: {}, TREND_PCT: 15,
}));

const recordCommit = jest.fn(async () => {});
jest.mock('../lib/extractionTelemetry', () => ({
  recordCommit,
  // top-level require of the route destructures these too; inert stand-ins.
  sha256Hex: jest.fn(() => 'sha'), confStats: jest.fn(() => ({})),
  recordExtraction: jest.fn(async () => null), findPriorImport: jest.fn(async () => null),
}));

// resolveTargetAccount just returns the caller's own account for these tests.
jest.mock('../lib/oemTargetAccount', () => ({
  resolveTargetAccount: jest.fn(async (req) => req.user.accountId),
  TargetAccountError: class extends Error { constructor(s, m) { super(m); this.httpStatus = s; } },
}));

// Inert heavy top-level requires so importing the route is hermetic.
jest.mock('../lib/testReportParse', () => ({
  extractPdfText: jest.fn(), parseTestReport: jest.fn(), severityFor: jest.fn(), evaluate: jest.fn(),
  MEASUREMENT_VOCAB: {},
}));
jest.mock('../lib/testReportExtract', () => ({ runDeterministic: jest.fn() }));
jest.mock('../lib/aiTestReportExtract', () => ({ aiFillReadings: jest.fn(), aiFillReadingsFromImage: jest.fn() }));
jest.mock('../lib/assetIdentity', () => ({ resolveAsset: jest.fn() }));
const writeLog = jest.fn();
jest.mock('../lib/activityLog', () => ({ writeLog }));
const notifyReportIngested = jest.fn(() => ({ catch: () => {} }));
jest.mock('../lib/loopNotify', () => ({ notifyReportIngested }));

// Role gates are pass-through (the route enforces role INLINE off req.user.role;
// the stub auth sets the role, so the inline checks still exercise correctly).
jest.mock('../middleware/roles', () => ({
  requireManager: (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

// ── Fake prisma: asset.findFirst honors tenancy (accountId scope). ──────────────
jest.mock('../lib/prisma', () => {
  const assets = [
    { id: '00000000-0000-4000-8000-0000000000b1', accountId: 'acct-a', archivedAt: null },
    { id: '00000000-0000-4000-8000-0000000000b2', accountId: 'acct-a', archivedAt: null },
    { id: '00000000-0000-4000-8000-0000000000b9', accountId: 'acct-b', archivedAt: null }, // foreign tenant
  ];
  const client = {
    asset: {
      findFirst: async ({ where }) =>
        assets.find((a) => a.id === where.id && a.accountId === where.accountId && a.archivedAt === null) || null,
    },
    $transaction: async (fn) => fn(client),
  };
  client.default = client;
  return client;
});

const express = require('express');
const request = require('supertest');

// Build an app whose stub auth injects a configurable role/account.
function makeApp(user) {
  const router = require('../routes/testReportImport');
  const app = express();
  app.use(express.json());
  // NB: Express 4 defines req.ip as a read-only getter on the request prototype,
  // so a plain `req.ip = ...` throws "Cannot set property ip ... only a getter"
  // under strict mode and crashes the whole middleware chain (every route 500s).
  // Override the getter with a concrete value instead so the route still reads a
  // source IP (folded into the activity-log details.ip).
  app.use((req, res, next) => {
    req.user = user;
    Object.defineProperty(req, 'ip', { value: '203.0.113.5', configurable: true });
    next();
  });
  app.use('/api/test-reports/import', router);
  return app;
}

const MANAGER = { id: 'user-a', accountId: 'acct-a', role: 'manager', name: 'Mgr', email: 'mgr@a.test' };
const VIEWER  = { id: 'user-v', accountId: 'acct-a', role: 'viewer', name: 'Vwr', email: 'vwr@a.test' };

beforeEach(() => {
  buildTestReportPreview.mockClear();
  commitAssetReadings.mockClear();
  recordCommit.mockClear();
  writeLog.mockClear();
  notifyReportIngested.mockClear();
});

describe('POST /bulk-preview — per-file fan-out', () => {
  test('1 good + 1 failing file → per-file outcomes; the bad file does not abort the batch', async () => {
    const app = makeApp(MANAGER);
    const res = await request(app)
      .post('/api/test-reports/import/bulk-preview')
      .attach('files', Buffer.from('%PDF-good'), 'good-report.pdf')
      .attach('files', Buffer.from('%PDF-bad'), 'corrupt-report.pdf');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { results, counts } = res.body.data;
    expect(results).toHaveLength(2);
    expect(counts).toEqual({ total: 2, extracted: 1, failed: 1 });

    // Order preserved (input order); good file extracted with its fields + flags.
    const good = results.find((r) => r.filename === 'good-report.pdf');
    expect(good.status).toBe('extracted');
    expect(good.extractionId).toBe(EXT_1);
    expect(good.summary.total).toBe(2);
    expect(good.confidence).toEqual({ red: 1, yellow: 0, green: 1 });
    // plausibility gate surfaced from the sanityNote row
    expect(good.plausibilityFlags).toHaveLength(1);
    expect(good.plausibilityFlags[0].label).toBe('Contact Resistance');

    const bad = results.find((r) => r.filename === 'corrupt-report.pdf');
    expect(bad.status).toBe('failed');
    expect(typeof bad.error).toBe('string');

    // Extraction was attempted for BOTH files.
    expect(buildTestReportPreview).toHaveBeenCalledTimes(2);
  });

  test('empty upload → 400', async () => {
    const app = makeApp(MANAGER);
    const res = await request(app).post('/api/test-reports/import/bulk-preview');
    expect(res.status).toBe(400);
  });
});

describe('POST /bulk-commit — per-item outcomes + tenancy', () => {
  test('one cross-tenant assetId is rejected (404) while the others commit', async () => {
    const app = makeApp(MANAGER);
    const res = await request(app).post('/api/test-reports/import/bulk-commit').send({
      items: [
        { extractionId: EXT_1, filename: 'a.pdf', assetId: ASSET_OWN,     measurements: [{ measurementType: 'insulation_resistance', asFoundValue: 1000, passFail: 'GREEN' }] },
        { extractionId: EXT_FOREIGN, filename: 'foreign.pdf', assetId: ASSET_FOREIGN, measurements: [{ measurementType: 'insulation_resistance', asFoundValue: 900, passFail: 'GREEN' }] },
        { extractionId: EXT_2, filename: 'b.pdf', assetId: ASSET_OWN_2,   measurements: [{ measurementType: 'contact_resistance', asFoundValue: 50, passFail: 'GREEN' }] },
      ],
    });

    expect(res.status).toBe(201);
    const { results, totals } = res.body.data;
    expect(results).toHaveLength(3);

    const own = results.find((r) => r.filename === 'a.pdf');
    const foreign = results.find((r) => r.filename === 'foreign.pdf');
    const own2 = results.find((r) => r.filename === 'b.pdf');
    expect(own.status).toBe('committed');
    expect(own2.status).toBe('committed');
    expect(foreign.status).toBe('failed');
    expect(foreign.httpStatus).toBe(404);

    expect(totals.committed).toBe(2);
    expect(totals.failed).toBe(1);
    expect(totals.itemsSubmitted).toBe(3);

    // Reused the shared writer for exactly the two in-tenant items (never the foreign one).
    expect(commitAssetReadings).toHaveBeenCalledTimes(2);
    const committedAssetIds = commitAssetReadings.mock.calls.map((c) => c[1].assetId);
    expect(committedAssetIds).toEqual(expect.arrayContaining([ASSET_OWN, ASSET_OWN_2]));
    expect(committedAssetIds).not.toContain(ASSET_FOREIGN);

    // recordCommit carries the accountId per item (existing convention) — once per committed item.
    expect(recordCommit).toHaveBeenCalledTimes(2);
    recordCommit.mock.calls.forEach((c) => expect(c[0].accountId).toBe('acct-a'));

    // One activity-log row for the whole batch with the counts.
    expect(writeLog).toHaveBeenCalledTimes(1);
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'test_reports_bulk_imported', accountId: 'acct-a',
      details: expect.objectContaining({ committed: 2, failed: 1 }),
    }));
  });

  test('viewer (read-only) → 403, nothing commits, no activity log', async () => {
    const app = makeApp(VIEWER);
    const res = await request(app).post('/api/test-reports/import/bulk-commit').send({
      items: [{ extractionId: EXT_1, assetId: ASSET_OWN, measurements: [{ measurementType: 'insulation_resistance', asFoundValue: 1000, passFail: 'GREEN' }] }],
    });
    expect(res.status).toBe(403);
    expect(commitAssetReadings).not.toHaveBeenCalled();
    expect(recordCommit).not.toHaveBeenCalled();
    expect(writeLog).not.toHaveBeenCalled();
  });

  test('empty items[] → 400', async () => {
    const app = makeApp(MANAGER);
    const res = await request(app).post('/api/test-reports/import/bulk-commit').send({ items: [] });
    expect(res.status).toBe(400);
  });

  test('an item missing measurements is rejected per-item; siblings still commit', async () => {
    const app = makeApp(MANAGER);
    const res = await request(app).post('/api/test-reports/import/bulk-commit').send({
      items: [
        { extractionId: EXT_1, filename: 'good.pdf', assetId: ASSET_OWN, measurements: [{ measurementType: 'insulation_resistance', asFoundValue: 1000, passFail: 'GREEN' }] },
        { extractionId: EXT_2, filename: 'empty.pdf', assetId: ASSET_OWN_2, measurements: [] },
      ],
    });
    expect(res.status).toBe(201);
    const { results, totals } = res.body.data;
    expect(totals.committed).toBe(1);
    expect(results.find((r) => r.filename === 'empty.pdf').status).toBe('failed');
    expect(results.find((r) => r.filename === 'good.pdf').status).toBe('committed');
  });
});

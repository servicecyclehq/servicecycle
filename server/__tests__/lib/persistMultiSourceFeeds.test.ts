/**
 * __tests__/lib/persistMultiSourceFeeds.test.ts
 * Hermetic: deriveForBusRows is pure; persistMultiSourceFeeds is exercised against a
 * fake Prisma txn so no DB is touched. Verifies the derive -> map names -> persist
 * AssetFeed contract (idempotent delete of involved loads, dedupe, unresolved skip).
 */
const { deriveForBusRows, persistMultiSourceFeeds, buildExtractedModel, mergeHints } = require('../../lib/persistMultiSourceFeeds');

const MODEL = [
  { busName: 'UTIL-A', equipmentTypeGuess: 'UTILITY_SERVICE', sourceRole: 'normal', side: 'A' },
  { busName: 'UTIL-B', equipmentTypeGuess: 'UTILITY_SERVICE', sourceRole: 'normal', side: 'B' },
  { busName: 'UPS-A', equipmentTypeGuess: 'UPS_BATTERY', fedFromBusName: 'UTIL-A', side: 'A' },
  { busName: 'UPS-B', equipmentTypeGuess: 'UPS_BATTERY', fedFromBusName: 'UTIL-B', side: 'B' },
  { busName: 'RACK-1', equipmentTypeGuess: 'IT_RACK', fedFromBusName: 'UPS-A', secondFeedFromBusName: 'UPS-B', redundancyZone: '2N' },
];

function fakeTxn() {
  const calls: any = { deletes: [], creates: [] };
  const txn: any = {
    assetFeed: {
      deleteMany: async (args: any) => { calls.deletes.push(args); return { count: 0 }; },
      create: async (args: any) => { calls.creates.push(args.data); return args.data; },
    },
  };
  return { txn, calls };
}

describe('deriveForBusRows', () => {
  test('derives dual-corded + source kinds + busHints from a 2N model', () => {
    const d = deriveForBusRows(MODEL);
    expect(d.dualCorded).toContain('RACK-1');
    // UPS-A/UPS-B fed from utilities; RACK-1 fed from both UPS sides
    const loads = d.feeds.map((f: any) => f.loadBusName);
    expect(loads).toEqual(expect.arrayContaining(['UPS-A', 'UPS-B', 'RACK-1']));
    // RACK-1 in a 2N zone with two cords => NOT a MISSED_FEED gap
    const rackMissed = d.gaps.find((g: any) => g.busName === 'RACK-1' && g.code === 'MISSED_FEED');
    expect(rackMissed).toBeUndefined();
    // busHints carries the fields the editable bus row has no column for
    expect(d.busHints['RACK-1']).toEqual(expect.objectContaining({ secondFeedFromBusName: 'UPS-B', redundancyZone: '2N' }));
  });

  test('a 2N-zoned load with only one cord raises MISSED_FEED', () => {
    const d = deriveForBusRows([{ busName: 'RACK-9', equipmentTypeGuess: 'IT_RACK', fedFromBusName: 'UPS-A', redundancyZone: '2N' }]);
    expect(d.gaps.some((g: any) => g.busName === 'RACK-9' && g.code === 'MISSED_FEED')).toBe(true);
  });
});

describe('persistMultiSourceFeeds', () => {
  test('persists resolved edges, deletes involved loads once, dedupes', async () => {
    const derived = deriveForBusRows(MODEL);
    const nameToAssetId = new Map<string, string>([
      ['UTIL-A', 'a1'], ['UTIL-B', 'a2'], ['UPS-A', 'a3'], ['UPS-B', 'a4'], ['RACK-1', 'a5'],
    ]);
    const { txn, calls } = fakeTxn();
    const r = await persistMultiSourceFeeds(txn, { accountId: 'acc', siteId: 'site', derived, nameToAssetId });
    // 4 real edges: UPS-A<-UTIL-A, UPS-B<-UTIL-B, RACK-1<-UPS-A, RACK-1<-UPS-B
    expect(r.feedsPersisted).toBe(4);
    expect(calls.creates.length).toBe(4);
    // idempotent delete: one deleteMany scoped to the 3 involved load assets
    expect(calls.deletes.length).toBe(1);
    expect(calls.deletes[0].where.loadAssetId.in.sort()).toEqual(['a3', 'a4', 'a5']);
    // every created row is a well-formed edge for lib/redundancyImpact
    for (const c of calls.creates) {
      expect(c.accountId).toBe('acc');
      expect(c.siteId).toBe('site');
      expect(typeof c.loadAssetId).toBe('string');
      expect(typeof c.sourceAssetId).toBe('string');
      expect(c.loadAssetId).not.toBe(c.sourceAssetId);
    }
  });

  test('skips edges whose endpoints do not resolve to confirmed assets', async () => {
    const derived = deriveForBusRows(MODEL);
    // UTIL-B intentionally unmapped => UPS-B<-UTIL-B edge cannot persist
    const nameToAssetId = new Map<string, string>([
      ['UTIL-A', 'a1'], ['UPS-A', 'a3'], ['UPS-B', 'a4'], ['RACK-1', 'a5'],
    ]);
    const { txn, calls } = fakeTxn();
    const r = await persistMultiSourceFeeds(txn, { accountId: 'acc', siteId: 'site', derived, nameToAssetId });
    expect(r.skippedUnresolved).toBeGreaterThanOrEqual(1);
    expect(calls.creates.every((c: any) => c.sourceAssetId !== 'UTIL-B')).toBe(true);
  });
});

describe('mergeHints', () => {
  test('overlays stored hints onto reviewer-corrected rows by busName', () => {
    const rows = [{ busName: 'RACK-1', fedFromBusName: 'UPS-A-CORRECTED' }];
    const merged = mergeHints(rows, { 'RACK-1': { secondFeedFromBusName: 'UPS-B', side: 'A' } });
    expect(merged[0].fedFromBusName).toBe('UPS-A-CORRECTED');
    expect(merged[0].secondFeedFromBusName).toBe('UPS-B');
  });
});
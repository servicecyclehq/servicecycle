/**
 * redundancyImpact.test.ts -- known-answer tests for the multi-source redundancy engine,
 * driven by the synthetic 2N data-center fixture (spec 3g). Pure/in-code, no DB.
 */
import { redundancyImpact } from '../lib/redundancyImpact';
import { datacenter2N, rackIds, crahIds } from '../lib/redundancyImpactFixtures';

const { nodes, edges } = datacenter2N;
const run = (offline = {}) => redundancyImpact(nodes, edges, offline);
const byId = (r: ReturnType<typeof run>, id: string) => r.loads.find((l) => l.loadId === id)!;

describe('redundancyImpact -- baseline (nothing offline)', () => {
  const r = run();
  it('has 12 racks + 4 CRAHs classified', () => {
    expect(rackIds).toHaveLength(12);
    expect(crahIds).toHaveLength(4);
    expect(r.loads).toHaveLength(16);
  });
  it('every rack is 2N (RETAINED, 2 independent durable paths)', () => {
    for (const id of rackIds) {
      const l = byId(r, id);
      expect(l.status).toBe('RETAINED');
      expect(l.durablePaths).toBe(2);
      expect(l.redundancyContradiction).toBeUndefined();
    }
  });
  it('every CRAH is 2-fed (RETAINED) and its N+1 claim is not contradicted', () => {
    for (const id of crahIds) {
      const l = byId(r, id);
      expect(l.status).toBe('RETAINED');
      expect(l.durablePaths).toBe(2);
      expect(l.redundancyContradiction).toBeUndefined();
    }
  });
  it('nothing dropped; action is (trivially) concurrent-maintainable', () => {
    expect(r.dropped).toBe(0);
    expect(r.concurrentMaintainable).toBe(true);
    expect(r.cleanConcurrentMaintenance).toBe(true);
  });
});

describe('KNOWN ANSWER 1 -- offline = LV-SWGR-B', () => {
  const r = run({ nodeIds: ['LV-SWGR-B'] });
  it('0 racks DROPPED, all 12 racks AT_RISK (A-only)', () => {
    const dropped = rackIds.filter((id) => byId(r, id).status === 'DROPPED');
    const atRisk = rackIds.filter((id) => byId(r, id).status === 'AT_RISK');
    expect(dropped).toHaveLength(0);
    expect(atRisk).toHaveLength(12);
    for (const id of rackIds) {
      const l = byId(r, id);
      expect(l.durablePaths).toBe(1); // only the A train is durable now
      expect(l.redundancyDowngrade).toBe(true);
    }
  });
  it('concurrent-maintainable = TRUE (no DROPPED)', () => {
    expect(r.dropped).toBe(0);
    expect(r.concurrentMaintainable).toBe(true);
  });
});

describe('KNOWN ANSWER 2 -- offline = UTIL-A + GEN-A (side A loses its durable sources)', () => {
  const r = run({ nodeIds: ['UTIL-A', 'GEN-A'] });
  it('side A rides UPS-A battery; racks up on B (0 DROPPED, racks AT_RISK)', () => {
    expect(rackIds.filter((id) => byId(r, id).status === 'DROPPED')).toHaveLength(0);
    for (const id of rackIds) {
      const l = byId(r, id);
      expect(l.status).toBe('AT_RISK'); // durable only via B; A is battery-only
      expect(l.durablePaths).toBe(1);
    }
  });
  it('side A mechanical loads (CRAH, no UPS) are AT_RISK', () => {
    for (const id of crahIds) {
      const l = byId(r, id);
      expect(l.status).toBe('AT_RISK');
      expect(l.durablePaths).toBe(1); // durable via LV-SWGR-B only
    }
  });
  it('no load dropped', () => {
    expect(r.dropped).toBe(0);
    expect(r.concurrentMaintainable).toBe(true);
  });
});

describe('KNOWN ANSWER 3 -- remove a rack B input (single-cord downgrade)', () => {
  const r = run({ edgeIds: ['B-cord-RACK-01'] });
  it('RACK-01 flips RETAINED -> AT_RISK with a redundancy-downgrade flag', () => {
    const l = byId(r, 'RACK-01');
    expect(l.status).toBe('AT_RISK');
    expect(l.durablePaths).toBe(1);
    expect(l.baselineDurablePaths).toBe(2);
    expect(l.redundancyDowngrade).toBe(true);
  });
  it('the other 11 racks remain RETAINED (2N)', () => {
    for (const id of rackIds.filter((x) => x !== 'RACK-01')) {
      expect(byId(r, id).status).toBe('RETAINED');
    }
    expect(r.dropped).toBe(0);
  });
});

describe('side convenience + hard-down + contradiction', () => {
  it('offline={side:"B"} takes the whole B train down -> all racks AT_RISK, none dropped', () => {
    const r = run({ side: 'B' });
    expect(rackIds.every((id) => byId(r, id).status === 'AT_RISK')).toBe(true);
    expect(r.dropped).toBe(0);
    expect(r.concurrentMaintainable).toBe(true);
  });
  it('taking BOTH sides at the transformer level DROPS every load (not maintainable)', () => {
    const r = run({ nodeIds: ['XFMR-A', 'XFMR-B'] });
    // racks still ride UPS-A/UPS-B battery briefly -> AT_RISK (rideThroughOnly), not dropped;
    // CRAHs have no UPS and lose both durable feeds -> DROPPED.
    for (const id of crahIds) expect(byId(r, id).status).toBe('DROPPED');
    for (const id of rackIds) {
      const l = byId(r, id);
      expect(l.status).toBe('AT_RISK');
      expect(l.rideThroughOnly).toBe(true);
    }
    expect(r.concurrentMaintainable).toBe(false); // CRAHs dropped
  });
  it('flags a nameplate 2N claim the graph does not support', () => {
    // a single-corded rack that still claims 2N
    const nodes2 = [...nodes, { id: 'RACK-BAD', isLoad: true, redundancyClaim: '2N', label: 'RACK-BAD' }];
    const edges2 = [...edges, { id: 'only-cord', loadAssetId: 'RACK-BAD', sourceAssetId: 'PDU-A', role: 'normal' as const, side: 'A' as const, sourceKind: 'derived' as const }];
    const r = redundancyImpact(nodes2, edges2, {});
    const bad = r.loads.find((l) => l.loadId === 'RACK-BAD')!;
    expect(bad.baselineDurablePaths).toBe(1);
    expect(bad.redundancyContradiction).toMatch(/2N/);
  });
});

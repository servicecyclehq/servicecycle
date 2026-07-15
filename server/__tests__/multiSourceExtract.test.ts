/**
 * multiSourceExtract.test.ts -- unit tests for best-effort multi-source derivation.
 * Synthetic input only; extraction accuracy vs real drawings is a human-iteration follow-on.
 */
import { deriveMultiSourceTopology } from '../lib/multiSourceExtract';

describe('deriveMultiSourceTopology', () => {
  const model = {
    buses: [
      { busName: 'UTIL-A', equipmentType: 'UTILITY_SERVICE', sourceRole: 'utility', side: 'A' as const },
      { busName: 'GEN-A', equipmentType: 'GENERATOR', sourceRole: 'generator', side: 'A' as const },
      { busName: 'MV-SWGR-A', fedFromBusName: 'UTIL-A', alternateSourceBusName: 'GEN-A', transferType: 'ATS', sourceRole: 'emergency', side: 'A' as const },
      { busName: 'UPS-A', equipmentType: 'UPS_BATTERY', fedFromBusName: 'MV-SWGR-A', side: 'A' as const },
      { busName: 'PDU-A', fedFromBusName: 'UPS-A', side: 'A' as const },
      { busName: 'PDU-B', fedFromBusName: 'UPS-B', side: 'B' as const },
      // dual-corded rack: A from PDU-A, B from PDU-B, in a 2N zone
      { busName: 'RACK-01', fedFromBusName: 'PDU-A', secondFeedFromBusName: 'PDU-B', side: 'A' as const, redundancyZone: '2N' },
      // rack labeled 2N but only single-corded -> MISSED_FEED gap
      { busName: 'RACK-02', fedFromBusName: 'PDU-A', side: 'A' as const, redundancyZone: '2N' },
      // STS with an alternate that isn't in the model -> UNTRACED_ALTERNATE gap
      { busName: 'STS-1', fedFromBusName: 'PDU-A', alternateSourceBusName: 'PDU-GHOST', transferType: 'STS', side: 'A' as const },
    ],
  };
  const d = deriveMultiSourceTopology(model);

  it('detects the dual-corded rack and its two normal feeds on opposite sides', () => {
    expect(d.dualCorded).toContain('RACK-01');
    const rackFeeds = d.feeds.filter((f) => f.loadBusName === 'RACK-01');
    expect(rackFeeds).toHaveLength(2);
    expect(rackFeeds.map((f) => f.side).sort()).toEqual(['A', 'B']);
    expect(rackFeeds.every((f) => f.role === 'normal')).toBe(true);
  });

  it('maps source kinds (utility / generator / ups)', () => {
    expect(d.sourceKinds['UTIL-A']).toBe('utility');
    expect(d.sourceKinds['GEN-A']).toBe('generator');
    expect(d.sourceKinds['UPS-A']).toBe('ups');
  });

  it('emits an ATS emergency edge with the transfer device tagged', () => {
    const alt = d.feeds.find((f) => f.loadBusName === 'MV-SWGR-A' && f.sourceBusName === 'GEN-A');
    expect(alt).toBeTruthy();
    expect(alt!.role).toBe('emergency');
    expect(alt!.transferBusName).toBe('MV-SWGR-A');
    expect(alt!.sourceKind).toBe('generator');
  });

  it('flags a 2N-zone bus that resolved single-corded (MISSED_FEED)', () => {
    expect(d.gaps.some((g) => g.code === 'MISSED_FEED' && g.busName === 'RACK-02')).toBe(true);
    expect(d.gaps.some((g) => g.code === 'MISSED_FEED' && g.busName === 'RACK-01')).toBe(false);
  });

  it('flags a transfer device whose alternate source is untraceable (UNTRACED_ALTERNATE)', () => {
    expect(d.gaps.some((g) => g.code === 'UNTRACED_ALTERNATE' && g.busName === 'STS-1')).toBe(true);
  });
});

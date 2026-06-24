// rollupIncidentsBySite — per-site incident attention signal for the fleet view.
const { rollupIncidentsBySite } = require('../lib/arcFlashIncident');

const NOW = new Date('2026-06-23T00:00:00Z').getTime();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

describe('rollupIncidentsBySite', () => {
  const incidents = [
    { siteId: 'S1', occurredAt: daysAgo(10), status: 'open', injury: true },
    { siteId: 'S1', occurredAt: daysAgo(400), status: 'closed', injury: false }, // outside 365d window
    { siteId: 'S1', occurredAt: null, createdAt: daysAgo(5), status: 'reviewed', injury: false }, // falls back to createdAt
    { siteId: 'S2', occurredAt: daysAgo(30), status: 'closed', injury: false },
    { siteId: null, occurredAt: daysAgo(3), status: 'open', injury: false }, // -> 'unassigned'
  ];
  const m = rollupIncidentsBySite(incidents, NOW, 365);

  test('counts recent within window, by occurredAt or createdAt fallback', () => {
    expect(m.get('S1').recent).toBe(2); // 10d + 5d(createdAt); 400d excluded
  });

  test('open = anything not closed', () => {
    expect(m.get('S1').open).toBe(2); // open + reviewed
    expect(m.get('S2').open).toBe(0); // closed
  });

  test('injury tally + last-occurred tracked', () => {
    expect(m.get('S1').injury).toBe(1);
    expect(m.get('S1').lastOccurredAt).toBe(new Date(daysAgo(5)).getTime());
  });

  test('null siteId buckets to unassigned', () => {
    expect(m.get('unassigned').recent).toBe(1);
  });

  test('empty input is safe', () => {
    expect(rollupIncidentsBySite([], NOW, 365).size).toBe(0);
    expect(rollupIncidentsBySite(null, NOW, 365).size).toBe(0);
  });
});

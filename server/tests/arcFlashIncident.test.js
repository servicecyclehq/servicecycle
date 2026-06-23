// Unit coverage for the arc-flash incident register's pure helpers: the
// log-time study-state snapshot and the enum normalizer.
const { buildStudyStateSnapshot, normEnum, incidentOut, INCIDENT_TYPES, WORK_TYPES } =
  require('../lib/arcFlashIncident');

describe('arc-flash incident register', () => {
  test('normEnum allowlists and falls back', () => {
    expect(normEnum('arc_flash', INCIDENT_TYPES, 'near_miss')).toBe('arc_flash');
    expect(normEnum('ARC_FLASH', INCIDENT_TYPES, 'near_miss')).toBe('arc_flash');
    expect(normEnum('bogus', INCIDENT_TYPES, 'near_miss')).toBe('near_miss');
    expect(normEnum(null, WORK_TYPES, 'other')).toBe('other');
  });

  test('snapshot is null when there is no current label', () => {
    expect(buildStudyStateSnapshot(null)).toBeNull();
  });

  test('snapshot captures the label + flags an expired study', () => {
    const asOf = new Date('2026-06-23T00:00:00Z');
    const snap = buildStudyStateSnapshot({
      busName: 'SWGR-1A',
      nominalVoltage: '480V',
      incidentEnergyCalCm2: 12.5,
      ppeCategory: 2,
      labelSeverity: 'warning',
      confidence: { score: 74, band: 'yellow' },
      study: { performedDate: '2020-01-01', expiresAt: '2025-01-01', superseded: false },
    }, asOf);
    expect(snap.busName).toBe('SWGR-1A');
    expect(snap.incidentEnergyCalCm2).toBe(12.5);
    expect(snap.ppeCategory).toBe(2);
    expect(snap.labelSeverity).toBe('warning');
    expect(snap.confidenceScore).toBe(74);
    expect(snap.confidenceBand).toBe('yellow');
    expect(snap.studyExpired).toBe(true); // expired 2025 vs asOf 2026
    expect(snap.capturedAt).toBe(asOf.toISOString());
  });

  test('snapshot marks a current study as not expired', () => {
    const snap = buildStudyStateSnapshot({
      busName: 'MCC-2',
      study: { performedDate: '2024-01-01', expiresAt: '2029-01-01', superseded: false },
    }, new Date('2026-06-23T00:00:00Z'));
    expect(snap.studyExpired).toBe(false);
    expect(snap.incidentEnergyCalCm2).toBeNull();
  });

  test('incidentOut shapes the row without leaking internal fields', () => {
    const out = incidentOut({
      id: 'i1', assetId: 'a1', siteId: 's1', busName: 'B', incidentType: 'near_miss',
      occurredAt: null, description: 'd', injury: false, status: 'open',
      accountId: 'SECRET', reportedById: 'SECRET',
    });
    expect(out.id).toBe('i1');
    expect(out.description).toBe('d');
    expect(out).not.toHaveProperty('accountId');
    expect(out).not.toHaveProperty('reportedById');
  });
});

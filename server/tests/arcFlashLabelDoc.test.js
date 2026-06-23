// buildLabelModel — severity + field-set-by-method decisions for the NFPA 70E
// label. (The PDF rendering itself is exercised via the route, not unit-tested.)
const { buildLabelModel } = require('../lib/arcFlashLabelDoc');

describe('buildLabelModel', () => {
  test('DANGER when incident energy > 40 cal/cm2', () => {
    const m = buildLabelModel({ incidentEnergyCalCm2: 45, nominalVoltage: '480V', workingDistanceIn: 18 });
    expect(m.signalWord).toBe('DANGER');
    expect(m.danger).toBe(true);
  });

  test('DANGER when voltage > 600 V even at low IE', () => {
    const m = buildLabelModel({ incidentEnergyCalCm2: 2, nominalVoltage: '4.16kV' });
    expect(m.signalWord).toBe('DANGER');
  });

  test('WARNING for ordinary LV bus', () => {
    const m = buildLabelModel({ incidentEnergyCalCm2: 8, nominalVoltage: '480V' });
    expect(m.signalWord).toBe('WARNING');
    expect(m.danger).toBe(false);
  });

  test('incident-energy method shows IE; not the category', () => {
    const m = buildLabelModel({ ppeMethod: 'incident_energy', incidentEnergyCalCm2: 12, workingDistanceIn: 18, requiredArcRatingCalCm2: 12, ppeCategory: 2, nominalVoltage: '480V' });
    expect(m.method).toBe('incident_energy');
    expect(m.showIE).toBe(true);
    expect(m.showPpeCat).toBe(false);
  });

  test('PPE-category method shows the category', () => {
    const m = buildLabelModel({ ppeMethod: 'ppe_category', ppeCategory: 2, nominalVoltage: '208V' });
    expect(m.method).toBe('ppe_category');
    expect(m.showPpeCat).toBe(true);
  });

  test('infers incident-energy method when IE present and no explicit method', () => {
    const m = buildLabelModel({ incidentEnergyCalCm2: 5, nominalVoltage: '480V' });
    expect(m.method).toBe('incident_energy');
    expect(m.showIE).toBe(true);
  });

  test('facility name leads; brand passes through; bus identity resolved', () => {
    const m = buildLabelModel(
      { busName: 'SWGR-1A', nominalVoltage: '480V', incidentEnergyCalCm2: 10, study: { performedDate: '2024-01-01' } },
      { facilityName: 'Riverside Foods', brandName: 'AcmeElec' },
    );
    expect(m.facilityName).toBe('Riverside Foods');
    expect(m.brandName).toBe('AcmeElec');
    expect(m.busName).toBe('SWGR-1A');
    expect(m.studyDate).not.toBe('—');
  });
});

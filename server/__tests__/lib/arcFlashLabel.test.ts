/**
 * Unit tests for the Slice 3.5c label snapshot + printed-vs-current mismatch.
 */
import { labelSnapshot, computeLabelMismatch, LABEL_FIELDS } from '../../lib/arcFlashLabel';

describe('labelSnapshot', () => {
  test('coerces decimals and keeps the canonical fields', () => {
    const s = labelSnapshot({ nominalVoltage: '480V', incidentEnergyCalCm2: '8.40', arcFlashBoundaryIn: 36, ppeCategory: 2, labelSeverity: 'warning', extra: 'ignored' });
    expect(s).toEqual({ nominalVoltage: '480V', incidentEnergyCalCm2: 8.4, arcFlashBoundaryIn: 36, workingDistanceIn: null, ppeCategory: 2, requiredArcRatingCalCm2: null, labelSeverity: 'warning' });
    expect(Object.keys(s).sort()).toEqual([...LABEL_FIELDS].sort());
  });
});

describe('computeLabelMismatch', () => {
  const printed = { nominalVoltage: '480V', incidentEnergyCalCm2: 8.4, arcFlashBoundaryIn: 36, workingDistanceIn: 18, ppeCategory: 2, requiredArcRatingCalCm2: 8, labelSeverity: 'warning' };

  test('identical current -> no mismatch (decimal-string equal)', () => {
    const r = computeLabelMismatch(printed, { ...printed, incidentEnergyCalCm2: '8.40' });
    expect(r.isMismatch).toBe(false);
    expect(r.changes).toHaveLength(0);
  });

  test('changed incident energy + severity -> flagged with both', () => {
    const r = computeLabelMismatch(printed, { ...printed, incidentEnergyCalCm2: 45, labelSeverity: 'danger' });
    expect(r.isMismatch).toBe(true);
    expect(r.changes.map(c => c.field).sort()).toEqual(['incidentEnergyCalCm2', 'labelSeverity']);
    const ie = r.changes.find(c => c.field === 'incidentEnergyCalCm2');
    expect(ie).toMatchObject({ printed: 8.4, current: 45 });
  });

  test('never-printed (empty snapshot) -> no mismatch', () => {
    expect(computeLabelMismatch(null, printed).isMismatch).toBe(false);
    expect(computeLabelMismatch({}, printed).isMismatch).toBe(false);
  });
});

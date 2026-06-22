/**
 * Unit tests for the Slice 12 regulatory-change assessment.
 */
import { assessRegulatoryStatus, STANDARD_EDITIONS } from '../../lib/arcFlashRegulatory';

const asOf = new Date('2026-06-22T00:00:00Z');

describe('assessRegulatoryStatus', () => {
  test('current IEEE 1584-2018 study performed after NFPA 70E-2024 -> not outdated', () => {
    const r = assessRegulatoryStatus({ performedDate: '2024-06-01', method: 'IEEE 1584-2018', calcMethod: 'ieee_1584_2018' }, asOf);
    expect(r.outdated).toBe(false);
    expect(r.ieeeEdition).toBe('2018');
  });

  test('IEEE 1584-2002 basis is flagged outdated', () => {
    const r = assessRegulatoryStatus({ performedDate: '2024-01-01', method: 'IEEE 1584-2002' }, asOf);
    expect(r.outdated).toBe(true);
    expect(r.ieeeEdition).toBe('2002');
    expect(r.reasons.join(' ')).toMatch(/1584-2002/);
  });

  test('study predating NFPA 70E-2024 is flagged', () => {
    const r = assessRegulatoryStatus({ performedDate: '2019-01-01', method: 'IEEE 1584-2018', calcMethod: 'ieee_1584_2018' }, asOf);
    expect(r.outdated).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/NFPA 70E-2024/);
  });

  test('Lee method is not treated as an outdated 1584 edition', () => {
    const r = assessRegulatoryStatus({ performedDate: '2024-06-01', calcMethod: 'lee_method' }, asOf);
    expect(r.ieeeEdition).toBeNull();
    expect(r.outdated).toBe(false);
  });

  test('editions table exposes the current governing editions', () => {
    expect(STANDARD_EDITIONS.nfpa70e.current).toBe('2024');
    expect(STANDARD_EDITIONS.ieee1584.current).toBe('2018');
  });
});

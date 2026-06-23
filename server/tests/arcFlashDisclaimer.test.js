// The "ServiceCycle is the data layer, not the safety authority" microcopy must
// be the SAME canonical string at every data-validity gate: the energized-work
// permit and the field-collection task (and the v1 work-order precheck, which
// returns the same constant). Pure-function coverage.
const { SC_DATA_LAYER_DISCLAIMER } = require('../lib/arcFlashCopy');
const { buildEnergizedWorkPermit } = require('../lib/arcFlashPermit');
const { buildCollectionTasks } = require('../lib/arcFlashDevice');

describe('arc-flash data-layer disclaimer', () => {
  test('canonical string states the lane clearly', () => {
    expect(typeof SC_DATA_LAYER_DISCLAIMER).toBe('string');
    expect(SC_DATA_LAYER_DISCLAIMER).toMatch(/cannot authorize/i);
    expect(SC_DATA_LAYER_DISCLAIMER).toMatch(/qualified person/i);
    expect(SC_DATA_LAYER_DISCLAIMER).toMatch(/NFPA 70E/);
    expect(SC_DATA_LAYER_DISCLAIMER).toMatch(/log the results/i);
  });

  test('energized-work permit carries the canonical disclaimer', () => {
    const permit = buildEnergizedWorkPermit({
      bus: { busName: 'SWGR-1A', incidentEnergyCalCm2: 12, nominalVoltage: '480V' },
      study: { performedDate: '2025-01-01', expiresAt: '2030-01-01' },
      asset: { equipmentType: 'SWITCHGEAR', site: { name: 'Riverside' } },
    });
    expect(permit.disclaimer).toContain(SC_DATA_LAYER_DISCLAIMER);
  });

  test('field-collection task carries the canonical disclaimer', () => {
    const tasks = buildCollectionTasks([{
      id: 'b1',
      busName: 'BUS-1',
      readiness: 'blocked',
      gaps: { fields: [{ category: 'must_obtain', status: 'missing', field: 'nominalVoltage', label: 'Nominal voltage' }] },
    }]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].disclaimer).toBe(SC_DATA_LAYER_DISCLAIMER);
  });
});

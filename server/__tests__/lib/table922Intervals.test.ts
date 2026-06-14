/**
 * seventyBInterval verified against NFPA 70B:2023 Table 9.2.2 (primary source).
 * Visual inspection is 12/12/6 ONLY for the distribution set; 60/36/12 otherwise.
 */
import '../helpers/setup';
const { seventyBInterval } = require('../../scripts/seed-standards');

describe('Table 9.2.2 intervals', () => {
  test('IR thermography is 12/12/6 for all equipment', () => {
    expect(seventyBInterval({ equipmentType: 'SWITCHGEAR', name: 'Infrared thermography scan', code: 'SWGR_IR_THERMO', c2: 12 })).toEqual({ c1: 12, c2: 12, c3: 6 });
  });
  test('switchgear visual inspection is 12/12/6', () => {
    expect(seventyBInterval({ equipmentType: 'SWITCHGEAR', name: 'Visual inspection', code: 'X_VISUAL', c2: 24 })).toEqual({ c1: 12, c2: 12, c3: 6 });
  });
  test('panelboard visual inspection is 60/36/12 (NOT 12/12/6) - the fix', () => {
    expect(seventyBInterval({ equipmentType: 'PANELBOARD', name: 'Visual/mechanical inspection', code: 'PNL_TORQUE_VISUAL', c2: 24 })).toEqual({ c1: 60, c2: 36, c3: 12 });
  });
  test('cable visual inspection is 60/36/12 (the fix)', () => {
    expect(seventyBInterval({ equipmentType: 'CABLE_LV', name: 'Visual inspection at terminations', code: 'CBLLV_TERM_VISUAL', c2: 12 })).toEqual({ c1: 60, c2: 36, c3: 12 });
  });
  test('grounding visual is 12/12/6; grounding electrical test is 60/36/36', () => {
    expect(seventyBInterval({ equipmentType: 'GROUNDING_SYSTEM', name: 'Visual corrosion inspection', code: 'GND_VISUAL', c2: 12 })).toEqual({ c1: 12, c2: 12, c3: 6 });
    expect(seventyBInterval({ equipmentType: 'GROUNDING_SYSTEM', name: 'Ground-resistance test (fall-of-potential)', code: 'GND_FALL', c2: 36 })).toEqual({ c1: 60, c2: 36, c3: 36 });
  });
  test('motor electrical test is 60/36/12', () => {
    expect(seventyBInterval({ equipmentType: 'MOTOR', name: 'Winding insulation resistance', code: 'MTR_IR', c2: 12 })).toEqual({ c1: 60, c2: 36, c3: 12 });
  });
  test('operational (monthly) tasks return null (not 70B-derived)', () => {
    expect(seventyBInterval({ equipmentType: 'GENERATOR', name: 'Monthly exercise under load', code: 'GEN_X', c2: 1 })).toBeNull();
  });
});

export {};
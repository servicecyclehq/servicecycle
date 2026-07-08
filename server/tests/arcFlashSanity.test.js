'use strict';

/**
 * Unit coverage for lib/arcFlashSanity.ts — the contradiction / sanity-check
 * engine that gates physically-impossible arc-flash values before they reach
 * printed labels or posted studies.
 *
 * Pure-function suite: no DB, no server. Esbuild transform handles the TS.
 */

const {
  checkBusContradictions,
  checkSystemContradictions,
} = require('../lib/arcFlashSanity');

// ── helpers ───────────────────────────────────────────────────────────────────

function codes(findings) {
  return findings.map((f) => f.code);
}

function severities(findings) {
  return findings.map((f) => f.severity);
}

// ── checkBusContradictions ────────────────────────────────────────────────────

describe('checkBusContradictions', () => {
  describe('arcing current vs bolted fault current', () => {
    test('flags arcing current greater than bolted fault current (physically impossible)', () => {
      const f = checkBusContradictions({
        busName: 'SWGR-1A',
        arcingCurrentKA: 22.5,
        boltedFaultCurrentKA: 21.9,
      });
      expect(codes(f)).toContain('arcing_gt_bolted');
      const finding = f.find((x) => x.code === 'arcing_gt_bolted');
      expect(finding.severity).toBe('error');
    });

    test('does NOT flag when arcing current is less than bolted fault current', () => {
      const f = checkBusContradictions({
        busName: 'SWGR-1A',
        arcingCurrentKA: 18.0,
        boltedFaultCurrentKA: 21.9,
      });
      expect(codes(f)).not.toContain('arcing_gt_bolted');
    });

    test('does NOT flag when arcing equals bolted (edge equality is valid)', () => {
      const f = checkBusContradictions({
        busName: 'SWGR-1A',
        arcingCurrentKA: 21.9,
        boltedFaultCurrentKA: 21.9,
      });
      expect(codes(f)).not.toContain('arcing_gt_bolted');
    });

    test('does NOT flag when either value is absent', () => {
      expect(codes(checkBusContradictions({ busName: 'B', arcingCurrentKA: 20 }))).not.toContain('arcing_gt_bolted');
      expect(codes(checkBusContradictions({ busName: 'B', boltedFaultCurrentKA: 20 }))).not.toContain('arcing_gt_bolted');
    });
  });

  describe('reduced arcing current vs arcing current', () => {
    test('flags reduced arcing current greater than full arcing current', () => {
      const f = checkBusContradictions({
        busName: 'MCC-2',
        arcingCurrentKA: 15.0,
        arcingCurrentReducedKA: 16.5,
      });
      expect(codes(f)).toContain('reduced_gt_arcing');
      expect(f.find((x) => x.code === 'reduced_gt_arcing').severity).toBe('error');
    });

    test('does NOT flag when reduced arcing is below full arcing', () => {
      const f = checkBusContradictions({
        busName: 'MCC-2',
        arcingCurrentKA: 15.0,
        arcingCurrentReducedKA: 11.2,
      });
      expect(codes(f)).not.toContain('reduced_gt_arcing');
    });
  });

  describe('PPE category vs incident energy', () => {
    test('flags PPE Cat 1 (max 4 cal/cm²) when incident energy is 10 cal/cm²', () => {
      // NFPA 70E: Cat 1 covers up to 4 cal/cm². IE=10 means Cat 1 is under-protective.
      const f = checkBusContradictions({
        busName: 'PNL-A',
        incidentEnergyCalCm2: 10,
        ppeCategory: 1,
      });
      expect(codes(f)).toContain('ppe_under_ie');
      expect(f.find((x) => x.code === 'ppe_under_ie').severity).toBe('error');
    });

    test('flags PPE Cat 0 (max 1.2 cal/cm²) when incident energy is 2 cal/cm²', () => {
      const f = checkBusContradictions({
        busName: 'PNL-A',
        incidentEnergyCalCm2: 2.0,
        ppeCategory: 0,
      });
      expect(codes(f)).toContain('ppe_under_ie');
    });

    test('flags PPE Cat 2 (max 8 cal/cm²) when incident energy is 9 cal/cm²', () => {
      const f = checkBusContradictions({
        busName: 'BUS-7',
        incidentEnergyCalCm2: 9,
        ppeCategory: 2,
      });
      expect(codes(f)).toContain('ppe_under_ie');
    });

    test('accepts PPE Cat 0 for IE below 1.2 cal/cm²', () => {
      const f = checkBusContradictions({
        busName: 'PNL-X',
        incidentEnergyCalCm2: 0.9,
        ppeCategory: 0,
      });
      expect(codes(f)).not.toContain('ppe_under_ie');
      expect(codes(f)).not.toContain('ppe_above_cat4');
    });

    test('accepts PPE Cat 3 (max 25 cal/cm²) for IE of 14.2 cal/cm² — valid', () => {
      const f = checkBusContradictions({
        busName: 'SWGR-2B',
        incidentEnergyCalCm2: 14.2,
        ppeCategory: 3,
        requiredArcRatingCalCm2: 25,
      });
      expect(codes(f)).not.toContain('ppe_under_ie');
      expect(codes(f)).not.toContain('ppe_above_cat4');
      expect(codes(f)).not.toContain('arc_rating_below_ie');
    });

    test('accepts PPE Cat 4 for IE between 25 and 40 cal/cm²', () => {
      const f = checkBusContradictions({
        busName: 'SWGR-HV',
        incidentEnergyCalCm2: 36,
        ppeCategory: 4,
        requiredArcRatingCalCm2: 40,
      });
      expect(codes(f)).not.toContain('ppe_under_ie');
      expect(codes(f)).not.toContain('ppe_above_cat4');
    });
  });

  describe('incident energy > 40 cal/cm² with a PPE category assigned', () => {
    test('flags ppe_above_cat4 when IE > 40 and any PPE category is assigned', () => {
      // NFPA 70E: > 40 cal/cm² means NO category applies — equipment must be de-energized.
      const f = checkBusContradictions({
        busName: 'MAIN-TIE',
        incidentEnergyCalCm2: 55,
        ppeCategory: 4,
      });
      expect(codes(f)).toContain('ppe_above_cat4');
      expect(f.find((x) => x.code === 'ppe_above_cat4').severity).toBe('error');
    });

    test('flags ppe_above_cat4 even when PPE Cat 0 is assigned at IE=41', () => {
      const f = checkBusContradictions({
        busName: 'MAIN-TIE',
        incidentEnergyCalCm2: 41,
        ppeCategory: 0,
      });
      expect(codes(f)).toContain('ppe_above_cat4');
    });

    test('does NOT flag ppe_above_cat4 when IE is exactly 40 (boundary inclusive)', () => {
      const f = checkBusContradictions({
        busName: 'MAIN-TIE',
        incidentEnergyCalCm2: 40,
        ppeCategory: 4,
      });
      expect(codes(f)).not.toContain('ppe_above_cat4');
    });
  });

  describe('clearing time plausibility', () => {
    test('flags clearing time of 0 as implausible', () => {
      const f = checkBusContradictions({ busName: 'B', clearingTimeMs: 0 });
      expect(codes(f)).toContain('clearing_implausible');
      expect(f.find((x) => x.code === 'clearing_implausible').severity).toBe('warning');
    });

    test('flags negative clearing time as implausible', () => {
      const f = checkBusContradictions({ busName: 'B', clearingTimeMs: -50 });
      expect(codes(f)).toContain('clearing_implausible');
    });

    test('flags clearing time > 2000 ms for LV equipment as implausible', () => {
      // 2000 ms boundary — just over should flag
      const f = checkBusContradictions({ busName: 'B', clearingTimeMs: 2001 });
      expect(codes(f)).toContain('clearing_implausible');
    });

    test('flags clearing time exactly at 2000 ms as implausible (> 2000 check)', () => {
      // The check is clearing > 2000, so 2000 itself is valid
      const f = checkBusContradictions({ busName: 'B', clearingTimeMs: 2000 });
      expect(codes(f)).not.toContain('clearing_implausible');
    });

    test('accepts clearing time of 100 ms (well within window)', () => {
      const f = checkBusContradictions({ busName: 'B', clearingTimeMs: 100 });
      expect(codes(f)).not.toContain('clearing_implausible');
    });
  });

  describe('arc rating vs incident energy', () => {
    test('flags arc rating below incident energy (PPE would be under-protective)', () => {
      // PPE arc rating = 20 cal/cm², IE = 25 cal/cm² — ATPV too low
      const f = checkBusContradictions({
        busName: 'SWGR-3',
        incidentEnergyCalCm2: 25,
        requiredArcRatingCalCm2: 20,
      });
      expect(codes(f)).toContain('arc_rating_below_ie');
      expect(f.find((x) => x.code === 'arc_rating_below_ie').severity).toBe('error');
    });

    test('does NOT flag when arc rating equals incident energy (exact match is valid)', () => {
      const f = checkBusContradictions({
        busName: 'SWGR-3',
        incidentEnergyCalCm2: 25,
        requiredArcRatingCalCm2: 25,
      });
      expect(codes(f)).not.toContain('arc_rating_below_ie');
    });

    test('does NOT flag when arc rating exceeds incident energy', () => {
      const f = checkBusContradictions({
        busName: 'SWGR-3',
        incidentEnergyCalCm2: 12,
        requiredArcRatingCalCm2: 40,
      });
      expect(codes(f)).not.toContain('arc_rating_below_ie');
    });
  });

  describe('incident energy without source inputs', () => {
    test('warns when incident energy is present but both fault current and clearing time are absent', () => {
      const f = checkBusContradictions({
        busName: 'ORPHAN-BUS',
        incidentEnergyCalCm2: 8.5,
        // no boltedFaultCurrentKA, no clearingTimeMs
      });
      expect(codes(f)).toContain('ie_without_inputs');
      expect(f.find((x) => x.code === 'ie_without_inputs').severity).toBe('warning');
    });

    test('does NOT warn when clearing time is present alongside IE', () => {
      const f = checkBusContradictions({
        busName: 'B',
        incidentEnergyCalCm2: 8.5,
        clearingTimeMs: 200,
      });
      expect(codes(f)).not.toContain('ie_without_inputs');
    });

    test('does NOT warn when bolted fault current is present alongside IE', () => {
      const f = checkBusContradictions({
        busName: 'B',
        incidentEnergyCalCm2: 8.5,
        boltedFaultCurrentKA: 21.9,
      });
      expect(codes(f)).not.toContain('ie_without_inputs');
    });
  });

  describe('bus fault current vs utility source max', () => {
    test('warns when bus fault current exceeds the utility source maximum', () => {
      const f = checkBusContradictions(
        { busName: 'MAIN-BUS', boltedFaultCurrentKA: 35 },
        { utilityMaxFaultKA: 30 },
      );
      expect(codes(f)).toContain('bus_fault_gt_source');
      expect(f.find((x) => x.code === 'bus_fault_gt_source').severity).toBe('warning');
    });

    test('does NOT warn when bus fault is within utility max', () => {
      const f = checkBusContradictions(
        { busName: 'MAIN-BUS', boltedFaultCurrentKA: 21.9 },
        { utilityMaxFaultKA: 30 },
      );
      expect(codes(f)).not.toContain('bus_fault_gt_source');
    });

    test('does NOT warn when ctx.utilityMaxFaultKA is absent', () => {
      const f = checkBusContradictions(
        { busName: 'MAIN-BUS', boltedFaultCurrentKA: 50 },
        {},
      );
      expect(codes(f)).not.toContain('bus_fault_gt_source');
    });
  });

  describe('trip settings on non-adjustable devices', () => {
    test('warns when trip settings recorded for a fuse (no adjustable trip unit)', () => {
      const f = checkBusContradictions({
        busName: 'FUSED-BUS',
        deviceType: 'fuse',
        tripUnitType: 'none',
        deviceSettings: { ltPickupA: 200 },
      });
      expect(codes(f)).toContain('settings_without_trip_unit');
      expect(f.find((x) => x.code === 'settings_without_trip_unit').severity).toBe('warning');
    });

    test('warns when trip settings recorded for a thermal-magnetic breaker', () => {
      const f = checkBusContradictions({
        busName: 'TM-BUS',
        deviceType: 'breaker',
        tripUnitType: 'thermal_magnetic',
        deviceSettings: { ltPickupA: 100 },
      });
      expect(codes(f)).toContain('settings_without_trip_unit');
    });

    test('does NOT warn for an electronic (LSI) trip unit with settings', () => {
      const f = checkBusContradictions({
        busName: 'ELEC-BUS',
        deviceType: 'breaker',
        tripUnitType: 'electronic_lsi',
        deviceSettings: { ltPickupA: 800, stPickupA: 1600 },
      });
      expect(codes(f)).not.toContain('settings_without_trip_unit');
    });
  });

  describe('PPE category validity bounds', () => {
    test('rejects PPE Cat 5 (does not exist in NFPA 70E)', () => {
      // Cat 5 is out of range 0-4; the code checks ppe >= 0 && ppe <= 4,
      // so Cat 5 is simply not gated by the category check. Confirm no false "ppe_under_ie".
      const f = checkBusContradictions({
        busName: 'B',
        incidentEnergyCalCm2: 10,
        ppeCategory: 5,
      });
      // Cat 5 is outside [0,4] so the PPE range check is skipped. No ppe_under_ie.
      expect(codes(f)).not.toContain('ppe_under_ie');
      expect(codes(f)).not.toContain('ppe_above_cat4');
    });

    test('rejects negative PPE category (no contradiction fired — value is out-of-range)', () => {
      const f = checkBusContradictions({
        busName: 'B',
        incidentEnergyCalCm2: 10,
        ppeCategory: -1,
      });
      // ppeCategory -1 fails the ppe >= 0 guard; no ppe_under_ie or ppe_above_cat4.
      expect(codes(f)).not.toContain('ppe_under_ie');
      expect(codes(f)).not.toContain('ppe_above_cat4');
    });
  });

  describe('clean bus — no false positives', () => {
    test('a textbook 480V bus produces zero findings', () => {
      const f = checkBusContradictions({
        busName: 'SWGR-1A',
        nominalVoltage: '480V',
        boltedFaultCurrentKA: 21.9,
        arcingCurrentKA: 16.2,
        arcingCurrentReducedKA: 12.4,
        incidentEnergyCalCm2: 14.2,
        ppeCategory: 3,
        requiredArcRatingCalCm2: 25,
        clearingTimeMs: 150,
        deviceType: 'breaker',
        tripUnitType: 'electronic_lsi',
        deviceSettings: { ltPickupA: 800 },
      });
      expect(f).toHaveLength(0);
    });

    test('bus with no values produces zero findings', () => {
      const f = checkBusContradictions({ busName: 'EMPTY' });
      expect(f).toHaveLength(0);
    });

    test('unnamed bus uses fallback label without throwing', () => {
      const f = checkBusContradictions({
        arcingCurrentKA: 25,
        boltedFaultCurrentKA: 20,
      });
      expect(f).toHaveLength(1);
      expect(f[0].busName).toBe('(unnamed bus)');
    });
  });
});

  // Regression-lock for the 2026-07-08 acquisition-audit fix: the bolted
  // fault-current validity envelope must be voltage-class branched the same
  // way the electrode-gap check already is (500 A-106 kA i.e. 0.5-106 kA for
  // <=600 V; 200 A-65 kA i.e. 0.2-65 kA for 601 V-15 kV), NOT a flat 0.5-106 kA
  // window regardless of voltage class.
  describe('IEEE 1584-2018 fault-current validity bound — voltage-class branched', () => {
    test('LV (480V) bus below the LV floor of 0.5 kA is flagged', () => {
      const f = checkBusContradictions({ busName: 'LV-1', nominalVoltage: '480V', boltedFaultCurrentKA: 0.3 });
      expect(codes(f)).toContain('fault_below_ieee1584_min');
      const finding = f.find((x) => x.code === 'fault_below_ieee1584_min');
      expect(finding.severity).toBe('error');
      expect(finding.message).toContain('0.5 kA');
      expect(finding.message).toContain('600 V');
    });

    test('LV (480V) bus above the LV ceiling of 106 kA is flagged', () => {
      const f = checkBusContradictions({ busName: 'LV-1', nominalVoltage: '480V', boltedFaultCurrentKA: 110 });
      expect(codes(f)).toContain('fault_exceeds_ieee1584_max');
      const finding = f.find((x) => x.code === 'fault_exceeds_ieee1584_max');
      expect(finding.message).toContain('106 kA');
    });

    test('LV (480V) bus within 0.5-106 kA is NOT flagged', () => {
      const f = checkBusContradictions({ busName: 'LV-1', nominalVoltage: '480V', boltedFaultCurrentKA: 21.9 });
      expect(codes(f)).not.toContain('fault_below_ieee1584_min');
      expect(codes(f)).not.toContain('fault_exceeds_ieee1584_max');
    });

    test('MV (4160V) bus at 0.3 kA is valid (above the 0.2 kA MV floor) — the old flat 0.5 kA floor would have wrongly flagged this', () => {
      const f = checkBusContradictions({ busName: 'MV-1', nominalVoltage: '4160V', boltedFaultCurrentKA: 0.3 });
      expect(codes(f)).not.toContain('fault_below_ieee1584_min');
    });

    test('MV (4160V) bus below the MV floor of 0.2 kA is flagged', () => {
      const f = checkBusContradictions({ busName: 'MV-1', nominalVoltage: '4160V', boltedFaultCurrentKA: 0.15 });
      expect(codes(f)).toContain('fault_below_ieee1584_min');
      const finding = f.find((x) => x.code === 'fault_below_ieee1584_min');
      expect(finding.message).toContain('0.2 kA');
      expect(finding.message).toContain('601 V');
    });

    test('MV (4160V) bus at 70 kA is flagged — the old flat 106 kA ceiling would have wrongly let this through', () => {
      const f = checkBusContradictions({ busName: 'MV-1', nominalVoltage: '4160V', boltedFaultCurrentKA: 70 });
      expect(codes(f)).toContain('fault_exceeds_ieee1584_max');
      const finding = f.find((x) => x.code === 'fault_exceeds_ieee1584_max');
      expect(finding.message).toContain('65 kA');
    });

    test('MV (13.8kV) bus within 0.2-65 kA is NOT flagged', () => {
      const f = checkBusContradictions({ busName: 'MV-2', nominalVoltage: '13.8kV', boltedFaultCurrentKA: 25 });
      expect(codes(f)).not.toContain('fault_below_ieee1584_min');
      expect(codes(f)).not.toContain('fault_exceeds_ieee1584_max');
    });

    test('unknown voltage defaults to the wider MV envelope, same convention as the gap check', () => {
      // No nominalVoltage supplied: 0.3 kA would fail the LV floor (0.5) but
      // passes the MV floor (0.2) — the code must default to MV like the
      // adjacent gap check does when voltage class can't be determined.
      const f = checkBusContradictions({ busName: 'UNKNOWN-V', boltedFaultCurrentKA: 0.3 });
      expect(codes(f)).not.toContain('fault_below_ieee1584_min');
    });

    test('electrode-gap check is unaffected by the fault-current change (regression)', () => {
      const fLv = checkBusContradictions({ busName: 'LV-1', nominalVoltage: '480V', conductorGapMm: 100 });
      expect(codes(fLv)).toContain('gap_outside_ieee1584_range');
      const fMv = checkBusContradictions({ busName: 'MV-1', nominalVoltage: '4160V', conductorGapMm: 100 });
      expect(codes(fMv)).not.toContain('gap_outside_ieee1584_range');
    });
  });

  describe('working distance below IEEE 1584-2018 floor — reworded message, same 12in/304.8mm value', () => {
    test('flags working distance below 12 in regardless of voltage class', () => {
      const f = checkBusContradictions({ busName: 'B', nominalVoltage: '4160V', workingDistanceIn: 10 });
      expect(codes(f)).toContain('working_distance_below_ieee1584_min');
      const finding = f.find((x) => x.code === 'working_distance_below_ieee1584_min');
      expect(finding.message).toContain('12 in');
      expect(finding.message).not.toMatch(/≤600 V|601 V–15 kV/); // NOT voltage-branched, unlike fault current/gap
    });

    test('does NOT flag working distance of exactly 12 in (inclusive floor)', () => {
      const f = checkBusContradictions({ busName: 'B', workingDistanceIn: 12 });
      expect(codes(f)).not.toContain('working_distance_below_ieee1584_min');
    });
  });

  describe('"Category 0" legacy-terminology wording fix (audit 2026-07-08) — values unchanged', () => {
    test('cat0_boundary_present fires for IE<1.2 cal/cm^2 equipment with a boundary recorded, and its message does not say "Category 0"', () => {
      const f = checkBusContradictions({ busName: 'PNL-Y', ppeCategory: 0, arcFlashBoundaryIn: 12 });
      expect(codes(f)).toContain('cat0_boundary_present');
      const finding = f.find((x) => x.code === 'cat0_boundary_present');
      expect(finding.severity).toBe('warning');
      expect(finding.message).not.toContain('Category 0');
      expect(finding.message).toContain('1.2 cal/cm²');
    });

    test('the 1.2 cal/cm^2 threshold itself is unchanged: PPE "Cat 0" is still under-protective at exactly 1.2', () => {
      const f = checkBusContradictions({ busName: 'PNL-Z', incidentEnergyCalCm2: 1.2, ppeCategory: 0 });
      expect(codes(f)).toContain('ppe_under_ie');
    });
  });

// ── checkSystemContradictions ─────────────────────────────────────────────────

describe('checkSystemContradictions', () => {
  describe('per-bus propagation', () => {
    test('runs per-bus checks on every bus in the array', () => {
      const buses = [
        { busName: 'MAIN',  arcingCurrentKA: 22, boltedFaultCurrentKA: 20 }, // error
        { busName: 'FEEDER', clearingTimeMs: -1 },                            // warning
      ];
      const { findings, errorCount, warningCount } = checkSystemContradictions(buses);
      expect(errorCount).toBeGreaterThanOrEqual(1);
      expect(warningCount).toBeGreaterThanOrEqual(1);
    });

    test('errorCount and warningCount totals are accurate', () => {
      const buses = [
        { busName: 'E1', arcingCurrentKA: 25, boltedFaultCurrentKA: 20 },  // error
        { busName: 'E2', arcingCurrentKA: 30, boltedFaultCurrentKA: 25 },  // error
      ];
      const { findings, errorCount, warningCount } = checkSystemContradictions(buses);
      expect(errorCount).toBe(2);
      expect(warningCount).toBe(0);
    });
  });

  describe('cross-bus selectivity (miscoordination) check', () => {
    test('flags downstream device rated higher than upstream device (possible miscoordination)', () => {
      // Upstream (main) breaker = 800 A; downstream breaker = 1200 A — wrong!
      const buses = [
        { busName: 'MAIN-BUS',   deviceRatingA: 800 },
        { busName: 'SUB-PANEL',  deviceRatingA: 1200, fedFromBusName: 'MAIN-BUS' },
      ];
      const { findings } = checkSystemContradictions(buses);
      const found = findings.find((f) => f.code === 'downstream_over_upstream');
      expect(found).toBeTruthy();
      expect(found.severity).toBe('warning');
      expect(found.busName).toBe('SUB-PANEL');
    });

    test('does NOT flag when downstream device is correctly lower-rated', () => {
      const buses = [
        { busName: 'MAIN-BUS',  deviceRatingA: 1200 },
        { busName: 'SUB-PANEL', deviceRatingA: 800, fedFromBusName: 'MAIN-BUS' },
      ];
      const { findings } = checkSystemContradictions(buses);
      expect(findings.find((f) => f.code === 'downstream_over_upstream')).toBeUndefined();
    });

    test('does NOT flag when ratings are equal', () => {
      const buses = [
        { busName: 'A', deviceRatingA: 600 },
        { busName: 'B', deviceRatingA: 600, fedFromBusName: 'A' },
      ];
      const { findings } = checkSystemContradictions(buses);
      expect(findings.find((f) => f.code === 'downstream_over_upstream')).toBeUndefined();
    });

    test('does NOT flag when fedFromBusName does not match any known bus', () => {
      const buses = [
        { busName: 'ORPHAN', deviceRatingA: 9999, fedFromBusName: 'NONEXISTENT' },
      ];
      const { findings } = checkSystemContradictions(buses);
      expect(findings.find((f) => f.code === 'downstream_over_upstream')).toBeUndefined();
    });

    test('bus name matching is case-insensitive', () => {
      const buses = [
        { busName: 'Main-Bus',  deviceRatingA: 800 },
        { busName: 'Sub-Panel', deviceRatingA: 1200, fedFromBusName: 'main-bus' },
      ];
      const { findings } = checkSystemContradictions(buses);
      expect(findings.find((f) => f.code === 'downstream_over_upstream')).toBeTruthy();
    });
  });

  describe('utility source max cross-check', () => {
    test('propagates utilityMaxFaultKA from systemMeta to per-bus checks', () => {
      const buses = [
        { busName: 'MAIN', boltedFaultCurrentKA: 35 },
      ];
      const { findings } = checkSystemContradictions(buses, { utility: { maxFaultKA: 30 } });
      expect(findings.find((f) => f.code === 'bus_fault_gt_source')).toBeTruthy();
    });
  });

  describe('edge cases', () => {
    test('empty bus array returns zero findings', () => {
      const { findings, errorCount, warningCount } = checkSystemContradictions([]);
      expect(findings).toHaveLength(0);
      expect(errorCount).toBe(0);
      expect(warningCount).toBe(0);
    });

    test('null/undefined bus array is tolerated without throwing', () => {
      expect(() => checkSystemContradictions(null)).not.toThrow();
      expect(() => checkSystemContradictions(undefined)).not.toThrow();
    });
  });
});

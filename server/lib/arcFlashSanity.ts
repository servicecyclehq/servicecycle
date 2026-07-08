/**
 * lib/arcFlashSanity.ts — Slice 2.8c: contradiction / study sanity-check engine.
 *
 * Auto-flag arc-flash data that is physically impossible or internally
 * inconsistent, so a reviewer (and the PE) catch transcription / extraction /
 * modeling errors before they ride into a posted label. Every check is
 * DETERMINISTIC and standards-grounded (engineering-guidelines #7) — never an LLM
 * judgement. SC raises the flag; the licensed PE adjudicates.
 *
 * Per-bus checks:
 *   - arcing current cannot exceed bolted fault current (IEEE 1584)
 *   - reduced arcing current cannot exceed arcing current
 *   - required arc rating (ATPV) must be >= incident energy (else PPE is
 *     under-protective)
 *   - PPE category must cover the incident energy (NFPA 70E 130.7 arc ratings:
 *     Cat 1 4, Cat 2 8, Cat 3 25, Cat 4 40 cal/cm^2); > 40 cal/cm^2 = no category
 *   - trip SETTINGS recorded for a device with no adjustable trip unit
 *     (fuse / switch / thermal-magnetic) — "settings that violate the device"
 *   - incident energy present without the fault current / clearing time it
 *     derives from
 *   - clearing time outside a plausible 0-2000 ms window
 *   - bus available fault current exceeds the utility source max (model error)
 *
 * Cross-bus (topology) check:
 *   - a downstream device rated HIGHER than its upstream device (selectivity /
 *     miscoordination proxy)
 */

'use strict';

export type Severity = 'error' | 'warning';
export interface Finding { busName: string; code: string; severity: Severity; message: string; detail?: string; }

// NFPA 70E PPE-category arc ratings (cal/cm^2). The assigned category must have an
// arc rating >= the incident energy at the working distance.
// IE < 1.2 cal/cm² (no arc-flash PPE required). "Category 0" was legacy NFPA 70E
// terminology removed in the 2015 edition; the 1.2 cal/cm² threshold itself is
// still correct — only the label was wrong. The record key `0` below is kept
// purely as an internal index (mirrors the ppeCategory field's own 0..4 values
// from the sealed study) and is never surfaced as "Category 0" in messages.
const PPE_CATEGORY_CAL: Record<number, number> = { 0: 1.2, 1: 4, 2: 8, 3: 25, 4: 40 };

function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function present(v: any): boolean {
  if (v == null || v === '') return false;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

function busKey(name: any): string { return String(name == null ? '' : name).trim().toLowerCase(); }

/**
 * Run the per-bus contradiction checks. `ctx.utilityMaxFaultKA` (optional) enables
 * the source cross-check. Returns the findings for this bus.
 */
export function checkBusContradictions(bus: any, ctx: { utilityMaxFaultKA?: number | null } = {}): Finding[] {
  const out: Finding[] = [];
  const name = bus.busName || '(unnamed bus)';
  const add = (code: string, severity: Severity, message: string, detail?: string) => out.push({ busName: name, code, severity, message, detail });

  const bolted = num(bus.boltedFaultCurrentKA);
  const arcing = num(bus.arcingCurrentKA);
  const arcingReduced = num(bus.arcingCurrentReducedKA);
  const ie = num(bus.incidentEnergyCalCm2);
  const arcRating = num(bus.requiredArcRatingCalCm2);
  const ppe = num(bus.ppeCategory);
  const clearing = num(bus.clearingTimeMs);

  // 1. Arcing current cannot exceed bolted fault current.
  if (bolted != null && arcing != null && arcing > bolted) {
    add('arcing_gt_bolted', 'error', 'Arcing current exceeds bolted fault current (physically impossible).', `${arcing} kA arcing > ${bolted} kA bolted`);
  }
  // 2. Reduced arcing current cannot exceed arcing current.
  if (arcing != null && arcingReduced != null && arcingReduced > arcing) {
    add('reduced_gt_arcing', 'error', 'Reduced arcing current exceeds arcing current.', `${arcingReduced} kA > ${arcing} kA`);
  }
  // 3. Required arc rating must cover incident energy.
  if (ie != null && arcRating != null && arcRating < ie) {
    add('arc_rating_below_ie', 'error', 'Required arc rating is below the incident energy — PPE would be under-protective.', `${arcRating} cal/cm^2 rating < ${ie} cal/cm^2 incident energy`);
  }
  // 4. PPE category must cover incident energy.
  // [AFX-1] Use <= (not <) so the boundary case (ie === PPE_CATEGORY_CAL[ppe]) is
  // flagged as under-protective. E.g. Cat 0 covers IE < 1.2; at exactly 1.2 the PPE
  // is insufficient and the worker needs Cat 1 per NFPA 70E Table 130.7(C)(15)(a).
  if (ie != null && ppe != null && ppe >= 0 && ppe <= 4) {
    if (ie > 40) {
      add('ppe_above_cat4', 'error', 'Incident energy exceeds 40 cal/cm^2 — no PPE category applies; the equipment should be de-energized.', `${ie} cal/cm^2 with PPE Cat ${ppe} assigned`);
    } else if (PPE_CATEGORY_CAL[ppe] != null && PPE_CATEGORY_CAL[ppe] <= ie) {
      add('ppe_under_ie', 'error', 'Assigned PPE category does not cover the incident energy.', `Cat ${ppe} (${PPE_CATEGORY_CAL[ppe]} cal/cm^2) <= ${ie} cal/cm^2`);
    }
  }
  // 5. Trip settings recorded for a device that has no adjustable trip unit.
  const devType = String(bus.deviceType || '').toLowerCase();
  const tripUnit = String(bus.tripUnitType || '').toLowerCase();
  const adjustable = tripUnit === 'electronic_lsi' || tripUnit === 'electronic_lsig' || devType === 'relay';
  const nonAdjustable = devType === 'fuse' || devType === 'switch' || tripUnit === 'none' || tripUnit === 'thermal_magnetic';
  if (present(bus.deviceSettings) && !adjustable && nonAdjustable) {
    add('settings_without_trip_unit', 'warning', 'Trip settings recorded for a device with no adjustable trip unit (fuse / switch / thermal-magnetic).', `deviceType=${devType || 'n/a'}, tripUnit=${tripUnit || 'n/a'}`);
  }
  // 6. Incident energy with no fault current / clearing time behind it.
  if (ie != null && bolted == null && clearing == null) {
    add('ie_without_inputs', 'warning', 'Incident energy is present without the fault current or clearing time it derives from — confirm its source.');
  }
  // 7. Clearing time plausibility.
  if (clearing != null && (clearing <= 0 || clearing > 2000)) {
    add('clearing_implausible', 'warning', 'Clearing time is outside the plausible 0-2000 ms window.', `${clearing} ms`);
  }
  // 8. Bus fault current exceeds the utility source max.
  const uMax = num(ctx.utilityMaxFaultKA);
  if (bolted != null && uMax != null && bolted > uMax) {
    add('bus_fault_gt_source', 'warning', 'Bus available fault current exceeds the utility source maximum — check the model.', `${bolted} kA bus > ${uMax} kA utility max`);
  }

  // [AFX-5] The AC PPE-Category (table) Method is not applicable above 15 kV — the
  // selection table NFPA 70E 2024 Table 130.7(C)(15)(a) tops out at 15 kV. Above that the
  // Incident Energy Analysis Method is required. (130.7(C)(15)(b) is the DC table.)
  const nomV = num(bus.nominalVoltage != null ? String(bus.nominalVoltage).replace(/[^0-9.]/g, '') : null);
  const nomVKv = bus.nominalVoltage != null && /kv/i.test(String(bus.nominalVoltage)) ? (nomV != null ? nomV * 1000 : null) : nomV;
  if (bus.ppeMethod === 'ppe_category' && nomVKv != null && nomVKv > 15000) {
    add('ppe_category_exceeds_voltage_limit', 'error',
      'PPE Category (table) Method (Table 130.7(C)(15)(a)) is not applicable above 15 kV per NFPA 70E 2024. Use the Incident Energy Analysis Method at this voltage.',
      `nominalVoltage=${bus.nominalVoltage}, ppeMethod=ppe_category`);
  }

  // [AFX-9] IEEE 1584-2018 input range validation. The model's bolted (available)
  // fault-current validity envelope is voltage-class dependent, same as the
  // electrode-gap range right below: 500 A–106 kA (0.5–106 kA) for ≤600 V, but
  // only 200 A–65 kA (0.2–65 kA) for 601 V–15 kV (audit 2026-07-08 correction —
  // a prior flat 0.5–106 kA window regardless of voltage class both missed MV
  // buses outside 65–106 kA and false-flagged valid MV buses at 200–500 A).
  const boltedKA = num(bus.boltedFaultCurrentKA);
  const gapMm    = num(bus.conductorGapMm);
  const wdIn     = num(bus.workingDistanceIn);
  if (boltedKA != null) {
    // Default to the wider MV envelope when voltage is unknown, same convention
    // as the gap check below, so we don't false-flag a valid MV study.
    const lvClassFault = nomVKv != null && nomVKv <= 600;
    const faultMinKA = lvClassFault ? 0.5 : 0.2;
    const faultMaxKA = lvClassFault ? 106 : 65;
    const voltageLabel = lvClassFault ? '≤600 V' : '601 V–15 kV';
    if (boltedKA < faultMinKA) {
      add('fault_below_ieee1584_min', 'error',
        `Available (bolted) fault current is below the IEEE 1584-2018 minimum of ${faultMinKA} kA for ${voltageLabel} — results are outside model validity.`,
        `boltedFaultCurrentKA=${boltedKA}, nominalVoltage=${bus.nominalVoltage ?? 'n/a'}`);
    }
    if (boltedKA > faultMaxKA) {
      add('fault_exceeds_ieee1584_max', 'error',
        `Bolted fault current exceeds IEEE 1584-2018 maximum of ${faultMaxKA} kA for ${voltageLabel} — results are outside model validity.`,
        `boltedFaultCurrentKA=${boltedKA}, nominalVoltage=${bus.nominalVoltage ?? 'n/a'}`);
    }
  }
  // Electrode-gap validity is voltage-class dependent: 6.35–76.2 mm for ≤600 V,
  // 19.05–254 mm for 601 V–15 kV. Default to the wider MV envelope when voltage is
  // unknown so we don't false-flag a valid MV study.
  if (gapMm != null) {
    const lvClass = nomVKv != null && nomVKv <= 600;
    const gapMin = lvClass ? 6.35 : 19.05;
    const gapMax = lvClass ? 76.2 : 254;
    if (gapMm < gapMin || gapMm > gapMax) {
      add('gap_outside_ieee1584_range', 'error',
        `Conductor gap ${gapMm} mm is outside the IEEE 1584-2018 valid range (${gapMin}–${gapMax} mm for ${lvClass ? '≤600 V' : '601 V–15 kV'}).`,
        `conductorGapMm=${gapMm}, nominalVoltage=${bus.nominalVoltage ?? 'n/a'}`);
    }
  }
  // Unlike fault current and gap above, IEEE 1584-2018's working-distance floor
  // is NOT voltage-class branched — it is a single "greater than or equal to
  // 12 in (304.8 mm)" bound that applies across the model's full 208 V–15 kV
  // range. Below 12 in the worker is effectively within the arc plasma cloud
  // itself, so the model's empirical fit (built from tests no closer than 12 in)
  // isn't just "unvalidated" data-entry-wise — the physical premise of a
  // measured working distance breaks down. Reworded 2026-07-08 (audit) for
  // precision; the 12 in / 304.8 mm value itself was already correct.
  if (wdIn != null && wdIn < 12) {
    add('working_distance_below_ieee1584_min', 'error',
      'Working distance is below the IEEE 1584-2018 validity floor of 12 in (304.8 mm), applicable at all voltage classes — the arc-flash model is not empirically validated this close to the arc (the worker would be within the plasma cloud). Confirm the recorded working distance before relying on this result.',
      `workingDistanceIn=${wdIn}`);
  }

  // [AFX-12] NFPA 70E 2024 Table 130.7(C)(15)(a) Note 3: no AFPB required at Cat 0.
  const ppeCategory = num(bus.ppeCategory);
  const afbIn = num(bus.arcFlashBoundaryIn);
  if (ppeCategory === 0 && afbIn != null) {
    out.push({ busName: name, code: 'cat0_boundary_present', severity: 'warning',
      message: 'Equipment with IE < 1.2 cal/cm² (no arc-flash PPE required) does not require an Arc Flash Protection Boundary per NFPA 70E 2024 Table 130.7(C)(15)(a) Note 3. Verify this value.' });
  }

  return out;
}

/**
 * Run per-bus checks across a system plus the cross-bus selectivity proxy.
 * `systemMeta.utility.maxFaultKA` feeds the source cross-check. Pure.
 */
export function checkSystemContradictions(buses: any[], systemMeta: any = {}): { findings: Finding[]; errorCount: number; warningCount: number } {
  const utilityMaxFaultKA = num(systemMeta && systemMeta.utility && systemMeta.utility.maxFaultKA);
  const findings: Finding[] = [];
  for (const b of buses || []) findings.push(...checkBusContradictions(b, { utilityMaxFaultKA }));

  // Cross-bus: a downstream device rated higher than its upstream device.
  const byKey = new Map<string, any>();
  for (const b of buses || []) byKey.set(busKey(b.busName), b);
  for (const b of buses || []) {
    const up = b.fedFromBusName ? byKey.get(busKey(b.fedFromBusName)) : null;
    if (!up) continue;
    const dn = num(b.deviceRatingA);
    const upRating = num(up.deviceRatingA);
    if (dn != null && upRating != null && dn > upRating) {
      findings.push({
        busName: b.busName || '(unnamed bus)', code: 'downstream_over_upstream', severity: 'warning',
        message: 'Downstream protective device is rated higher than its upstream device — possible miscoordination / selectivity issue.',
        detail: `${b.busName} ${dn} A fed from ${up.busName} ${upRating} A`,
      });
    }
  }

  return {
    findings,
    errorCount: findings.filter((f) => f.severity === 'error').length,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
  };
}

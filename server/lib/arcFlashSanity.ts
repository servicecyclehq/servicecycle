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
// Cat 0: IE < 1.2 cal/cm² — no arc flash boundary; Cat 0 PPE applies.
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
  if (ie != null && ppe != null && ppe >= 0 && ppe <= 4) {
    if (ie > 40) {
      add('ppe_above_cat4', 'error', 'Incident energy exceeds 40 cal/cm^2 — no PPE category applies; the equipment should be de-energized.', `${ie} cal/cm^2 with PPE Cat ${ppe} assigned`);
    } else if (PPE_CATEGORY_CAL[ppe] != null && PPE_CATEGORY_CAL[ppe] < ie) {
      add('ppe_under_ie', 'error', 'Assigned PPE category does not cover the incident energy.', `Cat ${ppe} (${PPE_CATEGORY_CAL[ppe]} cal/cm^2) < ${ie} cal/cm^2`);
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

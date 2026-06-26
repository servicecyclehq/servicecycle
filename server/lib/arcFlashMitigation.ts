/**
 * lib/arcFlashMitigation.ts — Slice 4 / 4.5: incident-energy-reduction upsell +
 * what-if ROI.
 *
 * Two deterministic, HONEST pieces:
 *  - recommendMitigations(bus): which standard energy-reduction / worker-safety
 *    options apply to a bus, EXCLUDING ones already present. Directional only — it
 *    never asserts a recalculated incident energy (SC is the data layer; it does
 *    not run IEEE 1584). Each option carries the mechanism + a "verify by re-study"
 *    caveat.
 *  - estimateMitigationRoi(...): given the CURRENT incident energy, a USER/PE-
 *    supplied expected reduction %, and an estimated mitigation cost, computes the
 *    energy-after, PPE-category change, whether it clears the >40 cal DANGER line,
 *    and $/cal-reduced. The reduction % is an input, not a claim — the engine only
 *    does the arithmetic.
 */

'use strict';

function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseVolts(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /kv/i.test(m[2] || '') ? n * 1000 : n;
}

const VERIFY = 'Estimated effect only — a licensed PE re-runs the IEEE 1584 study to confirm the reduced value.';

interface MitigationDef {
  key: string;
  label: string;
  category: 'reduce_energy' | 'improve_safety';
  presentFlag: string | null; // bus field that, when true, means it's already in place
  mechanism: string;
  applies: (ctx: { volts: number | null; deviceType: string; tripUnit: string; danger: boolean }) => boolean;
  caveat: string;
}

const MITIGATIONS: MitigationDef[] = [
  {
    key: 'maintenance_mode_erms', label: 'Energy-reducing maintenance switch (ERMS)', category: 'reduce_energy', presentFlag: 'ermsPresent',
    mechanism: 'A temporary maintenance setting lowers the instantaneous trip so the breaker clears an arcing fault faster while workers are exposed.',
    applies: ({ deviceType, tripUnit }) => deviceType === 'breaker' || tripUnit.startsWith('electronic') || deviceType === 'relay',
    caveat: VERIFY + ' NEC 240.87 documentation required.',
  },
  {
    key: 'lower_instantaneous', label: 'Lower / add instantaneous trip', category: 'reduce_energy', presentFlag: null,
    mechanism: 'A lower instantaneous pickup clears high-current arcing faults in the fast region of the curve.',
    applies: ({ tripUnit, deviceType }) => tripUnit === 'electronic_lsi' || tripUnit === 'electronic_lsig' || deviceType === 'relay',
    caveat: VERIFY + ' Confirm coordination is preserved.',
  },
  {
    key: 'current_limiting_fuse', label: 'Current-limiting fuses', category: 'reduce_energy', presentFlag: null,
    mechanism: 'Current-limiting fuses cut off let-through energy within the first half-cycle in their current-limiting range.',
    applies: ({ volts }) => volts == null || volts <= 600,
    caveat: VERIFY + ' Effective only above the fuse current-limiting threshold.',
  },
  {
    key: 'zsi', label: 'Zone-selective interlocking (ZSI)', category: 'reduce_energy', presentFlag: 'zsiEnabled',
    mechanism: 'The upstream device clears a downstream bus fault without waiting out its intentional short-time delay.',
    applies: ({ tripUnit }) => tripUnit === 'electronic_lsig' || tripUnit === 'electronic_lsi',
    caveat: VERIFY,
  },
  {
    key: 'differential_relay', label: 'Bus differential / arc-flash relay (87 / light-sensing)', category: 'reduce_energy', presentFlag: 'differentialPresent',
    mechanism: 'Optical light-sensing or bus-differential protection trips in a few milliseconds, well before the overcurrent curve.',
    applies: ({ volts }) => volts != null && volts > 600,
    caveat: VERIFY,
  },
  {
    key: 'arc_resistant', label: 'Arc-resistant gear / remote racking', category: 'improve_safety', presentFlag: 'arcResistant',
    mechanism: 'Arc-resistant construction redirects blast energy away from the worker, and remote racking removes the worker from the arc-flash boundary. (Worker safety — does not lower the calculated incident energy.)',
    applies: ({ volts }) => volts != null && volts > 600,
    caveat: 'Improves worker protection; the posted incident energy is unchanged.',
  },
];

/**
 * Recommend applicable, not-yet-present mitigations for a bus. Pure + directional.
 */
export function recommendMitigations(bus: any): { danger: boolean; options: any[]; note: string } {
  const volts = parseVolts(bus.nominalVoltage);
  const ie = num(bus.incidentEnergyCalCm2);
  const danger = (ie != null && ie > 40) || (volts != null && volts > 600);
  const ctx = { volts, deviceType: String(bus.deviceType || '').toLowerCase(), tripUnit: String(bus.tripUnitType || '').toLowerCase(), danger };

  const options = MITIGATIONS
    .filter((m) => !(m.presentFlag && bus[m.presentFlag] === true))
    .filter((m) => m.applies(ctx))
    .map((m) => ({ key: m.key, label: m.label, category: m.category, mechanism: m.mechanism, caveat: m.caveat }));

  const note = danger
    ? 'This bus is in the DANGER class. Consider the energy-reduction options below, then request a quote. ServiceCycle is the data layer; a PE confirms the reduced value by re-study.'
    : 'Options to reduce incident energy or improve worker protection. A PE confirms any reduction by re-study.';
  return { danger, options, note };
}

// NFPA 70E PPE-category arc ratings (cal/cm^2) — for the what-if PPE-band change.
const PPE_BANDS: Array<[number, number]> = [[4, 1], [8, 2], [25, 3], [40, 4]];
function ppeCategoryFor(ie: number | null): number | null {
  if (ie == null) return null;
  // NFPA 70E: below 1.2 cal/cm² no arc flash boundary exists — no PPE category applies.
  if (ie < 1.2) return null;
  // > 40 cal -> DANGER, no category (de-energize; do not work energized).
  if (ie > 40) return null;
  for (const [cal, cat] of PPE_BANDS) if (ie <= cal) return cat;
  return null; // safety net — unreachable given the >40 guard above
}

/**
 * What-if ROI. The reduction % is a USER/PE estimate (an input), not a computed
 * IEEE 1584 result. Pure arithmetic + caveat.
 */
export function estimateMitigationRoi(opts: { currentIeCalCm2: any; estReductionPct: any; mitigationCostUsd?: any }): any {
  const ie = num(opts.currentIeCalCm2);
  let pct = num(opts.estReductionPct);
  if (pct == null) pct = 0;
  pct = Math.max(0, Math.min(100, pct));
  const cost = num(opts.mitigationCostUsd);

  if (ie == null) return { ok: false, reason: 'No current incident energy on this bus to model against.' };

  const ieAfter = Math.round(ie * (1 - pct / 100) * 100) / 100;
  const calReduced = Math.round((ie - ieAfter) * 100) / 100;
  const removesDanger = ie > 40 && ieAfter <= 40;
  const ppeBefore = ppeCategoryFor(ie);
  const ppeAfter = ppeCategoryFor(ieAfter);
  const costPerCalReduced = cost != null && calReduced > 0 ? Math.round((cost / calReduced) * 100) / 100 : null;

  return {
    ok: true,
    currentIeCalCm2: ie, estReductionPct: pct, ieAfterCalCm2: ieAfter, calReduced,
    ppeBefore, ppeAfter, ppeImproved: ppeBefore != null && ppeAfter != null && ppeAfter < ppeBefore,
    removesDanger, mitigationCostUsd: cost, costPerCalReduced,
    caveat: 'The reduction percentage is your (or your PE\'s) estimate — ServiceCycle does not run the IEEE 1584 calculation. Confirm the modeled value with a re-study before relabeling.',
  };
}

export { ppeCategoryFor };

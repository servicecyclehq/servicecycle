/**
 * lib/arcFlashTccLibrary.ts — Slice 3.5d: a small, curated OEM device library so a
 * photographed/typed nameplate becomes a STRUCTURED device (manufacturer, series,
 * type, trip unit, frame range) pointing at the manufacturer's published TCC.
 *
 * HONEST BY DESIGN: this is a deterministic SEED library, not a TCC engine. It
 * identifies the device and offers a CLASS-TYPICAL instantaneous-region clearing
 * time as a draft default — the real clearing time still derives from the
 * published TCC at the bus's available fault current, and a licensed PE confirms
 * it. Every suggestion is flagged "typical — verify against the published TCC."
 *
 * Class-typical clearing times (instantaneous / high-fault region), in cycles @
 * 60 Hz -> ms: molded-case breaker ~0.5-1 cycle (~8-16 ms); insulated-case /
 * low-voltage power breaker w/ instantaneous ~1-1.5 cycle (~16-25 ms); current-
 * limiting fuse sub-cycle in its current-limiting range (~4-8 ms). These are
 * representative figures, NOT product guarantees.
 */

'use strict';

export interface TccEntry {
  manufacturer: string;
  series: string;
  aliases: string[]; // lower-case substrings that identify this series on a nameplate
  deviceType: 'breaker' | 'fuse';
  tripUnitType?: 'thermal_magnetic' | 'electronic_lsi' | 'electronic_lsig' | 'none';
  fuseClass?: string;
  frameMinA: number;
  frameMaxA: number;
  typicalClearingTimeMs: number; // class-typical instantaneous-region clearing time
  curveRef: string;
}

// Representative, widely-deployed protective devices. Kept intentionally small +
// general (class-level), expandable later. Times are class typicals (see header).
export const TCC_LIBRARY: TccEntry[] = [
  { manufacturer: 'Schneider / Square D', series: 'PowerPact H/J/L', aliases: ['powerpact', 'powerpac', 'square d', 'squared'], deviceType: 'breaker', tripUnitType: 'electronic_lsig', frameMinA: 15, frameMaxA: 600, typicalClearingTimeMs: 16, curveRef: 'Square D PowerPact TCC (Micrologic)' },
  { manufacturer: 'Schneider / Square D', series: 'Masterpact NW/NT', aliases: ['masterpact', 'masterpac'], deviceType: 'breaker', tripUnitType: 'electronic_lsig', frameMinA: 800, frameMaxA: 6300, typicalClearingTimeMs: 25, curveRef: 'Masterpact Micrologic TCC' },
  { manufacturer: 'Eaton', series: 'Series C (F/J/K/L)', aliases: ['series c', 'eaton', 'cutler', 'hammer'], deviceType: 'breaker', tripUnitType: 'thermal_magnetic', frameMinA: 15, frameMaxA: 1200, typicalClearingTimeMs: 12, curveRef: 'Eaton Series C TCC' },
  { manufacturer: 'Eaton', series: 'Magnum DS', aliases: ['magnum', 'magnum ds'], deviceType: 'breaker', tripUnitType: 'electronic_lsig', frameMinA: 800, frameMaxA: 6400, typicalClearingTimeMs: 25, curveRef: 'Eaton Magnum Digitrip TCC' },
  { manufacturer: 'ABB', series: 'Tmax XT', aliases: ['tmax', 'tmax xt', 'abb'], deviceType: 'breaker', tripUnitType: 'electronic_lsig', frameMinA: 10, frameMaxA: 1600, typicalClearingTimeMs: 16, curveRef: 'ABB Tmax XT Ekip TCC' },
  { manufacturer: 'ABB', series: 'Emax 2', aliases: ['emax', 'emax 2'], deviceType: 'breaker', tripUnitType: 'electronic_lsig', frameMinA: 630, frameMaxA: 6300, typicalClearingTimeMs: 25, curveRef: 'ABB Emax 2 Ekip TCC' },
  { manufacturer: 'GE', series: 'Spectra RMS', aliases: ['spectra', 'general electric', '\bge\b'], deviceType: 'breaker', tripUnitType: 'electronic_lsig', frameMinA: 15, frameMaxA: 1200, typicalClearingTimeMs: 16, curveRef: 'GE Spectra RMS TCC' },
  { manufacturer: 'Siemens', series: 'Sentron VL', aliases: ['sentron', 'siemens', 'vl breaker'], deviceType: 'breaker', tripUnitType: 'electronic_lsig', frameMinA: 15, frameMaxA: 1600, typicalClearingTimeMs: 16, curveRef: 'Siemens Sentron TCC' },
  { manufacturer: 'Eaton / Bussmann', series: 'Low-Peak LPS-RK', aliases: ['lps-rk', 'low-peak', 'lowpeak', 'bussmann', 'lpn-rk'], deviceType: 'fuse', fuseClass: 'RK1', frameMinA: 1, frameMaxA: 600, typicalClearingTimeMs: 8, curveRef: 'Bussmann Low-Peak RK1 TCC (current-limiting)' },
  { manufacturer: 'Mersen', series: 'Amp-Trap AJT', aliases: ['amp-trap', 'amptrap', 'ajt', 'mersen', 'ferraz'], deviceType: 'fuse', fuseClass: 'J', frameMinA: 1, frameMaxA: 600, typicalClearingTimeMs: 6, curveRef: 'Mersen Amp-Trap Class J TCC (current-limiting)' },
  { manufacturer: 'Eaton / Bussmann', series: 'KRP-C Hi-Cap', aliases: ['krp-c', 'hi-cap', 'class l'], deviceType: 'fuse', fuseClass: 'L', frameMinA: 601, frameMaxA: 6000, typicalClearingTimeMs: 8, curveRef: 'Bussmann KRP-C Class L TCC (current-limiting)' },
];

const TYPICAL_NOTE = 'Class-typical instantaneous-region clearing time — verify against the published TCC at the bus available fault current.';

function norm(s: any): string { return String(s || '').toLowerCase(); }

/**
 * Search the library. Ranks by manufacturer/series/alias text match, device type,
 * and whether the rating falls within the frame range. Pure.
 */
export function searchTcc(query: { manufacturer?: string; model?: string; deviceType?: string; ratingA?: number; q?: string } = {}): Array<TccEntry & { score: number; note: string }> {
  const hay = norm([query.q, query.manufacturer, query.model].filter(Boolean).join(' '));
  const wantType = norm(query.deviceType);
  const rating = query.ratingA != null && Number.isFinite(Number(query.ratingA)) ? Number(query.ratingA) : null;

  const scored = TCC_LIBRARY.map((e) => {
    let score = 0;
    for (const a of e.aliases) if (a && hay.includes(a.replace(/\\b/g, ''))) score += 3;
    if (hay && norm(e.manufacturer).split(/[\s/]+/).some((w) => w.length > 2 && hay.includes(w))) score += 1;
    if (wantType && e.deviceType === wantType) score += 2;
    if (rating != null && rating >= e.frameMinA && rating <= e.frameMaxA) score += 2;
    return { ...e, score, note: TYPICAL_NOTE };
  }).filter((e) => e.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Best single match for a collected device, plus a typical clearing-time
 * suggestion + the structured device identity to apply. Returns null if no match.
 */
export function suggestFromDevice(device: { manufacturer?: string; model?: string; deviceType?: string; ratingA?: number } = {}): any {
  const matches = searchTcc({ manufacturer: device.manufacturer, model: device.model, deviceType: device.deviceType, ratingA: device.ratingA });
  const best = matches[0];
  if (!best) return null;
  return {
    manufacturer: best.manufacturer,
    series: best.series,
    deviceType: best.deviceType,
    tripUnitType: best.tripUnitType || null,
    fuseClass: best.fuseClass || null,
    suggestedClearingTimeMs: best.typicalClearingTimeMs,
    curveRef: best.curveRef,
    note: best.note,
    confidence: best.score >= 5 ? 'good' : 'weak',
  };
}

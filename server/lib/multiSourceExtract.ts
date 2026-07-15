/**
 * lib/multiSourceExtract.ts -- best-effort derivation of multi-source topology from an
 * extracted one-line model. PURE (no IO), unit-tested against a synthetic model only.
 *
 * ACCURACY IS UNVERIFIED against real drawings and needs Dustin in the loop -- treat the
 * output as a strong draft a human corrects, never a stamp. This intentionally does NOT
 * edit the large lib/arcFlashExtract.ts prompt/parse path (truncation-prone); wiring these
 * device classes + A/B + dual-corded hints into the live extractor prompt is the documented
 * human-iteration follow-on. Here we only turn whatever hints the extractor already surfaces
 * (side, second feeder, transfer alternate, source role) into AssetFeed-shaped edges + gap
 * flags, so the redundancy engine has something to chew on and reviewers see the gaps.
 */

export type MSSourceKind = 'utility' | 'generator' | 'grid' | 'ups' | 'bess' | 'derived';
export type MSRole = 'normal' | 'alternate' | 'emergency' | 'bypass';

export interface ExtractedBus {
  busName: string;
  equipmentType?: string | null;
  fedFromBusName?: string | null;
  side?: 'A' | 'B' | null;
  sourceRole?: string | null;
  secondFeedFromBusName?: string | null;
  alternateSourceBusName?: string | null;
  transferType?: string | null; // 'ATS' | 'STS'
  redundancyZone?: string | null; // e.g. '2N' if the drawing labels the zone
}
export interface ExtractedModel {
  buses?: ExtractedBus[];
}

export interface DerivedFeed {
  loadBusName: string;
  sourceBusName: string;
  role: MSRole;
  side: 'A' | 'B' | null;
  sourceKind: MSSourceKind;
  transferBusName: string | null;
}
export interface DerivedGap {
  code: 'MISSED_FEED' | 'INCOMPLETE_TRANSFER' | 'UNTRACED_ALTERNATE' | 'REDUNDANCY_CONTRADICTION';
  busName: string;
  message: string;
}
export interface DerivedTopology {
  feeds: DerivedFeed[];
  sides: Record<string, 'A' | 'B' | null>;
  dualCorded: string[];
  sourceKinds: Record<string, MSSourceKind | undefined>;
  gaps: DerivedGap[];
}

function sideFromName(name: string): 'A' | 'B' | null {
  const s = name.toUpperCase();
  if (/\bSIDE\s*A\b|\bTRAIN\s*A\b|(^|[\s\-_])A($|[\s\-_\d])/.test(s)) return 'A';
  if (/\bSIDE\s*B\b|\bTRAIN\s*B\b|(^|[\s\-_])B($|[\s\-_\d])/.test(s)) return 'B';
  return null;
}
function inferSide(bus: ExtractedBus): 'A' | 'B' | null {
  return bus.side ?? sideFromName(bus.busName);
}
function inferSourceKind(bus: ExtractedBus): MSSourceKind | undefined {
  const hay = `${bus.equipmentType ?? ''} ${bus.sourceRole ?? ''} ${bus.busName}`.toUpperCase();
  if (/UTIL/.test(hay)) return 'utility';
  if (/\bGEN|GENSET|GENERATOR|PARALLEL/.test(hay)) return 'generator';
  if (/\bUPS\b/.test(hay)) return 'ups';
  if (/BESS|BATTERY/.test(hay)) return 'bess';
  if (/\bGRID\b/.test(hay)) return 'grid';
  return undefined;
}
function is2NZone(bus: ExtractedBus): boolean {
  const z = (bus.redundancyZone ?? '').toUpperCase().replace(/\s+/g, '');
  return z.startsWith('2N') || z === 'TWON' || z === 'TWO_N';
}
function roleFrom(bus: ExtractedBus, fallback: MSRole): MSRole {
  const r = (bus.sourceRole ?? '').toLowerCase();
  if (r === 'emergency' || r === 'alternate' || r === 'bypass' || r === 'normal') return r as MSRole;
  return fallback;
}

export function deriveMultiSourceTopology(model: ExtractedModel): DerivedTopology {
  const buses = model.buses ?? [];
  const known = new Set(buses.map((b) => b.busName));
  const feeds: DerivedFeed[] = [];
  const sides: Record<string, 'A' | 'B' | null> = {};
  const sourceKinds: Record<string, MSSourceKind | undefined> = {};
  const dualCorded: string[] = [];
  const gaps: DerivedGap[] = [];

  for (const bus of buses) {
    const side = inferSide(bus);
    sides[bus.busName] = side;
    sourceKinds[bus.busName] = inferSourceKind(bus);

    const cords: string[] = [];
    if (bus.fedFromBusName) {
      feeds.push({ loadBusName: bus.busName, sourceBusName: bus.fedFromBusName, role: 'normal', side, sourceKind: 'derived', transferBusName: bus.transferType ? bus.busName : null });
      cords.push(bus.fedFromBusName);
    }
    if (bus.secondFeedFromBusName) {
      const secondSide = side === 'A' ? 'B' : side === 'B' ? 'A' : null;
      feeds.push({ loadBusName: bus.busName, sourceBusName: bus.secondFeedFromBusName, role: 'normal', side: secondSide, sourceKind: 'derived', transferBusName: null });
      cords.push(bus.secondFeedFromBusName);
      dualCorded.push(bus.busName);
    }
    if (bus.alternateSourceBusName) {
      feeds.push({ loadBusName: bus.busName, sourceBusName: bus.alternateSourceBusName, role: roleFrom(bus, 'emergency'), side, sourceKind: inferSourceKind({ busName: bus.alternateSourceBusName }) ?? 'derived', transferBusName: bus.transferType ? bus.busName : null });
      // an ATS/STS whose alternate source is not itself in the model = incomplete backup path
      if (!known.has(bus.alternateSourceBusName)) {
        gaps.push({ code: 'UNTRACED_ALTERNATE', busName: bus.busName, message: `transfer device alternate source "${bus.alternateSourceBusName}" is not traceable in the drawing` });
      }
    }

    // a transfer device with no alternate at all = incomplete backup path
    if (bus.transferType && !bus.alternateSourceBusName) {
      gaps.push({ code: 'INCOMPLETE_TRANSFER', busName: bus.busName, message: `${bus.transferType} has no traceable alternate/emergency source` });
    }
    // a load labeled in a 2N zone that resolved to a single cord = possible missed feed
    if (is2NZone(bus) && cords.length < 2) {
      gaps.push({ code: 'MISSED_FEED', busName: bus.busName, message: `bus is in a 2N zone but only ${cords.length} feed(s) were extracted -- a second feeder may have been missed` });
    }
  }

  return { feeds, sides, dualCorded, sourceKinds, gaps };
}

export default deriveMultiSourceTopology;

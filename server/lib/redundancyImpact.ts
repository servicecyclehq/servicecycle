/**
 * lib/redundancyImpact.ts -- pure redundancy-impact engine for multi-source topologies.
 *
 * Answers the core concurrent-maintainability / contingency question of a redundant
 * facility: "what still has power if I take asset X (or an entire A/B side) offline?"
 *
 * The engine is a PURE function of (nodes, edges, offlineSet) with NO database, IO, or
 * Prisma dependency, so it is fully unit-testable against an in-code fixture. The
 * read-only endpoint (routes/arcFlashRedundancy.ts) is a thin adapter that loads the
 * AssetFeed graph for a site and calls this.
 *
 * Source model (see spec 3e):
 *   - DURABLE sources  = utility | generator | grid  -> can power indefinitely.
 *   - RIDE-THROUGH      = ups | bess                  -> finite battery bridge, NOT durable.
 * Classification is by DURABLE reachability (that is the maintainability/redundancy
 * question). A load powered only by a ups/bess battery (durable path gone) is reported
 * AT_RISK with rideThroughOnly=true rather than RETAINED -- honest about the finite bridge.
 *
 * Redundancy = the number of INDEPENDENT durable source paths ("cords") a load still has,
 * where independent means their upstream cones do not share a node (matching the spec's
 * dual-corded definition: >=2 feeds whose source paths do not share a single common
 * upstream source). Per load, after removing the offline set:
 *   - >=2 independent durable paths -> RETAINED  (still powered, still redundant)
 *   -   1 independent durable path  -> AT_RISK   (powered, redundancy lost)
 *   -   0 durable but >=1 battery   -> AT_RISK   (rideThroughOnly)
 *   -   0 durable and 0 battery     -> DROPPED   (dark)
 * Concurrent maintainability of an action holds when NO load is DROPPED (ideally also no
 * AT_RISK on the maintenance target).
 */

export type SourceKind = 'utility' | 'generator' | 'grid' | 'ups' | 'bess' | 'derived';
export type FeedRole = 'normal' | 'alternate' | 'emergency' | 'bypass';
export type Side = 'A' | 'B' | null;

export interface RINode {
  id: string;
  /** Source nodes only: the kind of source this node IS (a root of power). Durable =
   *  utility|generator|grid; ride-through = ups|bess. Undefined for pass-through gear. */
  sourceKind?: SourceKind;
  /** True if this node is a terminal load (IT rack, mechanical unit) to be classified. */
  isLoad?: boolean;
  label?: string;
  /** Optional nameplate redundancy CLAIM ('2N','2N+1','N+1','N+2','N',...) for contradiction
   *  flagging against the graph-derived redundancy. Accepts SC's redundancyStatus tokens too
   *  ('TWO_N','N_PLUS_1'). Null/undefined = no claim. */
  redundancyClaim?: string | null;
}

export interface RIEdge {
  id?: string;
  loadAssetId: string; // downstream (fed) node
  sourceAssetId: string; // upstream (feeding) node
  role: FeedRole;
  side?: Side;
  sourceKind?: SourceKind;
  transferAssetId?: string | null;
}

export interface OfflineSpec {
  /** Take these nodes offline (de-energized / removed for maintenance or failure). */
  nodeIds?: string[];
  /** Take these specific feed edges offline (e.g. pull one cord of a dual-corded rack). */
  edgeIds?: string[];
  /** Convenience: take an entire distribution side offline (removes every edge on that side). */
  side?: 'A' | 'B';
}

export type LoadStatus = 'RETAINED' | 'AT_RISK' | 'DROPPED';

export interface LoadResult {
  loadId: string;
  label?: string;
  status: LoadStatus;
  durablePaths: number; // independent durable source paths remaining after the action
  baselineDurablePaths: number; // independent durable source paths with nothing offline
  rideThroughOnly: boolean; // powered only by ups/bess battery (no durable path remains)
  redundancyDowngrade: boolean; // was redundant (>=2), now not (still powered)
  redundancyContradiction?: string; // nameplate claim the graph does not support
}

export interface RedundancyImpactResult {
  offline: { nodeIds: string[]; edgeIds: string[]; side: 'A' | 'B' | null };
  loads: LoadResult[];
  retained: number;
  atRisk: number;
  dropped: number;
  /** No load DROPPED under this action. */
  concurrentMaintainable: boolean;
  /** No load DROPPED and no load AT_RISK (the ideal maintenance window). */
  cleanConcurrentMaintenance: boolean;
}

const DURABLE = new Set<SourceKind>(['utility', 'generator', 'grid']);
const RIDE_THROUGH = new Set<SourceKind>(['ups', 'bess']);

interface CordTrace {
  durable: boolean;
  rideThrough: boolean;
  cone: Set<string>;
}

/** Required independent durable paths implied by a nameplate redundancy claim. */
function requiredPathsForClaim(claim: string | null | undefined): number | null {
  if (!claim) return null;
  const c = claim.toUpperCase().replace(/\s+/g, '');
  if (c === 'N' || c === 'NPLUS0' || c === 'N+0') return 1;
  if (c.startsWith('2N') || c === 'TWO_N' || c === 'TWON') return 2; // 2N, 2N+1
  if (c.includes('N+1') || c === 'N_PLUS_1' || c === 'NPLUS1') return 2; // needs a redundant path
  if (c.includes('N+2') || c === 'N_PLUS_2' || c === 'NPLUS2') return 2;
  if (c.includes('BLOCK') || c.includes('DISTRIBUTED') || c.includes('CATCHER') || c.includes('RESERVE')) return 2;
  return null; // unrecognized claim -> do not flag
}

/** Max number of pairwise node-disjoint cones (independent paths). Exact for small n. */
function maxDisjoint(cones: Set<string>[]): number {
  const n = cones.length;
  if (n === 0) return 0;
  if (n === 1) return 1;
  const disjoint = (a: Set<string>, b: Set<string>): boolean => {
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    for (const v of small) if (big.has(v)) return false;
    return true;
  };
  if (n <= 12) {
    // exact: largest subset whose members are pairwise disjoint
    let best = 1;
    for (let mask = 1; mask < 1 << n; mask++) {
      const idx: number[] = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
      if (idx.length <= best) continue;
      let ok = true;
      for (let i = 0; i < idx.length && ok; i++)
        for (let j = i + 1; j < idx.length && ok; j++)
          if (!disjoint(cones[idx[i]], cones[idx[j]])) ok = false;
      if (ok) best = idx.length;
    }
    return best;
  }
  // greedy fallback for pathological fan-in (loads never realistically exceed a few cords)
  const sorted = [...cones].sort((a, b) => a.size - b.size);
  const used = new Set<string>();
  let count = 0;
  for (const cone of sorted) {
    if (disjoint(cone, used)) {
      count++;
      for (const v of cone) used.add(v);
    }
  }
  return count;
}

/** Analyze the graph under a given removal set; returns per-load durable-path counts. */
function analyze(
  nodes: RINode[],
  edges: RIEdge[],
  removedNodes: Set<string>,
  removedEdges: Set<string>,
  removedSide: 'A' | 'B' | null,
): Map<string, { durablePaths: number; rideThroughOnly: boolean }> {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, RIEdge[]>();
  for (const e of edges) {
    if (!incoming.has(e.loadAssetId)) incoming.set(e.loadAssetId, []);
    incoming.get(e.loadAssetId)!.push(e);
  }
  const edgeRemoved = (e: RIEdge): boolean => {
    if (e.id && removedEdges.has(e.id)) return true;
    if (removedSide && e.side === removedSide) return true;
    return false;
  };

  // Trace one cord (an incoming edge to a load) upward to its sources.
  const traceCord = (edge: RIEdge): CordTrace => {
    const cone = new Set<string>();
    let durable = false;
    let rideThrough = false;
    if (edgeRemoved(edge) || removedNodes.has(edge.sourceAssetId)) return { durable, rideThrough, cone };
    const stack: string[] = [edge.sourceAssetId];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (removedNodes.has(cur)) continue;
      cone.add(cur);
      const sk = nodeById.get(cur)?.sourceKind;
      if (sk && DURABLE.has(sk)) {
        durable = true;
        continue; // a durable source is a root -- do not expand above it
      }
      if (sk && RIDE_THROUGH.has(sk)) rideThrough = true; // record, but keep looking upstream for durable
      for (const ue of incoming.get(cur) ?? []) {
        if (edgeRemoved(ue)) continue;
        if (!removedNodes.has(ue.sourceAssetId)) stack.push(ue.sourceAssetId);
      }
    }
    return { durable, rideThrough, cone };
  };

  const out = new Map<string, { durablePaths: number; rideThroughOnly: boolean }>();
  for (const node of nodes) {
    if (!node.isLoad) continue;
    const cords = (incoming.get(node.id) ?? []).map(traceCord);
    const durableCones = cords.filter((c) => c.durable).map((c) => c.cone);
    const durablePaths = maxDisjoint(durableCones);
    const anyRideThrough = cords.some((c) => c.rideThrough);
    out.set(node.id, { durablePaths, rideThroughOnly: durablePaths === 0 && anyRideThrough });
  }
  return out;
}

export function redundancyImpact(
  nodes: RINode[],
  edges: RIEdge[],
  offline: OfflineSpec = {},
): RedundancyImpactResult {
  const removedNodes = new Set(offline.nodeIds ?? []);
  const removedEdges = new Set(offline.edgeIds ?? []);
  const removedSide = offline.side ?? null;

  const baseline = analyze(nodes, edges, new Set(), new Set(), null);
  const post = analyze(nodes, edges, removedNodes, removedEdges, removedSide);

  const loads: LoadResult[] = [];
  for (const node of nodes) {
    if (!node.isLoad) continue;
    const b = baseline.get(node.id) ?? { durablePaths: 0, rideThroughOnly: false };
    const p = post.get(node.id) ?? { durablePaths: 0, rideThroughOnly: false };
    let status: LoadStatus;
    if (p.durablePaths >= 2) status = 'RETAINED';
    else if (p.durablePaths === 1) status = 'AT_RISK';
    else if (p.rideThroughOnly) status = 'AT_RISK';
    else status = 'DROPPED';
    const redundancyDowngrade = b.durablePaths >= 2 && p.durablePaths < 2 && status !== 'DROPPED';
    const req = requiredPathsForClaim(node.redundancyClaim);
    const redundancyContradiction =
      req != null && b.durablePaths < req
        ? `nameplate claims ${node.redundancyClaim} (needs >=${req} independent durable paths) but the graph derives only ${b.durablePaths}`
        : undefined;
    loads.push({
      loadId: node.id,
      label: node.label,
      status,
      durablePaths: p.durablePaths,
      baselineDurablePaths: b.durablePaths,
      rideThroughOnly: p.rideThroughOnly,
      redundancyDowngrade,
      redundancyContradiction,
    });
  }

  const retained = loads.filter((l) => l.status === 'RETAINED').length;
  const atRisk = loads.filter((l) => l.status === 'AT_RISK').length;
  const dropped = loads.filter((l) => l.status === 'DROPPED').length;
  return {
    offline: { nodeIds: [...removedNodes], edgeIds: [...removedEdges], side: removedSide },
    loads,
    retained,
    atRisk,
    dropped,
    concurrentMaintainable: dropped === 0,
    cleanConcurrentMaintenance: dropped === 0 && atRisk === 0,
  };
}

export default redundancyImpact;

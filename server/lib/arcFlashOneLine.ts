/**
 * lib/arcFlashOneLine.ts — Slice 6: auto-build the one-line FORWARD from the
 * collected asset graph.
 *
 * SC already parses an UPLOADED one-line into buses + topology (the reverse). This
 * assembles the power-path the other way: from the assets the customer has
 * collected — each carrying its feed source (fedFromAssetId) and current arc-flash
 * label — into a layered single-line graph (source/utility at the top, feeders
 * cascading down), hazard-colored, so the diagram builds itself as data lands.
 *
 * Pure + deterministic: assigns a depth level to every node (cycle-safe), emits
 * the edges, and orders nodes for a stable left-to-right layout. The client lays
 * out by level; this owns the graph math.
 */

'use strict';

function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function voltsOf(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /kv/i.test(m[2] || '') ? n * 1000 : n;
}

export interface OneLineNode {
  id: string; name: string; equipmentType: string | null; nominalVoltage: string | null;
  incidentEnergyCalCm2: number | null; labelSeverity: string | null; fedFromId: string | null; level: number;
  // [F-O1] True when labelSeverity above was COMPUTED here (no stored value on
  // the row) rather than read from the study. An inferred severity must not
  // render indistinguishably from a real study-derived label — that silently
  // masks "this bus has no study yet" as if it were labeled.
  labelSeverityInferred: boolean;
  // [F-O2] True when the asset had a fedFromAssetId that does NOT resolve
  // within this query's asset set (cross-site feed, or the upstream asset
  // wasn't returned) — the edge is dropped and the node renders as level-0,
  // which looks identical to "this is a real power source." That's an
  // affirmative topology claim that isn't on file; flag it instead of hiding it.
  feedUnresolved: boolean;
}

/**
 * Build the one-line graph. `assets` = [{ id, name, equipmentType, nominalVoltage,
 * fedFromAssetId, incidentEnergyCalCm2, labelSeverity }]. Pure.
 */
export function buildOneLine(assets: any[]): { nodes: OneLineNode[]; edges: Array<{ from: string; to: string }>; maxLevel: number } {
  const list = Array.isArray(assets) ? assets : [];
  const ids = new Set(list.map((a) => a.id));
  const byId = new Map(list.map((a) => [a.id, a]));

  // Depth from the nearest source, cycle-safe. A node whose feed is null or points
  // outside the set is a root (level 0).
  const levelCache = new Map<string, number>();
  function levelOf(id: string, seen: Set<string>): number {
    if (levelCache.has(id)) return levelCache.get(id) as number;
    const a = byId.get(id);
    const parent = a && a.fedFromAssetId;
    if (!parent || !ids.has(parent) || seen.has(id)) { levelCache.set(id, 0); return 0; }
    seen.add(id);
    const lvl = levelOf(parent, seen) + 1;
    levelCache.set(id, lvl);
    return lvl;
  }

  const nodes: OneLineNode[] = list.map((a) => ({
    id: a.id,
    name: a.name || a.busName || (a.nameplateData && a.nameplateData.busName) || a.equipmentType || 'Asset',
    equipmentType: a.equipmentType || null,
    nominalVoltage: a.nominalVoltage || null,
    incidentEnergyCalCm2: num(a.incidentEnergyCalCm2),
    labelSeverity: a.labelSeverity || (((num(a.incidentEnergyCalCm2) || 0) > 40 || (voltsOf(a.nominalVoltage) || 0) > 600) ? 'danger' : (a.incidentEnergyCalCm2 != null || a.nominalVoltage ? 'warning' : null)),
    labelSeverityInferred: !a.labelSeverity,
    fedFromId: a.fedFromAssetId && ids.has(a.fedFromAssetId) ? a.fedFromAssetId : null,
    feedUnresolved: !!(a.fedFromAssetId && !ids.has(a.fedFromAssetId)),
    level: levelOf(a.id, new Set()),
  }));

  // Stable ordering: by level, then highest voltage first, then name.
  nodes.sort((x, y) => x.level - y.level || (voltsOf(y.nominalVoltage) || 0) - (voltsOf(x.nominalVoltage) || 0) || String(x.name).localeCompare(String(y.name)));

  const edges = nodes.filter((n) => n.fedFromId).map((n) => ({ from: n.fedFromId as string, to: n.id }));
  const maxLevel = nodes.reduce((m, n) => Math.max(m, n.level), 0);
  return { nodes, edges, maxLevel };
}

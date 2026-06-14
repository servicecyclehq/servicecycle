/**
 * powerPath.ts — power-path graph traversal helpers.
 *
 * The Asset.fedFromAssetId self-relation forms the facility power-path graph
 * (an asset points at its upstream source; feedsDownstream are its children).
 * #25 (arc-flash first-class records) needs to expand a study's root bus down
 * the graph so an engineer can bind one switchgear and have its whole
 * downstream tree inherit the study coverage.
 *
 * BFS, account-scoped, cycle-guarded, and node-capped so a malformed feed loop
 * can never hang the request. Mirrors the cap/guard discipline in the
 * GET /api/assets/:id/power-path route.
 */

import prisma from './prisma';

const MAX_DOWNSTREAM_NODES = 500;

/**
 * Returns the set of asset ids transitively fed from `rootAssetId` (NOT
 * including the root). Account-scoped; cycle-guarded; capped at 500 nodes.
 */
export async function resolveDownstreamAssetIds(
  accountId: string,
  rootAssetId: string,
): Promise<string[]> {
  const visited = new Set<string>([rootAssetId]);
  const collected: string[] = [];
  let frontier: string[] = [rootAssetId];

  while (frontier.length > 0 && collected.length < MAX_DOWNSTREAM_NODES) {
    const children: { id: string }[] = await prisma.asset.findMany({
      where:  { fedFromAssetId: { in: frontier }, accountId, archivedAt: null },
      select: { id: true },
    });
    frontier = [];
    for (const c of children) {
      if (visited.has(c.id)) continue; // cycle guard
      visited.add(c.id);
      collected.push(c.id);
      frontier.push(c.id);
      if (collected.length >= MAX_DOWNSTREAM_NODES) break;
    }
  }
  return collected;
}

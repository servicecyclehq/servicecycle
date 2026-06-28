'use strict';

/**
 * lib/fieldScope.ts
 * -----------------
 * Assignment-scope resolver for the field-labor (field_tech) role.
 *
 * A field_tech sees ONLY the work assigned to them. This resolver returns the
 * set of work-order ids and asset ids reachable from WorkOrder rows where
 * assignedUserId = the user's id. The /api/field handlers clamp every read and
 * write to it, so a subcontractor never sees another customer's assets or any
 * work that isn't theirs.
 *
 * For every NON-field_tech role the resolver returns null = "unrestricted"
 * (account-wide), so managers/admins keep their existing Field Mode behaviour.
 * accountId scoping remains the hard tenant boundary in both cases.
 */

interface AssignmentScope {
  workOrderIds: Set<string>;
  assetIds: Set<string>;
}

async function getFieldAssignmentScope(prisma, user): Promise<AssignmentScope | null> {
  if (!user || user.role !== 'field_tech') return null; // account-wide
  const rows = await prisma.workOrder.findMany({
    where:  { accountId: user.accountId, assignedUserId: user.id },
    select: { id: true, assetId: true },
  });
  return {
    workOrderIds: new Set(rows.map((r) => r.id)),
    assetIds:     new Set(rows.map((r) => r.assetId).filter(Boolean)), // drop null assetIds (unassigned WOs)
  };
}

module.exports = { getFieldAssignmentScope };

export {};

'use strict';

/**
 * salesRollup.ts - the sales-manager roll-up (Chunk B).
 *
 * A compliance-OPPORTUNITY lens on the operator's book of customer accounts,
 * grouped by Account Manager (Account.assignedRepId -> User). NOT a CRM: every
 * number here is a byproduct SC already captures (compliance %, open
 * deficiencies, work orders) - ZERO manual data entry, read-only.
 *
 * groupByAm() is pure (no I/O) so it is unit-testable; the route feeds it the
 * scoped accounts + the reused compliance/aggregate maps.
 *
 * SECURITY / tenancy: this is a CROSS-ACCOUNT view, so it is gated to OPERATOR
 * staff only (the roles that legitimately see across customer accounts:
 * oem_admin / group_admin / super_admin) - identical isolation to the fleet
 * dashboard. A customer-account admin must NEVER load it (that would leak the
 * operator's other customers once customers have their own logins). admin /
 * manager are allowed ONLY in DEMO_MODE so the sandbox (just us, no real
 * customers) is testable. The account scope is enforced separately in the route
 * by mirroring the fleet partnerOrg guard (fail-closed). A broad "grant any
 * viewer" capability is intentionally deferred - cross-account grants are
 * security-sensitive and shouldn't be a casual flag.
 */

const OPERATOR_ROLES = ['oem_admin', 'group_admin', 'super_admin'];

function canViewSales(user: any, opts: any = {}): boolean {
  if (!user) return false;
  if (OPERATOR_ROLES.includes(user.role)) return true;
  // Sandbox-only: let admin/manager test the view when there are no real
  // customer logins in the instance.
  if (opts.demoMode === true && (user.role === 'admin' || user.role === 'manager')) return true;
  return false;
}

// Sort a book of account cards worst-compliance-first; unknown (null) goes last
// (no data to act on yet, vs. a known-low account that needs attention now).
function sortWorstFirst(cards: any[]): void {
  cards.sort((x, y) => {
    const rx = x.compliance == null ? Infinity : x.compliance;
    const ry = y.compliance == null ? Infinity : y.compliance;
    if (rx !== ry) return rx - ry;
    return (y.openDeficiencies || 0) - (x.openDeficiencies || 0);
  });
}

/**
 * Group scoped accounts into per-AM "book" cards + an Unassigned bucket.
 * @param accounts   [{ id, companyName, assignedRepId }]
 * @param reps       Map repId -> { id, name, email }
 * @param compliance Map accountId -> number|null  (buildComplianceGap.overallRate)
 * @param counts     Map accountId -> { openDeficiencies, openWorkOrders, overdueSchedules, assets }
 * Pure.
 */
function groupByAm(opts: any): any {
  const accounts = opts.accounts || [];
  const reps = opts.reps || new Map();
  const compliance = opts.compliance || new Map();
  const counts = opts.counts || new Map();

  const byRep = new Map<string, any>();
  const unassigned: any[] = [];

  for (const a of accounts) {
    const c = counts.get(a.id) || {};
    const card = {
      accountId: a.id,
      companyName: a.companyName,
      compliance: compliance.has(a.id) ? compliance.get(a.id) : null,
      openDeficiencies: c.openDeficiencies || 0,
      openWorkOrders: c.openWorkOrders || 0,
      overdueSchedules: c.overdueSchedules || 0,
      assets: c.assets || 0,
    };
    const repId = a.assignedRepId;
    if (!repId || !reps.has(repId)) { unassigned.push(card); continue; }
    if (!byRep.has(repId)) {
      const r = reps.get(repId);
      byRep.set(repId, { repId: r.id, repName: r.name || r.email || 'Unnamed rep', repEmail: r.email || null, accounts: [] });
    }
    byRep.get(repId).accounts.push(card);
  }

  const repsOut: any[] = [];
  for (const v of byRep.values()) {
    sortWorstFirst(v.accounts);
    const known = v.accounts.map((a: any) => a.compliance).filter((c: any) => typeof c === 'number');
    v.accountCount = v.accounts.length;
    v.avgCompliance = known.length ? Math.round(known.reduce((s: number, c: number) => s + c, 0) / known.length) : null;
    v.openDeficiencies = v.accounts.reduce((s: number, a: any) => s + (a.openDeficiencies || 0), 0);
    v.openWorkOrders = v.accounts.reduce((s: number, a: any) => s + (a.openWorkOrders || 0), 0);
    repsOut.push(v);
  }
  // Reps with the worst average compliance first - the biggest opportunity surface.
  repsOut.sort((x, y) => {
    const rx = x.avgCompliance == null ? Infinity : x.avgCompliance;
    const ry = y.avgCompliance == null ? Infinity : y.avgCompliance;
    return rx - ry;
  });
  sortWorstFirst(unassigned);

  return {
    reps: repsOut,
    unassigned,
    summary: {
      repCount: repsOut.length,
      accountCount: accounts.length,
      unassignedCount: unassigned.length,
    },
  };
}

/**
 * Decide which accounts actually move in a reassignment. Pure + safe:
 * only accounts that are (a) in the provided in-scope set AND (b) currently
 * owned by fromRepId are eligible; if requestedIds is given, intersect with it
 * (so the UI can move a selected subset). Returns the eligible account id list.
 * @param accounts    in-scope [{ id, assignedRepId }]
 * @param fromRepId   the departing rep (null/'' = the Unassigned bucket)
 * @param requestedIds optional subset the caller asked to move
 */
function selectAccountsToMove(accounts: any[], fromRepId: any, requestedIds?: any): string[] {
  const from = fromRepId || null;
  const want = Array.isArray(requestedIds) && requestedIds.length ? new Set(requestedIds) : null;
  const out: string[] = [];
  for (const a of accounts || []) {
    const owner = a.assignedRepId || null;
    if (owner !== from) continue;
    if (want && !want.has(a.id)) continue;
    out.push(a.id);
  }
  return out;
}

module.exports = { canViewSales, groupByAm, sortWorstFirst, selectAccountsToMove };

export {};

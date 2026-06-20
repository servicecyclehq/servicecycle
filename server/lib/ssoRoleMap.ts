'use strict';

/**
 * lib/ssoRoleMap.ts
 * -----------------
 * Maps IdP group/role claims to a ServiceCycle role.
 *
 * SECURITY INVARIANTS (see docs/security/SSO_DESIGN.md §5 Q3):
 *  - Default is lowest-privilege: `viewer`.
 *  - Only `viewer | consultant | manager` are ever grantable from a claim.
 *  - `admin`, `oem_admin`, `super_admin` are NEVER granted from an IdP claim,
 *    even if a (mis)configured mapping row points at one — such rows are
 *    ignored here as defense-in-depth. Those roles are set by an existing
 *    ServiceCycle admin in-app only.
 *  - When multiple groups match, the HIGHEST assignable role wins (manager >
 *    consultant > viewer), but never above manager.
 */

const ASSIGNABLE = ['viewer', 'consultant', 'manager']; // claim-grantable, low -> high
const RANK: Record<string, number> = { viewer: 1, consultant: 2, manager: 3 };
const NEVER_FROM_CLAIM = ['admin', 'oem_admin', 'super_admin'];

/** Returns the role if it is claim-assignable, else null (privileged/unknown). */
function sanitizeRole(role: any): string | null {
  return typeof role === 'string' && ASSIGNABLE.includes(role) ? role : null;
}

export interface RoleMapping { idpGroup: string; role: string }

/**
 * Compute the role for an SSO user from their claim groups + the account's
 * mappings. Never returns a privileged role.
 */
function mapClaimsToRole(opts: {
  claimGroups?: string[];
  mappings?: RoleMapping[];
  defaultRole?: string;
}): string {
  const { claimGroups = [], mappings = [], defaultRole = 'viewer' } = opts || {};
  const def = sanitizeRole(defaultRole) || 'viewer';
  const claims = new Set(
    claimGroups.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim().toLowerCase())
  );
  let best: string | null = null;
  for (const m of mappings) {
    if (!m || typeof m.idpGroup !== 'string') continue;
    const r = sanitizeRole(m.role); // privileged/unknown mappings are ignored
    if (!r) continue;
    if (claims.has(m.idpGroup.trim().toLowerCase())) {
      if (!best || RANK[r] > RANK[best]) best = r;
    }
  }
  return best || def;
}

/** Pull candidate claim group/role strings out of a Polis userinfo Profile. */
function extractClaimGroups(profile: any): string[] {
  const out: string[] = [];
  const push = (v: any) => {
    if (Array.isArray(v)) out.push(...v);
    else if (typeof v === 'string' && v.trim()) out.push(v);
  };
  if (profile) {
    push(profile.groups);
    push(profile.roles);
    const raw = profile.raw || {};
    push(raw.groups);
    push(raw.roles);
  }
  return out.filter((x) => typeof x === 'string' && x.trim());
}

module.exports = { mapClaimsToRole, extractClaimGroups, sanitizeRole, ASSIGNABLE, NEVER_FROM_CLAIM, RANK };

export {};

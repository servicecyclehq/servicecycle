/**
 * Unit tests for lib/ssoRoleMap — role mapping security invariants.
 * Pure; runs in the esbuild "unit" jest project.
 */
const { mapClaimsToRole, extractClaimGroups, sanitizeRole } = require('../lib/ssoRoleMap');

describe('mapClaimsToRole', () => {
  test('default is viewer when nothing matches', () => {
    expect(mapClaimsToRole({ claimGroups: ['Random'], mappings: [] })).toBe('viewer');
  });

  test('maps a matched group to its role', () => {
    expect(mapClaimsToRole({
      claimGroups: ['Field-Managers'],
      mappings: [{ idpGroup: 'Field-Managers', role: 'manager' }],
    })).toBe('manager');
  });

  test('case-insensitive group match', () => {
    expect(mapClaimsToRole({
      claimGroups: ['field-managers'],
      mappings: [{ idpGroup: 'Field-Managers', role: 'manager' }],
    })).toBe('manager');
  });

  test('highest assignable role wins when multiple match', () => {
    expect(mapClaimsToRole({
      claimGroups: ['A', 'B'],
      mappings: [{ idpGroup: 'A', role: 'viewer' }, { idpGroup: 'B', role: 'manager' }],
    })).toBe('manager');
  });

  test('SECURITY: a mapping to admin is IGNORED (never claim-granted)', () => {
    expect(mapClaimsToRole({
      claimGroups: ['Admins'],
      mappings: [{ idpGroup: 'Admins', role: 'admin' }],
    })).toBe('viewer'); // falls back to default; admin row ignored
  });

  test('SECURITY: oem_admin / super_admin mappings ignored', () => {
    expect(mapClaimsToRole({
      claimGroups: ['X', 'Y'],
      mappings: [{ idpGroup: 'X', role: 'oem_admin' }, { idpGroup: 'Y', role: 'super_admin' }],
    })).toBe('viewer');
  });

  test('SECURITY: even with a valid manager match, admin mapping cannot elevate past manager', () => {
    expect(mapClaimsToRole({
      claimGroups: ['Admins', 'Mgrs'],
      mappings: [{ idpGroup: 'Admins', role: 'admin' }, { idpGroup: 'Mgrs', role: 'manager' }],
    })).toBe('manager');
  });

  test('configurable default role (still sanitized)', () => {
    expect(mapClaimsToRole({ claimGroups: [], mappings: [], defaultRole: 'consultant' })).toBe('consultant');
    // a privileged default is rejected, falls back to viewer
    expect(mapClaimsToRole({ claimGroups: [], mappings: [], defaultRole: 'admin' })).toBe('viewer');
  });
});

describe('sanitizeRole', () => {
  test('allows viewer/consultant/manager only', () => {
    expect(sanitizeRole('viewer')).toBe('viewer');
    expect(sanitizeRole('manager')).toBe('manager');
    expect(sanitizeRole('admin')).toBeNull();
    expect(sanitizeRole('oem_admin')).toBeNull();
    expect(sanitizeRole('super_admin')).toBeNull();
    expect(sanitizeRole('nonsense')).toBeNull();
  });
});

describe('extractClaimGroups', () => {
  test('pulls groups/roles from top-level and raw', () => {
    const profile = {
      groups: ['G1'], roles: ['R1'],
      raw: { groups: ['G2'], roles: ['R2'] },
    };
    const out = extractClaimGroups(profile);
    expect(out).toEqual(expect.arrayContaining(['G1', 'R1', 'G2', 'R2']));
  });
  test('handles a single string group in raw', () => {
    expect(extractClaimGroups({ raw: { groups: 'Solo' } })).toContain('Solo');
  });
  test('empty/garbage profile -> empty array', () => {
    expect(extractClaimGroups(null)).toEqual([]);
    expect(extractClaimGroups({})).toEqual([]);
  });
});

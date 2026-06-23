// Unit coverage for the sales roll-up grouping + capability gate (Chunk B).
const { canViewSales, groupByAm, selectAccountsToMove } = require('../lib/salesRollup');

describe('canViewSales (operator-only, leak-safe)', () => {
  test('operator roles always see it', () => {
    expect(canViewSales({ role: 'oem_admin' })).toBe(true);
    expect(canViewSales({ role: 'group_admin' })).toBe(true);
    expect(canViewSales({ role: 'super_admin' })).toBe(true);
  });
  test('customer-account roles are blocked in production (no cross-account leak)', () => {
    expect(canViewSales({ role: 'admin' })).toBe(false);
    expect(canViewSales({ role: 'manager' })).toBe(false);
    expect(canViewSales({ role: 'viewer' })).toBe(false);
  });
  test('admin/manager allowed ONLY in demo mode (sandbox testing)', () => {
    expect(canViewSales({ role: 'admin' }, { demoMode: true })).toBe(true);
    expect(canViewSales({ role: 'manager' }, { demoMode: true })).toBe(true);
    expect(canViewSales({ role: 'viewer' }, { demoMode: true })).toBe(false);
  });
  test('no user = no access', () => {
    expect(canViewSales(null, { demoMode: true })).toBe(false);
  });
});

describe('groupByAm', () => {
  const reps = new Map([
    ['r1', { id: 'r1', name: 'Mark', email: 'mark@x.com' }],
    ['r2', { id: 'r2', name: 'Dana', email: 'dana@x.com' }],
  ]);
  const accounts = [
    { id: 'a1', companyName: 'Lowe\'s', assignedRepId: 'r1' },
    { id: 'a2', companyName: 'Target', assignedRepId: 'r1' },
    { id: 'a3', companyName: 'Costco', assignedRepId: 'r2' },
    { id: 'a4', companyName: 'Orphan Co', assignedRepId: null },
    { id: 'a5', companyName: 'Stale Rep Co', assignedRepId: 'gone' }, // rep not in map -> unassigned
  ];
  const compliance = new Map([['a1', 58], ['a2', 91], ['a3', 73], ['a4', 40]]);
  const counts = new Map([
    ['a1', { openDeficiencies: 5, openWorkOrders: 2 }],
    ['a2', { openDeficiencies: 0, openWorkOrders: 1 }],
  ]);

  const out = groupByAm({ accounts, reps, compliance, counts });

  test('groups accounts under their AM and buckets orphans', () => {
    expect(out.summary.repCount).toBe(2);
    expect(out.summary.unassignedCount).toBe(2); // Orphan Co + Stale Rep Co
    const mark = out.reps.find(r => r.repId === 'r1');
    expect(mark.accountCount).toBe(2);
  });

  test('book is sorted worst-compliance-first', () => {
    const mark = out.reps.find(r => r.repId === 'r1');
    expect(mark.accounts[0].companyName).toBe('Lowe\'s'); // 58 before 91
    expect(mark.avgCompliance).toBe(75); // (58+91)/2 = 74.5 -> 75
  });

  test('reps are ordered worst-average-first', () => {
    // Mark avg 75, Dana avg 73 -> Dana first (bigger opportunity)
    expect(out.reps[0].repId).toBe('r2');
  });

  test('aggregates the open-deficiency counts per rep', () => {
    const mark = out.reps.find(r => r.repId === 'r1');
    expect(mark.openDeficiencies).toBe(5);
  });
});

describe('selectAccountsToMove', () => {
  const accounts = [
    { id: 'a1', assignedRepId: 'r1' },
    { id: 'a2', assignedRepId: 'r1' },
    { id: 'a3', assignedRepId: 'r2' },
    { id: 'a4', assignedRepId: null },
  ];
  test('moves a rep\'s whole book when no subset given', () => {
    expect(selectAccountsToMove(accounts, 'r1').sort()).toEqual(['a1', 'a2']);
  });
  test('moves only the requested subset, still constrained to the rep', () => {
    expect(selectAccountsToMove(accounts, 'r1', ['a1', 'a3'])).toEqual(['a1']); // a3 is r2's, excluded
  });
  test('handles the Unassigned bucket (null fromRep)', () => {
    expect(selectAccountsToMove(accounts, null)).toEqual(['a4']);
  });
  test('never moves an account owned by someone else', () => {
    expect(selectAccountsToMove(accounts, 'r2', ['a1', 'a2', 'a3'])).toEqual(['a3']);
  });
});

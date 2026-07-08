/**
 * server/scripts/activity-log-chain.test.js
 * -----------------------------------------
 *
 * Sandbox test for server/lib/activityLogChain.js. No database — exercises
 * the pure-function helpers (canonical, stableStringify, computeRowHash)
 * + simulates settleAllPending + verifyAllChains via an in-memory mock
 * of the Prisma client.
 *
 * Run with:
 *   node server/scripts/activity-log-chain.test.js
 *
 * Exits non-zero on any failure.
 */

'use strict';

const path = require('path');
const { canonical, stableStringify, computeRowHash, settleAccount, verifyAccount, settleAllPending, verifyAllChains } = require(
  path.join(__dirname, '..', 'lib', 'activityLogChain')
);

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok — ${msg}`);
  else { console.error(`  FAIL — ${msg}`); failures++; }
}

// ── In-memory Prisma mock ──────────────────────────────────────────────────
function makeMockPrisma(initialRows) {
  const rows = initialRows.map(r => ({ ...r }));

  return {
    // 2026-07-08 acquisition-audit fix: settleAccount() batches its updates
    // via prisma.$transaction(updates[]) (S2-FN-02 batching optimization) —
    // this mock never implemented it, so any test hitting a >0-row settle
    // crashed with "prisma.$transaction is not a function" (pre-existing,
    // unrelated to the canonical() change below). The update() promises are
    // already in flight by the time $transaction receives them (same as
    // real Prisma's array-of-promises form), so just await them all.
    async $transaction(promises) {
      return Promise.all(promises);
    },
    activityLog: {
      async findFirst({ where, orderBy, select }) {
        let candidates = rows.filter(r => matches(r, where));
        candidates = sortRows(candidates, orderBy);
        if (candidates.length === 0) return null;
        return projectRow(candidates[0], select);
      },
      async findMany({ where, orderBy, select, distinct }) {
        let result = rows.filter(r => matches(r, where));
        if (orderBy) result = sortRows(result, orderBy);
        if (distinct) {
          const seen = new Set();
          result = result.filter(r => {
            const key = distinct.map(k => String(r[k])).join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        return result.map(r => projectRow(r, select));
      },
      async update({ where, data }) {
        const row = rows.find(r => r.id === where.id);
        if (!row) throw new Error(`mock: row ${where.id} not found`);
        Object.assign(row, data);
        return row;
      },
      async create({ data }) {
        const row = { id: data.id || `gen_${rows.length + 1}`, ...data };
        if (!row.createdAt) row.createdAt = new Date();
        rows.push(row);
        return row;
      },
      async count({ where }) {
        return rows.filter(r => matches(r, where)).length;
      },
    },
    _rows: rows, // exposed for assertions
  };
}

function matches(row, where) {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // Prisma filter object: { not: x }, { in: [...] }, etc.
      if ('not' in v) {
        if (v.not === null && row[k] === null) return false;
        if (v.not !== null && row[k] === v.not) return false;
        continue;
      }
      if ('in' in v) {
        if (!v.in.includes(row[k])) return false;
        continue;
      }
      throw new Error(`mock: unsupported filter ${JSON.stringify(v)} on ${k}`);
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function sortRows(rows, orderBy) {
  if (!orderBy) return rows;
  const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const o of orders) {
      for (const [k, dir] of Object.entries(o)) {
        const av = a[k], bv = b[k];
        if (av === bv) continue;
        if (av < bv) return dir === 'asc' ? -1 : 1;
        return dir === 'asc' ? 1 : -1;
      }
    }
    return 0;
  });
}

function projectRow(row, select) {
  if (!select) return row;
  const out = {};
  for (const k of Object.keys(select)) {
    if (select[k]) out[k] = row[k];
  }
  return out;
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function main() {
console.log('=== activityLogChain sandbox test ===');
console.log('');

console.log('Test 1 — stableStringify produces deterministic output regardless of key order');
const a = stableStringify({ b: 1, a: 2, c: 3 });
const b = stableStringify({ c: 3, a: 2, b: 1 });
assert(a === b, 'order-independent for flat object');
const nested = stableStringify({ x: { d: 1, a: [3, { z: 1, m: 2 }] } });
const nested2 = stableStringify({ x: { a: [3, { m: 2, z: 1 }], d: 1 } });
assert(nested === nested2, 'order-independent for nested');

console.log('');
console.log('Test 2 — canonical() round-trips Date to ISO string, excludes accountId/assetId/userId');
const c = canonical({ id: 'r1', accountId: 'acc1', assetId: 'asset1', action: 'test', createdAt: new Date('2026-05-19T12:00:00.000Z'), details: { x: 1 } });
assert(c.includes('"createdAt":"2026-05-19T12:00:00.000Z"'), 'Date serialized to ISO');
// 2026-07-08 acquisition-audit fix (W1-M3): accountId/assetId are FK columns
// with onDelete: SetNull, so they're excluded from the hash payload (same
// reason userId already was) — a legitimate hard-delete must not read as
// tamper. Assert they're absent, not merely nulled.
assert(!c.includes('accountId'), 'accountId excluded from canonical payload entirely');
assert(!c.includes('assetId'), 'assetId excluded from canonical payload entirely');
assert(!c.includes('userId'), 'userId excluded from canonical payload entirely');

console.log('');
console.log('Test 3 — computeRowHash produces stable, distinct hashes');
const h1 = computeRowHash(null, c);
const h2 = computeRowHash(null, c);
assert(h1 === h2, 'same input -> same hash');
assert(h1.length === 64, 'sha256 hex = 64 chars');
const h3 = computeRowHash('deadbeef', c);
assert(h3 !== h1, 'different prevHash -> different rowHash');

console.log('');
console.log('Test 4 — settleAccount chains rows in order');
const t = (n) => new Date(`2026-05-19T12:00:0${n}.000Z`);
const mock1 = makeMockPrisma([
  { id: 'r1', accountId: 'acc1', contractId: null, userId: 'u1', action: 'login_success', details: null, createdAt: t(1), prevHash: null, rowHash: null },
  { id: 'r2', accountId: 'acc1', contractId: 'c1', userId: 'u1', action: 'contract_created', details: { name: 'x' }, createdAt: t(2), prevHash: null, rowHash: null },
  { id: 'r3', accountId: 'acc1', contractId: 'c1', userId: 'u1', action: 'status_changed', details: { from: 'a', to: 'b' }, createdAt: t(3), prevHash: null, rowHash: null },
]);
const settleRes = await settleAccount(mock1, 'acc1');
assert(settleRes.settled === 3, 'settled 3 pending rows');
assert(mock1._rows.every(r => r.rowHash !== null), 'all rows have rowHash');
assert(mock1._rows[0].prevHash === null, 'first row prevHash is null');
assert(mock1._rows[1].prevHash === mock1._rows[0].rowHash, 'second row prevHash links to first');
assert(mock1._rows[2].prevHash === mock1._rows[1].rowHash, 'third row prevHash links to second');

console.log('');
console.log('Test 5 — verifyAccount accepts a clean chain');
const verifyRes = await verifyAccount(mock1, 'acc1');
assert(verifyRes.ok === true, 'clean chain verifies');
assert(verifyRes.total === 3, 'verified 3 rows');
assert(verifyRes.breakAt.length === 0, 'no breaks');

console.log('');
console.log('Test 6 — tamper detection: modify middle row details');
mock1._rows[1].details = { name: 'TAMPERED' };
const verifyTampered = await verifyAccount(mock1, 'acc1');
assert(verifyTampered.ok === false, 'tampered chain detected');
assert(verifyTampered.breakAt.includes('r2'), 'r2 flagged as break');

console.log('');
console.log('Test 7 — tamper detection: insert fake row after the fact');
const mock2 = makeMockPrisma([
  { id: 'r1', accountId: 'acc1', contractId: null, userId: 'u1', action: 'login_success', details: null, createdAt: t(1), prevHash: null, rowHash: null },
  { id: 'r2', accountId: 'acc1', contractId: null, userId: 'u1', action: 'logout', details: null, createdAt: t(3), prevHash: null, rowHash: null },
]);
await settleAccount(mock2, 'acc1');
// Now attacker inserts a fake row in the middle WITH a recomputed rowHash
// but FORGETS to update the downstream prevHash. Simulate that here.
mock2._rows.splice(1, 0, {
  id: 'r1_fake', accountId: 'acc1', contractId: null, userId: 'evil', action: 'permission_denied', details: null, createdAt: t(2),
  prevHash: mock2._rows[0].rowHash, rowHash: 'aa'.repeat(32), // bogus hash
});
const verifyInsert = await verifyAccount(mock2, 'acc1');
assert(verifyInsert.ok === false, 'inserted fake row detected');

console.log('');
console.log('Test 8 — per-account isolation (acc1 tamper does not break acc2)');
const mock3 = makeMockPrisma([
  { id: 'a1', accountId: 'acc1', contractId: null, userId: null, action: 'x', details: null, createdAt: t(1), prevHash: null, rowHash: null },
  { id: 'a2', accountId: 'acc1', contractId: null, userId: null, action: 'y', details: null, createdAt: t(2), prevHash: null, rowHash: null },
  { id: 'b1', accountId: 'acc2', contractId: null, userId: null, action: 'p', details: null, createdAt: t(1), prevHash: null, rowHash: null },
  { id: 'b2', accountId: 'acc2', contractId: null, userId: null, action: 'q', details: null, createdAt: t(2), prevHash: null, rowHash: null },
]);
await settleAllPending(mock3);
mock3._rows[0].action = 'TAMPERED';
const acc1Verify = await verifyAccount(mock3, 'acc1');
const acc2Verify = await verifyAccount(mock3, 'acc2');
assert(acc1Verify.ok === false, 'acc1 chain broken (as expected)');
assert(acc2Verify.ok === true,  'acc2 chain still verifies (per-account isolation)');

console.log('');
console.log('Test 9 — NULL accountId chain (cross-tenant events)');
const mock4 = makeMockPrisma([
  { id: 'g1', accountId: null, contractId: null, userId: null, action: 'login_failed', details: { reason: 'unknown_email' }, createdAt: t(1), prevHash: null, rowHash: null },
  { id: 'g2', accountId: null, contractId: null, userId: null, action: 'login_failed', details: { reason: 'unknown_email' }, createdAt: t(2), prevHash: null, rowHash: null },
]);
await settleAllPending(mock4);
assert(mock4._rows[0].rowHash !== null, 'NULL-account row 1 chained');
assert(mock4._rows[1].prevHash === mock4._rows[0].rowHash, 'NULL-account chain links correctly');
const nullVerify = await verifyAccount(mock4, null);
assert(nullVerify.ok === true, 'NULL-account chain verifies');

console.log('');
console.log('Test 10 — idempotent settle: re-running with no NULL rows is a no-op');
const settle2 = await settleAllPending(mock4);
assert(settle2.length === 0, 're-running settler reports no pending accounts');

console.log('');
if (failures === 0) {
  console.log('=== All tests passed ===');
  process.exit(0);
} else {
  console.error(`=== ${failures} test(s) FAILED ===`);
  process.exit(1);
}
}

main().catch(err => { console.error('Test runner crashed:', err); process.exit(1); });

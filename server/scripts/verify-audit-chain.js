#!/usr/bin/env node
"use strict";

/**
 * scripts/verify-audit-chain.js
 * -----------------------------
 * STANDALONE, INDEPENDENT verifier for ServiceCycle's tamper-evident audit log.
 *
 * Hand this single file to an auditor with an exported NDJSON audit log
 * (GET /api/activity/export?format=ndjson). It re-implements the chain algorithm
 * from scratch (only Node's built-in crypto) so the auditor does NOT have to
 * trust the running server, the database, or any ServiceCycle code to confirm
 * the log has not been altered.
 *
 * The audit log is a SEPARATE SHA-256 hash chain PER account (cross-tenant /
 * global events use accountId=null as their own chain). This verifier groups
 * rows by accountId and checks each chain independently:
 *   1. Integrity  - every row's rowHash == sha256(prevHash | canonical(row)),
 *      so no field of any row was changed after the fact.
 *   2. Continuity - within an account chain each row's prevHash == the previous
 *      row's rowHash, so no row was inserted, deleted, or reordered.
 * Rows whose rowHash is not yet set are "pending" (the background settle job
 * hasn't chained them) and are reported, never treated as a break. Continuity
 * assumes a FULL per-account export (a date-filtered subset can legitimately
 * omit rows and is not continuity-checkable).
 *
 * Usage:
 *   node verify-audit-chain.js audit.ndjson      # verify a file
 *   cat audit.ndjson | node verify-audit-chain.js -   # verify stdin
 * Exit code 0 = intact, 1 = break detected, 2 = usage/parse error.
 *
 * The canonical()/computeRowHash() below MUST stay byte-for-byte identical to
 * server/lib/activityLogChain.ts (a unit test guards this).
 */

const crypto = require("crypto");
const fs = require("fs");

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

function canonical(row) {
  const obj = {
    id:        row.id,
    accountId: row.accountId === undefined ? null : row.accountId,
    assetId:   row.assetId === undefined ? null : row.assetId,
    action:    row.action,
    details:   row.details === undefined ? null : row.details,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
  return stableStringify(obj);
}

function computeRowHash(prevHash, canonicalRow) {
  return crypto.createHash("sha256").update(prevHash || "").update("|").update(canonicalRow).digest("hex");
}

// Map an exported NDJSON line (ts/actorUserId/...) to the canonical row shape.
function fromExportLine(o) {
  return {
    id:        o.id,
    accountId: o.accountId ?? null,
    assetId:   o.assetId ?? null,
    action:    o.action,
    details:   o.details ?? null,
    createdAt: o.ts,           // export uses `ts`; the chain hashes the createdAt ISO string
    prevHash:  o.prevHash ?? null,
    rowHash:   o.rowHash ?? null,
  };
}

/**
 * Verify an array of NDJSON strings (or parsed objects). Groups by accountId
 * (global = accountId null) and verifies each chain. Returns
 * { ok, total, pending, chains, breaks:[{accountId,id,reason}] }.
 */
function verifyLines(lines) {
  const all = [];
  for (const line of lines) {
    const s = typeof line === "string" ? line.trim() : line;
    if (!s) continue;
    all.push(typeof s === "string" ? fromExportLine(JSON.parse(s)) : fromExportLine(s));
  }
  const pending = all.filter((r) => !r.rowHash);
  const settled = all.filter((r) => r.rowHash);

  const groups = new Map();
  for (const r of settled) {
    const k = r.accountId == null ? "__global__" : r.accountId;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const breaks = [];
  const notes = [];
  for (const [acct, rows] of groups) {
    // Match the chain's construction order: (createdAt asc, id asc). The export
    // sorts by createdAt only, so same-millisecond rows can arrive in a
    // different order than they were chained; re-sort to remove that ambiguity.
    rows.sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)));
    // The global (accountId=null) chain holds cross-tenant events; an
    // account-scoped export sees only the slice tied to this account's users, so
    // its continuity legitimately has gaps and is NOT continuity-checkable here.
    // We still verify the integrity (rowHash) of every global row.
    const checkContinuity = acct !== "__global__";
    if (!checkContinuity && rows.length) {
      notes.push("global (accountId=null) chain: integrity verified; continuity skipped (account-scoped export sees only a slice of cross-tenant events)");
    }
    let prevRowHash = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const expected = computeRowHash(r.prevHash, canonical(r));
      if (r.rowHash !== expected) {
        breaks.push({ accountId: acct, id: r.id, reason: "rowHash mismatch (row altered)" });
      }
      if (checkContinuity && i > 0 && (r.prevHash || null) !== prevRowHash) {
        breaks.push({ accountId: acct, id: r.id, reason: "prevHash does not link to previous row in this account chain (gap/insert/reorder)" });
      }
      prevRowHash = r.rowHash;
    }
  }
  return { ok: breaks.length === 0, total: settled.length, pending: pending.length, chains: groups.size, breaks, notes };
}

function main(argv) {
  const arg = argv[2];
  if (!arg) {
    console.error("Usage: node verify-audit-chain.js <audit.ndjson> | -");
    process.exit(2);
  }
  let raw;
  try {
    raw = arg === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(arg, "utf8");
  } catch (e) {
    console.error("Cannot read input:", e.message);
    process.exit(2);
  }
  let result;
  try {
    result = verifyLines(raw.split(/\r?\n/));
  } catch (e) {
    console.error("Parse error:", e.message);
    process.exit(2);
  }
  const tail = `${result.total} settled rows across ${result.chains} account chain(s)` +
               (result.pending ? `, ${result.pending} pending (unsettled, not yet chained)` : "");
  for (const n of (result.notes || [])) console.log("note: " + n);
  if (result.ok) {
    console.log(`OK - audit chain intact: ${tail}.`);
    process.exit(0);
  }
  console.error(`BREAK - ${result.breaks.length} problem(s) over ${tail}:`);
  for (const b of result.breaks.slice(0, 50)) {
    console.error(`  account ${b.accountId} (id=${b.id}): ${b.reason}`);
  }
  process.exit(1);
}

if (require.main === module) main(process.argv);

module.exports = { verifyLines, canonical, computeRowHash, stableStringify, fromExportLine };
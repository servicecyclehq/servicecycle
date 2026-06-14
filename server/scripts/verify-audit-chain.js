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
 * What it proves on a contiguous export slice:
 *   1. Integrity  - every row's rowHash == sha256(prevHash | canonical(row)),
 *      so no field of any row was changed after the fact.
 *   2. Continuity - each row's prevHash == the previous row's rowHash, so no row
 *      was inserted, deleted, or reordered within the slice.
 * Genesis (prevHash === null on the very first row) is only assertable on a
 * full-from-start export; on a filtered slice the first row's prevHash is taken
 * as given and continuity is checked from there.
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
    // export uses `ts`; the chain hashes the createdAt ISO string
    createdAt: o.ts,
    prevHash:  o.prevHash ?? null,
    rowHash:   o.rowHash ?? null,
  };
}

/**
 * Verify an array of NDJSON strings (or parsed objects). Returns
 * { ok, total, breaks:[{index,id,reason}] }.
 */
function verifyLines(lines) {
  const rows = [];
  for (const line of lines) {
    const s = typeof line === "string" ? line.trim() : line;
    if (!s) continue;
    rows.push(typeof s === "string" ? fromExportLine(JSON.parse(s)) : fromExportLine(s));
  }
  const breaks = [];
  let prevRowHash = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const expected = computeRowHash(r.prevHash, canonical(r));
    if (r.rowHash !== expected) {
      breaks.push({ index: i, id: r.id, reason: "rowHash mismatch (row altered)" });
    }
    if (i > 0 && (r.prevHash || null) !== prevRowHash) {
      breaks.push({ index: i, id: r.id, reason: "prevHash does not link to previous row (gap/insert/reorder)" });
    }
    prevRowHash = r.rowHash;
  }
  return { ok: breaks.length === 0, total: rows.length, breaks };
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
  if (result.ok) {
    console.log(`OK - audit chain intact across ${result.total} rows.`);
    process.exit(0);
  }
  console.error(`BREAK - ${result.breaks.length} problem(s) across ${result.total} rows:`);
  for (const b of result.breaks.slice(0, 50)) {
    console.error(`  row ${b.index} (id=${b.id}): ${b.reason}`);
  }
  process.exit(1);
}

if (require.main === module) main(process.argv);

module.exports = { verifyLines, canonical, computeRowHash, stableStringify, fromExportLine };
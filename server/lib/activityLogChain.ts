'use strict';

/**
 * server/lib/activityLogChain.js
 * -------------------------------
 *
 * Hash-chained tamper evidence for ActivityLog (Pass-6 W4 MT-127, closes
 * Pass-4 Layer 4 C-L4-03).
 *
 * Design:
 *
 *   Each ActivityLog row stores `rowHash = sha256(prevHash || canonical(row))`
 *   where `canonical(row)` is a stable JSON serialization of the
 *   audit-relevant fields (id, accountId, assetId, action,
 *   details, createdAt). The chain is per-account (accountId column),
 *   with a single "global" chain for cross-tenant events keyed by
 *   `accountId IS NULL` (e.g. failed-login for unknown emails).
 *
 *   Writes do NOT compute the hash inline. The chain is settled by a
 *   background job (settleAllPending) that picks up rows with
 *   `rowHash IS NULL` every ~30 seconds and computes the chain in
 *   creation order. Decoupling write from chain compute means routes
 *   that bypass writeLog (direct prisma.activityLog.create calls in
 *   route files) still get chained.
 *
 *   A nightly verifier (verifyAllChains) recomputes each chain end-to-end
 *   and flags breaks by inserting an `audit_chain_break` ActivityLog
 *   event with the affected row IDs in `details`. Operators see the
 *   break via GET /api/admin/audit-chain/verify.
 *
 * Threat model coverage:
 *
 *   Defeats: insider with DB SELECT/INSERT/UPDATE/DELETE on activity_logs
 *   modifying rows to cover tracks. Without app-server access to
 *   the chain compute, they cannot recompute hashes for inserted /
 *   modified rows; the verifier detects the discontinuity.
 *
 *   Does NOT defeat: insider with both DB access AND app-server access
 *   (or knowledge of the canonical() function) who rewrites the chain
 *   and recomputes all subsequent hashes. That's the higher-bar threat
 *   the W4 design decision deliberately scoped out (Pass-6 W4 design
 *   call: hash-chain over HKDF-signed entries).
 *
 * [LEGAL-8-6] Safety-data coverage (arc-flash + LOTO):
 *
 *   The chain commits to each row's `details` JSON (see canonical() below). The
 *   arc-flash safety mutation paths now write the changed hazard values
 *   (incident energy / PPE / arc-flash boundary / PE attribution / study date /
 *   incident classification) into `details` with old->new + actor on every
 *   mutation:
 *     - SystemStudy edits        -> system_study_updated / *_pe_attribution_changed
 *     - SystemStudyAsset binds   -> arc_flash_study_assets_bound / *_unbound
 *     - PE results CSV imports   -> arc_flash_results_imported (per-bus from->to)
 *     - AFX overwrite imports    -> arc_flash_afx_import_applied (per-field from->to)
 *     - ingest reviewer edits    -> arc_flash_ingest_bus_edited
 *     - ingest confirm           -> arc_flash_ingest_confirmed (AI-provenance)
 *     - ArcFlashIncident         -> arc_flash_incident_logged / *_amended
 *     - v1 protective devices    -> api_v1_protective_device_created (payload hash)
 *   Because those values live in `details`, the chain transitively commits to the
 *   safety numbers — a later direct-DB edit of the value in its own table cannot
 *   change what the chain already attested without recomputing the whole chain
 *   (the higher-bar threat above).
 *
 * [DD-8-2] Residual / trust boundary (partially mitigated):
 *
 *   This scheme is tamper-EVIDENT, not tamper-PROOF. An actor with BOTH database
 *   write access AND app-server access (the canonical() + computeRowHash() code,
 *   here) can rewrite a row and recompute every subsequent hash, producing an
 *   internally-consistent forged chain that verifyAllChains() would pass. Full
 *   defeat of that actor requires anchoring the chain head OUTSIDE the trust
 *   boundary (e.g. periodic publish of the latest rowHash to an append-only
 *   external store / WORM bucket / notarization service), which is infra, not an
 *   application change. Until that exists, the integrity guarantee holds only
 *   against a DB-only insider; treat the app-server + DB compound actor as the
 *   accepted residual risk and gate that access operationally.
 */

const crypto = require('crypto');

// Stable JSON serialization: sort keys recursively + use a canonical
// form for special values. The chain is sensitive to ANY change in
// canonical form, so this function must be deterministic.
//
// v0.71.4 (audit-2 CR-1): userId intentionally excluded from canonical().
// Including userId meant every GDPR Art. 17 erasure (SET userId = NULL)
// changed the canonical payload for every row that user touched, causing
// the verifier to fire audit_chain_break on all those rows. Fix: drop
// userId from the payload. The chain still covers id, accountId,
// assetId, action, details, createdAt — all compliance-relevant fields.
// ServiceCycle conversion note: contractId became assetId, which changes
// the canonical form. This shipped together with the schema reset, so no
// rowHash backfill is needed — fresh databases chain from genesis with the
// new form.
//
// [LEGAL-8-6] `details` is part of the canonical payload, so when a safety
// mutation writes its changed hazard values (incident energy / PPE / boundary /
// PE attribution / study date / incident fields) into details with old->new +
// actor, the chain transitively commits to those values. Do NOT drop details
// from canonical() — that would un-cover every safety number the audit trail
// relies on.
function canonical(row) {
  const obj = {
    id:         row.id,
    accountId:  row.accountId === undefined ? null : row.accountId,
    assetId:    row.assetId === undefined ? null : row.assetId,
    // userId intentionally omitted — see comment above (audit-2 CR-1)
    action:     row.action,
    details:    row.details === undefined ? null : row.details,
    // Date.toISOString() pins to millisecond resolution; that's the
    // Postgres TIMESTAMP(3) granularity, so the chain is stable
    // regardless of which client did the insert.
    createdAt:  row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
  return stableStringify(obj);
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function computeRowHash(prevHash, canonicalRow) {
  // SHA-256 over (prevHash || "|" || canonical). The pipe separator
  // prevents trivial prefix attacks (otherwise rows with consecutive
  // prevHash values could collide).
  return crypto.createHash('sha256')
    .update(prevHash || '')
    .update('|')
    .update(canonicalRow)
    .digest('hex');
}

/**
 * Settle the chain for one accountId (or NULL for the global chain).
 * Picks up rows where rowHash IS NULL, ordered by (createdAt, id),
 * computes hashes referencing the most-recent settled row, writes back.
 * Idempotent — re-running with no NULL rows is a no-op.
 *
 * Returns { settled: N, lastHash: '<hex>' | null }.
 *
 * Caller is responsible for not running concurrent settlers on the same
 * account (the index.js cron runs serially, which is enough).
 */
async function settleAccount(prisma, accountId) {
  // Find the most-recent ALREADY-SETTLED row for this account; its
  // rowHash becomes the prevHash for the first new row.
  const lastSettled = await prisma.activityLog.findFirst({
    where:   { accountId: accountId, rowHash: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select:  { rowHash: true },
  });
  let prevHash = lastSettled ? lastSettled.rowHash : null;

  // S2-FN-02 (v0.75.x): cap pending fetch to 500 rows per call to bound
  // memory and per-call latency. Batch the N sequential updates into one
  //  so DB round-trips go from O(N) to O(1). When a full 500-row
  // batch lands, schedule the next settle immediately rather than waiting
  // the full 30-second cron interval.
  const SETTLE_BATCH = 500;
  const pending = await prisma.activityLog.findMany({
    where:   { accountId: accountId, rowHash: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select:  {
      id: true, accountId: true, assetId: true, userId: true,
      action: true, details: true, createdAt: true,
    },
    take: SETTLE_BATCH,
  });

  // Compute hashes sequentially (each depends on prevHash of prior row),
  // then flush all updates in one transaction.
  const updates = [];
  for (const row of pending) {
    const rh = computeRowHash(prevHash, canonical(row));
    updates.push({ id: row.id, prevHash, rowHash: rh });
    prevHash = rh;
  }

  if (updates.length > 0) {
    await prisma.$transaction(
      updates.map(u => prisma.activityLog.update({
        where: { id: u.id },
        data:  { prevHash: u.prevHash, rowHash: u.rowHash },
      }))
    );
  }

  const settled = updates.length;
  // If we hit the batch cap there are likely more rows; schedule an
  // immediate follow-up settle rather than waiting 30s.
  const hasMore = settled === SETTLE_BATCH;
  return { settled, lastHash: prevHash, hasMore };
}

/**
 * Settle every account that has pending rows. Returns per-account stats.
 */
async function settleAllPending(prisma) {
  // Discover distinct accountIds with pending rows.
  const pendingAccounts = await prisma.activityLog.findMany({
    where:   { rowHash: null },
    select:  { accountId: true },
    distinct: ['accountId'],
  });
  const results = [];
  for (const { accountId } of pendingAccounts) {
    const r = await settleAccount(prisma, accountId);
    results.push({ accountId, ...r });
    // S2-FN-02: if the batch was full, settle the same account again
    // immediately rather than waiting for the next 30s cron tick.
    if (r.hasMore) {
      let cont = r;
      while (cont.hasMore) {
        cont = await settleAccount(prisma, accountId);
        results.push({ accountId, ...cont });
      }
    }
  }
  return results;
}

/**
 * Verify the chain for one account. Returns:
 *   { accountId, ok: boolean, total: N, breakAt: [...rowIds], lastHash: '<hex>' }
 *
 * A "break" is a row whose stored rowHash doesn't match the recomputed
 * value given the chain so far. This indicates either tampering or
 * a settler race (rare but possible — settler updates the row's
 * prevHash/rowHash after another row was inserted with an earlier
 * createdAt). The verifier doesn't auto-heal; an operator must
 * investigate via the admin endpoint.
 */
async function verifyAccount(prisma, accountId) {
  const rows = await prisma.activityLog.findMany({
    where:   { accountId: accountId, rowHash: { not: null } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select:  {
      id: true, accountId: true, assetId: true, userId: true,
      action: true, details: true, createdAt: true,
      prevHash: true, rowHash: true,
    },
  });

  const breakAt = [];
  let prevHash = null;
  let lastHash = null;
  for (const row of rows) {
    const expectedPrev = prevHash; // null on first row
    const expectedRowHash = computeRowHash(expectedPrev, canonical(row));
    if ((row.prevHash || null) !== expectedPrev || row.rowHash !== expectedRowHash) {
      breakAt.push(row.id);
    }
    prevHash = row.rowHash;
    lastHash = row.rowHash;
  }
  return { accountId, ok: breakAt.length === 0, total: rows.length, breakAt, lastHash };
}

/**
 * Verify every account's chain. Returns per-account verification results
 * plus a `summary` object with aggregate counts.
 *
 * If any chain breaks, also writes an `audit_chain_break` ActivityLog
 * event (which itself gets chained eventually — so this is an
 * append-only signal even when the chain it describes is compromised).
 */
async function verifyAllChains(prisma) {
  const accounts = await prisma.activityLog.findMany({
    where:   { rowHash: { not: null } },
    select:  { accountId: true },
    distinct: ['accountId'],
  });

  const results = [];
  for (const { accountId } of accounts) {
    results.push(await verifyAccount(prisma, accountId));
  }

  const summary = {
    accountsChecked: results.length,
    accountsBroken:  results.filter(r => !r.ok).length,
    totalRowsChecked: results.reduce((s, r) => s + r.total, 0),
    totalBreaks:      results.reduce((s, r) => s + r.breakAt.length, 0),
    verifiedAt:       new Date().toISOString(),
  };

  // Emit an `audit_chain_break` event for each broken chain so the
  // tamper signal is itself logged. Without this, an attacker who
  // controls the verifier's process could quietly skip the log entry.
  for (const r of results.filter(r => !r.ok)) {
    try {
      await prisma.activityLog.create({
        data: {
          accountId: r.accountId,
          action:    'audit_chain_break',
          details:   {
            verifiedAt: summary.verifiedAt,
            totalRows:  r.total,
            breakAt:    r.breakAt.slice(0, 50), // cap to bound payload size
            note:       'Chain verification detected mismatched rowHash — possible tampering or settler race. Operator must investigate.',
          },
        },
      });
      // S5-FN-05 (v0.74.0): push chain-break to Better Stack so operator is paged
      // at the 03:45 run rather than discovering it via the admin UI.
      try {
        require('./betterStack').logEvent('audit_chain_break', {
          accountId:  r.accountId,
          verifiedAt: summary.verifiedAt,
          totalRows:  r.total,
          breakAt:    r.breakAt.slice(0, 10),
        });
      } catch (_) { /* best-effort */ }
    } catch (err) {
      console.error('[activityLogChain] failed to log chain break:', err.message);
    }
  }

  return { results, summary };
}

module.exports = {
  canonical, stableStringify, computeRowHash,
  settleAccount, settleAllPending,
  verifyAccount, verifyAllChains,
};

export {};

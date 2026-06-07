/**
 * lib/cron/nightlySync.js
 *
 * Nightly cloud marketplace auto-sync scheduler.
 *
 * Fires at 02:00 UTC every day. Iterates all accounts that have at least one
 * connected cloud connector (status === 'connected'), calls fetchPurchases()
 * on each, then syncs results into LapseIQ via syncEngine.
 *
 * Design:
 *   - Pure setTimeout — no new npm dependencies.
 *   - Each connector is synced independently; one failure does not abort others.
 *   - Errors are logged but not re-thrown; the scheduler reschedules itself
 *     regardless of how the run went.
 *   - call start() once at server boot (after DB is ready).
 */

import prisma from '../prisma';
const { syncPurchases }    = require('../syncEngine');
const { getProvider }      = require('../cloudConnectors');
const { decryptIfEncrypted } = require('../crypto');

// ── M2: Safe error categorization (mirrors routes/cloudConnectors.js) ─────────
function _categorizeSyncError(err) {
  const status = err?.response?.status;
  const msg    = (err?.message || '').toLowerCase();
  if (status === 401 || status === 403 || msg.includes('unauthorized') ||
      msg.includes('forbidden') || msg.includes('credentials') || msg.includes('invalid_client')) {
    return 'Authentication failed — check credentials and IAM permissions.';
  }
  if (status === 404 || msg.includes('not found')) {
    return 'Resource not found — verify account ID / project ID.';
  }
  if (status === 429 || msg.includes('throttl') || msg.includes('rate limit') || msg.includes('quota')) {
    return 'Rate limited by cloud provider — will retry at next sync.';
  }
  if (msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('timeout')) {
    return 'Network error — could not reach cloud provider API.';
  }
  if (status >= 500) return `Cloud provider server error (${status}) — will retry at next sync.`;
  return 'Sync failed — check server logs for details.';
}

// ── Credential helpers (mirrors routes/cloudConnectors.js) ─────────────────────

const SENSITIVE_KEYS = ['secretAccessKey', 'clientSecret', 'serviceAccountKey', 'privateKey', 'apiKey', 'secret', 'password'];

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.some(s => key.toLowerCase().includes(s.toLowerCase()));
}

function decryptCredentials(creds) {
  if (!creds || typeof creds !== 'object') return creds;
  const result = {};
  for (const [key, value] of Object.entries(creds)) {
    result[key] = (isSensitiveKey(key) && value) ? decryptIfEncrypted(value) : value;
  }
  return result;
}

// ── Sync runner ───────────────────────────────────────────────────────────────

async function runNightlySync() {
  const runStart = new Date();
  console.info(`[nightlySync] Starting nightly sync at ${runStart.toISOString()}`);

  let connectors;
  try {
    connectors = await prisma.cloudConnector.findMany({
      where:  { status: 'connected' },
      select: { id: true, accountId: true, provider: true, credentials: true },
    });
  } catch (err) {
    console.error('[nightlySync] Failed to query connectors:', err.message);
    return;
  }

  if (connectors.length === 0) {
    console.info('[nightlySync] No connected connectors found — nothing to sync.');
    return;
  }

  console.info(`[nightlySync] Found ${connectors.length} connected connector(s).`);

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalErrors  = 0;

  for (const connector of connectors) {
    const label = `[nightlySync][${connector.provider}:${connector.accountId.slice(0, 8)}]`;
    try {
      const providerMod = getProvider(connector.provider);
      if (!providerMod?.fetchPurchases) {
        console.warn(`${label} Provider module missing fetchPurchases — skipping.`);
        continue;
      }

      const plainCreds = decryptCredentials(connector.credentials ?? {});

      let records;
      try {
        // L4: enforce 5-minute wall-clock limit so one slow provider can't block others
        records = await _withTimeout(
          providerMod.fetchPurchases(plainCreds),
          CONNECTOR_TIMEOUT_MS,
          label
        );
      } catch (fetchErr) {
        // M2: log raw error server-side; store safe category in DB
        console.error(`${label} fetchPurchases failed:`, fetchErr.message);
        const safeError = _categorizeSyncError(fetchErr);
        await prisma.cloudConnector.update({
          where: { id: connector.id },
          data:  { lastError: safeError },
        }).catch(() => {});
        totalErrors++;
        continue;
      } finally {
        // M3: wipe plaintext credentials from memory immediately after fetch
        if (plainCreds && typeof plainCreds === 'object') {
          Object.keys(plainCreds).forEach(k => { plainCreds[k] = null; });
        }
      }

      if (!records || records.length === 0) {
        console.info(`${label} fetchPurchases returned 0 records — nothing to upsert.`);
        // Still update lastSyncAt so the UI shows "synced but empty"
        await prisma.cloudConnector.update({
          where: { id: connector.id },
          data:  { lastSyncAt: new Date(), lastError: null },
        }).catch(() => {});
        continue;
      }

      const result = await syncPurchases(connector.accountId, connector.provider, records);

      totalCreated += result.created;
      totalUpdated += result.updated;
      totalErrors  += result.errors.length;

      console.info(
        `${label} Sync complete — created: ${result.created}, updated: ${result.updated}, ` +
        `skipped: ${result.skipped}, errors: ${result.errors.length}`
      );

      if (result.errors.length > 0) {
        result.errors.forEach(e =>
          console.warn(`${label} Record error [${e.externalId}]: ${e.error}`)
        );
      }
    } catch (err) {
      console.error(`${label} Unexpected error during sync:`, err.message);
      totalErrors++;
    }
  }

  const elapsed = Date.now() - runStart.getTime();
  console.info(
    `[nightlySync] Run complete in ${elapsed}ms — ` +
    `total created: ${totalCreated}, updated: ${totalUpdated}, errors: ${totalErrors}`
  );
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Calculate milliseconds until the next 02:00 UTC.
 * If 02:00 UTC has already passed today, target tomorrow.
 */
function msUntilNext2amUtc() {
  const now    = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    2, 0, 0, 0   // 02:00:00.000 UTC
  ));
  if (target <= now) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - now.getTime();
}

let _timer = null;

function _scheduleNext() {
  const delay = msUntilNext2amUtc();
  const nextRun = new Date(Date.now() + delay);
  console.info(`[nightlySync] Next sync scheduled for ${nextRun.toISOString()} (in ${Math.round(delay / 60000)} min)`);

  _timer = setTimeout(async () => {
    await runNightlySync().catch(err =>
      console.error('[nightlySync] Unhandled error in runNightlySync:', err.message)
    );
    _scheduleNext();   // reschedule for tomorrow regardless of outcome
  }, delay);

  // Allow Node process to exit even if the timer is pending
  if (_timer.unref) _timer.unref();
}

// ── L4: Per-connector wall-clock timeout ──────────────────────────────────────
// Prevents a single slow/hung connector (e.g. Azure paginating 10k records)
// from blocking every later connector in the nightly run.
const CONNECTOR_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function _withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Connector timed out after ${ms / 60000} min`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Start the nightly sync scheduler.
 * Call once after the database connection is confirmed ready.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
function start() {
  if (_timer) return;  // already running
  console.info('[nightlySync] Scheduler starting...');
  _scheduleNext();
}

module.exports = { start, runNightlySync };

export {};

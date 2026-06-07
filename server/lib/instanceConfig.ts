'use strict';

/**
 * lib/instanceConfig.js
 * ---------------------
 * Singleton-row reader for the deployment-wide InstanceConfig table.
 *
 * The setup gate in server/index.js checks `setupCompletedAt` on every
 * incoming /api/* request, so this read is on the hot path. We cache the
 * result for CACHE_TTL_MS to avoid hitting the DB per-request, accepting
 * eventual consistency: a freshly-completed wizard takes up to TTL ms to
 * unlock the gate. The wizard's `complete` endpoint MUST call
 * invalidateInstanceConfigCache() right after the write so the next request
 * sees the new state immediately.
 *
 * upsert-on-read pattern: the InstanceConfig table holds exactly one row
 * (id = 'singleton'). On first read of a fresh DB, the row may not yet
 * exist — upsert creates it with all defaults so callers always get a
 * non-null cfg object back.
 *
 * NOT thread-safe across multiple Node processes (which we don't ship —
 * single-instance self-hosted is the deployment model). If you ever move
 * to a multi-process setup, replace the in-memory cache with a Redis read
 * or accept the per-request DB cost.
 */

import prisma from './prisma';

let _cached    = null;
let _cachedAt  = 0;
const CACHE_TTL_MS = 5_000; // 5s — short enough that operators don't notice, long enough to absorb burst traffic

/**
 * Get the singleton InstanceConfig row. Cached for CACHE_TTL_MS.
 *
 * @returns {Promise<{
 *   id: string,
 *   setupCompletedAt: Date | null,
 *   setupCompletedBy: string | null,
 *   demoMode: boolean,
 *   demoLastResetAt: Date | null,
 *   createdAt: Date,
 *   updatedAt: Date,
 * }>}
 */
async function getInstanceConfig() {
  if (_cached && Date.now() - _cachedAt < CACHE_TTL_MS) return _cached;
  _cached = await prisma.instanceConfig.upsert({
    where:  { id: 'singleton' },
    update: {},                  // touch nothing on read; just ensure row exists
    create: { id: 'singleton' }, // all other fields take their @default values
  });

  // Backwards-compat bootstrap: instances that existed BEFORE the
  // InstanceConfig table was added already have admin users and shouldn't be
  // forced through the setup wizard. We auto-mark configured in that case so
  // legacy upgrades don't trip the gate.
  //
  // v0.6.x bugfix: previously this fired whenever ANY admin existed, which
  // meant a FRESH install's wizard would short-circuit after step 1 (the
  // step that creates the first admin). The fix: only auto-mark when the
  // oldest admin pre-dates the InstanceConfig row. On a fresh install the
  // upsert above creates the row FIRST and the wizard creates the admin
  // AFTER, so admin.createdAt > config.createdAt -> no auto-mark, and the
  // wizard runs to completion. On a legacy instance the admins exist
  // months before the upsert creates the row -> admin.createdAt <
  // config.createdAt -> auto-mark fires once and is sticky thereafter.
  if (!_cached.setupCompletedAt) {
    const firstAdmin = await prisma.user.findFirst({
      where:   { role: 'admin' },
      orderBy: { createdAt: 'asc' },
      select:  { id: true, createdAt: true },
    });
    if (firstAdmin && firstAdmin.createdAt < _cached.createdAt) {
      _cached = await prisma.instanceConfig.update({
        where: { id: 'singleton' },
        data:  { setupCompletedAt: new Date(), setupCompletedBy: firstAdmin.id },
      });
      console.log('[instanceConfig] auto-marked configured (admin pre-dates config row — legacy bootstrap)');
    }
  }

  _cachedAt = Date.now();
  return _cached;
}

/**
 * Invalidate the cache. Call this immediately after any write to
 * InstanceConfig so the next call to getInstanceConfig() returns fresh data.
 */
function invalidateInstanceConfigCache() {
  _cached   = null;
  _cachedAt = 0;
}

/**
 * Convenience: returns true iff the first-run wizard has finished.
 * Wraps getInstanceConfig() so callers don't have to destructure.
 */
async function isInstanceConfigured() {
  const cfg = await getInstanceConfig();
  return !!cfg.setupCompletedAt;
}

module.exports = {
  getInstanceConfig,
  invalidateInstanceConfigCache,
  isInstanceConfigured,
};

export {};

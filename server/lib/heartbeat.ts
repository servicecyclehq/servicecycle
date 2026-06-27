/**
 * heartbeat.js — healthchecks.io cron heartbeat module
 *
 * Pass-5 Tier 4 / Agent 5 G10 follow-up. Wraps each cron callback with a
 * start / success / fail ping so a silently-stopped scheduler (node-cron
 * crash, malformed timezone, container OOM-killed at the wrong moment)
 * alarms within minutes of the missed window instead of weeks later when
 * a customer notices the maintenance-due alert never fired.
 *
 * Configuration (operator picks one — both forms can coexist; the per-check
 * override takes precedence):
 *
 *   1. Project key (recommended, scales as we add more crons):
 *        HEALTHCHECKS_PING_KEY=<22-char project ping key>
 *      The ping URL is `https://hc-ping.com/<key>/<slug>`, where <slug> is
 *      the cron name normalised to a valid healthchecks.io slug —
 *      lowercase, camelCase boundaries hyphenated, non-alphanumerics
 *      collapsed to hyphens. e.g. cron `alertEngine` → slug `alert-engine`,
 *      `restoreTest` → `restore-test`, `backup` → `backup`.
 *
 *      IMPORTANT: healthchecks.io rejects a mixed-case / non-slug path with
 *      HTTP 400 "invalid url format", and returns HTTP 404 for a valid slug
 *      it has never seen. So the target check must be CREATED first — either
 *      in the dashboard, or by sending one ping with `?create=1` appended:
 *        curl -fsS -m5 --retry 2 -X POST \
 *          "https://hc-ping.com/<key>/alert-engine?create=1"
 *      We deliberately do NOT append `?create=1` on every ping: the free
 *      tier caps at 20 checks and blanket auto-create would provision a
 *      check for all ~20 crons (prunes/settles included) and clutter the
 *      board. Pre-create only the crons you actually want to watch.
 *
 *   2. Per-check full URL (override the project-key derivation):
 *        HEALTHCHECKS_URL_ALERTENGINE=https://hc-ping.com/<uuid>
 *        HEALTHCHECKS_URL_BACKUP=https://hc-ping.com/<uuid>
 *        HEALTHCHECKS_URL_ACTIVITYLOGPRUNE=https://hc-ping.com/<uuid>
 *        HEALTHCHECKS_URL_BACKUPLOGPRUNE=https://hc-ping.com/<uuid>
 *        HEALTHCHECKS_URL_REFRESHTOKENPRUNE=https://hc-ping.com/<uuid>
 *        HEALTHCHECKS_URL_EARLYACCESSPRUNE=https://hc-ping.com/<uuid>
 *        HEALTHCHECKS_URL_DEMOPRUNE=https://hc-ping.com/<uuid>
 *        HEALTHCHECKS_URL_DEMORESET=https://hc-ping.com/<uuid>
 *      The env var name is `HEALTHCHECKS_URL_` + the cron name uppercased
 *      with non-alphanumerics replaced by underscore. A UUID ping URL is
 *      used verbatim (no slug normalisation, no 400/404 slug rules).
 *
 * If NEITHER form is set, every call is a no-op. This module never throws
 * and never blocks the cron callback — monitoring outages must not
 * destabilize the scheduled work itself.
 *
 * POP-8-3: "no-op when unconfigured" means an unmonitored production box can
 * lose its scheduler silently. This module intentionally cannot self-provision
 * a healthchecks.io account, so the fail-LOUD enforcement lives at startup:
 * server/index.ts emits a prominent warning in production when no heartbeat
 * target is configured (unless HEARTBEAT_MONITORING_ACK=true). Configure a key
 * here to make a dead cron alarm within minutes.
 *
 * See docs/observability.md for end-to-end setup instructions.
 */

'use strict';

const HC_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 10_000; // healthchecks.io accepts up to ~100KB; keep small

function envSlug(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

// healthchecks.io ping-key slugs must be lowercase, digits, and hyphens.
// A mixed-case path (e.g. the raw cron name `alertEngine`) is rejected with
// HTTP 400 "invalid url format", so the cron name MUST be normalised before
// it is used as the slug. camelCase boundaries become hyphens so the slug
// stays readable: `alertEngine` → `alert-engine`, `webhookDlqRetry` →
// `webhook-dlq-retry`, `backup` → `backup`.
function hcSlug(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')   // split camelCase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')              // any run of non-slug chars → hyphen
    .replace(/^-+|-+$/g, '');                 // trim leading/trailing hyphens
}

/**
 * Resolve the ping URL for a given cron and signal.
 *  signal === 'start'   → POST {baseUrl}/start
 *  signal === 'fail'    → POST {baseUrl}/fail
 *  signal === 'success' → POST {baseUrl}        (healthchecks default)
 * Returns null if no monitoring is configured for the cron.
 */
function urlFor(name, signal) {
  const overrideEnv = `HEALTHCHECKS_URL_${envSlug(name)}`;
  const override = process.env[overrideEnv];
  const pingKey = process.env.HEALTHCHECKS_PING_KEY;

  let baseUrl = null;
  if (override && /^https?:\/\//i.test(override)) {
    baseUrl = override.replace(/\/+$/, '');
  } else if (pingKey) {
    baseUrl = `https://hc-ping.com/${encodeURIComponent(pingKey)}/${hcSlug(name)}`;
  }
  if (!baseUrl) return null;

  if (signal === 'start') return `${baseUrl}/start`;
  if (signal === 'fail')  return `${baseUrl}/fail`;
  return baseUrl;
}

/**
 * Ping the configured healthchecks.io endpoint for `name`.
 *
 *  name   — cron name as passed to runOnce(name, fn). Normalised to a
 *           healthchecks slug via hcSlug(); the resulting slug must match a
 *           check that already exists on healthchecks.io (see header note).
 *  signal — 'start' | 'success' | 'fail'. Defaults to 'success'.
 *  body   — optional short string (timing info, error message). Capped at
 *           MAX_BODY_BYTES to avoid accidentally posting a stack trace
 *           with PII.
 *
 * Always resolves; never throws. Failures are silently swallowed unless
 * HEALTHCHECKS_DEBUG=true is set, in which case a single warn log is
 * emitted so operators can diagnose misconfiguration.
 */
async function pingHeartbeat(name, signal = 'success', body = null) {
  const url = urlFor(name, signal);
  if (!url) return;

  let controller;
  let timer;
  try {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), HC_TIMEOUT_MS);

    const init: any = {
      method: 'POST',
      headers: { 'User-Agent': 'ServiceCycle-heartbeat/1.0' },
      signal: controller.signal,
    };
    if (body != null) {
      const bodyStr = typeof body === 'string' ? body : String(body);
      init.body = bodyStr.length > MAX_BODY_BYTES ? bodyStr.slice(0, MAX_BODY_BYTES) : bodyStr;
      init.headers['Content-Type'] = 'text/plain; charset=utf-8';
    }

    const resp = await fetch(url, init);
    if (!resp.ok && process.env.HEALTHCHECKS_DEBUG === 'true') {
      console.warn(`[heartbeat] ${name} (${signal}) returned HTTP ${resp.status}`);
    }
  } catch (e) {
    if (process.env.HEALTHCHECKS_DEBUG === 'true') {
      console.warn(`[heartbeat] ${name} (${signal}) ping failed: ${e.message}`);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { pingHeartbeat, urlFor, hcSlug };

export {};

'use strict';

/**
 * server/lib/betterStack.js
 * -------------------------
 *
 * Centralised event-ingest client for Better Stack (Pass-6 W4 task #9).
 *
 * No-op when not configured. The operator sets:
 *   BETTERSTACK_INGEST_URL    e.g. https://in.logs.betterstack.com
 *   BETTERSTACK_SOURCE_TOKEN  bearer token from Better Stack sources UI
 *
 * If either is missing, every call returns immediately without making
 * network requests. This keeps the lib safe to call from anywhere — we
 * don't want a missing-config state to interfere with code paths that
 * benefit from structured logging when it IS configured.
 *
 * Why a thin wrapper and not pino/winston-betterstack transports?
 *   - The cascade event payload has known shape; we want a single source
 *     of truth for the schema so analytics queries don't drift.
 *   - The volume is low (one event per AI call + occasional alerts);
 *     batching/buffering complexity isn't earned yet.
 *   - When this lib evolves (replace Better Stack with CloudWatch, add
 *     local mirroring, etc.), the call sites stay the same.
 */

const BS_TIMEOUT_MS = 5_000;
const BS_MAX_PAYLOAD_BYTES = 32_000; // Better Stack's per-event soft cap

function getConfig() {
  const url = process.env.BETTERSTACK_INGEST_URL;
  const token = process.env.BETTERSTACK_SOURCE_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

/**
 * Post a single event to Better Stack. Fire-and-forget — never throws.
 *
 * @param {string} eventName  short snake_case name; e.g. 'ai_cascade_attempt'
 * @param {object} fields     additional structured fields
 * @returns {Promise<void>}
 */
async function logEvent(eventName, fields: any = {}) {
  const cfg = getConfig();
  if (!cfg) return;
  if (typeof eventName !== 'string' || !eventName) return;

  const payload = {
    dt:        new Date().toISOString(),
    event:     eventName,
    service:   'lapseiq-server',
    version:   process.env.LAPSEIQ_VERSION || 'unknown',
    env:       process.env.NODE_ENV || 'production',
    demo_mode: process.env.DEMO_MODE === 'true',
    ...fields,
  };

  let body;
  try {
    body = JSON.stringify(payload);
  } catch (e) {
    // Probably circular reference in fields. Drop the offending event.
    if (process.env.BETTERSTACK_DEBUG === 'true') {
      console.warn('[betterStack] payload serialization failed:', e.message);
    }
    return;
  }

  if (body.length > BS_MAX_PAYLOAD_BYTES) {
    // Truncate by re-serializing without the message-body field if present.
    const trimmed = { ...payload };
    if ('details' in trimmed) trimmed.details = '[truncated]';
    if ('payload' in trimmed) trimmed.payload = '[truncated]';
    try { body = JSON.stringify(trimmed); } catch { return; }
  }

  let controller;
  let timer;
  try {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), BS_TIMEOUT_MS);
    const resp = await fetch(cfg.url, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${cfg.token}`,
        'Content-Type':  'application/json',
        'User-Agent':    'LapseIQ-betterStack/1.0',
      },
      body,
      signal: controller.signal,
    });
    if (!resp.ok && process.env.BETTERSTACK_DEBUG === 'true') {
      console.warn(`[betterStack] ${eventName} returned HTTP ${resp.status}`);
    }
  } catch (e) {
    if (process.env.BETTERSTACK_DEBUG === 'true') {
      console.warn(`[betterStack] ${eventName} dispatch failed: ${e.message}`);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Helper for AI cascade events — pinned schema so the Better Stack
 * dashboard query stays stable across changes to the cascade
 * dispatcher. Call from server/lib/ai.js on every provider attempt.
 *
 * @param {object} p
 * @param {string} p.provider      'cloudflare' | 'huggingface' | 'groq' | 'gemini'
 * @param {number} p.hop           0 for primary, 1+ for fallback hops
 * @param {string} p.task          'extract' | 'brief' | 'ask' | 'classify'
 * @param {string} p.outcome       'success' | 'cascade' | 'fail' | 'breaker_open'
 * @param {number} p.latencyMs     wall-clock ms for the attempt (success or fail)
 * @param {string} [p.errorName]   ServerError | ClientError | QuotaError | TimeoutError
 * @param {string} [p.errorMessage] truncated to 200 chars
 */
function logCascadeEvent(p) {
  return logEvent('ai_cascade_attempt', {
    provider:      p.provider,
    hop:           Number(p.hop) || 0,
    task:          p.task,
    outcome:       p.outcome,
    latency_ms:    Number(p.latencyMs) || 0,
    error_name:    p.errorName,
    error_message: p.errorMessage ? String(p.errorMessage).slice(0, 200) : undefined,
  });
}

module.exports = { logEvent, logCascadeEvent };

export {};

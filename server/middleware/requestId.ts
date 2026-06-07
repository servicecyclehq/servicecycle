/**
 * requestId.js — per-request UUID middleware for /api/v1/* responses.
 *
 * Sets `req.requestId` AND emits `X-Request-Id` on the response. The header
 * is the support-triage primitive: when an integrator complains about a
 * failing endpoint, the first thing they share is the request id from
 * their HTTP client logs, and we grep for it in `winston` to find the
 * corresponding server-side error trace.
 *
 * v0.37.1 W5 MT-129.
 *
 * Behaviour:
 *   - If the client already sent an `X-Request-Id` header (rare in
 *     practice but common for upstream gateways / k8s ingress chains)
 *     we honor it after sanitising — strips any CR/LF + caps length at
 *     128 chars so a hostile client can't inject log lines via the
 *     header value.
 *   - Otherwise we mint a fresh UUID v4 via the existing `uuid` dep.
 *
 * Apply per-route, not globally — keeps the surface minimal until we
 * decide every endpoint should carry one.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

const HEADER = 'X-Request-Id';
const MAX_LEN = 128;
// Conservative whitelist: hex, letter, digit, dash, underscore. Anything
// else gets dropped before we honor a client-supplied value.
const SAFE = /^[A-Za-z0-9_-]+$/;

function sanitiseInbound(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_LEN) return null;
  if (!SAFE.test(trimmed)) return null;
  return trimmed;
}

function requestId(req, res, next) {
  const inbound = sanitiseInbound(req.get(HEADER));
  req.requestId = inbound || uuidv4();
  res.setHeader(HEADER, req.requestId);
  next();
}

module.exports = { requestId };

export {};

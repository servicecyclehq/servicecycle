// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// schemas/common.js  (Item 2 â€” central request/response validation)
//
// Shared Zod building blocks + the ONE canonical route-key normalizer used by
// every consumer (the validation middleware, the schema registry, the route
// inventory generator, and the OpenAPI builder). Keeping normalizeKey here â€”
// and ONLY here â€” guarantees the key a request resolves to at runtime is byte-
// identical to the key authored in the registry and emitted into openapi.json.
//
// Response-shape philosophy mirrors schemas/api.js: objects are .passthrough()
// so ADDING a field never trips drift; REMOVING a required field does. The
// per-endpoint precise schemas list only the MINIMUM the client depends on.
//
// Safe-default philosophy (the long tail â€” reports/admin/etc.):
//   - request body/params/query default to passthrough â†’ NEVER reject live
//     traffic. Only hand-authored precise bodies can 400, and those are
//     written to match the handler's existing guard so behaviour is unchanged.
//   - response defaults to object|array|null â†’ catches a handler that returns
//     a bare primitive (a real, if rare, regression) with ~zero false drift.
//     In production validateResponse only LOGS, so even a miss is non-fatal.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

'use strict';

const { z } = require('zod');

// â”€â”€ canonical key normalizer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// key = "METHOD /api/full/path"  (pattern path, params kept as :name)
// Used identically by middleware (basePath = mount pattern, routePath =
// layer.route.path) and by the static inventory/openapi generators.
function normalizeKey(method, basePath, routePath) {
  let full = String(basePath || '').replace(/\/+$/, '');
  const sub = String(routePath || '');
  if (sub && sub !== '/') {
    full += sub.startsWith('/') ? sub : '/' + sub;
  }
  full = full.replace(/\/+$/, '') || '/';
  return String(method).toUpperCase() + ' ' + full;
}

// â”€â”€ envelope helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The dominant convention: { success: true, data: <T> }.
const envelope = (dataSchema) =>
  z.object({ success: z.literal(true), data: dataSchema }).passthrough();

// Mutation endpoints that just confirm: { success: true }  (data optional).
const successOnly = z.object({ success: z.literal(true) }).passthrough();

// â”€â”€ safe defaults â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PASSTHROUGH = z.object({}).passthrough();          // body / query default
const ANY_PARAMS  = z.object({}).passthrough();          // params default (all strings)
// object | array | null â€” rejects only top-level primitives.
const DEFAULT_RESPONSE = z.union([
  z.array(z.unknown()),
  z.object({}).passthrough(),
  z.null(),
]);

const DEFAULTS = Object.freeze({
  body:     PASSTHROUGH,
  params:   ANY_PARAMS,
  query:    PASSTHROUGH,
  response: DEFAULT_RESPONSE,
});

// Fill an authored partial entry with defaults so the middleware can rely on
// all four slots existing. `precise` flags whether this is a hand-authored
// entry (used by the coverage report only).
function withDefaults(partial) {
  const p = partial || {};
  return {
    body:     p.body     || DEFAULTS.body,
    params:   p.params   || DEFAULTS.params,
    query:    p.query    || DEFAULTS.query,
    response: p.response || DEFAULTS.response,
    precise: {
      body:     !!p.body,
      params:   !!p.params,
      query:    !!p.query,
      response: !!p.response,
    },
    summary: p.summary || null,
    tags:    p.tags || null,
  };
}

module.exports = {
  z,
  normalizeKey,
  envelope,
  successOnly,
  PASSTHROUGH,
  ANY_PARAMS,
  DEFAULT_RESPONSE,
  DEFAULTS,
  withDefaults,
};
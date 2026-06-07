// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// middleware/validation.js  (Item 2 â€” central request + response validation)
//
// Two entry points, both wired from server/index.js:
//
//   installValidation(router, basePath)
//     Walks an Express Router's stack and, for every route handler, swaps in a
//     wrapper that runs request validation (params â†’ query â†’ body) against the
//     registry entry for that route BEFORE the real handler. Implemented by
//     replacing layer.handle (NOT by injecting fake Layer objects) so Express's
//     own Layer.handle_request machinery keeps working unchanged. Idempotent.
//
//   installResponseValidation(app)
//     One global middleware that patches res.json to validate the outgoing
//     payload against the registry entry stashed on the request by the request
//     wrapper. Delegates to lib/responseValidator (logs + render_errors in
//     prod, would-throw in dev) but is wrapped so a validation hiccup can NEVER
//     break response delivery.
//
// Safety: registry defaults are passthrough for body/params/query, so a route
// with no hand-authored schema is never rejected. Only precise schemas â€” each
// written to mirror the handler's existing guard â€” can produce a 400.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

'use strict';

const { getEntry, normalizeKey } = require('../schemas/registry');
const { validateResponse } = require('../lib/responseValidator');

// Validate one request. Returns true if a 400 was sent (caller must stop).
function runRequestValidation(entry, req, res) {
  // params â†’ query â†’ body. params/query are always objects on Express reqs;
  // body may be undefined on verbs without a parsed body, so coerce to {}.
  const parts = [
    ['params', req.params || {}],
    ['query',  req.query  || {}],
    ['body',   req.body == null ? {} : req.body],
  ];
  for (const [name, value] of parts) {
    const schema = entry[name];
    if (!schema) continue;
    const r = schema.safeParse(value);
    if (!r.success) {
      const issue = r.error.issues[0];
      const field = (issue && issue.path && issue.path.join('.')) || name;
      const reason = (issue && issue.message) || 'Invalid value';
      res.status(400).json({
        success: false,
        error: 'Invalid ' + field + ': ' + reason,
        field,
      });
      return true;
    }
  }
  return false;
}

function installValidation(router, basePath) {
  if (!router || !Array.isArray(router.stack)) return router;
  for (const layer of router.stack) {
    const route = layer && layer.route;
    if (!route || !Array.isArray(route.stack)) continue;
    const routePath = route.path;
    // Skip array/regex route paths â€” can't form a stable registry key.
    if (typeof routePath !== 'string') continue;

    for (const rl of route.stack) {
      const method = rl && rl.method;
      if (!method || typeof rl.handle !== 'function') continue;
      if (rl.__lqValidated) continue; // idempotent across double-installs
      rl.__lqValidated = true;

      const key = normalizeKey(method, basePath, routePath);
      const entry = getEntry(key);
      const orig = rl.handle;

      rl.handle = function lqValidatedHandle(req, res, next) {
        // Validate ONCE per request even though a route may have several
        // handler layers (e.g. requireManager + handler).
        if (!req.__lqReqValidated) {
          req.__lqReqValidated = true;
          req._schemaEntry = entry;
          req._routeKey = key;
          try {
            if (runRequestValidation(entry, req, res)) return; // 400 sent
          } catch (e) {
            // Never let a validator bug break the request â€” fall through to
            // the real handler.
            console.error('[validation] request check error on', key, '::', e && e.message);
          }
        }
        return orig.call(this, req, res, next);
      };
    }
  }
  return router;
}

function installResponseValidation(app) {
  app.use(function lqResponsePatch(req, res, next) {
    const orig = res.json.bind(res);
    res.json = function (payload) {
      try {
        const entry = req._schemaEntry;
        const status = res.statusCode || 200;
        // Only validate success payloads â€” error envelopes ({success:false,...})
        // are a different shape and would otherwise log false drift on every 4xx/5xx.
        if (entry && entry.response && status < 400) {
          // validateResponse: logs + persists render_errors in prod, throws in
          // dev. We swallow any throw so response delivery is never blocked;
          // the drift is still surfaced via its console.error / render_errors.
          validateResponse(req._routeKey || (req.method + ' ' + req.originalUrl), entry.response, payload, req);
        }
      } catch (e) {
        console.error('[validation] response drift on', req._routeKey || req.originalUrl, '::', e && e.message);
      }
      return orig(payload);
    };
    next();
  });
  return app;
}

module.exports = { installValidation, installResponseValidation, runRequestValidation };

export {};

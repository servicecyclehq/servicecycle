// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// server/lib/responseValidator.js  (v0.90.9)
//
// Catches API-shape regressions at the response boundary. The pattern the
// v0.87 / v0.89.7 cascades exposed: a Prisma field rename (or refactor)
// silently reshapes an endpoint response, and downstream React code crashes
// on the first .map() / .access. ErrorBoundary + render_errors catches the
// crash in prod, but by then it's already happened.
//
// validateResponse() wraps res.json() shape checks AT the source. If the
// payload doesn't match the contract:
//   - NODE_ENV !== 'production'  â†’ throw (Playwright smoke + dev catches it)
//   - NODE_ENV === 'production' â†’ log + persist a render_errors row with
//                                  kind='server' name='ContractDrift', so
//                                  the same dashboard sees the regression.
//                                  Original payload still ships (don't blow
//                                  up the user's request just because the
//                                  shape drifted).
//
// Schemas live in server/schemas/api.js. They are intentionally loose --
// .passthrough() lets us ADD new fields without triggering drift, but
// REMOVING a required field is structural and gets caught.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const IS_PROD = process.env.NODE_ENV === 'production';

function trunc(v, max) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Validate a response payload against a zod schema.
 *
 * @param {string} endpointName  - e.g. "/api/config"
 * @param {z.ZodTypeAny} schema  - zod schema (typically from schemas/api.js)
 * @param {object} payload       - the object about to be res.json'd
 * @param {object} [req]         - express req (for telemetry enrichment)
 * @returns {object} the payload, unchanged. Returns same ref so callsite
 *                   can `return res.json(validateResponse(...))`.
 *
 * In production: never throws. Drift is observable via render_errors.
 * In dev/test:   throws on drift so smoke + unit tests catch it loudly.
 */
function validateResponse(endpointName, schema, payload, req) {
  const result = schema.safeParse(payload);
  if (result.success) return payload;

  // Drift detected. Build a compact issue summary so render_errors.message
  // is actionable: "path.to.field: expected string, got undefined"
  const issues = (result.error && result.error.issues) || [];
  const issueSummary = issues.slice(0, 5).map(i => {
    const path = (i.path || []).join('.') || '(root)';
    return path + ': ' + i.message;
  }).join(' | ');

  if (!IS_PROD) {
    // Loud failure in dev: tests + smoke see the throw immediately.
    const err = new Error('[ContractDrift] ' + endpointName + ' :: ' + issueSummary);
    (err as any).endpointName = endpointName;
    (err as any).issues = issues;
    throw err;
  }

  // Production: persist + return payload unchanged.
  try {
    const prisma = require('./prisma').default;
    const errorCode = 'DRIFT-' + Date.now().toString(36).toUpperCase();
    const ip = req
      ? ((req.headers && req.headers['x-forwarded-for']) || req.ip || 'unknown').split(',')[0].trim()
      : 'unknown';
    prisma.renderError.create({
      data: {
        kind:           'server',
        errorCode:      errorCode,
        name:           'ContractDrift',
        message:        trunc(endpointName + ' :: ' + issueSummary, 1000),
        stack:          trunc(JSON.stringify(issues, null, 2), 4000),
        path:           trunc(endpointName, 500),
        userId:         req && req.user && req.user.id        ? req.user.id        : null,
        accountId:      req && req.user && req.user.accountId ? req.user.accountId : null,
        userAgent:      req ? trunc(req.headers && req.headers['user-agent'], 500) : null,
        lapseiqVersion: trunc(process.env.LAPSEIQ_VERSION, 32),
        ip:             trunc(ip, 64),
      },
    }).catch((persistErr) => {
      console.error('[ContractDrift] failed to persist:', persistErr && persistErr.message);
    });
    // Also stdout so Better Stack sees it in realtime.
    console.error('[ContractDrift]', endpointName, '::', issueSummary);
  } catch (_) { /* never throw from a telemetry path */ }

  return payload;
}

module.exports = { validateResponse };

export {};

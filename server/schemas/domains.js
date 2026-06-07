// ─────────────────────────────────────────────────────────────────────────────
// schemas/domains.js  (Item 2 — hand-authored precise schemas)
//
// Keys are canonical "METHOD /api/full/path" (see common.normalizeKey).
// Anything NOT listed here falls back to common.DEFAULTS via the registry:
//   body/params/query → passthrough (never rejects live traffic)
//   response          → object|array|null (logs-only in prod)
//
// Precision priority = the shapes the client reads on hot paths (the bug class
// the v0.89.x /api/preferences cascade came from). Inner objects stay
// .passthrough() so additive changes never trip drift.
//
// Request bodies are authored ONLY where the handler already 400s on the same
// condition, so turning them on changes nothing for valid callers. Endpoints
// that already validateBody() inline (auth/users) are left to their inline
// schema — we keep the central body permissive there to avoid a double 400
// with a less-specific message.
//
// ServiceCycle conversion note: every entry for the removed contract-renewal
// surface (/api/contracts*, /api/vendors*, /api/budget*, /api/news*,
// /api/categories*, dashboard precise shape) has been dropped. The registry
// is passthrough for unregistered routes, so the new asset/site/work-order
// routes run on safe defaults until a later pass authors precise schemas.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { z, envelope, successOnly } = require('./common');
const {
  authMeSchema,
  bootstrapSchema,
} = require('./api');

// ── small reusable shapes ─────────────────────────────────────────────────────
const arr = z.array(z.unknown());

const overrides = {
  // ── auth / identity (response only; bodies validated inline) ────────────────
  'GET /api/auth/me': { response: authMeSchema, summary: 'Current authenticated user + account' },

  // ── bootstrap (highest blast radius; loose during the model rework) ─────────
  'GET /api/bootstrap': { response: bootstrapSchema, summary: 'Mount-time bundle for the authed SPA shell' },

  // ── preferences (the /api/preferences cascade origin) ───────────────────────
  'GET /api/preferences': {
    response: z.object({ items: z.array(z.unknown()) }).passthrough(),
    summary: 'All key/value preferences for the current user',
  },
  'GET /api/preferences/:key': {
    response: z.object({
      key:       z.string(),
      value:     z.unknown(),                // null when unset (200, not 404)
      updatedAt: z.union([z.string(), z.null()]),
    }).passthrough(),
    summary: 'Single preference value (value=null when unset)',
  },

  // ── alerts ───────────────────────────────────────────────────────────────────
  'GET /api/alerts': {
    response: envelope(z.object({ alerts: arr, count: z.number() }).passthrough()),
    summary: 'Active alerts for the current user/scope',
  },
  'GET /api/alerts/preferences': {
    response: envelope(z.object({ preferences: z.array(z.unknown()) }).passthrough()),
    summary: 'Per-user alert delivery preferences',
  },

  // ── custom fields ────────────────────────────────────────────────────────────
  'GET /api/custom-fields': {
    response: envelope(z.object({ fields: arr }).passthrough()),
    summary: 'Account-defined custom asset fields',
  },
  'POST /api/custom-fields': {
    // handler 400s without name + type → matches existing guard.
    body: z.object({ name: z.string(), type: z.string() }).passthrough(),
    response: envelope(z.object({ field: z.object({}).passthrough() }).passthrough()),
    summary: 'Create a custom field',
  },
};

module.exports = { overrides };

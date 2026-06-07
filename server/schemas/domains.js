// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// schemas/domains.js  (Item 2 â€” hand-authored precise schemas)
//
// Keys are canonical "METHOD /api/full/path" (see common.normalizeKey).
// Anything NOT listed here falls back to common.DEFAULTS via the registry:
//   body/params/query â†’ passthrough (never rejects live traffic)
//   response          â†’ object|array|null (logs-only in prod)
//
// Precision priority = the shapes the client reads on hot paths (the bug class
// the v0.89.x /api/preferences + v0.89.7 /api/news cascades came from). Inner
// objects stay .passthrough() so additive changes never trip drift.
//
// Request bodies are authored ONLY where the handler already 400s on the same
// condition, so turning them on changes nothing for valid callers. Endpoints
// that already validateBody() inline (auth/contracts/users) are left to their
// inline schema â€” we keep the central body permissive there to avoid a double
// 400 with a less-specific message.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

'use strict';

const { z, envelope, successOnly } = require('./common');
const {
  authMeSchema,
  bootstrapSchema,
  newsSummarySchema,
} = require('./api');

// â”€â”€ small reusable shapes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const Pagination = z.object({
  page:  z.number(),
  limit: z.number(),
  total: z.number(),
  pages: z.number(),
}).passthrough();

const arr = z.array(z.unknown());

const overrides = {
  // â”€â”€ auth / identity (response only; bodies validated inline) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/auth/me': { response: authMeSchema, summary: 'Current authenticated user + account' },

  // â”€â”€ bootstrap / news (highest blast radius; from schemas/api.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/bootstrap':    { response: bootstrapSchema,   summary: 'Mount-time bundle: contracts + members + vendors + categories + settings' },
  'GET /api/news/summary': { response: newsSummarySchema, summary: 'Navbar news/outage badge counts' },

  // â”€â”€ preferences (the /api/preferences cascade origin) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/dashboard': {
    response: envelope(z.object({
      summary: z.object({
        totalActive:            z.number(),
        totalAnnualSpend:       z.number(),
        expiringIn90Days:       z.number(),
        autoRenewalTraps:       z.number(),
        spendAtRisk:            z.number(),
        totalSavingsNegotiated: z.number(),
        openAlerts:             z.number(),
      }).passthrough(),
      needsAttentionToday: z.object({}).passthrough(),
      upcomingRenewals:    arr,
      spendByVendor:       arr,
      renewalsByMonth:     arr,
    }).passthrough()),
    summary: 'Dashboard summary cards + charts',
  },

  // â”€â”€ contracts (list + detail) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/contracts': {
    response: envelope(z.object({
      contracts:       arr,
      pagination:      Pagination,
      scopeRestricted: z.boolean(),
    }).passthrough()),
    summary: 'Paginated contract list',
  },
  'GET /api/contracts/:id': {
    response: envelope(z.object({ contract: z.object({}).passthrough() }).passthrough()),
    summary: 'Single contract detail',
  },

  // â”€â”€ vendors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/vendors': {
    response: envelope(z.object({ vendors: arr }).passthrough()),
    summary: 'Vendor list',
  },

  // â”€â”€ alerts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/alerts': {
    response: envelope(z.object({ alerts: arr, count: z.number() }).passthrough()),
    summary: 'Active alerts for the current user/scope',
  },
  'GET /api/alerts/preferences': {
    response: envelope(z.object({ preferences: z.array(z.unknown()) }).passthrough()),
    summary: 'Per-user alert delivery preferences',
  },

  // â”€â”€ categories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/categories': {
    response: envelope(z.object({ categories: arr }).passthrough()),
    summary: 'Contract categories',
  },
  'POST /api/categories': {
    // handler 400s when name missing â†’ requiring it here changes nothing valid.
    body: z.object({ name: z.string() }).passthrough(),
    response: envelope(z.object({ category: z.object({}).passthrough() }).passthrough()),
    summary: 'Create a category',
  },

  // â”€â”€ custom fields â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/custom-fields': {
    response: envelope(z.object({ fields: arr }).passthrough()),
    summary: 'Account-defined custom contract fields',
  },
  'POST /api/custom-fields': {
    // handler 400s without name + type â†’ matches existing guard.
    body: z.object({ name: z.string(), type: z.string() }).passthrough(),
    response: envelope(z.object({ field: z.object({}).passthrough() }).passthrough()),
    summary: 'Create a custom field',
  },

  // â”€â”€ budget â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/budget/forecast': {
    response: envelope(z.object({}).passthrough()),
    summary: 'Budget forecast',
  },
};

module.exports = { overrides };
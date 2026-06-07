// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// server/schemas/api.js  (v0.90.9)
//
// Zod response contracts for the highest-blast-radius endpoints. These run
// at the res.json() boundary via lib/responseValidator.js so an accidental
// field rename / removal surfaces as a ContractDrift row in render_errors
// instead of a silent client crash three pages downstream.
//
// Design choice: .passthrough() on every object. Adding new fields is fine;
// removing required ones triggers drift. The required-field set is the
// MINIMUM the client depends on -- anything optional client-side is not in
// the schema. Bias toward catching real regressions, not flagging cosmetic
// additions.
//
// Coverage target = the four endpoints whose response shapes are read on
// EVERY authed page-load. Render-time crashes here cascade through
// AuthContext / Sidebar / Dashboard / the active page in one go.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const { z } = require('zod');

// Envelope wrapper -- every wrapped endpoint returns { success: true, data: T }
const envelope = (dataSchema) =>
  z.object({
    success: z.literal(true),
    data:    dataSchema,
  }).passthrough();

// â”€â”€ /api/auth/me â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AuthContext.fetchUser cascades into Sidebar permission gates, AI consent
// modal, the entire authed layout. A drift here breaks every authed page.
const authMeSchema = envelope(
  z.object({
    user: z.object({
      id:        z.string(),
      accountId: z.string(),
      name:      z.string().nullable().optional(),
      email:     z.string(),
      role:      z.string(),
      // featureFlags + hiddenFeatures are read by Sidebar; if missing,
      // every "is this feature visible" check becomes a TypeError.
      featureFlags:   z.unknown().optional(),
      hiddenFeatures: z.unknown().optional(),
      account: z.object({
        id:          z.string(),
        companyName: z.string().nullable().optional(),
        status:      z.string(),
        planType:    z.string().nullable().optional(),
        planTier:    z.string().nullable().optional(),
      }).passthrough(),
    }).passthrough(),
    // aiProvider + aiConsentVersion drive the consent modal copy + version
    // tracking. AI consent gates AI features account-wide.
    aiProvider:        z.string().nullable().optional(),
    aiConsentVersion:  z.string().nullable().optional(),
  }).passthrough()
);

// â”€â”€ /api/config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Polled every 60s by VersionSkewDetector; also drives "AI features enabled"
// flag in AuthContext + the Settings page AI section.
const configSchema = envelope(
  z.object({
    aiEnabled:      z.boolean(),
    aiConfigured:   z.boolean(),
    // lapseiqVersion may legitimately be null if LAPSEIQ_VERSION env unset
    // (rare but valid -- e.g. local dev). VersionSkewDetector handles null.
    lapseiqVersion: z.string().nullable().optional(),
  }).passthrough()
);

// â”€â”€ /api/bootstrap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Hit on /dashboard, /contracts, navigation between them. Renders the
// contracts table, vendor dropdowns, owner picker, settings-driven fiscal
// year start. The single highest-blast-radius shape in the app.
const bootstrapSchema = envelope(
  z.object({
    contracts:       z.array(z.unknown()),  // shape is enormous; just verify it's an array
    pagination: z.object({
      page:  z.number(),
      limit: z.number(),
      total: z.number(),
      pages: z.number(),
    }).passthrough(),
    scopeRestricted: z.boolean(),
    members:         z.array(z.unknown()),
    vendors:         z.array(z.unknown()),
    categories:      z.array(z.unknown()),
    settings: z.object({
      fiscalYearStartMonth: z.number(),
      onboardingComplete:   z.boolean(),
      passwordMinLength:    z.number(),
    }).passthrough(),
  }).passthrough()
);

// â”€â”€ /api/news/summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Drives Navbar badge + NewsPage tab counts. Was the v0.89.7 cascade origin
// (wrong Prisma relation name) -- exactly the bug class this layer catches.
const newsSummarySchema = envelope(
  z.object({
    counts:           z.record(z.string(), z.number()),
    unreadHeadlines:  z.number(),
    unreadOutages:    z.number(),
    newsOutageRegion: z.string(),
  }).passthrough()
);

module.exports = {
  authMeSchema,
  configSchema,
  bootstrapSchema,
  newsSummarySchema,
};
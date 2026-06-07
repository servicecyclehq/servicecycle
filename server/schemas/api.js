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
    // App version may legitimately be null if the version env var is unset
    // (rare but valid -- e.g. local dev). VersionSkewDetector handles null.
    // Optional + passthrough so either key name passes during the rename
    // from the inherited product.
    servicecycleVersion: z.string().nullable().optional(),
  }).passthrough()
);

// â”€â”€ /api/bootstrap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Hit on /dashboard, /assets, navigation between them. The precise inherited
// shape (contracts + vendors + categories arrays) is gone with the model
// rework; a loose envelope keeps the registry compiling while the bootstrap
// route is rebuilt around assets/sites. A later pass re-tightens this once
// the new response shape settles.
const bootstrapSchema = envelope(z.object({}).passthrough());

module.exports = {
  authMeSchema,
  configSchema,
  bootstrapSchema,
};
/**
 * featureFlags.js
 *
 * Shared constants and helpers for the per-user feature visibility system.
 *
 * featureFlags   (Json, admin-set)  — which features the admin has ENABLED for this user
 * hiddenFeatures (Json, user-set)   — features the user has chosen to HIDE from their own view
 *
 * Effective visibility = featureFlags[feature] === true AND hiddenFeatures[feature] !== true
 */

// ── Canonical feature list ─────────────────────────────────────────────────────
// Order matters — this is the display order in the permissions matrix.
const ALL_FEATURES = [
  'contracts_write',  // Create & edit contracts
  'vendors_write',    // Add & manage vendors
  'renewal_brief',    // AI renewal brief generation
  'contract_flags',   // AI-detected contract risk flags
  'communications',   // Log & view communications
  'export',           // Export data to CSV
  'budget',           // Budget forecast page
  'ingest',           // AI document upload & ingestion
  'alerts',           // Renewal & billing alerts
  'news',             // Vendor news feed
];

// ── Role-based defaults ───────────────────────────────────────────────────────
// Applied when a user is first created OR when their role changes.
// Admins always get full access (enforced in the permissions save route too).
const FEATURE_DEFAULTS = {
  admin: {
    contracts_write: true,
    vendors_write:   true,
    renewal_brief:   true,
    contract_flags:  true,
    communications:  true,
    export:          true,
    budget:          true,
    ingest:          true,
    alerts:          true,
    news:            true,
  },
  manager: {
    contracts_write: true,
    vendors_write:   true,
    renewal_brief:   true,
    contract_flags:  true,
    communications:  true,
    export:          true,
    budget:          true,
    ingest:          true,
    alerts:          true,
    news:            true,
  },
  viewer: {
    contracts_write: false,
    vendors_write:   false,
    renewal_brief:   false,
    contract_flags:  true,   // can see flags, just can't act on them
    communications:  false,
    export:          false,
    budget:          false,
    ingest:          false,
    alerts:          true,   // renewal alerts are useful for read-only users
    news:            false,
  },
  consultant: {
    // Consultants are read-only-with-attribution per server/middleware/roles.js
    // header. The SPA "Consultant Access" amber banner promises read-only
    // behaviour and the server enforces it via requireManager on every
    // mutating route. Audit Cluster D P0: this flag was previously `true`
    // which made the SPA render write affordances (Log communication, Edit
    // contract-flags) that 403'd on submit — visible-but-blocked is a worse
    // UX than hidden. Aligning the flag with the route guard.
    contracts_write: false,
    vendors_write:   false,
    renewal_brief:   true,   // brief is an *AI read*; the resulting cached fields are still gated by requireManager on regen
    contract_flags:  false,  // was true; flag-edits hit requireManager
    communications:  false,  // was true; comms-create hits requireManager
    export:          false,
    budget:          false,
    ingest:          false,
    alerts:          true,
    news:            true,
  },
};

/**
 * Returns a fresh copy of the default feature flags for the given role.
 * Falls back to viewer defaults for unknown roles.
 */
function defaultFlagsForRole(role) {
  return { ...(FEATURE_DEFAULTS[role] || FEATURE_DEFAULTS.viewer) };
}

/**
 * Strips unknown keys and validates types.
 * Fills missing keys with the role defaults so stored flags are always complete.
 * Returns a clean, full flags object.
 */
function sanitizeFlags(flags, role = 'viewer') {
  const base = defaultFlagsForRole(role);
  if (!flags || typeof flags !== 'object') return base;
  const clean = { ...base };
  for (const f of ALL_FEATURES) {
    if (typeof flags[f] === 'boolean') clean[f] = flags[f];
  }
  return clean;
}

module.exports = { ALL_FEATURES, FEATURE_DEFAULTS, defaultFlagsForRole, sanitizeFlags };

export {};

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
// ServiceCycle conversion: contracts_write/vendors_write became
// assets_write/contractors_write; renewal_brief became maintenance_brief;
// contract_flags, budget, ingest, and news were removed with their features.
const ALL_FEATURES = [
  'assets_write',      // Create & edit assets, sites, and schedules
  'contractors_write', // Add & manage contractors and their techs
  'maintenance_brief', // AI maintenance recommendation / compliance summary
  'communications',    // Log & view communications
  'export',            // Export data to CSV
  'alerts',            // Maintenance-due & overdue alerts
];

// ── Role-based defaults ───────────────────────────────────────────────────────
// Applied when a user is first created OR when their role changes.
// Admins always get full access (enforced in the permissions save route too).
const FEATURE_DEFAULTS = {
  admin: {
    assets_write:      true,
    contractors_write: true,
    maintenance_brief: true,
    communications:    true,
    export:            true,
    alerts:            true,
  },
  manager: {
    assets_write:      true,
    contractors_write: true,
    maintenance_brief: true,
    communications:    true,
    export:            true,
    alerts:            true,
  },
  viewer: {
    assets_write:      false,
    contractors_write: false,
    maintenance_brief: false,
    communications:    false,
    export:            false,
    alerts:            true,   // due/overdue alerts are useful for read-only users
  },
  consultant: {
    // Consultants are read-only-with-attribution per server/middleware/roles.js
    // header. The SPA "Consultant Access" amber banner promises read-only
    // behaviour and the server enforces it via requireManager on every
    // mutating route. Audit Cluster D P0 history: write affordances must not
    // render for consultants — visible-but-blocked is a worse UX than hidden.
    assets_write:      false,
    contractors_write: false,
    maintenance_brief: true,   // the brief is an *AI read*; regen stays gated by requireManager
    communications:    false,  // comms-create hits requireManager
    export:            false,
    alerts:            true,
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

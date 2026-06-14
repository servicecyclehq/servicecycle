/**
 * lib/accountFeatures.ts
 *
 * Per-ACCOUNT feature flags -- distinct from lib/featureFlags.ts, which gates
 * per-USER page visibility by role. These flags gate whole product surfaces
 * (advanced ingest modules, the contractor credential wallet, arc-flash study
 * management, the enterprise trust pack) and the full NETA test battery on a
 * per-tenant basis, so a lean demo account can hide the specialized surfaces
 * while the code stays intact and reversible.
 *
 * Resolution order (lowest -> highest precedence):
 *   1. ACCOUNT_FEATURE_DEFAULTS below (all advanced surfaces OFF -- lean default)
 *   2. env override  ACCOUNT_FEATURE_<UPPER_KEY> = "true" | "false"
 *        (global default flip for self-host / a whole deployment)
 *   3. per-account override  AccountSetting key feature.<key> = "true" | "false"
 *
 * Served to the client on /api/config as data.accountFeatures so the SPA gates
 * rendering with the same object the server resolves.
 */

const prisma = require("./prisma").default;

// Canonical account-feature list. All default OFF: these are opt-in advanced
// surfaces, and a new (or demo) account gets the lean product until an operator
// turns one on.
const ACCOUNT_FEATURE_KEYS = [
  "dga_import",           // #28 transformer-oil DGA ingest card
  "thermography_import",  // #29 IR thermography ingest card
  "qemw_wallet",          // #37 contractor QEMW credential wallet page + nav
  "arc_flash_studies",    // #25 arc-flash / system-study management UI
  "enterprise_trust",     // #35 enterprise trust pack (SIEM export / SSO) UI
  "neta_full_battery",    // bulk-apply the full NETA test battery
                          // (OFF = lean manufacturer / 70B program only)
];

const ACCOUNT_FEATURE_DEFAULTS = ACCOUNT_FEATURE_KEYS.reduce((acc, k) => {
  acc[k] = false;
  return acc;
}, {});

function envOverride(key) {
  const raw = process.env["ACCOUNT_FEATURE_" + key.toUpperCase()];
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

// Pure merge of defaults + env + a settings map ({ "feature.x": "true" }).
// Exported for unit tests so the resolution order can be asserted without a DB.
function computeAccountFeatures(settingsMap = {}) {
  const out = {};
  for (const key of ACCOUNT_FEATURE_KEYS) {
    let val = ACCOUNT_FEATURE_DEFAULTS[key];
    const env = envOverride(key);
    if (env !== undefined) val = env;
    const raw = settingsMap["feature." + key];
    if (raw === "true") val = true;
    else if (raw === "false") val = false;
    out[key] = val;
  }
  return out;
}

// Resolve the effective flags for an account from the DB. Fail-open to the
// (lean) defaults on any error so a settings-table hiccup never crashes
// /api/config.
async function resolveAccountFeatures(accountId) {
  if (!accountId) return computeAccountFeatures({});
  try {
    const rows = await prisma.accountSetting.findMany({
      where: { accountId, key: { startsWith: "feature." } },
      select: { key: true, value: true },
    });
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    return computeAccountFeatures(map);
  } catch (_) {
    return computeAccountFeatures({});
  }
}

module.exports = {
  ACCOUNT_FEATURE_KEYS,
  ACCOUNT_FEATURE_DEFAULTS,
  computeAccountFeatures,
  resolveAccountFeatures,
};

export {};
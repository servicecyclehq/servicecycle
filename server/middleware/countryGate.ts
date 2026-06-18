'use strict';

/**
 * countryGate.js -- US-only registration enforcement via CF-IPCountry.
 *
 * Reads the CF-IPCountry header (ISO 3166-1 alpha-2; 'XX' for unknown;
 * 'T1' for Tor) that Cloudflare sets on every request traversing their
 * edge. Three modes, controlled by COUNTRY_GATE_MODE:
 *
 *   off (default for self-host)
 *     Pass through. Self-host operators take their own jurisdictional
 *     obligations and shouldn't be forced into our US-scope policy.
 *
 *   us_only (default for DEMO_MODE=true)
 *     403 if CF-IPCountry is present AND not in {US, XX}. XX (unknown)
 *     is allowed because legitimate users behind some corporate VPN
 *     egress + all dev-mode hits without CF lack a real country code.
 *     The Register.jsx attestation checkbox is the companion client-side
 *     surface that pairs with this for defense-in-depth.
 *
 *   embargo_only
 *     403 only if CF-IPCountry is in the OFAC comprehensive sanctions
 *     jurisdiction list. Looser than us_only; suitable for operators
 *     who want to honor OFAC obligations without restricting to US.
 *
 * The middleware DOES NOT block requests that lack CF-IPCountry entirely
 * (non-CF traffic, dev installs, self-host without an edge proxy). The
 * load-bearing claim in Privacy + ToS + TIA is "demo is US-only marketing,"
 * and the demo always runs behind Cloudflare. Operators who want stricter
 * behavior should layer CF Worker enforcement on top.
 *
 * Audit-pass anchor: Pass-6 / Lens 4 / L5-B02, L6-B01, L6-B02 (BLOCKING).
 * SHIP_QUEUE MT-026.
 */

// OFAC comprehensive sanctions jurisdictions as of 2026-05. Per OFAC
// guidance, these are blanket-restricted; transactions with persons in
// other partially-sanctioned countries (e.g. listed regions of Ukraine)
// require case-by-case legal review and are out of scope for a blanket
// blocklist. Counsel may revise this list as sanctions change; the env
// var COUNTRY_GATE_EMBARGO_EXTRA can append additional codes without a
// code change (comma-separated, uppercase ISO 3166-1 alpha-2).
const OFAC_EMBARGO_BASE = new Set(['CU', 'IR', 'KP', 'RU', 'SY']);

// US-only allowlist. XX = Cloudflare-unknown (legitimate corporate VPN
// or non-CF dev hits); US = the documented marketing scope. Operators
// who want a broader allowlist (e.g. US + CA + UK) can set
// COUNTRY_GATE_US_ONLY_ALLOW_EXTRA=CA,GB without a code change.
const US_ALLOW_BASE = new Set(['US', 'XX']);

function _extendSet(base, envName) {
  const raw = (process.env[envName] || '').trim();
  if (!raw) return base;
  const extra = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]{2,3}$/.test(s));
  return new Set([...base, ...extra]);
}

function _embargoSet() {
  return _extendSet(OFAC_EMBARGO_BASE, 'COUNTRY_GATE_EMBARGO_EXTRA');
}
function _usAllowSet() {
  return _extendSet(US_ALLOW_BASE, 'COUNTRY_GATE_US_ONLY_ALLOW_EXTRA');
}

function _resolveMode() {
  const explicit = (process.env.COUNTRY_GATE_MODE || '').trim().toLowerCase();
  if (explicit === 'us_only' || explicit === 'embargo_only' || explicit === 'off') {
    return explicit;
  }
  // Implicit default: us_only on demo, off everywhere else. Self-host
  // installs without an explicit COUNTRY_GATE_MODE setting pass through
  // because the operator -- not ForgeRift -- carries the jurisdictional
  // obligation.
  return process.env.DEMO_MODE === 'true' ? 'us_only' : 'off';
}

/**
 * Express middleware. Applies to a single route or any /api/* surface
 * caller wants to gate. Recommended mount points (per audit):
 *   - POST /api/auth/register  (BLOCKING per L5-B02)
 *   - POST /api/early-access   (lead-capture parity with registration)
 */
function countryGate(req, res, next) {
  const mode = _resolveMode();
  if (mode === 'off') return next();

  const country = String(req.headers['cf-ipcountry'] || '').trim().toUpperCase();
  // No header = traffic didn't traverse Cloudflare. Do NOT block:
  // self-host operators, direct-IP tests, and the install.sh path don't
  // see CF-IPCountry. The Register.jsx attestation is the user-facing
  // companion that captures intent when the edge can't enforce.
  if (!country) return next();

  const embargo = _embargoSet();
  // Always block embargoed jurisdictions regardless of mode.
  if (embargo.has(country)) {
    return res.status(403).json({
      success: false,
      error: 'Registration is not available in your country at this time.',
      code: 'COUNTRY_GATE_EMBARGO',
    });
  }

  if (mode === 'embargo_only') return next();

  // us_only mode: 403 anything not US (and not XX-unknown).
  const allow = _usAllowSet();
  if (!allow.has(country)) {
    return res.status(403).json({
      success: false,
      error: "ServiceCycle's demo sandbox is currently available to United States-based businesses only.",
      code: 'COUNTRY_GATE_US_ONLY',
    });
  }

  return next();
}

module.exports = {
  countryGate,
  // Exported for tests + admin endpoints that want to display the active
  // configuration in a status panel.
  _OFAC_EMBARGO_BASE: OFAC_EMBARGO_BASE,
  _US_ALLOW_BASE: US_ALLOW_BASE,
  _resolveMode,
};

export {};

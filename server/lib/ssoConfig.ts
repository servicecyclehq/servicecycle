'use strict';

/**
 * lib/ssoConfig.ts
 * ----------------
 * Single source of truth for enterprise-SSO / Ory Polis configuration.
 *
 * Secrets live in env ONLY (Polis API key, SCIM webhook secret, etc.). The
 * posture is FAIL CLOSED + LOUD:
 *   - `SSO_ENABLED` is the master switch (default off).
 *   - When it is on, every var in REQUIRED_WHEN_ENABLED must be present, or:
 *       • server/index.ts refuses to boot (missingSsoEnv drives the startup
 *         validator, same as JWT_SECRET/MASTER_KEY), and
 *       • getSsoConfig() throws, so any route that reaches it 503s rather than
 *         operating with half a config.
 *
 * Nothing here ever returns a partial config. See docs/security/SSO_DESIGN.md §6.
 */

const REQUIRED_WHEN_ENABLED = [
  'POLIS_BASE_URL',       // internal URL the API calls (token/userinfo/admin)
  'POLIS_API_KEY',        // Polis admin API key (server-only)
  'SCIM_WEBHOOK_SECRET',  // HMAC secret to verify inbound SCIM webhooks
  'SSO_CALLBACK_URL',     // our OAuth redirect_uri (must match Polis registration)
];

// INFOSEC-8-14 (KNOWN LIMITATION, deferred — needs schema): SCIM_WEBHOOK_SECRET
// is a single per-INSTANCE HMAC secret shared by every directory, rather than a
// per-DIRECTORY secret. A compromise of the one secret would let a forged
// webhook be accepted for ANY directory on the instance. Scoping the secret
// per-directory requires a new secret column on the ScimDirectory model (which
// today has none — see schema.prisma model ScimDirectory), so it is OUT OF
// SCOPE for an app-logic-only change and is documented here rather than
// silently shipped. Replay protection IS scoped/hardened separately (see
// DD-8-5 in routes/ssoScim.ts). When the schema lands, read the per-directory
// secret in ssoScim.ts after resolving the directory instead of cfg.scimWebhookSecret.

function isSsoEnabled(): boolean {
  return process.env.SSO_ENABLED === 'true';
}

/**
 * Returns the names of required SSO env vars that are missing/blank.
 * Empty array when SSO is disabled (nothing required) or fully configured.
 */
function missingSsoEnv(): string[] {
  if (!isSsoEnabled()) return [];
  return REQUIRED_WHEN_ENABLED.filter((k) => {
    const v = process.env[k];
    return !v || !String(v).trim();
  });
}

export interface SsoConfig {
  baseUrl: string;
  externalUrl: string;
  apiKey: string;
  product: string;
  callbackUrl: string;
  scimWebhookSecret: string;
  jitProvisioning: boolean;
  requestTimeoutMs: number;
}

/**
 * Returns the validated SSO config, or THROWS — never a partial object.
 * Callers (routes) catch and translate to a fail-closed 503/404.
 *   err.code === 'SSO_DISABLED'      -> feature off on this instance
 *   err.code === 'SSO_MISCONFIGURED' -> on, but env incomplete
 */
function getSsoConfig(): SsoConfig {
  if (!isSsoEnabled()) {
    const e: any = new Error('SSO is not enabled on this instance');
    e.code = 'SSO_DISABLED';
    throw e;
  }
  const miss = missingSsoEnv();
  if (miss.length) {
    const e: any = new Error(`SSO misconfigured: missing ${miss.join(', ')}`);
    e.code = 'SSO_MISCONFIGURED';
    throw e;
  }
  const baseUrl = String(process.env.POLIS_BASE_URL).replace(/\/+$/, '');
  return {
    baseUrl,
    externalUrl: String(process.env.POLIS_EXTERNAL_URL || baseUrl).replace(/\/+$/, ''),
    apiKey: String(process.env.POLIS_API_KEY),
    product: process.env.POLIS_PRODUCT || 'servicecycle',
    callbackUrl: String(process.env.SSO_CALLBACK_URL),
    scimWebhookSecret: String(process.env.SCIM_WEBHOOK_SECRET),
    jitProvisioning: process.env.SSO_JIT_PROVISIONING === 'true',
    requestTimeoutMs: Math.max(1000, parseInt(process.env.POLIS_TIMEOUT_MS || '8000', 10) || 8000),
  };
}

module.exports = { isSsoEnabled, missingSsoEnv, getSsoConfig, REQUIRED_WHEN_ENABLED };

export {};

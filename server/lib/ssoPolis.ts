'use strict';

/**
 * lib/ssoPolis.ts
 * ---------------
 * HTTP client for the self-hosted Ory Polis broker. Every outbound call has a
 * timeout (AbortController) and retry-with-backoff on transient failures
 * (network errors, 429, 5xx). Structured `[ssoPolis]` logs distinguish a
 * transient retry from a hard error.
 *
 * Response shapes are LIVE/SOURCE-verified against ory/polis@v26.2.0 — see
 * server/__tests__/fixtures/polis/ and docs/security/SSO_DESIGN.md §8.
 *
 *   OAuth (relying-party flow):
 *     buildAuthorizeUrl()       -> {externalUrl}/api/oauth/authorize
 *     exchangeCodeForToken()    -> POST {baseUrl}/api/oauth/token
 *     fetchUserInfo()           -> GET  {baseUrl}/api/oauth/userinfo
 *   Admin API (Api-Key auth; used by the per-account config routes):
 *     adminCreate/List/DeleteConnection -> /api/v1/sso
 *     adminCreate/List/DeleteDirectory  -> /api/v1/dsync
 */

import type { SsoConfig } from './ssoConfig';

const DEFAULT_RETRIES = 2;

function log(level: 'info' | 'warn' | 'error', msg: string, meta?: any) {
  const line = `[ssoPolis] ${msg}`;
  if (meta !== undefined) (console as any)[level](line, meta);
  else (console as any)[level](line);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Low-level fetch with timeout + retry/backoff. Retries only transient
 * failures (network/abort, 429, 5xx). 4xx responses are returned to the caller
 * (not retried) — an invalid code or bad request won't get better on retry.
 */
async function polisFetch(
  cfg: SsoConfig,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  opts: { retries?: number; label?: string } = {}
): Promise<{ status: number; ok: boolean; json: any; text: string }> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const label = opts.label || `${init.method || 'GET'} ${path}`;
  const url = `${cfg.baseUrl}${path}`;
  let lastErr: any;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      const text = await resp.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

      if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
        const backoff = 200 * Math.pow(2, attempt);
        log('warn', `${label} -> HTTP ${resp.status}, retrying in ${backoff}ms (attempt ${attempt + 1}/${retries})`);
        await sleep(backoff);
        continue;
      }
      if (!resp.ok) log('warn', `${label} -> HTTP ${resp.status}`);
      return { status: resp.status, ok: resp.ok, json, text };
    } catch (e: any) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) {
        const backoff = 200 * Math.pow(2, attempt);
        log('warn', `${label} transient failure (${e?.name || e?.message}), retrying in ${backoff}ms (attempt ${attempt + 1}/${retries})`);
        await sleep(backoff);
        continue;
      }
    }
  }
  log('error', `${label} failed after ${retries + 1} attempts`, lastErr?.message);
  const err: any = new Error(`Polis request failed: ${label}`);
  err.code = 'POLIS_UNREACHABLE';
  err.cause = lastErr;
  throw err;
}

function adminHeaders(cfg: SsoConfig): Record<string, string> {
  return { Authorization: `Api-Key ${cfg.apiKey}` };
}

// OIDC discovery (cached per baseUrl) — gives us issuer + jwks_uri for id_token
// validation. Live-verified shape in openid-configuration.json.
const _discoveryCache = new Map<string, any>();
async function getOidcDiscovery(cfg: SsoConfig): Promise<{ issuer: string; jwks_uri: string; [k: string]: any }> {
  const cached = _discoveryCache.get(cfg.baseUrl);
  if (cached) return cached;
  const res = await polisFetch(cfg, '/api/well-known/openid-configuration', { method: 'GET' }, { label: 'oidc discovery' });
  if (!res.ok || !res.json || !res.json.jwks_uri) {
    const err: any = new Error('Polis OIDC discovery failed');
    err.code = 'POLIS_DISCOVERY_FAILED';
    throw err;
  }
  _discoveryCache.set(cfg.baseUrl, res.json);
  return res.json;
}

// ── OAuth (relying-party) ────────────────────────────────────────────────────

/**
 * Build the browser-facing authorize URL. client_id='dummy' with tenant+product
 * is the documented Polis convention (confirmed in oauth_authorize_redirect.json).
 * scope defaults to 'openid' so Polis returns an id_token we can validate
 * (requires OpenID signing keys configured on Polis — see SSO_DESIGN.md §8/§12).
 */
function buildAuthorizeUrl(
  cfg: SsoConfig,
  args: { tenant: string; product?: string; state: string; nonce: string; codeChallenge: string; scope?: string }
): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: 'dummy',
    tenant: args.tenant,
    product: args.product || cfg.product,
    redirect_uri: cfg.callbackUrl,
    state: args.state,
    nonce: args.nonce,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256',
    scope: args.scope || 'openid',
  });
  return `${cfg.externalUrl}/api/oauth/authorize?${q.toString()}`;
}

export interface PolisTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  id_token?: string;
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
async function exchangeCodeForToken(
  cfg: SsoConfig,
  args: { code: string; codeVerifier: string; clientId?: string }
): Promise<PolisTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: cfg.callbackUrl,
    client_id: args.clientId || 'dummy',
    code_verifier: args.codeVerifier,
  }).toString();

  const res = await polisFetch(
    cfg,
    '/api/oauth/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    { label: 'oauth/token' }
  );
  if (!res.ok || !res.json || !res.json.access_token) {
    const err: any = new Error('Polis token exchange failed');
    err.code = 'POLIS_TOKEN_FAILED';
    err.status = res.status;
    throw err;
  }
  return res.json as PolisTokenResponse;
}

export interface PolisProfile {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  roles?: string[];
  groups?: string[];
  raw?: any;
  requested?: { tenant?: string; product?: string };
}

/** Fetch the user profile with the access token. */
async function fetchUserInfo(cfg: SsoConfig, accessToken: string): Promise<PolisProfile> {
  const res = await polisFetch(
    cfg,
    '/api/oauth/userinfo',
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
    { label: 'oauth/userinfo' }
  );
  if (!res.ok || !res.json || !res.json.id) {
    const err: any = new Error('Polis userinfo failed');
    err.code = 'POLIS_USERINFO_FAILED';
    err.status = res.status;
    throw err;
  }
  return res.json as PolisProfile;
}

// ── Admin API (Api-Key) ──────────────────────────────────────────────────────

async function adminCreateSamlConnection(cfg: SsoConfig, body: Record<string, any>) {
  const res = await polisFetch(cfg, '/api/v1/sso', {
    method: 'POST', headers: { ...adminHeaders(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { retries: 1, label: 'admin sso create(saml)' });
  if (!res.ok) throw adminErr('create SAML connection', res);
  return res.json;
}

async function adminCreateOidcConnection(cfg: SsoConfig, body: Record<string, any>) {
  const res = await polisFetch(cfg, '/api/v1/sso', {
    method: 'POST', headers: { ...adminHeaders(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { retries: 1, label: 'admin sso create(oidc)' });
  if (!res.ok) throw adminErr('create OIDC connection', res);
  return res.json;
}

async function adminListConnections(cfg: SsoConfig, q: { tenant: string; product?: string }) {
  const qs = new URLSearchParams({ tenant: q.tenant, product: q.product || cfg.product }).toString();
  const res = await polisFetch(cfg, `/api/v1/sso?${qs}`, { method: 'GET', headers: adminHeaders(cfg) },
    { label: 'admin sso list' });
  if (!res.ok) throw adminErr('list connections', res);
  return res.json;
}

async function adminDeleteConnection(cfg: SsoConfig, q: { clientID: string; clientSecret: string }) {
  const qs = new URLSearchParams({ clientID: q.clientID, clientSecret: q.clientSecret }).toString();
  const res = await polisFetch(cfg, `/api/v1/sso?${qs}`, { method: 'DELETE', headers: adminHeaders(cfg) },
    { retries: 1, label: 'admin sso delete' });
  if (!res.ok) throw adminErr('delete connection', res);
  return res.json ?? { ok: true };
}

async function adminCreateDirectory(cfg: SsoConfig, body: Record<string, any>) {
  const res = await polisFetch(cfg, '/api/v1/dsync', {
    method: 'POST', headers: { ...adminHeaders(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { retries: 1, label: 'admin dsync create' });
  if (!res.ok) throw adminErr('create directory', res);
  return res.json;
}

async function adminListDirectories(cfg: SsoConfig, q: { tenant: string; product?: string }) {
  const qs = new URLSearchParams({ tenant: q.tenant, product: q.product || cfg.product }).toString();
  const res = await polisFetch(cfg, `/api/v1/dsync?${qs}`, { method: 'GET', headers: adminHeaders(cfg) },
    { label: 'admin dsync list' });
  if (!res.ok) throw adminErr('list directories', res);
  return res.json;
}

async function adminDeleteDirectory(cfg: SsoConfig, directoryId: string) {
  const res = await polisFetch(cfg, `/api/v1/dsync/${encodeURIComponent(directoryId)}`,
    { method: 'DELETE', headers: adminHeaders(cfg) }, { retries: 1, label: 'admin dsync delete' });
  if (!res.ok) throw adminErr('delete directory', res);
  return res.json ?? { ok: true };
}

function adminErr(what: string, res: { status: number; json: any }) {
  const e: any = new Error(`Polis admin: ${what} -> HTTP ${res.status}`);
  e.code = 'POLIS_ADMIN_FAILED';
  e.status = res.status;
  e.detail = res.json?.error?.message || res.json?.error || null;
  return e;
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchUserInfo,
  getOidcDiscovery,
  adminCreateSamlConnection,
  adminCreateOidcConnection,
  adminListConnections,
  adminDeleteConnection,
  adminCreateDirectory,
  adminListDirectories,
  adminDeleteDirectory,
  _polisFetch: polisFetch,
};

export {};

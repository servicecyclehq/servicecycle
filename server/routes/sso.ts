const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
import prisma from '../lib/prisma';
const { getSsoConfig } = require('../lib/ssoConfig');
const { resolveAccountFeatures } = require('../lib/accountFeatures');
const ssoPolis = require('../lib/ssoPolis');
const { validateIdToken } = require('../lib/ssoIdToken');
const { createPkceBundle, randomToken } = require('../lib/ssoPkce');
const { mapClaimsToRole, extractClaimGroups } = require('../lib/ssoRoleMap');
const { issueTokenPair } = require('./auth');
const { writeLog: writeActivityLog } = require('../lib/activityLog');

// ── helpers ───────────────────────────────────────────────────────────────────

const LOGIN_STATE_TTL_MS = 10 * 60 * 1000; // 10 min
const HANDOFF_TTL_MS = 60 * 1000;          // 60 s

const clientBase = () => (process.env.CLIENT_URL || '').replace(/\/+$/, '');

// Same open-redirect guard as the SPA (Login.jsx): same-origin relative paths only.
function safeNext(next: any): string {
  if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/dashboard';
}

// Generic failure redirect back to the SPA login — deliberately uniform so it
// can't be used as an IdP-discovery / account-enumeration oracle (threat T13).
function failRedirect(res: any, reason: string) {
  console.warn(`[sso] login failed: ${reason}`);
  return res.redirect(302, `${clientBase()}/login?sso_error=unavailable`);
}

// Resolve config or fail closed. Returns null after responding on failure.
function configOrFail(res: any): any | null {
  try {
    return getSsoConfig();
  } catch (e: any) {
    if (e.code === 'SSO_DISABLED') {
      // Feature off on this instance — 404 so we don't advertise it.
      res.status(404).json({ success: false, error: 'Not found' });
    } else {
      console.error('[sso] misconfigured (fail closed):', e.message);
      res.status(503).json({ success: false, error: 'SSO is temporarily unavailable' });
    }
    return null;
  }
}

const SAFE_USER_SELECT = {
  id: true, accountId: true, name: true, email: true, role: true,
  featureFlags: true, hiddenFeatures: true, createdAt: true,
  account: { select: { id: true, companyName: true, status: true, planType: true, planTier: true, aiBriefEnabled: true } },
};

// ─── GET /api/sso/authorize?email=&next= ──────────────────────────────────────
// Entry point. Resolves the email domain -> account+connection, mints PKCE +
// state + nonce, persists them, and 302s the browser to Polis. Fails CLOSED and
// GENERIC on every miss (unknown domain, account not opted-in, misconfig).
router.get('/authorize', async (req: any, res: any) => {
  const cfg = configOrFail(res);
  if (!cfg) return;

  const email = String(req.query.email || '').trim().toLowerCase();
  const next = safeNext(req.query.next);
  const parsed = z.string().email().max(254).safeParse(email);
  if (!parsed.success) return failRedirect(res, 'invalid_email');
  const domain = email.split('@')[1];
  if (!domain) return failRedirect(res, 'no_domain');

  try {
    const dom = await prisma.ssoDomain.findUnique({ where: { domain } });
    if (!dom || !dom.isActive) return failRedirect(res, `unknown_domain:${domain}`);

    const connection = await prisma.ssoConnection.findUnique({ where: { id: dom.connectionId } });
    if (!connection || !connection.isActive || connection.accountId !== dom.accountId) {
      return failRedirect(res, 'no_active_connection');
    }

    // Account opt-in gate (ships dark behind the `sso` feature flag).
    const features = await resolveAccountFeatures(dom.accountId);
    if (!features.sso) return failRedirect(res, 'account_not_opted_in');

    const { state, nonce, codeVerifier, codeChallenge } = createPkceBundle();
    await prisma.ssoLoginState.create({
      data: {
        state, nonce, codeVerifier,
        accountId: dom.accountId,
        connectionId: connection.id,
        redirectTo: next,
        expiresAt: new Date(Date.now() + LOGIN_STATE_TTL_MS),
      },
    });

    const url = ssoPolis.buildAuthorizeUrl(cfg, {
      tenant: connection.polisTenant,
      product: connection.polisProduct,
      state, nonce, codeChallenge,
    });
    return res.redirect(302, url);
  } catch (e: any) {
    return failRedirect(res, `authorize_error:${e.message}`);
  }
});

// ─── GET /api/sso/callback?code=&state= ───────────────────────────────────────
// Validates state (CSRF, single-use, TTL), exchanges the code, validates the
// id_token + nonce, enforces tenant isolation, provisions/updates the user, and
// hands a single-use code back to the SPA (no tokens in the URL).
router.get('/callback', async (req: any, res: any) => {
  const cfg = configOrFail(res);
  if (!cfg) return;

  if (req.query.error) return failRedirect(res, `idp_error:${req.query.error}`);
  const state = String(req.query.state || '');
  const code = String(req.query.code || '');
  if (!state || !code) return failRedirect(res, 'missing_state_or_code');

  try {
    // Single-use state claim (atomic): only the first caller flips consumedAt.
    const claim = await prisma.ssoLoginState.updateMany({
      where: { state, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claim.count !== 1) return failRedirect(res, 'state_invalid_or_replayed');
    const login = await prisma.ssoLoginState.findUnique({ where: { state } });
    if (!login) return failRedirect(res, 'state_missing');

    const connection = await prisma.ssoConnection.findUnique({ where: { id: login.connectionId } });
    if (!connection || connection.accountId !== login.accountId) return failRedirect(res, 'connection_gone');

    // Re-check account opt-in at callback time (defense in depth).
    const features = await resolveAccountFeatures(login.accountId);
    if (!features.sso) return failRedirect(res, 'account_not_opted_in_callback');

    // Exchange code -> token (back-channel, PKCE).
    const token = await ssoPolis.exchangeCodeForToken(cfg, { code, codeVerifier: login.codeVerifier });

    // Validate id_token + nonce (alg pinned, JWKS sig, iss/exp).
    // INFOSEC-8-3 / DD-8-11: the id_token signature is the cryptographic proof
    // of identity. We FAIL CLOSED when it is absent — a misconfigured or
    // downgraded Polis (no OIDC signing keys) must not silently drop identity
    // verification down to an unsigned userinfo fetch and still provision/login
    // a user. PKCE + single-use state defend the channel against CSRF/replay,
    // but they do not prove WHO the subject is the way a signed id_token does.
    //
    // The historical "proceed on PKCE/state/userinfo alone" behavior is only
    // available behind an explicit, self-documenting operator opt-in
    // (SSO_ALLOW_MISSING_ID_TOKEN=true) for a Polis deployment that genuinely
    // cannot issue signed tokens. Default and recommended posture: reject.
    if (token.id_token) {
      try {
        const disc = await ssoPolis.getOidcDiscovery(cfg);
        await validateIdToken({
          idToken: token.id_token,
          jwksUri: disc.jwks_uri,
          expectedIss: disc.issuer,
          expectedNonce: login.nonce,
        });
      } catch (e: any) {
        return failRedirect(res, `id_token_invalid:${e.code || e.message}`);
      }
    } else if (process.env.SSO_ALLOW_MISSING_ID_TOKEN === 'true') {
      // Explicit operator opt-in only. The code exchange is back-channel +
      // PKCE + single-use state; we still enforce the tenant cross-check below.
      console.warn('[sso] no id_token returned and SSO_ALLOW_MISSING_ID_TOKEN=true — relying on PKCE/state/userinfo. Configure Polis OIDC signing keys to restore signed-identity validation.');
    } else {
      // Fail closed: no signed identity proof and no explicit opt-in.
      console.error('[sso] no id_token returned — rejecting (fail closed). Configure Polis OIDC signing keys, or set SSO_ALLOW_MISSING_ID_TOKEN=true to accept PKCE/state/userinfo-only logins.');
      return failRedirect(res, 'id_token_missing');
    }

    const profile = await ssoPolis.fetchUserInfo(cfg, token.access_token);

    // ── Cross-tenant isolation (threat T1) ───────────────────────────────────
    // FAIL CLOSED if requested.tenant is missing rather than silently skipping
    // the check. Verified 2026-07-06 directly against Polis's real source
    // (boxyhq/jackson v26.2.0, npm/src/controller/oauth.ts, the exact tag our
    // own docs/security/SSO_DESIGN.md cites) rather than relying solely on our
    // own "source-verified, not live-captured" caveat there: every connection-
    // resolution branch in authorize() sets requestedTenant to a real, non-
    // empty value before `if (requestedTenant) requested.tenant = requestedTenant`
    // runs, for both SP-initiated (OIDC/SAML, via tenant+product, encoded
    // client_id, or federated app) and IdP-initiated SAML flows, and that value
    // is carried unchanged through session -> code -> token -> userinfo. We
    // always send `tenant` on /authorize (buildAuthorizeUrl call above), so a
    // resolved connection with no requested.tenant should never happen; if it
    // ever does (future Polis change, or a connection somehow configured with
    // an empty-string tenant) this now rejects instead of quietly bypassing
    // the check.
    if (!profile.requested || !profile.requested.tenant) {
      return failRedirect(res, 'tenant_missing_from_profile');
    }
    if (profile.requested.tenant !== connection.polisTenant) {
      return failRedirect(res, 'tenant_mismatch');
    }
    const profEmail = String(profile.email || '').trim().toLowerCase();
    if (!profEmail) return failRedirect(res, 'no_profile_email');

    const existing = await prisma.user.findUnique({ where: { email: profEmail } });
    if (existing && existing.accountId !== login.accountId) {
      // This identity already belongs to a DIFFERENT account — never cross over.
      writeActivityLog({
        userId: existing.id, accountId: existing.accountId, action: 'sso_cross_tenant_blocked',
        details: { attemptedAccountId: login.accountId, connectionId: connection.id },
      });
      return failRedirect(res, 'cross_tenant_blocked');
    }

    // ── Role resolution (default viewer; never privileged from claims) ────────
    const mappings = await prisma.ssoRoleMapping.findMany({ where: { accountId: login.accountId } });
    const defaultSetting = await prisma.accountSetting.findUnique({
      where: { accountId_key: { accountId: login.accountId, key: 'sso.rolemap.default' } },
    }).catch(() => null);
    const claimGroups = extractClaimGroups(profile);
    const computedRole = mapClaimsToRole({
      claimGroups,
      mappings: mappings.map((m: any) => ({ idpGroup: m.idpGroup, role: m.role })),
      defaultRole: defaultSetting?.value || 'viewer',
    });

    // ── Provision / update ───────────────────────────────────────────────────
    const PRIVILEGED = new Set(['admin', 'oem_admin', 'super_admin']);
    let user = existing;
    if (user) {
      // Existing user in the right account: update last login; re-evaluate role
      // ONLY for non-privileged users (never downgrade an in-app admin grant,
      // never elevate past manager).
      const data: any = { lastSsoLoginAt: new Date() };
      if (!PRIVILEGED.has(user.role) && user.role !== computedRole) data.role = computedRole;
      user = await prisma.user.update({ where: { id: user.id }, data });
      if (!user.isActive) return failRedirect(res, 'user_inactive');
    } else {
      // No user yet -> JIT provisioning (gated). SCIM is the primary path.
      if (!cfg.jitProvisioning) {
        writeActivityLog({ userId: null, accountId: login.accountId, action: 'sso_jit_disabled_login_blocked', details: { email: profEmail } });
        return failRedirect(res, 'not_provisioned_jit_off');
      }
      const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() || profEmail.split('@')[0];
      // SCIM/JIT users have no usable password — store an unusable marker so the
      // password-login path can never match (passwordHash stays NOT NULL).
      const unusable = `!sso-no-password!${randomToken(24)}`;
      user = await prisma.user.create({
        data: {
          accountId: login.accountId, name, email: profEmail,
          passwordHash: unusable, role: computedRole, isActive: true,
          ssoManaged: true, lastSsoLoginAt: new Date(),
        },
      });
    }

    // ── One-time handoff (no tokens in the URL) ──────────────────────────────
    const handoffCode = randomToken(32);
    await prisma.ssoHandoff.create({
      data: {
        codeHash: crypto.createHash('sha256').update(handoffCode).digest('hex'),
        userId: user.id, accountId: user.accountId,
        redirectTo: safeNext(login.redirectTo),
        expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
      },
    });
    writeActivityLog({ userId: user.id, accountId: user.accountId, action: 'sso_login_success', details: { connectionId: connection.id, role: user.role } });

    const dest = `${clientBase()}/sso/callback?code=${encodeURIComponent(handoffCode)}&next=${encodeURIComponent(safeNext(login.redirectTo))}`;
    return res.redirect(302, dest);
  } catch (e: any) {
    return failRedirect(res, `callback_error:${e.code || e.message}`);
  }
});

// ─── POST /api/sso/exchange { code } ──────────────────────────────────────────
// SPA trades the one-time handoff code for the real JWT pair. JWT is minted HERE
// (so a leaked-but-unexchanged code grants nothing). Single-use + TTL.
router.post('/exchange', async (req: any, res: any) => {
  const code = req.body && typeof req.body.code === 'string' ? req.body.code : '';
  if (!code) return res.status(400).json({ success: false, error: 'Missing code' });

  try {
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    // Atomic single-use claim.
    const claim = await prisma.ssoHandoff.updateMany({
      where: { codeHash, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claim.count !== 1) return res.status(401).json({ success: false, error: 'Invalid or expired code' });
    const handoff = await prisma.ssoHandoff.findUnique({ where: { codeHash } });
    if (!handoff) return res.status(401).json({ success: false, error: 'Invalid or expired code' });

    const user = await prisma.user.findUnique({ where: { id: handoff.userId }, select: SAFE_USER_SELECT });
    if (!user) return res.status(401).json({ success: false, error: 'Invalid or expired code' });

    const fullUser = await prisma.user.findUnique({ where: { id: handoff.userId }, select: { isActive: true, twoFactorEnabled: true } });
    if (!fullUser || !fullUser.isActive) return res.status(403).json({ success: false, error: 'Account deactivated — contact your administrator' });

    // ── INFOSEC-8-1: admin-MFA policy visibility on the SSO path ──────────────
    // mfaRequiredForAdmins is enforced on the password-login path (auth.ts), but
    // the SSO callback mints tokens without a 2FA step. The standard enterprise
    // model is that the IdP owns MFA when SSO is in use, so we do NOT block the
    // SSO login (and must never lock out an admin who never enrolled app-TOTP —
    // their MFA lives at the IdP). What we DO is make the gap auditable: when an
    // account requires admin MFA and a privileged user signs in via SSO, record
    // whether app-2FA was enrolled and that enforcement was delegated to the
    // IdP. A true app-2FA step-up over SSO needs an SPA challenge the SsoCallback
    // page does not yet support — tracked separately (see DEMO_LANDMINES_v8
    // INFOSEC-8-1 SKIP note). Fail-open + audited, never fail-closed here.
    const PRIVILEGED_ROLES = new Set(['admin', 'oem_admin', 'super_admin']);
    if (PRIVILEGED_ROLES.has(user.role)) {
      try {
        const acct = await prisma.account.findUnique({
          where:  { id: user.accountId },
          select: { mfaRequiredForAdmins: true },
        });
        if (acct?.mfaRequiredForAdmins) {
          writeActivityLog({
            userId:    user.id,
            accountId: user.accountId,
            action:    'sso_admin_mfa_delegated_to_idp',
            details:   {
              role: user.role,
              appTotpEnrolled: !!fullUser.twoFactorEnabled,
              note: 'mfaRequiredForAdmins is on; SSO login proceeded with MFA enforced at the IdP (no app-TOTP step on SSO path).',
            },
          });
        }
      } catch (mfaErr: any) {
        // Visibility-only; never block the login on an audit lookup hiccup.
        console.error('[sso] admin-MFA policy audit lookup failed:', mfaErr.message);
      }
    }

    const { accessToken, refreshToken } = await issueTokenPair(user.id, user.accountId);
    return res.json({
      success: true,
      data: { token: accessToken, refreshToken, user, redirectTo: safeNext(handoff.redirectTo), aiProvider: process.env.AI_PROVIDER || 'anthropic' },
    });
  } catch (e: any) {
    console.error('[sso] exchange error:', e.message);
    return res.status(500).json({ success: false, error: 'SSO exchange failed' });
  }
});

module.exports = router;

export {};

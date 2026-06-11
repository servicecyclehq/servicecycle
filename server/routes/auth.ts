const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod'); // (B6) schema validation
const { authenticateToken } = require('../middleware/auth');
const { countryGate }       = require('../middleware/countryGate'); // (Pass-6 W3 MT-026) US-only registration gate
const { sendEmail, passwordResetHtml, inviteHtml, newViewerActivationHtml, welcomeHtml } = require('../lib/email');
const { defaultFlagsForRole } = require('../lib/featureFlags');
const { validate: validatePassword, validateStrength, loadAccountPolicy, buildPolicy } = require('../lib/passwordPolicy');
const { issuePending2faToken } = require('./twoFactor');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const { redactEmail } = require('../lib/redact'); // audit-7 item 3.1.3
const { validateBody } = require('../lib/validate'); // (B6)
import prisma from '../lib/prisma';

// ── B6 zod schemas ──────────────────────────────────────────────────────────
// Email max-length pinned at 254 per RFC 5321 to bound the LRU lockout map
// and reject pathological inputs before they reach the DB. Password upper
// bound at 200 stops bcrypt from chewing on a 1MB string the attacker
// supplied just to slow us down (bcrypt cost is per-byte). The actual
// minimum-length policy is enforced inside the handler against the
// per-account passwordPolicy — the zod check is just a sanity floor.
const LoginSchema = z.object({
  email:    z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});

// 2026-05-10 review M1 fix: reject angle brackets in company/name fields
// at validation time. The frontend escapes by default (React textContent),
// but storing raw `<script>...</script>` verbatim and re-displaying it as
// literal text is bad UX *and* a latent XSS hole the moment any future
// surface (PDF export, email template, etc.) renders it via innerHTML.
// Defence in depth — sanitise at the storage boundary, not just the render
// boundary.
const SAFE_TEXT = /^[^<>]*$/;
const RegisterSchema = z.object({
  companyName: z.string().trim().min(1).max(200).regex(SAFE_TEXT, 'Company name cannot contain < or >.'),
  name:        z.string().trim().min(1).max(200).regex(SAFE_TEXT, 'Name cannot contain < or >.'),
  email:       z.string().trim().email().max(254),
  password:    z.string().min(1).max(200),
  // Terms-acceptance gate: client must explicitly affirm acceptance of
  // the ToS, Privacy Policy, and (in DEMO_MODE) the Demo Sandbox Notice
  // before we'll create the account. Server records the version string
  // on the User row for audit purposes (see migration
  // 20260504040000_add_user_terms_acceptance).
  acceptedTerms:        z.literal(true, { errorMap: () => ({ message: 'You must accept the Terms of Service and Privacy Policy to register.' }) }),
  acceptedTermsVersion: z.string().trim().min(1).max(200).optional(),
  // (Pass-6 W3 MT-026) US-scope attestation -- companion to the
  // CF-IPCountry middleware. Required on the demo so visitors affirm
  // that their business operates in the U.S. (the documented marketing
  // scope cited by Privacy, ToS, and the Transfer Impact Assessment).
  // Optional on self-host because operators carry their own
  // jurisdictional obligation. The handler enforces required-on-demo
  // semantics rather than the schema, so the field is optional here
  // and the server gate accepts undefined when DEMO_MODE !== 'true'.
  acceptedUsScope: z.boolean().optional(),
});

const ForgotPasswordSchema = z.object({
  email: z.string().trim().email().max(254),
});

const ResetPasswordSchema = z.object({
  token:    z.string().length(64).regex(/^[a-f0-9]+$/, 'Invalid reset token format.'),     // SEC-A14-005: exactly 64 hex chars
  password: z.string().min(1).max(200),
});

// ── Token helpers ─────────────────────────────────────────────────────────────

const ACCESS_TOKEN_EXPIRY  = process.env.JWT_EXPIRES_IN  || '1h';  // H4: short-lived
// v0.37.4 W7: REFRESH_TOKEN_TTL_DAYS env override (default 30). Operators
// in regulated environments commonly want shorter session lifetimes than
// the 30-day default. Validated at startup (server/index.js); anything
// outside [1..365] refuses to start.
const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS, 10) || 30;
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Issue a short-lived access token + an opaque rotating refresh token. (H4)
 * Stores the refresh token hash in the DB; never stores the raw token.
 * Returns { accessToken, refreshToken, refreshTokenId }.
 * refreshTokenId is the DB row id — callers use it to set replacedById without
 * a subsequent findFirst query (H4 successor-id linkage).
 */
// Audit Cluster A P1 (2026-05-16): cap active refresh tokens per user.
// Pre-fix, a user who never called /logout and re-logged-in repeatedly
// accumulated an unbounded backlog of un-revoked rows (each one a viable
// re-auth primitive until its 30-day TTL). Keep the N most-recently-issued;
// older active rows get revoked. The /refresh reuse-detection cascade still
// works because revokedAt is set rather than deleting the row.
const REFRESH_TOKEN_PER_USER_CAP = parseInt(process.env.REFRESH_TOKEN_PER_USER_CAP || '10', 10);

async function issueTokenPair(userId, accountId) {
  // L2 (2026-06-09 audit): stamp the access token with the user's current
  // tokenEpoch (claim `ep`) so the auth middleware can revoke it instantly
  // when the epoch is bumped (password change/reset). `jti` gives each token
  // a unique id for tracing/audit. Login + refresh are infrequent, so the
  // extra single-column lookup here is negligible.
  const _epoch = await prisma.user.findUnique({
    where:  { id: userId },
    select: { tokenEpoch: true },
  });
  const accessToken = jwt.sign(
    { userId, accountId, ep: _epoch?.tokenEpoch ?? 0, jti: crypto.randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY, algorithm: 'HS256' }
  );

  const rawRefresh = crypto.randomBytes(48).toString('base64url');
  const expiresAt  = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  const stored = await prisma.refreshToken.create({
    data:   { userId, tokenHash: hashToken(rawRefresh), expiresAt },
    select: { id: true },
  });

  // Soft-cap: revoke any active rows for this user beyond the cap, oldest
  // first. Best-effort — a logging error here must not block the login
  // response. The 30-day cron-prune (server/index.js refreshTokenPrune)
  // sweeps the revoked rows later.
  try {
    const active = await prisma.refreshToken.findMany({
      where:   { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select:  { id: true },
    });
    if (active.length > REFRESH_TOKEN_PER_USER_CAP) {
      const surplus = active.slice(REFRESH_TOKEN_PER_USER_CAP).map(r => r.id);
      await prisma.refreshToken.updateMany({
        where: { id: { in: surplus } },
        data:  { revokedAt: new Date() },
      });
    }
  } catch (e) {
    console.warn('[refresh-token-cap] revoke surplus failed:', e.message);
  }

  return { accessToken, refreshToken: rawRefresh, refreshTokenId: stored.id }; // (H4)
}

// ── Per-IP credential limiter (M1) ───────────────────────────────────────────
// 5 attempts per 15 min per IP, applied only to credential-bearing routes.
// /refresh and /logout are intentionally exempt — they require a valid token
// shape already and should not share the same brute-force budget.
// S6: bumped from 5 to 10 attempts per 15 min per IP to match the spec'd
// strict-limiter budget for /login, /forgot-password, /reset-password.
// standardHeaders emits Retry-After on 429.
// W4 smoke pass (2026-05-16): same CF-edge req.ip issue as the global
// apiLimiter — credential brute-force attempts from one client cycled
// across CF edge IPs and effectively bypassed this limiter. Prefer the
// CF-Connecting-IP header which CF always sets to the original client IP.
//
// Pass-2 audit P0 (2026-05-17): only honor CF-Connecting-IP when a
// well-formed CF-Ray header accompanies it. CF-Ray shape is 16 hex
// chars + dash + 3 uppercase letters; see server/index.js for the
// matching regex + rationale. A direct-origin attacker who hasn't
// firewalled-out can still try to forge both, but the network-layer
// firewall to Cloudflare IPs is the real defense.
const _CF_RAY_RE = /^[a-f0-9]{16}-[A-Z]{3}$/;
function _credKey(req) {
  const { ipKeyGenerator } = require('express-rate-limit');
  const cf = req.headers['cf-connecting-ip'];
  const cfRay = req.headers['cf-ray'];
  if (cf && cfRay && typeof cf === 'string' && cf.length < 64 && _CF_RAY_RE.test(String(cfRay))) {
    return `ip:${ipKeyGenerator(cf)}`;
  }
  return `ip:${ipKeyGenerator(req.ip)}`;
}
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // (S6)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: _credKey,
  message: { success: false, error: 'Too many attempts, please try again in 15 minutes.' },
});

// T6-N1 (Pass-6 audit): Dedicated per-IP rate limiter for /auth/register.
// The shared credentialLimiter (10/15min) is broader; registrations
// specifically need a tighter window because:
//   1. Automated account-farm scripts can exhaust demo AI budgets within
//      minutes by registering throwaway accounts at scale.
//   2. 3 registrations per hour is generous for any legitimate visitor
//      (setup, re-test, invite-flow exploration) but blocks scripted abuse.
// Both limiters stack — an IP must pass BOTH. Placed BEFORE credentialLimiter
// in the route so the tighter guard fires first and 429s are descriptive.
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour sliding window
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: _credKey,
  message: { success: false, error: 'Too many registrations from this IP. Try again later.' },
});

// ── Per-email login lockout (M1) ──────────────────────────────────────────────
// In-memory LRU map: email → { count, windowStart, lockedUntil }
// A Map preserves insertion order; delete+re-insert on each access acts as LRU.
// Max EMAIL_LOCKOUT_MAX_SIZE entries — oldest is evicted on overflow.
// Restarts clear the map, which is acceptable for single-server self-hosted.
const EMAIL_LOCKOUT_WINDOW_MS   = 15 * 60 * 1000; // sliding window length
const EMAIL_LOCKOUT_MAX_FAILS   = 5;               // failures before lockout
const EMAIL_LOCKOUT_DURATION_MS = 15 * 60 * 1000; // lockout length
const EMAIL_LOCKOUT_MAX_SIZE    = 1000;            // cap map to prevent DoS growth

const loginFailMap = new Map();

function _recordLoginFail(email) {
  const key = email.toLowerCase();
  const now = Date.now();
  let entry = loginFailMap.get(key) || { count: 0, windowStart: now, lockedUntil: 0 };
  // Reset counter if window has expired
  if (now - entry.windowStart > EMAIL_LOCKOUT_WINDOW_MS) {
    entry = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  entry.count += 1;
  if (entry.count >= EMAIL_LOCKOUT_MAX_FAILS) {
    entry.lockedUntil = now + EMAIL_LOCKOUT_DURATION_MS;
  }
  // LRU eviction: delete + re-insert moves entry to tail of insertion order
  loginFailMap.delete(key);
  loginFailMap.set(key, entry);
  // Evict the oldest (head) entry when over the cap
  if (loginFailMap.size > EMAIL_LOCKOUT_MAX_SIZE) {
    loginFailMap.delete(loginFailMap.keys().next().value);
  }
}

function _isEmailLockedOut(email) {
  const entry = loginFailMap.get(email.toLowerCase());
  return !!(entry && entry.lockedUntil && Date.now() < entry.lockedUntil);
}

function _clearLoginFails(email) {
  loginFailMap.delete(email.toLowerCase());
}

// v0.36.7 (Pass-6 W2 MT-013): per-email rate-limit on /api/auth/forgot-password.
//
// The credentialLimiter (10/15min/IP) bounds per-IP attempts but does
// nothing to stop an IP-rotating attacker from spamming the same email
// (cycling through CF edges; the demo's 4 publicly-documented seed
// emails make this trivial). Each call: writes a fresh reset token
// (invalidating any legitimate in-progress reset), sends a Brevo
// email (drains the 300/day free tier in ~12 min at 1600/hr).
//
// This per-email map gates 1 reset email per email per 60s. The route
// still appears to succeed (returns 200) to preserve the existing
// enumeration-resistance contract; the email + token write are simply
// skipped on rate-limited calls.
//
// Same LRU-eviction shape as loginFailMap above so growth is bounded.
// Cleared on process restart, which is acceptable for the demo.
const FORGOT_RESET_WINDOW_MS = 60 * 1000;
const FORGOT_RESET_MAX_SIZE  = 1000;
const forgotResetMap = new Map();

function _shouldRateLimitForgot(email) {
  const key = email.toLowerCase();
  const now = Date.now();
  const last = forgotResetMap.get(key);
  if (last && (now - last) < FORGOT_RESET_WINDOW_MS) {
    return true;
  }
  forgotResetMap.delete(key);
  forgotResetMap.set(key, now);
  if (forgotResetMap.size > FORGOT_RESET_MAX_SIZE) {
    forgotResetMap.delete(forgotResetMap.keys().next().value);
  }
  return false;
}

// Token-rotation safeguard: don't issue a fresh reset token if the user
// already has a valid one issued less than 5 minutes ago. Prevents the
// attacker from silently invalidating a legitimate in-progress reset
// even when the per-email rate limit hasn't tripped yet (e.g., across
// process restarts that cleared the in-memory map).
const FORGOT_TOKEN_REUSE_WINDOW_MS = 5 * 60 * 1000;


// ─── POST /api/auth/register ──────────────────────────────────────────────────
// Closed by default on self-hosted deployments. (H3)
// Set REGISTRATION_OPEN=true only when provisioning a brand-new instance.
router.post('/register', registrationLimiter, credentialLimiter, countryGate, async (req, res) => { // (M1) + (Pass-6 W3 MT-026) + T6-N1
  if (process.env.REGISTRATION_OPEN !== 'true') {
    return res.status(403).json({
      success: false,
      error: 'Public registration is not enabled on this instance. Contact your administrator.',
    });
  }

  try {
    const parsed = validateBody(req, res, RegisterSchema); // (B6)
    if (!parsed) return;
    const { companyName, name, email, password, acceptedTermsVersion, acceptedUsScope } = parsed;

    // (Pass-6 W3 MT-026) Demo requires the US-scope attestation. Self-host
    // does not -- operators take their own jurisdictional obligation, and
    // forcing a US-only checkbox on a UK/EU self-host registrant would
    // misrepresent the product. The server-side check is the authoritative
    // gate; the Register.jsx checkbox is the user-facing surface.
    if (process.env.DEMO_MODE === 'true' && acceptedUsScope !== true) {
      return res.status(400).json({
        success: false,
        error: "You must confirm that your business operates in the United States to use the demo sandbox.",
        code: 'US_SCOPE_REQUIRED',
      });
    }
    // Default the version string to the latest published filenames so the
    // audit trail is meaningful even when an older client doesn't send one.
    // Update this default when the lawyer-approved versions land.
    const termsVersion = acceptedTermsVersion || 'eula-2026-05-04, tos-2026-05-04, privacy-2026-05-04, demo-notice-2026-05-04';

    // Register uses global defaults — no account exists yet to look up settings from
    const { valid: pwValid, errors: pwErrors } = await validateStrength(password, buildPolicy({}), { userInputs: [email, name, companyName].filter(Boolean) }); // audit-7 item 2.1.1 (zxcvbn + HIBP)
    if (!pwValid) {
      return res.status(400).json({ success: false, error: pwErrors[0], errors: pwErrors });
    }

    // Pass-3 audit MED #5: this 409 + "Email already registered" is an
    // enumeration oracle. The proper fix is email-verification-on-signup
    // (always return 200, send a "verify or recover" email regardless of
    // existing state) — a sprint-sized change deferred to a later wave.
    // For now the credentialLimiter (10 attempts / 15 min / IP, see
    // /api/auth/register in this file) is the practical defense — an
    // attacker can enumerate at most 10 addresses per IP per window.
    // Also softened the message to give legit users a recovery path
    // instead of a dead end.
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) {
      return res.status(409).json({
        success: false,
        error:   'An account with this email already exists. Try signing in or use Forgot password.',
        action:  'sign_in_or_reset',
      });
    }

    // Pass-4.5 AI-P0-3 (2026-05-17) — application-layer demo-signup cap.
    //
    // Pre-fix, DEMO_MAX_ACCOUNTS (default 1000) was enforced ONLY by the
    // 03:25 UTC prune cron in lib/demoPrune.js. An IP-rotating signup
    // script firing between sweeps could create N×1000 accounts in a
    // window and burn the shared Anthropic key all night before pruning
    // caught up. AI-safety audit (audit/ai-safety/05-cost-and-tenant.md
    // F-COST-01) modelled the worst case at ~$230-700/day on Haiku;
    // clamping demo caps to 1/day (Pass-4.5 task #31) brings the per-
    // account ceiling down ~5×, and this application-layer count gate
    // is the structural defense that closes the cap-evasion path.
    //
    // On self-hosted installs (DEMO_MODE !== 'true') the gate is a no-op
    // — operators set their own ceilings and rate limits.
    if (process.env.DEMO_MODE === 'true') {
      // Read the cap from the same env the cron uses, with the same
      // default. Excludes the legacy shared DEMO_ACCOUNT_ID seed from
      // the count so it never eats a slot (mirrors demoPrune.js).
      const { DEMO_ACCOUNT_ID } = require('../scripts/seed-demo');
      const capRaw = parseInt(process.env.DEMO_MAX_ACCOUNTS || '1000', 10);
      const demoCap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 1000;
      const liveCount = await prisma.account.count({
        where: { id: { not: DEMO_ACCOUNT_ID } },
      });
      if (liveCount >= demoCap) {
        return res.status(503).json({
          success: false,
          error:   'demo_at_capacity',
          message: 'The demo sandbox is at capacity right now. Inactive sandboxes are pruned nightly — please try again in a few hours, or self-host ServiceCycle on your own infrastructure (free) to skip the queue.',
        });
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: {
          companyName,
          status:   'active',
          planType: 'saas',
          planTier: 'small',
          // L3: stamp lastActiveAt at registration so the prune cron's
          // "never returned" branch (lastActiveAt IS NULL AND createdAt < cutoff)
          // measures dormancy from the right anchor — first activity, not first
          // intent. Operators on demo see fresh registrations get a full TTL
          // window even if the visitor never logs back in.
          lastActiveAt: new Date(),
          // Per-visitor demo accounts get the AI maintenance brief turned
          // on by default so the demo showcases the feature out of the
          // box. Self-host registrations (DEMO_MODE false) keep the
          // default OFF — operator opts in via Settings.
          aiBriefEnabled: process.env.DEMO_MODE === 'true',
        },
      });
      const user = await tx.user.create({
        data: {
          accountId: account.id,
          name,
          email: email.toLowerCase(),
          passwordHash,
          role: 'admin',
          featureFlags:         defaultFlagsForRole('admin'),
          acceptedTermsAt:      new Date(),
          acceptedTermsVersion: termsVersion,
        },
        // v0.38.3 followup: include the nested account object (matching
        // /api/auth/me's shape) so the client doesn't have to round-trip
        // to /auth/me before features gated on account.aiBriefEnabled —
        // notably the renewal-brief card — can render. Demo signups
        // previously landed on /contracts/:id with the brief button
        // hidden until the next page refresh fired /auth/me.
        select: {
          id: true, accountId: true, name: true, email: true,
          role: true, featureFlags: true, hiddenFeatures: true, createdAt: true,
          account: {
            select: {
              id: true, companyName: true, status: true, planType: true, planTier: true,
              aiBriefEnabled: true,
            },
          },
        },
      });
      return { account, user };
    });

    // L3: in DEMO_MODE, seed the visitor's brand-new account with the canned
    // demo data set (sites, assets, schedules, work orders). This is what
    // makes per-visitor sandboxes look populated on the very first dashboard
    // load instead of an empty-state stare. Fail-open: if seeding errors,
    // the registration still succeeds — the visitor lands in an empty
    // workspace they can populate themselves.
    if (process.env.DEMO_MODE === 'true') {
      try {
        const { seedAccountForUser } = require('../scripts/seed-demo');
        await seedAccountForUser(result.user.id);
      } catch (seedErr) {
        console.error('[demo] seedAccountForUser failed for new registration:', seedErr.message);
      }
    }

    // 2026-05-10 review H5 fix: write an account_created row so the Activity
    // Log on a freshly-registered account isn't empty. Previously only
    // login_failed events were persisted; a brand-new user would see the
    // ominous "No activity found" on every Activity Log visit until the
    // first asset write hit the log.
    writeActivityLog({
      userId:  result.user.id,
      action:  'account_created',
      details: { ip: req.ip, demoMode: process.env.DEMO_MODE === 'true' },
    });

    // Audit 6.1.1 — welcome email after register. Fire-and-forget; demo
    // EMAIL_MOCK=true sends to log instead of inbox, self-host sends real.
    // Failure must NEVER block registration response.
    try {
      const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';
      sendEmail({
        to:      result.user.email,
        subject: 'Welcome to ServiceCycle',
        html:    welcomeHtml({
          name:        result.user.name,
          companyName: result.user.account?.companyName,
          appUrl,
        }),
      }).catch(e => console.error('[auth] welcome email failed:', e.message));
    } catch (welcomeErr) {
      console.error('[auth] welcome email build error:', welcomeErr.message);
    }

    const { accessToken, refreshToken } = await issueTokenPair(result.user.id, result.user.accountId);
    res.status(201).json({ success: true, data: { token: accessToken, refreshToken, user: result.user } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// Industry-news refresh on login. The user wants the live news "search/pull"
// to fire when people sign in (demo + production) instead of relying on seeded
// items. This is throttled so a burst of logins triggers at most one RSS scan
// per window, and it's fire-and-forget so it never delays the login response.
// NewsItem is global (no accountId) and the scanner dedupes by URL.
let _lastNewsRefresh = 0;
const _NEWS_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 min
function _maybeRefreshNews() {
  const now = Date.now();
  if (now - _lastNewsRefresh < _NEWS_REFRESH_INTERVAL_MS) return;
  _lastNewsRefresh = now;
  try {
    const { runNewsScanner } = require('../lib/newsScanner');
    Promise.resolve(runNewsScanner()).catch((e) =>
      console.warn('[auth] news refresh on login failed (non-fatal):', e.message));
  } catch (e) {
    console.warn('[auth] news refresh unavailable:', e.message);
  }
}

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', credentialLimiter, async (req, res) => { // (M1)
  try {
    const parsed = validateBody(req, res, LoginSchema); // (B6)
    if (!parsed) return;
    const { email, password } = parsed;

    const normEmail = email.toLowerCase();

    // M1: per-email lockout check — must come before DB work to avoid wasted queries.
    // Returns the same generic 401 as bad-password so the lockout itself doesn't
    // reveal whether the email is registered.
    if (_isEmailLockedOut(normEmail)) {
      await new Promise((r) => setTimeout(r, 200)); // equalise timing
      // Note: lockout-hit logging would require a user lookup here, which we
      // deliberately skip to keep this fast path cheap. console.warn is enough
      // for operators to spot a sustained attack — the lockout itself is the
      // user-visible signal, and the original failures were already logged.
      console.warn(`[auth] login attempt during email lockout: email=${redactEmail(normEmail)} ip=${req.ip}`);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const user = await prisma.user.findUnique({ where: { email: normEmail } });

    if (!user) {
      await new Promise((r) => setTimeout(r, 200)); // prevent timing enumeration
      // Record fail even for unknown emails to prevent account-existence enumeration
      // via differing lockout behaviour between known and unknown addresses. (M1)
      _recordLoginFail(normEmail);
      // B4: anonymous-email failures now persist to ActivityLog (userId is
      // nullable as of migration 20260502160000_activity_log_user_optional).
      // Admins can spot brute-force against made-up addresses by querying
      // action='login_failed' AND userId IS NULL.
      writeActivityLog({
        userId:  null,
        action:  'login_failed',
        details: { ip: req.ip, reason: 'unknown_email', attemptedEmail: normEmail },
      });
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      _recordLoginFail(normEmail); // (M1)
      // C1: known-user failure — write an audit row pinned to the targeted
      // userId so admins can spot brute-force against a specific account.
      writeActivityLog({
        userId:  user.id,
        action:  'login_failed',
        details: { ip: req.ip, reason: 'bad_password' },
      });
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    // M2: reject deactivated users at login — same error message, don't leak account existence
    if (!user.isActive) {
      _recordLoginFail(normEmail); // (M1) count inactive-user failures too
      writeActivityLog({
        userId:  user.id,
        action:  'login_failed',
        details: { ip: req.ip, reason: 'inactive_user' },
      });
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    // Successful login — clear failure counter so a future genuine lock doesn't
    // carry over stale counts from before the user authenticated. (M1)
    _clearLoginFails(normEmail);

    // Refresh industry news on successful auth (throttled, fire-and-forget).
    _maybeRefreshNews();

    // 2FA gate: if enabled, issue a short-lived pending token instead of full tokens.
    // The client must POST /api/auth/2fa/verify-login with this token + TOTP code.
    if (user.twoFactorEnabled) {
      const twoFactorToken = issuePending2faToken(user.id, req);  // v0.68.5: pass req for IP+UA binding
      return res.json({ success: true, data: { requires2fa: true, twoFactorToken } });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    // 2026-05-10 review H5 fix: persist successful logins so the Activity Log
    // isn't all noise (login_failed only) and brand-new users see something
    // other than "No activity found" after their first sign-in.
    writeActivityLog({
      userId:  user.id,
      action:  'login_success',
      details: { ip: req.ip },
    });

    // H1 (audit High, 2026-05-22): mfaRequiredForAdmins enforcement.
    // If the account flips on this policy, the next admin login carries
    // requires2faSetup:true so the SPA can push them to /2fa/setup. We
    // intentionally do NOT block the login -- bricking already-active
    // admins when an admin flips the flag would be a worse failure mode
    // than the brief setup window. Once they enable 2FA they'll go
    // through the existing twoFactorEnabled gate above on subsequent
    // logins. Failure to read the account row is logged but does NOT
    // block login.
    let requires2faSetup = false;
    try {
      if (user.role === 'admin' && !user.twoFactorEnabled) {
        const acct = await prisma.account.findUnique({
          where:  { id: user.accountId },
          select: { mfaRequiredForAdmins: true },
        });
        if (acct?.mfaRequiredForAdmins) requires2faSetup = true;
      }
    } catch (mfaErr) {
      console.error('mfaRequiredForAdmins lookup error:', mfaErr);
    }

    // H4: short-lived access token + rotating refresh token
    const { accessToken, refreshToken } = await issueTokenPair(user.id, user.accountId);

    const { passwordHash: _omit, twoFactorSecret: _s, twoFactorBackupCodes: _b, ...safeUser } = user;
    res.json({ success: true, data: { token: accessToken, refreshToken, user: safeUser, aiProvider: process.env.AI_PROVIDER || 'anthropic', requires2faSetup } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
// Rotate a refresh token. On reuse detection, revoke ALL tokens for the user.
// N1: uses an atomic updateMany claim to eliminate the TOCTOU race present in
// the original find → check → update sequence. Two concurrent /refresh calls
// with the same token will both pass the findFirst check, but only one
// updateMany can match (the other sees count === 0) — the loser triggers the
// reuse-detection cascade, same as an explicit replay attack.
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(401).json({ success: false, error: 'Refresh token required' });
  }

  try {
    const tokenHash = hashToken(refreshToken);
    const stored = await prisma.refreshToken.findFirst({ where: { tokenHash } });

    if (!stored) {
      return res.status(401).json({ success: false, error: 'Invalid refresh token' });
    }

    // Reuse detection: already-revoked token submitted — possible theft replay
    if (stored.revokedAt) {
      const cascade = await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
      console.warn(`[auth] Refresh token reuse detected for user ${stored.userId} — all tokens revoked`);
      // v0.68.0 (audit Medium): audit-log the cascade so a refresh-token
      // theft replay is visible in the activity log.
      try {
        writeActivityLog({
          userId:    stored.userId,
          // @ts-ignore -- user is assigned before this catch branch runs
          accountId: user && user.accountId ? user.accountId : null,
          action:    'refresh_token_revoked_reuse_detected',
          details:   { revokedCount: cascade.count, ip: req.ip || null },
        });
      } catch (logErr) {
        console.error('activity log (refresh reuse) error:', logErr);
      }
      return res.status(401).json({ success: false, error: 'Invalid refresh token' });
    }

    if (stored.expiresAt < new Date()) {
      await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      return res.status(401).json({ success: false, error: 'Refresh token expired' });
    }

    // Verify user still active
    const user = await prisma.user.findUnique({
      where:  { id: stored.userId },
      select: { id: true, accountId: true, isActive: true },
    });
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, error: 'Invalid refresh token' });
    }

    // N1: Atomic claim — collapses the race window to a single SQL statement.
    // If two concurrent requests arrive with the same valid token, only the one
    // whose updateMany runs first will get count === 1. The other gets count === 0
    // and must treat this as reuse (cascade revoke all active tokens).
    const claim = await prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data:  { revokedAt: new Date() },
    });
    if (claim.count !== 1) {
      // Race lost — another request claimed the same token; treat as reuse
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
      console.warn(`[auth] Refresh token concurrent-claim/reuse detected for user ${stored.userId} — all tokens revoked`);
      return res.status(401).json({ success: false, error: 'Invalid refresh token' });
    }

    // Issue new pair; issueTokenPair now returns the DB row id directly (H4).
    // This avoids the fragile findFirst-by-createdAt successor lookup.
    const { accessToken, refreshToken: newRawRefresh, refreshTokenId: newTokenId } =
      await issueTokenPair(user.id, user.accountId);

    // Link the old token to its successor for audit-trail continuity. (H4)
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data:  { replacedById: newTokenId },
    });

    res.json({ success: true, data: { token: accessToken, refreshToken: newRawRefresh } });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(401).json({ success: false, error: 'Invalid refresh token' });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
// Revoke the given refresh token. Always 200 — don't leak whether it existed.
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    try {
      const tokenHash = hashToken(refreshToken);
      await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
    } catch {
      // Swallow
    }
  }
  res.json({ success: true });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, accountId: true, name: true, email: true, role: true,
        lastLogin: true, featureFlags: true, hiddenFeatures: true, createdAt: true,
        // Phase 4: AI consent state — drives the per-session consent modal.
        aiConsentDismissedAt: true,
        aiConsentSilenced:    true,
        account: {
          select: {
            id: true, companyName: true, status: true, planType: true, planTier: true,
            // Phase 4: per-account AI brief toggle for the client to decide
            // whether to render the "Generate brief" button at all.
            aiBriefEnabled: true,
            // Partner flywheel: expose to client so settings UI can show consent panel
            partnerOrgId: true,
            partnerOrg: { select: { name: true } },
          },
        },
      },
    });

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    // Per-instance AI provider (env-set; safe to expose since it's not a
    // tenant-isolated value). The client uses this to render "Acknowledge
    // sending data to <provider>" in the consent modal.
    // Pass-4 audit L3-07 / L3-08: surface the active provider AND the
    // current consent-text version so the client posts both back to
    // /api/auth/ai-consent when the user acknowledges; the server gate
    // uses them to detect drift.
    const { getActiveProvider, getCurrentConsentVersion } = require('../lib/aiConsent');
    const aiProvider = getActiveProvider();
    const aiConsentVersion = getCurrentConsentVersion();
    // v0.90.9: validate /api/auth/me response shape (drives AuthContext + Sidebar
    // permission gates). Drift here would cascade into every authed page.
    const { validateResponse } = require('../lib/responseValidator');
    const { authMeSchema }     = require('../schemas/api');
    const payload: any = { success: true, data: { user, aiProvider, aiConsentVersion } };
    res.json(validateResponse('/api/auth/me', authMeSchema, payload, req));
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

// ─── POST /api/auth/ai-consent ───────────────────────────────────────────────
// Phase 4 (v0.4.0): record that the user has acknowledged the AI consent
// modal. Sets aiConsentDismissedAt = now() on the User row. Idempotent —
// subsequent calls just bump the timestamp. The server-side gate in
// lib/aiConsent.js only cares that the column is non-null; the client uses
// the timestamp + sessionStorage to drive per-session re-prompts.
router.post('/ai-consent', authenticateToken, async (req, res) => {
  try {
    // Pass-4 audit L3-07 + L3-08: capture WHAT and WHICH the user
    // acknowledged so the server gate can detect drift. The client is
    // expected to echo the values it received from /api/auth/me; if it
    // omits them, recordAiConsent defaults to the server's current
    // active values.
    const { recordAiConsent } = require('../lib/aiConsent');
    // v0.71.4 (audit Medium "Data Integrity"): tighten from .slice()
    // truncation to zod rejection. Caps match lib/aiConsent.js helper limits
    // (32 / 64). Oversized payloads now return 400 instead of silently
    // truncating.
    const AiConsentSchema = z.object({
      version:  z.string().max(32).optional(),
      provider: z.string().max(64).optional(),
    });
    const parsed = AiConsentSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'invalid_ai_consent_payload' });
    }
    const { version, provider } = parsed.data;
    await recordAiConsent(req.user.id, { version, provider });
    return res.json({ success: true, data: { acknowledgedAt: new Date() } });
  } catch (err) {
    console.error('AI consent record error:', err);
    return res.status(500).json({ success: false, error: 'Failed to record AI consent' });
  }
});

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────
router.post('/forgot-password', credentialLimiter, async (req, res) => { // (M1)
  const parsed = validateBody(req, res, ForgotPasswordSchema); // (B6)
  if (!parsed) return;
  const { email } = parsed;
  const normalizedEmail = email.toLowerCase().trim();

  // v0.36.7 (MT-013): per-email rate-limit. Returns success-shaped
  // 200 so the enumeration-resistance contract holds; the email and
  // token write are skipped.
  if (_shouldRateLimitForgot(normalizedEmail)) {
    return res.json({ success: true });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (user && user.isActive) {
      // v0.36.7 (MT-013) token-rotation safeguard: if the user already
      // has a valid reset token issued in the last 5 min, do NOT
      // overwrite it. Protects against silent invalidation of a
      // legitimate in-progress reset even when the per-email rate
      // limit hasn't tripped (e.g., after a process restart cleared
      // the in-memory map). The response is still 200 so attackers
      // can't distinguish this case from a fresh send.
      const now = Date.now();
      const hasFreshToken =
        user.passwordResetToken &&
        user.passwordResetExpiresAt &&
        user.passwordResetExpiresAt.getTime() > now &&
        // Tokens carry a 60-min expiresAt; "fresh" = expiresAt is within
        // (now + 60min - 5min) = at least 55 minutes left.
        (user.passwordResetExpiresAt.getTime() - now) > (60 * 60 * 1000 - FORGOT_TOKEN_REUSE_WINDOW_MS);

      if (!hasFreshToken) {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(now + 60 * 60 * 1000);

        await prisma.user.update({
          where: { id: user.id },
          data:  { passwordResetToken: token, passwordResetExpiresAt: expiresAt },
        });

        const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';
        // S3-FN-01 (v0.75.1): fire-and-forget so Brevo hang cannot block response
        sendEmail({
          to:      user.email,
          subject: 'Reset your ServiceCycle password',
          html:    passwordResetHtml({ link: `${appUrl}/reset-password/${token}` }),
        }).catch(e => console.error('[auth] forgot-password email failed:', e.message));
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ success: false, error: 'Failed to process request' });
  }
});

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
router.post('/reset-password', credentialLimiter, async (req, res) => { // (M1)
  const parsed = validateBody(req, res, ResetPasswordSchema); // (B6)
  if (!parsed) return;
  const { token, password } = parsed;

  try {
    const user = await prisma.user.findFirst({
      where: { passwordResetToken: token, passwordResetExpiresAt: { gt: new Date() } },
    });

    if (!user) return res.status(400).json({ success: false, error: 'This reset link is invalid or has expired' });

    // Validate against this user's account policy
    const policy = await loadAccountPolicy(prisma, user.accountId);
    // audit-7 item 2.1.1: zxcvbn + HIBP layered on rule policy.
    const { valid: pwValid, errors: pwErrors } = await validateStrength(password, policy, { userInputs: [user.email, user.name].filter(Boolean) });
    if (!pwValid) {
      return res.status(400).json({ success: false, error: pwErrors[0], errors: pwErrors });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { id: user.id },
      // L2 (2026-06-09 audit): bump tokenEpoch so the reset also invalidates
      // every outstanding access token — closes the stolen-then-reset window
      // where an attacker's still-valid access token outlives the reset.
      data:  { passwordHash, passwordResetToken: null, passwordResetExpiresAt: null, tokenEpoch: { increment: 1 } },
    });

    // C2 (audit Critical, 2026-05-22): kill every outstanding refresh token
    // for the user whose password was just reset. Prevents a stolen-then-
    // reset attack where the attacker keeps using the original session even
    // after the legit owner reclaims the account via the reset link.
    let revokedCount = 0;
    try {
      const revoked = await prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
      revokedCount = revoked.count;
    } catch (revokeErr) {
      console.error('refresh-token revoke (password reset) error:', revokeErr);
    }
    try {
      writeActivityLog({
        userId:  user.id,
        action:  'password_reset_sessions_revoked',
        details: {
          revokedCount,
          ip: req.ip || req.headers['x-forwarded-for'] || null,
        },
      });
    } catch (logErr) {
      console.error('activity log (password reset) error:', logErr);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ success: false, error: 'Failed to reset password' });
  }
});

// ─── GET /api/auth/invite/:token ──────────────────────────────────────────────
router.get('/invite/:token', async (req, res) => {
  try {
    const invite = await prisma.userInvite.findUnique({
      where:   { token: req.params.token },
      include: { account: { select: { companyName: true } } },
    });

    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      return res.status(410).json({ success: false, error: 'This invite link is invalid or has expired' });
    }

    return res.json({
      success: true,
      data:    { email: invite.email, role: invite.role, companyName: invite.account.companyName },
    });
  } catch (err) {
    console.error('Invite validate error:', err);
    return res.status(500).json({ success: false, error: 'Failed to validate invite' });
  }
});

// ─── POST /api/auth/invite/:token/accept ─────────────────────────────────────
router.post('/invite/:token/accept', credentialLimiter, async (req, res) => { // (M1)
  const { name, password, acceptedTerms, acceptedTermsVersion } = req.body;
  if (!name?.trim()) return res.status(400).json({ success: false, error: 'Name is required' });
  if (!password) return res.status(400).json({ success: false, error: 'Password is required' });

  // Audit Cluster A P1 (2026-05-16): cap input sizes BEFORE bcrypt.hash.
  // Without these caps a 5 MB password survives to bcrypt and burns CPU.
  // The 200-char password cap matches the RegisterSchema. The 200-char name
  // cap matches the same.
  if (typeof name !== 'string' || name.length > 200) {
    return res.status(400).json({ success: false, error: 'Name is too long (max 200 characters)' });
  }
  if (typeof password !== 'string' || password.length > 200) {
    return res.status(400).json({ success: false, error: 'Password is too long (max 200 characters)' });
  }

  // Pass-4 audit L1-03 (2026-05-16): the AcceptInvite client got a
  // ToS/Privacy click-through checkbox in pass-3, but the server never
  // recorded the acceptance — every invite-flow User row had
  // acceptedTermsAt=null / acceptedTermsVersion=null. GDPR Art. 7(1)
  // requires the controller to be able to "demonstrate" consent; the
  // demonstration is a stored version + timestamp.
  if (acceptedTerms !== true) {
    return res.status(400).json({ success: false, error: 'You must accept the Terms of Service and Privacy Policy to continue.' });
  }
  const termsVersion = (typeof acceptedTermsVersion === 'string'
                       && acceptedTermsVersion.trim().length > 0
                       && acceptedTermsVersion.length <= 200)
    ? acceptedTermsVersion.trim()
    // Conservative fallback: stamp the current self-host terms-version
    // string. Matches what SetupWizard sends and is the correct version
    // for an invited user (the demo-notice doesn't apply to self-host).
    : 'eula-2026-05-04, tos-2026-05-04, privacy-2026-05-04';

  try {
    const invite = await prisma.userInvite.findUnique({ where: { token: req.params.token } });

    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      return res.status(410).json({ success: false, error: 'This invite link is invalid or has expired' });
    }

    // Validate password against the inviting account's policy
    const policy = await loadAccountPolicy(prisma, invite.accountId);
    // audit-7 item 2.1.1: zxcvbn + HIBP layered on rule policy.
    const { valid: pwValid, errors: pwErrors } = await validateStrength(password, policy, { userInputs: [invite.email, name].filter(Boolean) });
    if (!pwValid) {
      return res.status(400).json({ success: false, error: pwErrors[0], errors: pwErrors });
    }

    const existing = await prisma.user.findUnique({ where: { email: invite.email } });
    if (existing) {
      return res.status(409).json({ success: false, error: 'An account with this email already exists. Try logging in.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          accountId: invite.accountId,
          name: name.trim(),
          email: invite.email,
          passwordHash,
          role: invite.role,
          isActive: true,
          featureFlags: defaultFlagsForRole(invite.role),
          // Viewers start with scope-restricted access — they only see assets
          // at sites assigned to them (scoping rewire lands with the routes
          // adaptation). An admin can lift this in Settings → Users.
          assetScopeRestricted: invite.role === 'viewer',
          // Pass-4 audit L1-03: capture consent on the invite-accept path
          // so this isn't the one signup path that doesn't satisfy GDPR
          // Art. 7(1) demonstrability.
          acceptedTermsAt:      new Date(),
          acceptedTermsVersion: termsVersion,
        },
        // v0.38.3 followup: include the nested account object (matching
        // /api/auth/me's shape) so the invited user lands on /dashboard
        // with feature-gated UI already correct. Same fix as the
        // /register handler above; both signup paths now return the
        // same shape.
        select: {
          id: true, accountId: true, name: true, email: true,
          role: true, featureFlags: true, hiddenFeatures: true, createdAt: true,
          account: {
            select: {
              id: true, companyName: true, status: true, planType: true, planTier: true,
              aiBriefEnabled: true,
            },
          },
        },
      });

      await tx.userInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });

      if (invite.role === 'consultant') {
        await tx.consultantAccess.create({
          data: {
            accountId:    invite.accountId,
            consultantId: newUser.id,
            grantedById:  invite.invitedBy,
          },
        });
      }

      return newUser;
    });

    // H4: short-lived access token + refresh token
    const { accessToken, refreshToken } = await issueTokenPair(user.id, user.accountId);

    // If the new user is a scoped viewer, notify all admins so they can assign
    // sites and/or expand permissions. Fire-and-forget — never block the response.
    if (invite.role === 'viewer') {
      (async () => {
        try {
          const admins = await prisma.user.findMany({
            where: { accountId: invite.accountId, role: 'admin', isActive: true },
            select: { email: true },
          });

          const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';
          const settingsUrl = `${appUrl}/settings?tab=users`;

          for (const admin of admins) {
            await sendEmail({
              to: admin.email,
              subject: `${user.name} just activated their ServiceCycle account`,
              html: newViewerActivationHtml({
                viewerName: user.name,
                viewerEmail: user.email,
                // Assets carry no per-user owner — site-scoped visibility
                // lands with the scoping rewire, so until then a fresh
                // scoped viewer sees 0 assigned items.
                assetCount: 0,
                settingsUrl,
              }),
            });
          }
        } catch (notifyErr) {
          console.error('Viewer activation admin notify error:', notifyErr.message);
        }
      })();
    }

    return res.status(201).json({ success: true, data: { token: accessToken, refreshToken, user } });
  } catch (err) {
    console.error('Invite accept error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create account' });
  }
});

// Default export is the router itself so existing `require('./routes/auth')`
// callers continue to work unchanged.
// Named export `credentialLimiter` lets routes/setup.js reuse the same per-IP
// brute-force budget (10 / 15 min) instead of spinning up a fourth limiter.
module.exports = router;
module.exports.credentialLimiter = credentialLimiter;

export {};

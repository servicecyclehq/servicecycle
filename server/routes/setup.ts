'use strict';

/**
 * routes/setup.js
 * ---------------
 * First-run setup wizard endpoints. Mounted at /api/setup, sits BEFORE the
 * setup gate in server/index.js so an unconfigured instance can still reach
 * these routes (the gate would otherwise return 503 needsSetup:true).
 *
 * Defence-in-depth: every endpoint re-checks isInstanceConfigured() as its
 * first action and returns 409 if the wizard has already completed. This is
 * NOT a substitute for the middleware gate — it's a second layer in case the
 * gate is ever removed or routed around.
 *
 * Rate-limited with the same per-IP credentialLimiter (10 / 15 min) used by
 * /login etc., imported from routes/auth.js to avoid creating a fourth
 * limiter instance.
 *
 * Endpoints:
 *   POST /api/setup/account   — create first Account + admin User
 *   POST /api/setup/email     — store Resend config OR enable EMAIL_MOCK
 *   POST /api/setup/ai        — store AI provider key OR set AI_ENABLED=false
 *   POST /api/setup/complete  — mark setupCompletedAt; the SPA redirects to /login
 *   GET  /api/setup/status    — { configured: bool, demoMode: bool } — used by the SPA on boot
 *
 * Note on env mutation: the wizard mutates process.env for EMAIL_MOCK /
 * AI_ENABLED in the running process so subsequent requests honour the choice
 * without a server restart. After a restart, the .env file values take over.
 * For account-scoped settings (AI_API_KEY, BREVO_API_KEY, EMAIL_FROM), we
 * persist to account_settings so they survive restarts properly.
 */

const router = require('express').Router();
const bcrypt = require('bcryptjs');
import prisma from '../lib/prisma';
const { credentialLimiter } = require('./auth');
const {
  getInstanceConfig,
  invalidateInstanceConfigCache,
  isInstanceConfigured,
} = require('../lib/instanceConfig');
const { validate: validatePassword, validateStrength, buildPolicy } = require('../lib/passwordPolicy');
const { defaultFlagsForRole } = require('../lib/featureFlags');
// v0.71.4 (audit Medium "Data Integrity"): the wizard upserts BREVO_API_KEY
// + AI_API_KEY directly. Without encryption these sit in plaintext in
// AccountSetting until a settings.js write re-encrypts them. Wrap with the
// shared helper so they encrypt at first write.
const { encryptIfNeeded } = require('../lib/crypto');

// In-memory progress for a single in-flight wizard run. Tracks which steps
// have completed so the /complete endpoint can fail loudly if the operator
// somehow skipped /account. The state is intentionally per-process and is
// reset on restart — a partial wizard run that crashes mid-way just starts
// over, which is fine because /account is idempotent (it errors if any User
// already exists).
const _wizardState: any = {
  accountId: null,    // set by /account
  adminUserId: null,  // set by /account
  emailDone: false,   // set by /email (true regardless of mock vs real)
  aiDone: false,      // set by /ai
};

function _resetWizardState() {
  _wizardState.accountId    = null;
  _wizardState.adminUserId  = null;
  _wizardState.emailDone    = false;
  _wizardState.aiDone       = false;
}

// Guard: every endpoint runs this first. Returns true if it short-circuited
// the response (caller should `return`); false if the request may proceed.
async function _rejectIfConfigured(res) {
  if (await isInstanceConfigured()) {
    res.status(409).json({ success: false, error: 'Instance is already configured.' });
    return true;
  }
  return false;
}

// ── GET /api/setup/status ────────────────────────────────────────────────────
// Public — the SPA calls this on boot to decide whether to route to /setup or
// /login. Intentionally returns minimal info: just "is the wizard done?" and
// "is this a demo instance?". No fingerprintable details.

router.get('/status', async (_req, res) => {
  try {
    const cfg = await getInstanceConfig();
    // (A1) Demo mode can be activated two ways:
    //   1. process.env.DEMO_MODE=true at boot — the documented operator path.
    //      This drives the runtime overrides in index.js (email mock, AI off,
    //      registration open) and the 03:30 reset cron.
    //   2. InstanceConfig.demoMode=true in the DB — set by tooling that wants
    //      demo state to persist across restarts without an env flag.
    // OR them together so a freshly-launched DEMO_MODE=true instance shows
    // the banner without also having to UPDATE the singleton row.
    const envDemo = process.env.DEMO_MODE === 'true';
    // L7+legal: surface registrationOpen so the Login + Register pages can
    // gate the "Create an account" link without a second round trip. Demo
    // mode forces registration open via the DEMO_MODE startup block.
    const registrationOpen = process.env.REGISTRATION_OPEN === 'true' || envDemo;
    return res.json({
      success: true,
      data: {
        configured: !!cfg.setupCompletedAt,
        demoMode:   envDemo || !!cfg.demoMode,
        registrationOpen,
      },
    });
  } catch (err) {
    console.error('[setup/status]', err);
    return res.status(503).json({ success: false, error: 'Database unreachable.' });
  }
});

// ── POST /api/setup/account ──────────────────────────────────────────────────
// Step 1: create the first Account + admin User.
// Mirrors the body of /api/auth/register (server/routes/auth.js:107-165) but
// does NOT require REGISTRATION_OPEN — this is the bootstrap path.

router.post('/account', credentialLimiter, async (req, res) => {
  if (await _rejectIfConfigured(res)) return;

  // Belt-and-braces: also reject if any User already exists. Without this an
  // attacker who somehow reaches /api/setup/account on a configured instance
  // (e.g. via a misconfigured proxy bypassing the gate) can't create a new
  // admin. The setupCompletedAt check above handles the normal case.
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    return res.status(409).json({
      success: false,
      error: 'An account already exists on this instance. Setup is closed.',
    });
  }

  try {
    const { companyName, name, email, password, acceptedTerms, acceptedTermsVersion } = req.body;
    if (!companyName || !name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'All fields are required: companyName, name, email, password',
      });
    }

    // EULA acceptance gate (matches /api/auth/register; required by the
    // EULA §1(c) "first user account on a running ServiceCycle instance"
    // acceptance trigger). The wizard's UI step shows the EULA in a
    // scrollable region and binds an unchecked checkbox to acceptedTerms.
    if (acceptedTerms !== true) {
      return res.status(400).json({
        success: false,
        error: 'You must accept the End-User License Agreement, Terms of Service, and Privacy Policy to complete setup.',
      });
    }
    // Default the version string to the latest published filenames so the
    // audit trail is meaningful even when an older client doesn't send one.
    // Update this default when the lawyer-approved versions land.
    const termsVersion = (typeof acceptedTermsVersion === 'string' && acceptedTermsVersion.trim())
      ? acceptedTermsVersion.trim().slice(0, 200)
      : 'eula-2026-05-04, tos-2026-05-04, privacy-2026-05-04';

    // First-run uses pure defaults — no account exists yet to load policy from.
    const { valid, errors } = await validateStrength(password, buildPolicy({}), { userInputs: [email, name, companyName].filter(Boolean) }); // audit-7 item 2.1.1
    if (!valid) {
      return res.status(400).json({ success: false, error: errors[0], errors });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: { companyName, status: 'active', planType: 'saas', planTier: 'small' },
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
        select: {
          id: true, accountId: true, name: true, email: true, role: true,
        },
      });
      return { account, user };
    });

    _wizardState.accountId   = result.account.id;
    _wizardState.adminUserId = result.user.id;

    return res.status(201).json({
      success: true,
      data: { accountId: result.account.id, userId: result.user.id, email: result.user.email },
    });
  } catch (err) {
    console.error('[setup/account]', err);
    return res.status(500).json({ success: false, error: 'Failed to create account.' });
  }
});

// ── POST /api/setup/email ────────────────────────────────────────────────────
// Step 2: configure email delivery.
// Body shapes:
//   { mock: true }                                            — use console mock
//   { mock: false, brevoApiKey: "xkeysib-…", emailFrom: "..." }   — use Brevo
//
// Mock path: sets process.env.EMAIL_MOCK=true so the running process bypasses
// the provider without needing a restart. The operator should also add
// EMAIL_MOCK=true to .env for persistence across restarts (the /complete
// success message reminds them).
//
// Real path: persists to account_settings keyed BREVO_API_KEY + EMAIL_FROM.
// We do NOT validate the key with a test call — that would require a verified
// sender domain to exist, which is exactly what the operator is setting up
// here. First real send attempt fails loudly if the key is wrong.
//
// Back-compat: pre-v0.6.x clients sent `resendApiKey`. We accept either field
// name so a partially-deployed cluster doesn't 400 on the legacy spelling.

router.post('/email', credentialLimiter, async (req, res) => {
  if (await _rejectIfConfigured(res)) return;
  if (!_wizardState.accountId) {
    return res.status(412).json({ success: false, error: 'Complete the account step first.' });
  }

  try {
    const { mock, brevoApiKey, resendApiKey, emailFrom } = req.body;
    const apiKey = brevoApiKey || resendApiKey;  // accept either spelling

    if (mock === true) {
      process.env.EMAIL_MOCK = 'true';
      _wizardState.emailDone = true;
      return res.json({ success: true, data: { mode: 'mock' } });
    }

    if (!apiKey || !emailFrom) {
      return res.status(400).json({
        success: false,
        error: 'brevoApiKey and emailFrom are required when mock is false.',
      });
    }

    // Persist to account_settings. Using upsert so re-running the step (e.g.
    // operator hits Back, fixes a typo) overwrites cleanly.
    await prisma.$transaction([
      prisma.accountSetting.upsert({
        where:  { accountId_key: { accountId: _wizardState.accountId, key: 'BREVO_API_KEY' } },
        update: { value: encryptIfNeeded(apiKey) },
        create: { accountId: _wizardState.accountId, key: 'BREVO_API_KEY', value: encryptIfNeeded(apiKey) },
      }),
      prisma.accountSetting.upsert({
        where:  { accountId_key: { accountId: _wizardState.accountId, key: 'EMAIL_FROM' } },
        update: { value: emailFrom },
        create: { accountId: _wizardState.accountId, key: 'EMAIL_FROM', value: emailFrom },
      }),
    ]);

    // CR-6 (audit-2 2026-05-22): use setRuntimeBrevoKey() instead of
    // process.env so the plaintext key is never written into the process env
    // where it could be leaked by env-dump endpoints or accidentally logged.
    // The module-level setter makes the key available to email.js for the
    // lifetime of this process; it is NOT persisted to disk.
    require('../lib/email').setRuntimeBrevoKey(apiKey);
    process.env.EMAIL_FROM     = emailFrom;
    process.env.EMAIL_MOCK     = 'false';

    _wizardState.emailDone = true;
    return res.json({ success: true, data: { mode: 'brevo' } });
  } catch (err) {
    console.error('[setup/email]', err);
    return res.status(500).json({ success: false, error: 'Failed to save email settings.' });
  }
});

// ── POST /api/setup/ai ───────────────────────────────────────────────────────
// Step 3: configure AI provider. Optional — operator can skip.
// Body shapes:
//   { skip: true }                                  — disables AI features
//   { skip: false, provider: "anthropic", apiKey }  — stores key in DB
//
// Skip path: sets AI_ENABLED=false for the running process. Operator should
// mirror to .env for persistence.
//
// Real path: stores in account_settings keyed AI_API_KEY (matches existing
// settings.js convention; verified at server/routes/settings.js:23). The key
// is encrypted at rest by the existing settings flow if the operator later
// edits via Settings UI — for the wizard we store plaintext to keep this
// endpoint simple, with a note in the response telling the operator to
// re-save via Settings to trigger encryption. (Future: add a wizard-specific
// encryption call here.)

router.post('/ai', credentialLimiter, async (req, res) => {
  if (await _rejectIfConfigured(res)) return;
  if (!_wizardState.accountId) {
    return res.status(412).json({ success: false, error: 'Complete the account step first.' });
  }

  try {
    const { skip, provider, apiKey } = req.body;

    if (skip === true) {
      process.env.AI_ENABLED = 'false';
      _wizardState.aiDone = true;
      return res.json({ success: true, data: { mode: 'disabled' } });
    }

    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: 'apiKey is required when skip is false.',
      });
    }

    const providerName = provider || 'anthropic';

    await prisma.$transaction([
      prisma.accountSetting.upsert({
        where:  { accountId_key: { accountId: _wizardState.accountId, key: 'AI_API_KEY' } },
        update: { value: encryptIfNeeded(apiKey) },
        create: { accountId: _wizardState.accountId, key: 'AI_API_KEY', value: encryptIfNeeded(apiKey) },
      }),
      prisma.accountSetting.upsert({
        where:  { accountId_key: { accountId: _wizardState.accountId, key: 'AI_PROVIDER' } },
        update: { value: providerName },
        create: { accountId: _wizardState.accountId, key: 'AI_PROVIDER', value: providerName },
      }),
    ]);

    // CR-6 (audit-2 2026-05-22): AI_API_KEY is encrypted in AccountSetting and
    // read per-request from the DB -- no need to put the plaintext key in process.env.
    process.env.AI_ENABLED  = 'true';
    process.env.AI_PROVIDER = providerName;

    _wizardState.aiDone = true;
    return res.json({
      success: true,
      data: {
        mode: 'enabled',
        provider: providerName,
        // Tell the SPA to nudge the operator to re-save via Settings for at-rest encryption
        encryptionNote: 'For at-rest encryption of this key, re-save it via Settings → AI after first login.',
      },
    });
  } catch (err) {
    console.error('[setup/ai]', err);
    return res.status(500).json({ success: false, error: 'Failed to save AI settings.' });
  }
});

// ── POST /api/setup/complete ─────────────────────────────────────────────────
// Step 4: mark setupCompletedAt and lock the wizard. Requires that /account
// has been called (email + ai are optional — operator can skip both).
// On success, the next request to ANY /api/* endpoint passes the gate.

router.post('/complete', credentialLimiter, async (req, res) => {
  if (await _rejectIfConfigured(res)) return;

  if (!_wizardState.accountId || !_wizardState.adminUserId) {
    return res.status(412).json({
      success: false,
      error: 'Account step has not been completed. Restart the wizard.',
    });
  }

  try {
    await prisma.instanceConfig.upsert({
      where: { id: 'singleton' },
      update: {
        setupCompletedAt: new Date(),
        setupCompletedBy: _wizardState.adminUserId,
      },
      create: {
        id:               'singleton',
        setupCompletedAt: new Date(),
        setupCompletedBy: _wizardState.adminUserId,
      },
    });

    invalidateInstanceConfigCache(); // (S8) immediate visibility — no 5s TTL wait

    const completedSteps: any = {
      account: true,
      email:   _wizardState.emailDone,
      ai:      _wizardState.aiDone,
    };

    _resetWizardState();

    return res.json({
      success: true,
      data: {
        completedSteps,
        // The SPA shows this as a footer note on the "Done" screen so the
        // operator knows what they still need to put in .env for restart-survival.
        persistenceNotes: [
          'EMAIL_MOCK and AI_ENABLED are mutated in process.env for this run only.',
          'Add them to server/.env to persist across restarts.',
          'BREVO_API_KEY and AI_API_KEY are stored in the database and survive restarts.',
        ],
      },
    });
  } catch (err) {
    console.error('[setup/complete]', err);
    return res.status(500).json({ success: false, error: 'Failed to finalise setup.' });
  }
});

module.exports = router;

export {};

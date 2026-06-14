/**
 * GET  /api/settings        — return current account settings (merged env + DB) — admin only (H2)
 * PUT  /api/settings        — save settings to DB (admin only)
 * POST /api/settings/test   — test AI connection with current or submitted settings
 *
 * Security changes (H1, H2):
 *   - AI_API_KEY is encrypted at rest using AES-256-GCM (lib/crypto.js).
 *   - GET /api/settings now requires admin role (H2).
 *   - maskKey replaced with full 8-dot mask; admin-only _apiKeyPreview added (H2).
 */

const express    = require('express');
const router     = express.Router();
const { requireAdmin } = require('../middleware/roles');
import prisma from '../lib/prisma';
const { encryptIfNeeded, decryptIfEncrypted, isEncrypted } = require('../lib/crypto');
const { normalizeEvalLeadTimes, DEFAULT_EVAL_LEAD_TIMES } = require('../utils/dates'); // #28 configurable evaluation lead times

// v0.68.0 (audit Medium): pattern-match key names that look sensitive and
// auto-encrypt their values on write. The ENCRYPTED_KEYS allowlist below
// stays as the explicit primary path; this regex is a secondary gate so
// future authors don't have to remember to add a new *_API_KEY / *_SECRET
// to the allowlist for it to be encrypted at rest.
const _AUTO_ENCRYPT_PATTERN = /(_API_KEY|_SECRET|_TOKEN|_PASSWORD|_WEBHOOK_URL)$/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

const SETTING_KEYS = [
  'AI_ENABLED',
  'AI_PROVIDER',
  'AI_API_KEY',
  'AI_MODEL',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_API_VERSION',
  // Storage
  'STORAGE_PROVIDER',
  'STORAGE_PATH',
  // Onboarding
  'ONBOARDING_COMPLETE',
  // Freemium
  'AI_INGEST_LIMIT',   // admin-overridable per-account limit (default 10)
  // Account preferences
  'FISCAL_YEAR_START_MONTH', // 1-12; 1 = January (calendar year default)
  // #12: roles permitted to reveal sensitive field values. JSON array string.
  // Default ["admin","manager"]; admin can never be removed (server-enforced).
  'LICENSE_REVEAL_ROLES',
  // #28: per-account evaluation lead-time model (value-tier breakpoints +
  // days-back + no-value default). JSON object string; drives the server
  // calculateEvaluationStartByDate and the client urgency model in lockstep.
  'EVALUATION_LEAD_TIMES',
  // Password policy (applied to reset-password and accept-invite flows)
  'PASSWORD_MIN_LENGTH',       // integer, default 12
  'PASSWORD_REQUIRE_NUMBER',   // 'true'|'false', default 'true'
  'PASSWORD_REQUIRE_SPECIAL',  // 'true'|'false', default 'true'
  // Slack integration (per-account incoming webhook for alert digests)
  'SLACK_ENABLED',             // 'true'|'false', default 'false'
  'SLACK_WEBHOOK_URL',         // encrypted at rest; must start with hooks.slack.com/services/
  // Microsoft Teams integration (per-account incoming webhook for alert digests)
  'TEAMS_ENABLED',             // 'true'|'false', default 'false'
  'TEAMS_WEBHOOK_URL',         // encrypted at rest; restricted to outlook.office(365)?.com + *.webhook.office.com
  // v0.66.0 per-role daily AI-call caps. Sum-across-all-actions limit per
  // user, applied alongside the existing per-action caps (lowest cap wins).
  // Lower-case keys to match aiQuota.js getAccountRoleCapOverride lookup
  // (it reads ai_cap_role_<role>). Empty string or unset = use built-in
  // default from aiQuota.ROLE_DEFAULTS. Value '-1' = clear override.
  // Defaults (admin=unlimited, manager=100, consultant=50, viewer=20).
  'ai_cap_role_admin',
  'ai_cap_role_manager',
  'ai_cap_role_consultant',
  'ai_cap_role_viewer',
];

// Setting keys whose values are encrypted at rest. Both AI_API_KEY and the
// Slack webhook URL are credentials — anyone with the URL can post into the
// channel — so they're treated identically here.
const ENCRYPTED_KEYS = new Set(['AI_API_KEY', 'SLACK_WEBHOOK_URL', 'TEAMS_WEBHOOK_URL']);

function envDefaults() {
  return {
    AI_ENABLED:              process.env.AI_ENABLED !== 'false' ? 'true' : 'false',
    AI_PROVIDER:             process.env.AI_PROVIDER || 'anthropic',
    AI_API_KEY:              process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    AI_MODEL:                process.env.AI_MODEL || '',
    AZURE_OPENAI_ENDPOINT:   process.env.AZURE_OPENAI_ENDPOINT || '',
    AZURE_OPENAI_DEPLOYMENT: process.env.AZURE_OPENAI_DEPLOYMENT || '',
    AZURE_API_VERSION:       process.env.AZURE_API_VERSION || '2024-02-01',
    STORAGE_PROVIDER:        process.env.STORAGE_PROVIDER || 'local',
    STORAGE_PATH:            process.env.STORAGE_PATH || '',
    ONBOARDING_COMPLETE:     '',
    LICENSE_REVEAL_ROLES:    process.env.LICENSE_REVEAL_ROLES || '["admin","manager"]',
    EVALUATION_LEAD_TIMES:   process.env.EVALUATION_LEAD_TIMES || JSON.stringify(DEFAULT_EVAL_LEAD_TIMES),
    SLACK_ENABLED:           process.env.SLACK_ENABLED === 'true' ? 'true' : 'false',
    SLACK_WEBHOOK_URL:       process.env.SLACK_WEBHOOK_URL || '',
    TEAMS_ENABLED:           process.env.TEAMS_ENABLED === 'true' ? 'true' : 'false',
    TEAMS_WEBHOOK_URL:       process.env.TEAMS_WEBHOOK_URL || '',
    // v0.66.0 per-role caps. Empty = no override; aiQuota falls back to
    // built-in defaults. Operators can also set env AI_DAILY_CAP_PER_USER_ROLE_<ROLE>.
    ai_cap_role_admin:       process.env.AI_DAILY_CAP_PER_USER_ROLE_ADMIN || '',
    ai_cap_role_manager:     process.env.AI_DAILY_CAP_PER_USER_ROLE_MANAGER || '',
    ai_cap_role_consultant:  process.env.AI_DAILY_CAP_PER_USER_ROLE_CONSULTANT || '',
    ai_cap_role_viewer:      process.env.AI_DAILY_CAP_PER_USER_ROLE_VIEWER || '',
  };
}

async function loadDbSettings(accountId) {
  const rows = await prisma.accountSetting.findMany({ where: { accountId } });
  const db: any = {};
  for (const r of rows) db[r.key] = r.value;
  return db;
}

/**
 * Merge env defaults with DB rows. AI_API_KEY from DB is decrypted here so the
 * rest of the code works with plaintext throughout the request lifecycle.
 * Encryption only happens at the storage boundary (PUT handler).
 */
function mergeSettings(envDefs, dbRows) {
  const merged: any = { ...envDefs };
  for (const key of SETTING_KEYS) {
    if (dbRows[key] !== undefined && dbRows[key] !== '') {
      // Decrypt at the storage boundary so the rest of the request
      // works in plaintext. Plaintext-on-disk values (legacy rows) pass
      // through unchanged thanks to decryptIfEncrypted's sentinel check.
      if (ENCRYPTED_KEYS.has(key)) {
        merged[key] = decryptIfEncrypted(dbRows[key]);
      } else {
        merged[key] = dbRows[key];
      }
    }
  }
  return merged;
}

/**
 * Full 8-dot mask for API key sent to client (H2).
 * Returns '' if no key is set.
 */
function maskKey(val) {
  if (!val) return '';
  return '•'.repeat(8);
}

/**
 * Admin-only preview: "sk-…XXXX" (last 4 chars of the plaintext key).
 * Only shown to admins. Provides just enough for "does this look right?"
 * without leaking meaningful entropy.
 */
function apiKeyPreview(val) {
  if (!val || val.length < 4) return null;
  return 'sk-…' + val.slice(-4);
}

/**
 * Slack webhook preview: shows the workspace ID prefix and last 4 chars of
 * the secret token. Slack URLs look like
 *   https://hooks.slack.com/services/T012345/B098765/abc...xyz
 * so the preview is "…/T012345/…XYZ" — recognisable to the admin who set it,
 * not enough to reconstruct.
 */
function slackUrlPreview(val) {
  if (!val) return null;
  try {
    const u = new URL(val);
    const parts = u.pathname.split('/').filter(Boolean); // ['services','T...','B...','token']
    if (parts.length < 4) return null;
    const team = parts[1];
    const tail = parts[3].slice(-4);
    return `…/${team}/…${tail}`;
  } catch {
    return null;
  }
}

/**
 * Teams webhook preview. Teams URLs vary in shape:
 *   - Legacy:  https://outlook.office.com/webhook/<guid>@<tenant>/IncomingWebhook/<id>/<token>
 *   - New:     https://<tenant>.webhook.office.com/webhookb2/<guid>@<tenant>/IncomingWebhook/<id>/<token>
 * Show "<host> · …<last 4 of last segment>" so the admin who set it can
 * recognise it without leaking enough to reconstruct.
 */
function teamsUrlPreview(val) {
  if (!val) return null;
  try {
    const u = new URL(val);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || '';
    const tail = last.slice(-4);
    return `${u.hostname} · …${tail}`;
  } catch {
    return null;
  }
}

// ── GET /api/settings — admin only (H2) ──────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
  try {
    const dbRows  = await loadDbSettings(req.user.accountId);
    // merged.AI_API_KEY is plaintext after mergeSettings decrypts it
    const merged  = mergeSettings(envDefaults(), dbRows);
    const hasDbKey  = !!(dbRows['AI_API_KEY'] && dbRows['AI_API_KEY'].length > 0);
    const hasEnvKey = !!(process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || (process.env.CF_WORKERS_AI_API_KEY && process.env.CF_WORKERS_AI_ACCOUNT_ID) || process.env.GROQ_API_KEY || process.env.HF_TOKEN);

    // aiBriefEnabled is a real Account column, not a KV setting (gates the
    // AI maintenance recommendation + NFPA compliance summary features).
    // Fetch it alongside the AccountSetting rows so the AI tab can render
    // the toggle. Surface as camelCase `aiBriefEnabled` to make clear it's
    // NOT one of the SETTING_KEYS (env-overridable string KV values).
    const accountRow = await prisma.account.findUnique({
      where:  { id: req.user.accountId },
      select: { aiBriefEnabled: true, fteCount: true },
    });
    const aiBriefEnabled = !!accountRow?.aiBriefEnabled;
    // v0.58.1: surface fteCount alongside the AI-brief toggle. Same Account-column source.
    const fteCount = accountRow?.fteCount ?? null;

    // v0.18.0: opt-in upstream feedback sync. Stored as AccountSetting
    // key 'ai_feedback_upstream_enabled' = 'true'|'false'. Surfaced as
    // boolean so the React toggle can bind directly.
    const aiFeedbackUpstreamEnabled = dbRows['ai_feedback_upstream_enabled'] === 'true';

    // #16: auto-email the leave-behind PDF to account contacts on WO completion.
    // AccountSetting KV 'auto_send_leave_behind' = 'true'|'false'; default off.
    const autoSendLeaveBehind = dbRows['auto_send_leave_behind'] === 'true';

    // #30: customer-side weekly digest + quarterly CFO report opt-ins.
    const customerWeeklyDigest = dbRows['customer_weekly_digest'] === 'true';
    const customerQuarterlyCfo = dbRows['customer_quarterly_cfo'] === 'true';

    // Ingest usage (for admin display and freemium metering)
    const ingestCount = parseInt(dbRows['AI_INGEST_COUNT'] || '0', 10);
    const ingestLimit = parseInt(dbRows['AI_INGEST_LIMIT'] || '10', 10);

    const plaintextKey = merged.AI_API_KEY;
    const plaintextSlack = merged.SLACK_WEBHOOK_URL;
    const hasDbSlack  = !!(dbRows['SLACK_WEBHOOK_URL'] && dbRows['SLACK_WEBHOOK_URL'].length > 0);
    const hasEnvSlack = !!process.env.SLACK_WEBHOOK_URL;
    const plaintextTeams = merged.TEAMS_WEBHOOK_URL;
    const hasDbTeams  = !!(dbRows['TEAMS_WEBHOOK_URL'] && dbRows['TEAMS_WEBHOOK_URL'].length > 0);
    const hasEnvTeams = !!process.env.TEAMS_WEBHOOK_URL;

    res.json({
      success: true,
      data: {
        ...merged,
        // Never send plaintext key to client
        AI_API_KEY:        maskKey(plaintextKey),
        // Admin-only partial preview to let them verify "does this look like my key"
        _apiKeyPreview:    apiKeyPreview(plaintextKey),
        _apiKeySet:        hasDbKey || hasEnvKey,
        _apiKeyFromDb:     hasDbKey,
        // Convenience flag: AI is enabled AND a key is actually configured.
        _aiConfigured:     (merged.AI_ENABLED === 'true') && (hasDbKey || hasEnvKey),
        ONBOARDING_COMPLETE: dbRows['ONBOARDING_COMPLETE'] === 'true',
        // Freemium metering
        _ingestCount: ingestCount,
        _ingestLimit: ingestLimit,
        // Slack integration. Webhook URL is masked the same way the API key
        // is — anyone with it can post into the channel. _slackConfigured
        // tells the UI whether the toggle has a real URL behind it.
        SLACK_WEBHOOK_URL: maskKey(plaintextSlack),
        _slackPreview:     plaintextSlack ? slackUrlPreview(plaintextSlack) : null,
        _slackSet:         hasDbSlack || hasEnvSlack,
        _slackConfigured:  (merged.SLACK_ENABLED === 'true') && (hasDbSlack || hasEnvSlack),
        // Teams integration mirrors Slack — same masked-placeholder
        // round-trip and same preview/set/configured booleans.
        TEAMS_WEBHOOK_URL: maskKey(plaintextTeams),
        _teamsPreview:     plaintextTeams ? teamsUrlPreview(plaintextTeams) : null,
        _teamsSet:         hasDbTeams || hasEnvTeams,
        _teamsConfigured:  (merged.TEAMS_ENABLED === 'true') && (hasDbTeams || hasEnvTeams),
        // Per-account AI maintenance-brief toggle (real Account column,
        // not a KV setting). Default false on self-host; demo seed flips
        // this to true.
        aiBriefEnabled,
        // v0.58.1: per-tenant total headcount (Account column). Drives cost-per-employee KPIs.
        fteCount,
        // v0.18.0: opt-in upstream feedback sync (AccountSetting KV).
        aiFeedbackUpstreamEnabled,
        // #16: auto-send leave-behind on WO completion (AccountSetting KV).
        autoSendLeaveBehind,
        // #30: customer digest + CFO report opt-ins (AccountSetting KV).
        customerWeeklyDigest,
        customerQuarterlyCfo,
      },
    });
  } catch (err) {
    console.error('GET /settings:', err);
    res.status(500).json({ success: false, error: 'Failed to load settings' });
  }
});

// ── PUT /api/settings ─────────────────────────────────────────────────────────
// Most settings require admin. ONBOARDING_COMPLETE can be set by any user so
// the wizard dismiss works regardless of role.

const ADMIN_ONLY_KEYS = new Set(SETTING_KEYS.filter(k => k !== 'ONBOARDING_COMPLETE'));

router.put('/', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';

    // #12: normalize LICENSE_REVEAL_ROLES to a clean JSON array of valid roles,
    // always including admin so an account can't lock every admin out of reveal.
    if (req.body && req.body.LICENSE_REVEAL_ROLES !== undefined) {
      let roles;
      try { roles = JSON.parse(req.body.LICENSE_REVEAL_ROLES); } catch { roles = null; }
      if (!Array.isArray(roles)) roles = ['admin', 'manager'];
      roles = roles.filter((r) => ['admin', 'manager', 'viewer', 'consultant'].includes(r));
      if (!roles.includes('admin')) roles.unshift('admin');
      req.body.LICENSE_REVEAL_ROLES = JSON.stringify(roles);
    }

    // #28: normalize EVALUATION_LEAD_TIMES to a clean, validated config so a
    // malformed payload can never corrupt the computed evaluationStartByDate.
    if (req.body && req.body.EVALUATION_LEAD_TIMES !== undefined) {
      let cfg;
      try { cfg = JSON.parse(req.body.EVALUATION_LEAD_TIMES); } catch { cfg = null; }
      req.body.EVALUATION_LEAD_TIMES = JSON.stringify(normalizeEvalLeadTimes(cfg));
    }

    const allowed = new Set(SETTING_KEYS);

    const updates = Object.entries<any>(req.body).filter(([k, v]) => {
      if (!allowed.has(k) || v === undefined) return false;
      if (ADMIN_ONLY_KEYS.has(k) && !isAdmin) return false;
      return true;
    });

    // Phase 4: aiBriefEnabled is a real Account column. Admin-only,
    // handled separately from the KV settings branch since it doesn't
    // share the upsert path. Accept Boolean, 'true', 'false' to match
    // the Slack/Teams style toggle handling.
    let aiBriefEnabledUpdate = null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'aiBriefEnabled') && isAdmin) {
      const v = req.body.aiBriefEnabled;
      const coerced = (v === true || v === 'true');
      aiBriefEnabledUpdate = coerced;
    }

    // Phase 4: aiConsentSilenced is a per-USER User column — every
    // authenticated user can manage their own "don't ask me each
    // session" preference, NOT admin-gated.
    let aiConsentSilencedUpdate = null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'aiConsentSilenced')) {
      const v = req.body.aiConsentSilenced;
      aiConsentSilencedUpdate = (v === true || v === 'true');
    }

    // v0.58.0: fteCount - admin-only Account column. Drives cost-per-employee
    // KPI in the Reports hub. Accepts null/empty (unset), 0..1_000_000.
    let fteCountUpdate = null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'fteCount') && isAdmin) {
      const v = req.body.fteCount;
      if (v === null || v === '' || v === undefined) {
        fteCountUpdate = { set: null };
      } else {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n >= 0 && n <= 1000000) {
          fteCountUpdate = { set: n };
        }
      }
    }

    // v0.18.0: aiFeedbackUpstreamEnabled — admin-only AccountSetting KV.
    // Controls whether this instance opts in to anonymous upstream feedback sync.
    let aiFeedbackUpstreamUpdate = null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'aiFeedbackUpstreamEnabled') && isAdmin) {
      const v = req.body.aiFeedbackUpstreamEnabled;
      aiFeedbackUpstreamUpdate = (v === true || v === 'true');
    }

    // #16: auto-send leave-behind toggle — admin-only AccountSetting KV.
    let autoSendLeaveBehindUpdate = null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'autoSendLeaveBehind') && isAdmin) {
      const v = req.body.autoSendLeaveBehind;
      autoSendLeaveBehindUpdate = (v === true || v === 'true');
    }

    // #30: customer weekly digest + quarterly CFO opt-ins — admin-only KV.
    let customerWeeklyDigestUpdate = null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'customerWeeklyDigest') && isAdmin) {
      const v = req.body.customerWeeklyDigest;
      customerWeeklyDigestUpdate = (v === true || v === 'true');
    }
    let customerQuarterlyCfoUpdate = null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'customerQuarterlyCfo') && isAdmin) {
      const v = req.body.customerQuarterlyCfo;
      customerQuarterlyCfoUpdate = (v === true || v === 'true');
    }

    if (updates.length === 0 && aiBriefEnabledUpdate === null && aiConsentSilencedUpdate === null && aiFeedbackUpstreamUpdate === null && autoSendLeaveBehindUpdate === null && customerWeeklyDigestUpdate === null && customerQuarterlyCfoUpdate === null && fteCountUpdate === null) {
      return res.status(400).json({ success: false, error: 'No valid settings provided' });
    }

    // Skip masked placeholder values (client sends '••••••••' meaning "keep existing")
    const isMasked = (v) => typeof v === 'string' && /^[•]+$/.test(v);

    // Reject malformed Slack webhook URLs at write time. This is the SSRF
    // gate — without it, an admin (or an attacker who has compromised an
    // admin) could point the webhook at internal services. Empty string is
    // allowed because the UI uses it to clear the setting.
    const writableUpdates = updates.filter(([, value]) => !isMasked(String(value)));
    const slackEntry = writableUpdates.find(([k]) => k === 'SLACK_WEBHOOK_URL');
    if (slackEntry && slackEntry[1] !== '' && slackEntry[1] != null) {
      const { isValidSlackWebhookUrl } = require('../lib/slack');
      if (!isValidSlackWebhookUrl(String(slackEntry[1]))) {
        return res.status(400).json({
          success: false,
          error: 'SLACK_WEBHOOK_URL must be a https://hooks.slack.com/services/… URL.',
        });
      }
    }

    // Teams URL SSRF gate — same shape as the Slack check above.
    const teamsEntry = writableUpdates.find(([k]) => k === 'TEAMS_WEBHOOK_URL');
    if (teamsEntry && teamsEntry[1] !== '' && teamsEntry[1] != null) {
      const { isValidTeamsWebhookUrl } = require('../lib/teams');
      if (!isValidTeamsWebhookUrl(String(teamsEntry[1]))) {
        return res.status(400).json({
          success: false,
          error: 'TEAMS_WEBHOOK_URL must be an https://outlook.office(365)?.com/webhook/… or https://*.webhook.office.com/webhookb2/… URL.',
        });
      }
    }

    await prisma.$transaction(
      writableUpdates
        .map(([key, value]) => {
          // Encrypt at-rest credentials. v0.69.0 (audit Medium "Secrets &
          // Config Guardian"): the explicit ENCRYPTED_KEYS allowlist remains
          // the primary path, but we ALSO check the auto-encrypt regex
          // (_AUTO_ENCRYPT_PATTERN from v0.68.2) so a future author who adds
          // a *_API_KEY / *_SECRET / *_TOKEN / *_PASSWORD / *_WEBHOOK_URL
          // setting key doesn't have to remember to update the allowlist.
          let storedValue = String(value);
          const shouldEncrypt = storedValue && (
            ENCRYPTED_KEYS.has(key) ||
            (typeof _AUTO_ENCRYPT_PATTERN !== 'undefined' && _AUTO_ENCRYPT_PATTERN.test(key))
          );
          if (shouldEncrypt) {
            storedValue = encryptIfNeeded(storedValue);
          }
          return prisma.accountSetting.upsert({
            where:  { accountId_key: { accountId: req.user.accountId, key } },
            update: { value: storedValue },
            create: { accountId: req.user.accountId, key, value: storedValue },
          });
        })
    );

    // Phase 4: handle the per-account aiBriefEnabled column update.
    // Only runs when the body included a value AND the caller is admin
    // (the earlier filter sets aiBriefEnabledUpdate=null otherwise).
    // Audited via Activity Log so a toggle change is traceable (mirrors
    // the customField audit pattern).
    if (aiBriefEnabledUpdate !== null) {
      const before = await prisma.account.findUnique({
        where:  { id: req.user.accountId },
        select: { aiBriefEnabled: true },
      });
      if (before?.aiBriefEnabled !== aiBriefEnabledUpdate) {
        await prisma.account.update({
          where: { id: req.user.accountId },
          data:  { aiBriefEnabled: aiBriefEnabledUpdate },
        });
        try {
          const { writeLog: writeActivityLog } = require('../lib/activityLog');
          writeActivityLog({
            userId:  req.user.id,
            action:  'ai_setting_changed',
            details: {
              setting: 'aiBriefEnabled',
              from:    !!before?.aiBriefEnabled,
              to:      aiBriefEnabledUpdate,
            },
          });
        } catch (logErr) {
          console.error('activity log error (aiBriefEnabled toggle):', logErr);
        }
      }
    }

    // Phase 4: per-user aiConsentSilenced update. No audit log entry — it's
    // a user-facing preference, not a security-relevant policy change. Quiet
    // saving avoids ActivityLog noise on a setting people may toggle often.
    if (aiConsentSilencedUpdate !== null) {
      await prisma.user.update({
        where: { id: req.user.id },
        data:  { aiConsentSilenced: aiConsentSilencedUpdate },
      });
    }

    // v0.18.0: persist upstream feedback opt-in flag as AccountSetting KV.
    if (aiFeedbackUpstreamUpdate !== null) {
      const key = 'ai_feedback_upstream_enabled';
      await prisma.accountSetting.upsert({
        where:  { accountId_key: { accountId: req.user.accountId, key } },
        update: { value: String(aiFeedbackUpstreamUpdate) },
        create: { accountId: req.user.accountId, key, value: String(aiFeedbackUpstreamUpdate) },
      });
    }

    // #16: persist auto-send-leave-behind toggle as AccountSetting KV.
    if (autoSendLeaveBehindUpdate !== null) {
      const key = 'auto_send_leave_behind';
      await prisma.accountSetting.upsert({
        where:  { accountId_key: { accountId: req.user.accountId, key } },
        update: { value: String(autoSendLeaveBehindUpdate) },
        create: { accountId: req.user.accountId, key, value: String(autoSendLeaveBehindUpdate) },
      });
    }

    // #30: persist customer digest + CFO report opt-ins as AccountSetting KV.
    if (customerWeeklyDigestUpdate !== null) {
      const key = 'customer_weekly_digest';
      await prisma.accountSetting.upsert({
        where:  { accountId_key: { accountId: req.user.accountId, key } },
        update: { value: String(customerWeeklyDigestUpdate) },
        create: { accountId: req.user.accountId, key, value: String(customerWeeklyDigestUpdate) },
      });
    }
    if (customerQuarterlyCfoUpdate !== null) {
      const key = 'customer_quarterly_cfo';
      await prisma.accountSetting.upsert({
        where:  { accountId_key: { accountId: req.user.accountId, key } },
        update: { value: String(customerQuarterlyCfoUpdate) },
        create: { accountId: req.user.accountId, key, value: String(customerQuarterlyCfoUpdate) },
      });
    }

    // v0.58.0: persist fteCount on the Account column. Admin-only, audited.
    if (fteCountUpdate !== null) {
      const before = await prisma.account.findUnique({
        where:  { id: req.user.accountId },
        select: { fteCount: true },
      });
      if (before?.fteCount !== fteCountUpdate.set) {
        await prisma.account.update({
          where: { id: req.user.accountId },
          data:  { fteCount: fteCountUpdate.set },
        });
        try {
          const { writeLog: writeActivityLog } = require('../lib/activityLog');
          writeActivityLog({
            userId:  req.user.id,
            action:  'account_setting_changed',
            details: { setting: 'fteCount', from: before?.fteCount ?? null, to: fteCountUpdate.set },
          });
        } catch (logErr) {
          console.error('activity log error (fteCount):', logErr);
        }
      }
    }

    res.json({ success: true, message: 'Settings saved' });
  } catch (err) {
    console.error('PUT /settings:', err);
    res.status(500).json({ success: false, error: 'Failed to save settings' });
  }
});

// ── POST /api/settings/test ───────────────────────────────────────────────────

router.post('/test', requireAdmin, async (req, res) => {
  try {
    const dbRows = await loadDbSettings(req.user.accountId);
    // mergeSettings decrypts AI_API_KEY from DB — plaintext available here
    const base   = mergeSettings(envDefaults(), dbRows);

    // If the client sends the masked placeholder don't use it — keep the stored value
    const isMasked = (v) => !v || /^[•]+$/.test(v);

    const submitted = req.body || {};
    const testSettings: any = {
      provider:        submitted.AI_PROVIDER        || base.AI_PROVIDER || 'anthropic',
      apiKey:          isMasked(submitted.AI_API_KEY) ? base.AI_API_KEY : submitted.AI_API_KEY,
      model:           submitted.AI_MODEL           || base.AI_MODEL    || undefined,
      azureEndpoint:   submitted.AZURE_OPENAI_ENDPOINT   || base.AZURE_OPENAI_ENDPOINT,
      azureDeployment: submitted.AZURE_OPENAI_DEPLOYMENT || base.AZURE_OPENAI_DEPLOYMENT,
      azureApiVersion: submitted.AZURE_API_VERSION        || base.AZURE_API_VERSION,
    };

    const { complete } = require('../lib/ai');
    const result = await complete({
      system:    'You are a helpful assistant.',
      user:      'Reply with exactly: "Connection successful"',
      maxTokens: 20,
      settings:  testSettings,
    });

    res.json({ success: true, message: result.text.trim() });
  } catch (err) {
    console.error('POST /settings/test:', err.message);
    const safeMsg = (err.message || 'AI connection test failed').split('\n')[0].slice(0, 200);
    res.status(400).json({ success: false, error: safeMsg }); // (L5)
  }
});


// ── POST /api/settings/slack/test ─────────────────────────────────────────────
// Sends a one-shot test message to the configured Slack webhook. Admin only.
// If the request body includes SLACK_WEBHOOK_URL, that URL is used (this is
// how the UI lets an admin verify a freshly-pasted URL before saving). If
// the body URL is the masked placeholder OR omitted, the saved DB value is
// used. Either way the URL is run through isValidSlackWebhookUrl() before
// any network call so the test endpoint can't be turned into an SSRF probe.
router.post('/slack/test', requireAdmin, async (req, res) => {
  try {
    const { sendSlackMessage, buildTestMessage, isValidSlackWebhookUrl } = require('../lib/slack');

    const isMasked = (v) => !v || /^[•]+$/.test(v);

    let webhookUrl = req.body?.SLACK_WEBHOOK_URL;
    if (isMasked(webhookUrl)) {
      const dbRows = await loadDbSettings(req.user.accountId);
      const merged = mergeSettings(envDefaults(), dbRows);
      webhookUrl = merged.SLACK_WEBHOOK_URL;
    }

    if (!webhookUrl || !isValidSlackWebhookUrl(webhookUrl)) {
      return res.status(400).json({
        success: false,
        error: 'No valid Slack webhook URL configured. Paste a https://hooks.slack.com/services/… URL.',
      });
    }

    const account = await prisma.account.findUnique({
      where:  { id: req.user.accountId },
      select: { companyName: true },
    });

    const { text, blocks } = buildTestMessage({
      accountName: account?.companyName || 'ServiceCycle',
      byUserName:  req.user.name || req.user.email || 'an admin',
    });

    const result = await sendSlackMessage({ webhookUrl, text, blocks });
    if (!result.ok) {
      return res.status(400).json({
        success: false,
        error: `Slack delivery failed: ${result.reason || 'unknown'}`,
      });
    }

    return res.json({ success: true, message: 'Test message delivered to Slack.' });
  } catch (err) {
    console.error('[settings/slack/test]', err);
    return res.status(500).json({ success: false, error: 'Failed to send Slack test message.' });
  }
});

// ── POST /api/settings/teams/test ─────────────────────────────────────────────
// Mirror of /slack/test for Microsoft Teams. Same masked-placeholder rule:
// the body URL is preferred when the admin has just edited it; otherwise the
// stored DB value is used. Always re-validated through isValidTeamsWebhookUrl
// before any network call so this endpoint can't be turned into an SSRF probe.
router.post('/teams/test', requireAdmin, async (req, res) => {
  try {
    const { sendTeamsMessage, buildTestMessage, isValidTeamsWebhookUrl } = require('../lib/teams');

    const isMasked = (v) => !v || /^[•]+$/.test(v);

    let webhookUrl = req.body?.TEAMS_WEBHOOK_URL;
    if (isMasked(webhookUrl)) {
      const dbRows = await loadDbSettings(req.user.accountId);
      const merged = mergeSettings(envDefaults(), dbRows);
      webhookUrl = merged.TEAMS_WEBHOOK_URL;
    }

    if (!webhookUrl || !isValidTeamsWebhookUrl(webhookUrl)) {
      return res.status(400).json({
        success: false,
        error: 'No valid Teams webhook URL configured. Paste a Microsoft-hosted incoming webhook URL.',
      });
    }

    const account = await prisma.account.findUnique({
      where:  { id: req.user.accountId },
      select: { companyName: true },
    });

    const card = buildTestMessage({
      accountName: account?.companyName || 'ServiceCycle',
      byUserName:  req.user.name || req.user.email || 'an admin',
    });

    const result = await sendTeamsMessage({ webhookUrl, card });
    if (!result.ok) {
      return res.status(400).json({
        success: false,
        error: `Teams delivery failed: ${result.reason || 'unknown'}`,
      });
    }

    return res.json({ success: true, message: 'Test message delivered to Teams.' });
  } catch (err) {
    console.error('[settings/teams/test]', err);
    return res.status(500).json({ success: false, error: 'Failed to send Teams test message.' });
  }
});

// ── GET /api/settings/public — no admin required ─────────────────────────────
// Returns non-sensitive account preferences that any authenticated user needs
// (e.g. fiscal year start month for calendar views on the assets page).

router.get('/public', async (req, res) => {
  try {
    const rows = await prisma.accountSetting.findMany({
      where: { accountId: req.user.accountId, key: { in: ['FISCAL_YEAR_START_MONTH', 'ONBOARDING_COMPLETE', 'PASSWORD_MIN_LENGTH'] } },
    });
    const db: any = {};
    for (const r of rows) db[r.key] = r.value;
    res.json({
      success: true,
      data: {
        fiscalYearStartMonth: parseInt(db['FISCAL_YEAR_START_MONTH'] || '1', 10),
        onboardingComplete: db['ONBOARDING_COMPLETE'] === 'true',
        passwordMinLength: parseInt(db['PASSWORD_MIN_LENGTH'] || '12', 10),
      },
    });
  } catch (err) {
    console.error('GET /settings/public:', err);
    res.status(500).json({ success: false, error: 'Failed to load account settings' });
  }
});

// ── GET /api/settings/export — full account data ZIP (admin only) ─────────────
// Streams a ZIP containing:
//   assets.csv         — all assets in spreadsheet-ready format
//   assets.json        — full asset data with site/schedule info
//   contractors.json   — all contractors
//   activity_log.json  — last 5,000 activity entries
//   documents.json     — document manifest (filenames, types — not the files themselves)
//   export_info.json   — account metadata and export timestamp

const archiver = require('archiver');

router.get('/export', requireAdmin, async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const exportedAt = new Date().toISOString();
    const dateSlug = exportedAt.split('T')[0];

    // ── Fetch all account data in parallel ─────────────────────────────────
    const [account, assets, contractors, activityLogs, documents] = await Promise.all([
      prisma.account.findUnique({
        where: { id: accountId },
        select: { id: true, companyName: true, planType: true, createdAt: true },
      }),
      prisma.asset.findMany({
        where:   { accountId },
        orderBy: { createdAt: 'asc' },
        include: {
          site:     { select: { id: true, name: true } },
          position: { select: { id: true, name: true, code: true } },
          schedules: {
            where:   { isActive: true },
            select:  {
              id: true, nextDueDate: true, lastCompletedDate: true,
              taskDefinition: { select: { taskName: true, taskCode: true } },
            },
            orderBy: { nextDueDate: 'asc' },
          },
        },
      }),
      prisma.contractor.findMany({
        where:   { accountId },
        orderBy: { name: 'asc' },
        select: {
          id: true, name: true, netaAccredited: true,
          supportEmail: true, supportPhone: true, supportPortalUrl: true,
          portalUrl: true, scoreSupport: true, scoreSatisfaction: true,
          notes: true, createdAt: true,
        },
      }),
      prisma.activityLog.findMany({
        where:   { accountId },
        orderBy: { createdAt: 'desc' },
        take:    5000,
        include: { user: { select: { name: true, email: true } } },
      }),
      prisma.document.findMany({
        where:   { accountId },
        orderBy: { uploadedAt: 'desc' },
        select: {
          id: true, filename: true, fileType: true, encrypted: true,
          uploadedBy: true, uploadedAt: true, assetId: true, workOrderId: true,
        },
      }),
    ]);

    // ── Build CSV for assets ────────────────────────────────────────────────
    const CSV_HEADERS = [
      'Site','Equipment Type','Manufacturer','Model','Serial Number',
      'Position','Governing Condition','Physical','Criticality','Environment',
      'In Service','Energized','Install Date','Next Due','Notes',
    ];

    function csvVal(v) {
      if (v == null) return '';
      let s = String(v);
      if (/^\s*[=+\-@\t\r]/.test(s)) s = "'" + s; // H6: formula injection guard
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    }
    function fmtDate(d) { return d ? new Date(d).toISOString().split('T')[0] : ''; }

    // Earliest active-schedule due date = the asset's "next due" for list views.
    function earliestNextDue(a) {
      const dates = (a.schedules || [])
        .map(s => s.nextDueDate)
        .filter(Boolean)
        .map(d => new Date(d).getTime())
        .filter(t => !Number.isNaN(t));
      return dates.length > 0 ? new Date(Math.min(...dates)) : null;
    }

    const csvRows = assets.map(a => [
      a.site?.name,
      a.equipmentType,
      a.manufacturer,
      a.model,
      a.serialNumber,
      a.position?.code || a.position?.name,
      a.governingCondition,
      a.conditionPhysical,
      a.conditionCriticality,
      a.conditionEnvironment,
      a.inService ? 'Yes' : 'No',
      a.isEnergized ? 'Yes' : 'No',
      fmtDate(a.installDate),
      fmtDate(earliestNextDue(a)),
      a.notes,
    ].map(csvVal).join(','));

    const assetsCsv = [CSV_HEADERS.join(','), ...csvRows].join('\n');

    // ── Strip sensitive fields from JSON exports ────────────────────────────
    const assetsJson = assets.map(a => ({
      id: a.id, equipmentType: a.equipmentType,
      site: a.site, position: a.position,
      manufacturer: a.manufacturer, model: a.model, serialNumber: a.serialNumber,
      nameplateData: a.nameplateData,
      installDate: a.installDate, lastCommissionedDate: a.lastCommissionedDate,
      conditionPhysical: a.conditionPhysical,
      conditionCriticality: a.conditionCriticality,
      conditionEnvironment: a.conditionEnvironment,
      governingCondition: a.governingCondition,
      inService: a.inService, isEnergized: a.isEnergized,
      nextDueDate: earliestNextDue(a),
      schedules: (a.schedules || []).map(s => ({
        id: s.id,
        task: s.taskDefinition?.taskName || s.taskDefinition?.taskCode || null,
        lastCompletedDate: s.lastCompletedDate,
        nextDueDate: s.nextDueDate,
      })),
      notes: a.notes, archivedAt: a.archivedAt,
      createdAt: a.createdAt, updatedAt: a.updatedAt,
    }));

    const activityJson = activityLogs.map(l => ({
      id: l.id, action: l.action, details: l.details,
      user: l.user ? { name: l.user.name, email: l.user.email } : null,
      assetId: l.assetId, createdAt: l.createdAt,
    }));

    const exportInfo: any = {
      exportedAt,
      accountId: account?.id,
      accountName: account?.companyName,
      planType: account?.planType,
      accountCreatedAt: account?.createdAt,
      counts: {
        assets:      assets.length,
        contractors: contractors.length,
        documents:   documents.length,
        activityLog: activityLogs.length,
      },
      note: 'This export contains your ServiceCycle account data as of the exportedAt timestamp. Document files are not included — see documents.json for a manifest.',
    };

    // ── Stream ZIP response ─────────────────────────────────────────────────
    const filename = `servicecycle-export-${dateSlug}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => { console.error('Export archive error:', err); });
    archive.pipe(res);

    archive.append(assetsCsv,                              { name: 'assets.csv' });
    archive.append(JSON.stringify(assetsJson,   null, 2),  { name: 'assets.json' });
    archive.append(JSON.stringify(contractors,  null, 2),  { name: 'contractors.json' });
    archive.append(JSON.stringify(activityJson, null, 2),  { name: 'activity_log.json' });
    archive.append(JSON.stringify(documents,    null, 2),  { name: 'documents.json' });
    archive.append(JSON.stringify(exportInfo,   null, 2),  { name: 'export_info.json' });

    await archive.finalize();
  } catch (err) {
    console.error('GET /settings/export error:', err);
    // Only send error header if headers not yet sent
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Export failed' });
    }
  }
});

// ── GET /api/settings/encryption/status ──────────────────────────────────────
// Returns current encryption state for this account.
router.get('/encryption/status', requireAdmin, async (req, res) => {
  try {
    const { masterKeyHint } = require('../lib/docCrypto');
    const rows = await prisma.accountSetting.findMany({
      where: {
        accountId: req.user.accountId,
        key: { in: ['ENCRYPTION_ENABLED', 'ENCRYPTION_ACKNOWLEDGED_AT', 'ENCRYPTION_ACKNOWLEDGED_BY'] },
      },
    });
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));

    return res.json({
      success: true,
      data: {
        enabled:          map['ENCRYPTION_ENABLED'] === 'true',
        acknowledgedAt:   map['ENCRYPTION_ACKNOWLEDGED_AT'] || null,
        acknowledgedBy:   map['ENCRYPTION_ACKNOWLEDGED_BY'] || null,
        masterKeyHint:    masterKeyHint(),
        masterKeyPresent: !!process.env.MASTER_KEY,
      },
    });
  } catch (err) {
    console.error('[settings/encryption/status]', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch encryption status.' });
  }
});

// ── POST /api/settings/encryption/verify-key ─────────────────────────────────
// Verifies the last 8 characters of MASTER_KEY. Used during the opt-in flow
// to prove the admin has the key accessible before enabling encryption.
router.post('/encryption/verify-key', requireAdmin, async (req, res) => {
  try {
    const { verifyMasterKeyTail } = require('../lib/docCrypto');
    const { tail } = req.body;
    if (!tail || typeof tail !== 'string' || tail.length !== 8) {
      return res.status(400).json({ success: false, error: 'Provide exactly 8 characters.' });
    }
    const match = verifyMasterKeyTail(tail);
    return res.json({ success: true, data: { match } });
  } catch (err) {
    console.error('[settings/encryption/verify-key]', err);
    return res.status(500).json({ success: false, error: 'Verification failed.' });
  }
});

// ── POST /api/settings/encryption/enable ─────────────────────────────────────
// Enables document encryption for this account. Requires prior acknowledgment
// from the UI (the key verification + checkbox flow). Records who enabled it
// and when for audit purposes.
router.post('/encryption/enable', requireAdmin, async (req, res) => {
  try {
    const { verifyMasterKeyTail } = require('../lib/docCrypto');
    const { tail, acknowledged } = req.body;

    // Re-verify the key tail server-side — never trust the client-side check alone
    if (!tail || !verifyMasterKeyTail(tail)) {
      return res.status(400).json({
        success: false,
        error: 'MASTER_KEY verification failed. Provide the last 8 characters of your MASTER_KEY.',
      });
    }

    if (!acknowledged) {
      return res.status(400).json({
        success: false,
        error: 'Acknowledgment is required before encryption can be enabled.',
      });
    }

    const now = new Date().toISOString();
    const upsert = (key, value) => prisma.accountSetting.upsert({
      where:  { accountId_key: { accountId: req.user.accountId, key } },
      update: { value },
      create: { accountId: req.user.accountId, key, value },
    });

    await Promise.all([
      upsert('ENCRYPTION_ENABLED',          'true'),
      upsert('ENCRYPTION_ACKNOWLEDGED_AT',   now),
      upsert('ENCRYPTION_ACKNOWLEDGED_BY',   req.user.id),
    ]);

    console.log(`[encryption] Enabled for account ${req.user.accountId} by user ${req.user.id} at ${now}`);

    return res.json({
      success: true,
      data: { enabled: true, acknowledgedAt: now, acknowledgedBy: req.user.id },
    });
  } catch (err) {
    console.error('[settings/encryption/enable]', err);
    return res.status(500).json({ success: false, error: 'Failed to enable encryption.' });
  }
});

// ── POST /api/settings/encryption/disable ────────────────────────────────────
// Disables encryption for new uploads. Already-encrypted documents remain
// encrypted and will continue to decrypt correctly as long as MASTER_KEY
// is unchanged. Does not re-encrypt or modify any stored files.
router.post('/encryption/disable', requireAdmin, async (req, res) => {
  try {
    await prisma.accountSetting.upsert({
      where:  { accountId_key: { accountId: req.user.accountId, key: 'ENCRYPTION_ENABLED' } },
      update: { value: 'false' },
      create: { accountId: req.user.accountId, key: 'ENCRYPTION_ENABLED', value: 'false' },
    });

    console.log(`[encryption] Disabled for account ${req.user.accountId} by user ${req.user.id}`);

    return res.json({ success: true, data: { enabled: false } });
  } catch (err) {
    console.error('[settings/encryption/disable]', err);
    return res.status(500).json({ success: false, error: 'Failed to disable encryption.' });
  }
});

// ── GET /api/settings/service-rep ─────────────────────────────────────────
// Returns the per-account service representative contact info.
// Used by the Quote Request feature to pre-fill who to contact.
router.get('/service-rep', requireAdmin, async (req, res) => {
  try {
    const account = await prisma.account.findUnique({
      where:  { id: req.user.accountId },
      select: { serviceRepName: true, serviceRepEmail: true, serviceRepPhone: true },
    });
    return res.json({ success: true, data: account ?? {} });
  } catch (err) {
    console.error('[settings/service-rep GET]', err);
    return res.status(500).json({ success: false, error: 'Failed to load service rep' });
  }
});

// ── PUT /api/settings/service-rep ─────────────────────────────────────────
// Updates the per-account service rep contact.  Admin only.
router.put('/service-rep', requireAdmin, async (req, res) => {
  try {
    const { serviceRepName, serviceRepEmail, serviceRepPhone } = req.body;
    const updated = await prisma.account.update({
      where: { id: req.user.accountId },
      data: {
        serviceRepName:  serviceRepName  != null ? String(serviceRepName)  : null,
        serviceRepEmail: serviceRepEmail != null ? String(serviceRepEmail) : null,
        serviceRepPhone: serviceRepPhone != null ? String(serviceRepPhone) : null,
      },
      select: { serviceRepName: true, serviceRepEmail: true, serviceRepPhone: true },
    });
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[settings/service-rep PUT]', err);
    return res.status(500).json({ success: false, error: 'Failed to update service rep' });
  }
});


// ── GET /api/settings/branding — no auth level gate; any user can load brand ──
// Returns BRAND_LOGO_URL, BRAND_PRIMARY_COLOR, BRAND_DISPLAY_NAME for CSS
// injection on load.  Safe to expose — cosmetic only.
router.get('/branding', async (req, res) => {
  try {
    const rows = await prisma.accountSetting.findMany({
      where: {
        accountId: req.user.accountId,
        key: { in: ['BRAND_LOGO_URL', 'BRAND_PRIMARY_COLOR', 'BRAND_DISPLAY_NAME'] },
      },
    });
    const m: Record<string, string> = {};
    for (const r of rows) m[r.key] = r.value;
    return res.json({
      success: true,
      data: {
        logoUrl:      m['BRAND_LOGO_URL']      ?? null,
        primaryColor: m['BRAND_PRIMARY_COLOR'] ?? null,
        displayName:  m['BRAND_DISPLAY_NAME']  ?? null,
      },
    });
  } catch (err) {
    console.error('[settings/branding GET]', err);
    return res.status(500).json({ success: false, error: 'Failed to load branding' });
  }
});

// ── PUT /api/settings/branding — admin only ────────────────────────────────────
// Saves white-label branding settings.  All fields optional (null clears).
// primaryColor must be a valid CSS hex (#rrggbb) if provided.
router.put('/branding', requireAdmin, async (req, res) => {
  try {
    const { logoUrl, primaryColor, displayName } = req.body;

    // Validate hex color if provided
    if (primaryColor != null && !/^#[0-9a-fA-F]{6}$/.test(String(primaryColor))) {
      return res.status(400).json({ success: false, error: 'primaryColor must be a 6-digit hex (e.g. #0057b8)' });
    }

    const upsert = async (key: string, value: string | null) => {
      if (value === null || value === undefined || String(value).trim() === '') {
        await prisma.accountSetting.deleteMany({ where: { accountId: req.user.accountId, key } });
      } else {
        await prisma.accountSetting.upsert({
          where:  { accountId_key: { accountId: req.user.accountId, key } },
          create: { accountId: req.user.accountId, key, value: String(value).trim() },
          update: { value: String(value).trim() },
        });
      }
    };

    await Promise.all([
      upsert('BRAND_LOGO_URL',      logoUrl),
      upsert('BRAND_PRIMARY_COLOR', primaryColor),
      upsert('BRAND_DISPLAY_NAME',  displayName),
    ]);

    return res.json({ success: true });
  } catch (err) {
    console.error('[settings/branding PUT]', err);
    return res.status(500).json({ success: false, error: 'Failed to save branding' });
  }
});


// ─── GET /api/settings/partner-events ─────────────────────────────────────────
// Customer-facing read-only audit log: events this account has shared with
// its partner org. Requires requireAdmin (scoped to own account).

router.get('/partner-events', requireAdmin, async (req: any, res: any) => {
  try {
    const { accountId } = req.user;
    const { limit = '50', cursor } = req.query;
    const take = Math.min(parseInt(String(limit), 10) || 50, 200);

    const where: any = { accountId, archived: false };
    if (cursor) where.id = { lt: String(cursor) };

    const logs = await prisma.partnerEventLog.findMany({
      where,
      take,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        eventType: true,
        payload: true,
        createdAt: true,
        digestSentAt: true,
        immediateEmailSentAt: true,
        assignedRep: { select: { name: true, email: true } },
        partnerOrg:  { select: { name: true } },
      },
    });

    res.json({
      logs,
      nextCursor: logs.length === take ? logs[logs.length - 1].id : null,
    });
  } catch (err: any) {
    console.error('[settings/partner-events]', err);
    res.status(500).json({ success: false, error: 'Failed to load partner events' });
  }
});

// ─── POST /api/settings/partner-revoke ────────────────────────────────────────
// Customer revokes partner access entirely — sets partnerOrgId = null and
// disables all consent settings.
router.post('/partner-revoke', requireAdmin, async (req: any, res: any) => {
  try {
    const { accountId } = req.user;

    const consentKeys = [
      'partner_share_deficiencies',
      'partner_share_inspections',
      'partner_share_quote_requests',
      'partner_share_overdue_tasks',
    ];

    await prisma.$transaction([
      prisma.account.update({
        where: { id: accountId },
        data: { partnerOrgId: null, assignedRepId: null, fallbackRepId: null },
      }),
      ...consentKeys.map((key) =>
        prisma.accountSetting.upsert({
          where:  { accountId_key: { accountId, key } },
          create: { accountId, key, value: 'false' },
          update: { value: 'false' },
        })
      ),
    ]);

    res.json({ success: true });
  } catch (err: any) {
    console.error('[settings/partner-revoke]', err);
    res.status(500).json({ success: false, error: 'Failed to revoke partner access' });
  }
});


module.exports = router;

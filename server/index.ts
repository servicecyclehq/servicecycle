require('dotenv').config();
const prisma = require('./lib/prisma').default;
const { settleAllPending, verifyAllChains } = require('./lib/activityLogChain'); // Pass-6 W4 MT-127
const { verifyToken } = require('./lib/jwtSecrets');

// ── Startup env validation ────────────────────────────────────────────────────
// Refuse to boot if required env vars are missing. Logs all missing names at
// once so the operator can fix them in a single restart cycle. (M3)
(function validateEnv() {
  const missing = [];

  if (!process.env.DATABASE_URL)  missing.push('DATABASE_URL');

  if (!process.env.JWT_SECRET) {
    missing.push('JWT_SECRET');
  } else {
    // S1: weak-default blocklist. .env.example placeholder + obvious operator
    // mistakes that pass length checks but provide ~0 entropy.
    const JWT_PLACEHOLDER = 'change-me-to-a-long-random-string-at-least-32-chars';
    const WEAK_JWT_DEFAULTS = new Set([
      JWT_PLACEHOLDER,                                     // .env.example value
      'changeme', 'changeme123', 'change-me',              // common copy-paste
      'secret', 'secretsecret', 'jwtsecret',
      'servicecycle', 'servicecycle-secret', 'servicecycle123',
      'password', 'password123', 'Admin1234',
      'admin', 'adminadmin',
      'a'.repeat(32), '0'.repeat(32),                      // padding tricks to bypass length
    ]);
    const jwtVal = process.env.JWT_SECRET.trim();
    if (WEAK_JWT_DEFAULTS.has(jwtVal) || WEAK_JWT_DEFAULTS.has(jwtVal.toLowerCase())) {
      console.error('[startup] JWT_SECRET matches a known weak default. Refusing to start.');
      console.error('  Generate: node -e “console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))”');
      process.exit(1);
    }
    if (jwtVal.length < 32) {
      console.error('[startup] JWT_SECRET must be at least 32 characters. Refusing to start.');
      console.error('  Generate: node -e “console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))”');
      process.exit(1);
    }
  }

  // (v0.37.0 MT-141) During a rotation window, OLD_JWT_SECRET is set
  // alongside JWT_SECRET so existing tokens still verify. The same
  // strength requirements apply to the old key.
  if (process.env.OLD_JWT_SECRET) {
    const oldVal = process.env.OLD_JWT_SECRET.trim();
    if (oldVal.length < 32) {
      console.error('[startup] OLD_JWT_SECRET must be at least 32 characters. Refusing to start.');
      process.exit(1);
    }
    if (oldVal === (process.env.JWT_SECRET || '').trim()) {
      console.error('[startup] OLD_JWT_SECRET equals JWT_SECRET — rotation is a no-op. Refusing to start.');
      process.exit(1);
    }
    console.warn('[startup] OLD_JWT_SECRET is set — running in JWT rotation window (dual-verify on).');
  }

  // L2: JWT_EXPIRES_IN sanity — reject values that break the short-lived-token model
  if (process.env.JWT_EXPIRES_IN) {
    const ms = require('ms');
    const expiryMs = ms(process.env.JWT_EXPIRES_IN);
    if (!expiryMs || expiryMs <= 0) {
      console.error('[startup] JWT_EXPIRES_IN is set to zero or unparseable — access tokens would never expire. Refusing to start.');
      process.exit(1);
    }
    if (expiryMs > ms('24h')) {
      console.error(`[startup] JWT_EXPIRES_IN=”${process.env.JWT_EXPIRES_IN}” exceeds 24 hours. This breaks the short-lived-token model. Refusing to start.`);
      console.error('  Recommended: JWT_EXPIRES_IN=1h (default)');
      process.exit(1);
    }
  }

  // v0.37.4 W7: REFRESH_TOKEN_TTL_DAYS sanity. Default 30. Refuse to start
  // outside [1..365] so an accidental "0" doesn't make sessions ephemeral
  // and an accidental "9999" doesn't drift past the per-account session-
  // policy promises the legal pack makes.
  if (process.env.REFRESH_TOKEN_TTL_DAYS) {
    const ttlDays = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS, 10);
    if (!Number.isFinite(ttlDays) || ttlDays < 1 || ttlDays > 365) {
      console.error(`[startup] REFRESH_TOKEN_TTL_DAYS="${process.env.REFRESH_TOKEN_TTL_DAYS}" is outside [1..365]. Refusing to start.`);
      console.error('  Recommended: REFRESH_TOKEN_TTL_DAYS=30 (default), or 7 for high-security tenants.');
      process.exit(1);
    }
  }

  // S2: MASTER_KEY entropy. Always required (used for TOTP secrets + DB-stored
  // API keys), and additionally must decode to exactly 32 bytes. When
  // ENCRYPT_DOCS=true, also enforce a minimum raw character length so an
  // operator cannot accidentally start the server with a short, low-entropy key
  // and silently encrypt every uploaded document with a weak root key.
  if (!process.env.MASTER_KEY) missing.push('MASTER_KEY');
  if (process.env.MASTER_KEY) {
    const masterVal = process.env.MASTER_KEY.trim();
    const decoded = Buffer.from(masterVal, 'base64');
    if (decoded.length !== 32) {
      console.error('[startup] MASTER_KEY must decode to exactly 32 bytes (44-char base64). Refusing to start.');
      console.error('  Generate: node -e “console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))”');
      process.exit(1);
    }
    if (process.env.ENCRYPT_DOCS === 'true' && masterVal.length < 32) {
      console.error('[startup] ENCRYPT_DOCS=true requires MASTER_KEY of at least 32 characters. Refusing to start.');
      console.error('  Generate: node -e “console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))”');
      process.exit(1);
    }
  } else if (process.env.ENCRYPT_DOCS === 'true') {
    // ENCRYPT_DOCS set but MASTER_KEY missing: fail with a message that names
    // encryption mode explicitly (the generic missing-vars block fires too,
    // but this clarifies the cause).
    console.error('[startup] ENCRYPT_DOCS=true but MASTER_KEY is not set. Refusing to start.');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && !process.env.CLIENT_URL) {
    missing.push('CLIENT_URL (required in production)');
  }
  if (process.env.EMAIL_MOCK !== 'true' && !process.env.BREVO_API_KEY) {
    missing.push('BREVO_API_KEY (or set EMAIL_MOCK=true for local dev)');
  }

  // M3: require an AI key in env when AI is enabled.
  // v0.35.1: provider-aware check. The legacy gate only knew about AI_API_KEY /
  // ANTHROPIC_API_KEY, which crash-looped the server when AI_PROVIDER=cloudflare
  // was set with only CF_WORKERS_AI_API_KEY (no legacy AI_API_KEY). Each
  // provider in lib/ai.js has its own credential env var; the gate accepts
  // any one of them as satisfying the "AI is configured" requirement.
  //
  // Note: a DB-stored key (saved via Settings UI) also satisfies this at runtime,
  // but the DB is unavailable at startup. Set AI_ENABLED=false to suppress this
  // check when using DB-stored keys exclusively; the key will be resolved at request time.
  const aiKeyCandidates = [
    'AI_API_KEY',                   // legacy generic
    'ANTHROPIC_API_KEY',            // anthropic provider
    'CF_WORKERS_AI_API_KEY',        // cloudflare provider (v0.35.0)
    'AZURE_OPENAI_API_KEY',         // azure_openai provider
    'OPENAI_API_KEY',               // openai provider
    'GEMINI_API_KEY',               // gemini provider (alt name)
  ];
  const hasAnyAiKey = aiKeyCandidates.some((name) => !!process.env[name]);
  if (process.env.AI_ENABLED !== 'false' && !hasAnyAiKey) {
    missing.push(`AI key (one of: ${aiKeyCandidates.join(', ')}) is required when AI_ENABLED is not false; ` +
                 'alternatively set AI_ENABLED=false and save the key via Settings UI');
  }

  if (missing.length > 0) {
    console.error('[startup] Missing required environment variables:');
    missing.forEach(v => console.error(`  - ${v}`));
    console.error('Set them in server/.env (see server/.env.example).');
    console.error('Generate MASTER_KEY: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    process.exit(1);
  }
})();

// S6-FN-05 (v0.74.1): soft warning for ANTHROPIC_API_KEY when AI_PROVIDER=anthropic.
// The hard check above already refuses to boot when AI_ENABLED is not false and NO
// AI key at all is present. This softer check fires when the configured provider is
// anthropic but no Anthropic-specific key is set -- server boots but AI calls fail.
(function warnMissingAnthropicKey() {
  const _provider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
  if (_provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY && !process.env.AI_API_KEY) {
    console.warn('[Boot] MISSING env: ANTHROPIC_API_KEY (or legacy AI_API_KEY) -- AI features will fail at runtime. Set ANTHROPIC_API_KEY in .env or switch AI_PROVIDER to another provider.');
  }
  if (process.env.CF_AI_GATEWAY_TOKEN !== undefined && !process.env.CF_AI_GATEWAY_TOKEN) {
    console.warn('[Boot] CF_AI_GATEWAY_TOKEN is set but empty -- Cloudflare AI Gateway routing will be skipped.');
  }
})();

const express     = require('express');
const compression = require('compression'); // v0.50: gzip response bodies (declared in package.json since forever but never required — bootstrap responses were going uncompressed)
const cors        = require('cors');
const helmet      = require('helmet');
const jwt     = require('jsonwebtoken'); // W4: rate-limiter verifies token signature before granting authenticated budget
const { rateLimit, ipKeyGenerator } = require('express-rate-limit'); // (S5) ipKeyGenerator normalizes IPv6 to /64 prefix

const authRoutes            = require('./routes/auth');
// ── ServiceCycle equipment-model routes (2026-06-07 rewire) ─────────────────
const assetRoutes           = require('./routes/assets');       // was routes/contracts
const siteRoutes            = require('./routes/sites');        // asset hierarchy
const contractorRoutes      = require('./routes/contractors');  // was routes/vendors
const scheduleRoutes        = require('./routes/schedules');    // maintenance schedules
const workOrderRoutes       = require('./routes/workOrders');   // execution
const deficiencyRoutes      = require('./routes/deficiencies'); // findings
const standardsRoutes       = require('./routes/standards');    // NFPA/NETA matrix
const assetsImportRoutes    = require('./routes/assetsImport'); // CSV/XLSX bulk import
const testReportImportRoutes = require('./routes/testReportImport'); // R1 PDF test-report ingest
const workOrdersImportRoutes = require('./routes/workOrdersImport'); // WO history import
const deficienciesImportRoutes = require('./routes/deficienciesImport'); // findings import
const schedulesImportRoutes  = require('./routes/schedulesImport'); // schedule history import
const assetBriefRoutes      = require('./routes/assetBrief');   // AI maintenance brief
const assetPhotoInspectRoutes = require('./routes/assetPhotoInspect'); // AI photo inspection (vision)
const fieldRoutes           = require('./routes/fieldRoutes');  // Field Mode: My Day + field asset card
const assetLabelRoutes      = require('./routes/assetLabels');  // QR label sheet PDF
const complianceRoutes      = require('./routes/compliance');   // per-standard reports + audit snapshots
const auditRoutes           = require('./routes/audits');       // audit visits + recommendations (RECs)
const newsRoutes            = require('./routes/news');         // regulatory/industry news feed (global)
const dashboardRoutes       = require('./routes/dashboard');
const userRoutes            = require('./routes/users');
const preferencesRoutes     = require('./routes/preferences'); // v0.42 per-user key/value prefs
const bootstrapRoutes       = require('./routes/bootstrap');   // v0.47 single-RT mount-time bundle
const alertRoutes           = require('./routes/alerts');
const exportRoutes          = require('./routes/export'); // Export-current-view (assets / work orders)
const settingsRoutes        = require('./routes/settings');
const consultantRoutes      = require('./routes/consultant');
const feedbackRoutes        = require('./routes/feedback');
const activityRoutes        = require('./routes/activity');
const errorsRoutes          = require('./routes/errors'); // v0.90.0 render-crash telemetry
const { router: twoFactorRoutes } = require('./routes/twoFactor');
const backupRoutes              = require('./routes/backup');
const documentRoutes            = require('./routes/documents');
const setupRoutes               = require('./routes/setup'); // (S8) first-run wizard
const adminRoutes               = require('./routes/admin'); // (A4) demo reset endpoint
const adminAuditChainRoutes     = require('./routes/adminAuditChain'); // Pass-6 W4 MT-127 chain verify endpoint
const adminPartnerOrgsRoutes    = require('./routes/adminPartnerOrgs'); // super-admin PartnerOrg management
const reportRoutes              = require('./routes/reports'); // compliance reports (stub — later session)
const customFieldRoutes         = require('./routes/customFields'); // admin-defined asset fields
const earlyAccessRoutes         = require('./routes/earlyAccess');  // (L7) public lead-capture POST
const helpRoutes                = require('./routes/help');           // v0.36.0 per-module in-app help
const aiUsageRoutes             = require('./routes/aiUsage');      // v0.32.4: per-user AI quota state for UI helper text
// v0.20.0: Public REST API — versioned read-only routes (API key auth)
const v1AssetRoutes      = require('./routes/v1/assets');
const v1ContractorRoutes = require('./routes/v1/contractors');
const apiKeyRoutes        = require('./routes/apiKeys');
const webhookRoutes       = require('./routes/webhooks');
const quoteRequestRoutes    = require('./routes/quoteRequests');
const fleetDashboardRoutes  = require('./routes/fleetDashboard');
const outagePlanRoutes      = require('./routes/outagePlan');
const assetTemplateRoutes   = require('./routes/assetTemplates');
const outagePlannerRoutes   = require('./routes/outagePlanner');
const lotoRoutes            = require('./routes/loto');
const disasterEventRoutes   = require('./routes/disasterEvents');
const leaveBehindRoutes     = require('./routes/leaveBehind');
const { authenticateApiKey, apiKeyLimiter } = require('./middleware/apiKeyAuth');
const { requestId }                      = require('./middleware/requestId'); // v0.37.1 W5 MT-129
const openapiRoute                       = require('./routes/openapi');        // v0.37.1 W5 MT-128
const { installValidation, installResponseValidation } = require('./middleware/validation'); // Item 2: central request/response validation
const { authenticateToken, optionalAuthenticateToken } = require('./middleware/auth');
const { demoWriteGuard }    = require('./middleware/demoGuard'); // (A2/A3) demo write protection
const { gpcMiddleware }     = require('./middleware/gpc'); // (Pass-6 W3 MT-027) Sec-GPC: 1 honoring
const { countryGate }       = require('./middleware/countryGate'); // (Pass-6 W3 MT-026) US-only registration gate
const { getInstanceConfig } = require('./lib/instanceConfig'); // (S8) setup gate
const { runAlertEngine }    = require('./lib/alertEngine');
const { runBackup }         = require('./lib/backup');
const { pruneActivityLog }  = require('./lib/activityLogPrune'); // (B2) retention
const { pruneBackupLog }    = require('./lib/backupLogPrune');   // (B1 5/02) retention
const { pruneWebhookDlq }   = require('./lib/dlqPrune');         // v0.37.1 W5 MT-132
const { pruneDocumentOrphans } = require('./lib/documentOrphanPrune'); // S4-FN-04 (v0.74.1)
const { pingHeartbeat }     = require('./lib/heartbeat'); // (Pass-5 Tier 4 / Agent 5 G10) per-cron healthchecks.io ping

// ── Demo mode (S9) ───────────────────────────────────────────────────────────
// DEMO_MODE=true flips the running instance into a constrained sandbox:
//   - EMAIL_MOCK is forced true regardless of .env (no real outbound mail
//     except feedback — see L4 in lib/email.js)
//   - REGISTRATION_OPEN is forced true so visitors can self-serve a sandbox
//   - AI_ENABLED is forced true so the demo can showcase the AI features
//     (the cap and the model override below are what protect operator credit
//     spend, not blanket disablement)
//   - Per-action AI quotas are pinned by lib/aiQuota.js's DEMO_DEFAULT_CAPS
//     map (L14): extract=2 (SHARED bucket — PDF ingest + signature reading
//     decrement the same daily counter), ask=6 per user per UTC day.
//     Operators can override per-action via AI_DAILY_CAP_PER_USER_<ACTION>
//     envs, or uniformly with the legacy AI_DAILY_CAP_PER_USER. We
//     deliberately do NOT pin AI_DAILY_CAP_PER_USER here — that would
//     override the per-action defaults and revert everyone to a uniform
//     low cap. The asymmetry matters because Ask LapseIQ is conversational
//     (visitors send 4-5 questions) while extract is "demo this once".
//     Renewal-brief generation has no daily cap — only the 30/hour
//     briefLimiter in routes/contracts.js — matching the published Demo
//     Sandbox Notice.
//   - AI_MODEL_OVERRIDE is forced to the cheapest model OF THE ACTIVE
//     PROVIDER (L2 + v0.32.6) so a stray feature setting (or a DB-saved
//     AI_MODEL) cannot escalate the demo's per-call cost. The mapping is
//     provider-aware — pre-v0.32.6 the override was unconditionally pinned
//     to Anthropic Haiku, which broke when DEMO_MODE was switched to
//     AI_PROVIDER=gemini (the server sent Gemini's API the model name
//     "claude-haiku-4-5-20251001" and got "model not found"). See lib/ai.js.
//   - A nightly cron at 03:30 wipes user-generated data and re-seeds (see end of file)
// These overrides happen BEFORE any module reads process.env so the rest of
// the app sees the demo-locked values uniformly.
if (process.env.DEMO_MODE === 'true') {
  process.env.EMAIL_MOCK            = 'true';
  process.env.AI_ENABLED            = 'true';
  process.env.REGISTRATION_OPEN     = 'true';
  // v0.32.7: provider-aware cheapest-model lock with operator-override
  // escape hatch. The override is the operator's emergency lever against
  // cost-inflating misconfigs; it must respect the active provider or
  // Gemini/OpenAI demos break instantly when the server tries to call
  // the wrong endpoint with a Claude model name.
  //
  // v0.32.7: gemini default switched from 2.0-flash to 2.5-flash. Google
  // moved 2.0-flash to paid-tier-only when 2.5 launched (~April 2026), so
  // 2.0-flash returns 429 limit:0 on every free-tier key. 2.5-flash
  // remains on the free tier (5 RPM / 250k TPM / 20 RPD).
  //
  // v0.32.7: if the operator explicitly sets AI_MODEL_OVERRIDE in .env,
  // RESPECT IT. The demo override is the fallback default, not a
  // mandatory pin. This unblocks future model swaps without a code
  // change (e.g. when 2.5-flash also gets bumped off free tier, set
  // AI_MODEL_OVERRIDE=gemini-3.0-flash-lite in .env and restart).
  // To opt out of demo-mode forcing entirely, unset DEMO_MODE.
  const _demoProvider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
  const _DEMO_FORCED_MODELS = {
    anthropic:    'claude-haiku-4-5-20251001',
    openai:       'gpt-4o-mini',
    azure_openai: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini',
    gemini:       'gemini-2.5-flash',
  };
  process.env.AI_MODEL_OVERRIDE = process.env.AI_MODEL_OVERRIDE
    || _DEMO_FORCED_MODELS[_demoProvider]
    || _DEMO_FORCED_MODELS.anthropic;
  console.log(`[demo] DEMO_MODE active — provider=${_demoProvider}, model forced to ${process.env.AI_MODEL_OVERRIDE}, email mocked, AI on, registration open, nightly reset scheduled.`);
}

const app = express();

// ── Response compression (v0.50) ────────────────────────────────────────────
// Gzip every response body that's compressible (JSON, HTML, CSS, JS, SVG).
// Mounted FIRST so all downstream middleware + routes pass through it.
// Without this, large JSON responses (e.g. /api/bootstrap returning the
// contracts list + vendors + categories + members in one payload) were
// going over the wire uncompressed from origin to Cloudflare. Cloudflare
// then re-compressed for the client, but the origin→CF leg was paying
// full size. The `compression` package was declared in package.json since
// forever and never `require()`d in this file. Confirmed via grep + agent
// audit during the v0.50 latency review.
//
// Threshold defaults to 1024 bytes (small responses pay more in CPU than
// they save in bytes). filter() defaults to compressing application/json,
// text/*, application/javascript, etc.
app.use(compression({ threshold: 1024, level: 6 }));  // PERF-003 (Round-5)

// ── Trust proxy (B1) ────────────────────────────────────────────────────────
// When LapseIQ runs behind nginx/caddy/traefik (the recommended deployment
// shape — see docs/install.md), Express sees the proxy's IP on every request
// instead of the real client. This breaks per-IP rate limiting (every caller
// collapses to one bucket) and pollutes ActivityLog with the proxy address
// instead of the actual originator.
//
// TRUST_PROXY=true tells Express to trust the LAST hop and read the original
// client IP from X-Forwarded-For. Only enable when LapseIQ is actually fronted
// by a reverse proxy you control — turning it on for a directly-exposed
// instance lets clients spoof their IP via the header.
//
// Multi-proxy chains (e.g. CloudFront → ALB → server) need a higher number;
// document the simple single-hop case here and the advanced cases in
// docs/install.md.
// resolveTrustProxy() turns the TRUST_PROXY env var into the value Express
// accepts. Three forms are supported, in order of preference:
//
//   1. TRUST_PROXY='127.0.0.1, 173.245.48.0/20, 103.21.244.0/22, ...'
//      Comma-separated CIDR allowlist. Express walks X-Forwarded-For from
//      right to left and only trusts entries originating from listed
//      networks; the first non-listed hop is treated as the real client.
//      This is the recommended form for production behind Cloudflare /
//      nginx / Caddy.
//
//      For a Cloudflare-fronted deployment, fetch the canonical CF IP
//      ranges with `bash scripts/get-trust-proxy-cidrs.sh` and paste the
//      output into TRUST_PROXY. The script also emits 127.0.0.1 and the
//      common Docker bridge subnets so the on-host reverse proxy hop is
//      covered.
//
//   2. TRUST_PROXY=true
//      Legacy single-hop trust. Express trusts the LAST X-Forwarded-For
//      entry. Equivalent to the v1 setting; kept for backward compat.
//      Vulnerable to spoofing if anyone can reach the reverse proxy
//      bypassing the firewall (which they should NOT be able to). Prefer
//      the explicit CIDR form.
//
//   3. unset / empty / 'false'
//      Default. No trust. req.ip is the connecting socket address. Use
//      only for directly-internet-exposed instances with no proxy.
function resolveTrustProxy() {
  const raw = (process.env.TRUST_PROXY || '').trim();
  if (!raw || raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'true') {
    console.warn('[startup] TRUST_PROXY=true is the legacy single-hop form. Prefer an explicit CIDR allowlist (see server/.env.example) so X-Forwarded-For chain spoofing is structurally blocked.');
    return 1;
  }
  const cidrs = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (cidrs.length === 0) return false;
  return cidrs;
}
app.set('trust proxy', resolveTrustProxy()); // (B1, N9 - Pass 5)

// C6 (audit Critical, 2026-05-22): warn on every boot if BACKUP_DEST=local
// so operators who skipped scripts/install.sh's off-host prompt see the
// risk in their logs. Demo droplet is unaffected (BACKUP_DEST=s3 there).
try {
  require('./lib/backup').warnIfLocalDest();
} catch (e) {
  console.warn('[startup] could not check BACKUP_DEST:', e.message);
}

// H6 (audit High, 2026-05-22): warn on every boot when HEALTHCHECKS_PING_KEY
// is unset AND DEMO_MODE !== 'true'. Without the ping key, all 12 LapseIQ
// crons run silently -- nothing pages oncall if alertEngine stops firing
// for a week. Demo droplet exempted because demo doesn't have an oncall
// rotation. Mirrors the BACKUP_DEST=local pattern just above.
if (process.env.DEMO_MODE !== 'true' && !process.env.HEALTHCHECKS_PING_KEY) {
  console.warn('[startup] HEALTHCHECKS_PING_KEY is unset -- 12 crons (alertEngine, backup, nightlySync, etc.) are running with no external monitor. Set HEALTHCHECKS_PING_KEY in .env to enable healthchecks.io heartbeat pings. See docs/dr.md.');
}

// S6-FN-04 (v0.74.1): Brevo boot probe -- verify the API key is valid at startup.
// A GET /v3/account call is cheap (<200ms) and surfaces a stale/invalid key in the
// boot log rather than 30+ minutes later when the first alert email fails silently.
// Does NOT crash the server -- operators may intentionally defer Brevo setup.
(async function brevoBootProbe() {
  const brevoKey = process.env.BREVO_API_KEY;
  if (!brevoKey || process.env.EMAIL_MOCK === 'true') return; // not configured or mocked
  try {
    const ac = new AbortController();
    const _t = setTimeout(() => ac.abort(), 8_000);
    const resp = await fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': brevoKey, 'Accept': 'application/json' },
      signal: ac.signal,
    }).finally(() => clearTimeout(_t));
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      console.log(`[Boot] Brevo API key verified OK (plan: ${data.plan?.[0]?.type || 'unknown'}).`);
    } else {
      console.warn(`[Boot] Brevo API key probe returned HTTP ${resp.status} -- email sending may fail. Check BREVO_API_KEY in .env.`);
    }
  } catch (e) {
    console.warn('[Boot] Brevo boot probe failed (network/timeout) -- email sending status unknown:', e.message);
  }
})();

// ── Security & Parsing ────────────────────────────────────────────────────────
// S3: Helmet must be the very first middleware so security headers attach to
// every response, including 4xx/5xx returned by downstream middleware errors.
//
// CSP escape hatch: CSP_REPORT_ONLY=true sends Content-Security-Policy-Report-Only
// instead of the enforcing header. Use during initial rollout to surface
// violations without breaking the app.
//
// HSTS is gated on NODE_ENV=production: enabling HSTS over plain HTTP (e.g.
// localhost dev) is harmless but pointless, and we don't want operators to
// accidentally cache an HSTS pin against a domain they later move off TLS.
// L6: extend connect-src, img-src, and font-src with the LapseIQ marketing
// zone (*.lapseiq.com) so the demo SPA can fetch from sister subdomains —
// e.g. lapseiq.com/install.sh links rendered in the help menu, marketing
// hero images embedded in upcoming docs panes, or future fonts served from
// the marketing CDN. script-src deliberately stays 'self' only — no third
// party should ever ship JS into the running app.
const cspDirectives = {
  defaultSrc:    ["'none'"],
  scriptSrc:     ["'self'"],                                     // S3: same-origin scripts only
  styleSrc:      ["'self'"],                                     // S3: same-origin styles only
  imgSrc:        ["'self'", 'data:', 'https://*.servicecycle.app'],   // L6: + marketing assets
  connectSrc:    ["'self'", 'https://*.servicecycle.app'],            // L6: + sister subdomains for XHR/fetch
  fontSrc:       ["'self'", 'https://*.servicecycle.app'],            // L6: + future marketing CDN fonts
  objectSrc:     ["'none'"],
  baseUri:       ["'none'"],
  formAction:    ["'self'"],
  frameAncestors:["'none'"],          // X-Frame-Options DENY equivalent
};

// ── Request logging (audit Cluster C P1) ───────────────────────────────────
// pino-http is installed but loaded lazily so the server still boots if a
// fresh checkout hasn't run npm install yet. Logs as line-delimited JSON
// (Docker's json driver concatenates that nicely for downstream tools).
// Redacts auth headers and password fields so credentials never hit the log
// stream. Each request gets a UUID req-id which propagates to the response
// `X-Request-Id` header — incident reports become greppable.
try {
  // eslint-disable-next-line global-require
  const pinoHttp = require('pino-http');
  app.use(pinoHttp({
    genReqId: (req, res) => {
      const existing = req.headers['x-request-id'];
      if (existing && /^[A-Za-z0-9._-]{8,128}$/.test(existing)) return existing;
      // Lazy require keeps the dep optional for self-hosted ops that skip npm install.
      const id = require('crypto').randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    autoLogging: {
      // Skip health/ready probes — they fire every few seconds from Docker
      // and would otherwise drown out genuine traffic in the log stream.
      ignore: (req) => req.url === '/api/health' || req.url === '/api/ready',
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.body.password',
        'req.body.passwordHash',
        'req.body.totpCode',
        'req.body.refreshToken',
        // Pass-4.5 AI-safety wave (Agent 4 P1) — AI request/response bodies
        // can carry PII pulled from customer documents (employee names in
        // license agreements, vendor contact emails, contract counterparty
        // details). Pre-fix these landed in stdout logs unredacted. Add
        // the known AI route body fields here so pino-http strips them
        // before serialisation.
        'req.body.question',          // /api/ask payload
        'req.body.text',              // /api/signature text path
        'req.body.message',           // generic chat-style payload (defensive)
        'req.body.notes',             // contract notes — often PII
        'req.body.internalNotes',
        'req.body.vendorNotes',
        // AI provider responses don't currently land in `res.body` for
        // pino-http (we don't echo them through), but if we ever add a
        // response-body serializer we should redact `res.body.aiResponse`
        // and `res.body.brief` here too.
      ],
      remove: true,
    },
    // Production: structured JSON. Dev: human-readable.
    transport: process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url, ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }));
} catch (e) {
  console.warn('[startup] pino-http not installed — request logging disabled. Run `npm install` to enable.');
}

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives:  cspDirectives,
    reportOnly:  process.env.CSP_REPORT_ONLY === 'true', // (S3)
  },
  frameguard:           { action: 'deny' },                        // X-Frame-Options: DENY
  noSniff:              true,                                      // X-Content-Type-Options: nosniff
  xssFilter:            true,                                      // X-XSS-Protection: 0 (modern guidance)
  referrerPolicy:       { policy: 'strict-origin-when-cross-origin' }, // (S3) per spec
  strictTransportSecurity: process.env.NODE_ENV === 'production'
    ? { maxAge: 60 * 60 * 24 * 365, includeSubDomains: true, preload: false } // 1y, prod only (S3)
    : false,
  // N2: CORP policy is env-driven so operators with split-domain hosting
  // (frontend and API on different eTLD+1) can set CORP_POLICY=cross-origin.
  // Default 'same-site' is correct for same-domain and localhost deployments.
  crossOriginResourcePolicy: { policy: process.env.CORP_POLICY || 'same-site' }, // (N2)
}));

// S4: CORS hardening. Lock to CLIENT_URL with explicit methods + headers; no
// wildcard. In production CLIENT_URL is required (validated above), so the
// fallback to localhost only fires in dev.
//
// v0.7.4: CLIENT_URL now accepts a comma-separated list so a single instance
// can serve multiple front-end origins (e.g. demo.lapseiq.com + lapseiq.com
// + www.lapseiq.com all proxying to the same backend, but cookies/sessions
// stay per-origin). Single-value CLIENT_URL is backward-compat.
const CORS_ORIGINS = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(
  cors({
    // Function form so we can match against the parsed allowlist. Returning
    // the actual matched origin lets express-cors echo it on the response
    // (required when credentials:true, which we use for refresh-token cookies).
    origin: (origin, callback) => {
      // No-origin requests (curl, server-side, same-origin XHR) are allowed —
      // the auth middleware + CSRF posture defends those independently.
      if (!origin) return callback(null, true);
      if (CORS_ORIGINS.includes(origin)) return callback(null, origin);
      // v0.37.1 W5 MT-130: sanitise the origin before logging so a hostile
      // client cannot inject log lines via CR/LF embedded in the header
      // value. The error itself carries a sentinel flag the post-cors
      // handler below uses to emit a clean 403 (vs the default 500 the
      // express error middleware would otherwise produce on a thrown Error).
      const safeOrigin = String(origin).replace(/[\r\n]+/g, ' ').slice(0, 200);
      const err = new Error(`CORS: origin '${safeOrigin}' not in allowlist`);
      (err as any).isCorsRejection = true;
      (err as any).statusCode      = 403;
      return callback(err, false);
    },
    credentials:    true,
    methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge:         600, // cache preflight 10 minutes
  })
);

// v0.37.1 W5 MT-130: short-circuit CORS-rejection errors to a clean 403.
// Without this, the rejection bubbles through to the default express
// error handler which returns 500 with an HTML stack trace body. Pass-2
// D-04 audit flagged that as a leak surface. We keep the rejection log
// for ops (still on the request-logger pipeline) but the client only
// sees a tight JSON envelope with no internals.
app.use((err, req, res, next) => {
  if (err && err.isCorsRejection) {
    return res.status(403).json({ success: false, error: 'CORS: origin not allowed' });
  }
  return next(err);
});
// Audit Cluster A P2: reduced from 10mb (most JSON endpoints expect <10 KB).
// File uploads — ingest (PDF), contractsImport (CSV), documents, signature —
// use multer for multipart and don't pass through express.json, so this
// limit is safe to tighten globally. If a future bulk-JSON endpoint
// legitimately needs >1mb it should mount express.json({limit:'5mb'}) on
// its own router rather than reopening the global limit.
app.use(express.json({ limit: '200kb' }));  // SEC-011 (Round-5)

// Item 2: patch res.json to validate outgoing payload shapes (logs + render_errors in prod).
installResponseValidation(app);

// Audit Cluster C P0: global request timeout. A slow-POST DoS against any
// route could otherwise hold a socket open indefinitely and starve the
// event loop. 60s is generous for AI brief generation (which is the
// slowest legitimate route) but bounded.
app.use((req, res, next) => {
  res.setTimeout(60_000, () => {
    if (!res.headersSent) {
      res.status(503).json({ success: false, error: 'Request timed out' });
    }
  });
  next();
});

// ── GPC (Pass-6 W3 MT-027) ───────────────────────────────────────────────────
// Honor the Global Privacy Control header (Sec-GPC: 1) by setting req.gpc on
// every request. Mounted before the rate limiter so even rate-limited 429s
// have the flag available for ActivityLog. Privacy Policy section 6 + 6A
// claim GPC honoring; this middleware substantiates that claim. See
// middleware/gpc.js for the cross-state statute list that requires honoring.
app.use(gpcMiddleware);

// ── Rate Limiting ─────────────────────────────────────────────────────────────
// S5: General API limiter with split budgets for authenticated vs anonymous
// callers. We don't run authenticateToken here (this limiter sits in front of
// it, so every call to /api/* hits us first).
//
// Key: always IP-based. Previously we keyed by decoded (unverified) JWT userId,
// which let a forged token place rate-limit pressure on a legitimate user's
// bucket. Switching to IP isolation ensures each origin is counted independently.
// The downside (users behind NAT share a bucket) is acceptable — the 200 req/min
// authenticated budget is generous enough for shared office networks.
//
// Limit: still split by whether a Bearer token is present. A forged token gets
// the higher budget, but the auth middleware will reject it on the next hop —
// the only consequence is the attacker consuming their own IP's quota faster.
// W4 smoke pass (2026-05-16): when the demo droplet sits behind Cloudflare
// AND a local Caddy reverse proxy, `req.ip` was resolving to a Cloudflare
// edge IP (104.x / 162.158.x / 172.70.x rotating per request). The
// rate-limit bucket was therefore keyed per-CF-edge, not per-client — so
// a parallel burst from one client hit different buckets and rate-limit
// never engaged. Prefer the CF-Connecting-IP header (CF always sets this
// to the original client IP regardless of intermediate hops); fall back
// to req.ip when not present (non-CF traffic, dev, install-script tests).
// Pass-2 audit P0 (2026-05-17): only honor CF-Connecting-IP when it is
// accompanied by a well-formed CF-Ray header. Cloudflare always sets
// both for any request that traversed their edge — CF-Ray is a 16-char
// hex string + dash + 3 uppercase letters (e.g. "9fce066e0bfab7ac-ORD").
// A client hitting the droplet's public IP directly (bypassing CF) can
// set arbitrary headers, but the format validator below forces them to
// also forge a CF-Ray that matches the shape. The real defense lives
// at the network layer — see deploy/Caddyfile.demo notes about
// firewalling origin port 443 to Cloudflare IP ranges only. This
// header check is defense-in-depth, not the primary perimeter.
//
// Pre-fix, any client could rotate CF-Connecting-IP per request and
// (a) get a clean rate-limit bucket per attack request, (b) frame
// another IP for credential lockout, (c) poison ActivityLog details.ip.
// Cloudflare published IPv4 ranges (https://www.cloudflare.com/ips-v4).
// Updated 2026-05-23. Re-check quarterly or on CF announcements.
const _CF_CIDR_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15',
  '104.16.0.0/13',   '104.24.0.0/14',   '172.64.0.0/13',   '131.0.72.0/22',
].map(cidr => {
  const [base, bits] = cidr.split('/');
  const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0;
  const net  = base.split('.').reduce((acc, o) => (acc << 8 | Number(o)) >>> 0, 0);
  return { net: (net & mask) >>> 0, mask };
});
function _isCloudflareIp(ip) {
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/, '');
  const parts = clean.split('.');
  if (parts.length !== 4) return false;
  const n = parts.reduce((acc, o) => (acc << 8 | Number(o)) >>> 0, 0);
  return _CF_CIDR_V4.some(({ net, mask }) => (n & mask) >>> 0 === net);
}
const _CF_RAY_RE = /^[a-f0-9]{16}-[A-Z]{3}$/;
// v0.73.4 (T6-N2): added _isCloudflareIp(socket) so a direct-origin
// attacker cannot forge CF-Connecting-IP to rotate rate-limit buckets.
function _clientIpKey(req) {
  const cf     = req.headers['cf-connecting-ip'];
  const cfRay  = req.headers['cf-ray'];
  const socket = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (cf && cfRay && typeof cf === 'string' && cf.length < 64 &&
      _CF_RAY_RE.test(String(cfRay)) && _isCloudflareIp(socket)) {
    return `ip:${ipKeyGenerator(cf)}`;
  }
  return `ip:${ipKeyGenerator(req.ip)}`;
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  standardHeaders: true,   // RateLimit-* headers + Retry-After on 429
  legacyHeaders:   false,
  // Key by normalized IP only — no unverified JWT decoding in key path.
  keyGenerator: _clientIpKey,
  // Pass-2 audit P0 (2026-05-17): bypass this limiter entirely for the
  // /api/v1/* public-API surface. Those routes authenticate via plaintext
  // API keys (NOT JWTs) and have their own per-key apiKeyLimiter (60/min).
  // Pre-fix the JWT-verify below silently failed for API-key bearers and
  // dropped every v1 call into the 30/min anonymous bucket — first
  // Zapier customer with two concurrent automations on one office IP
  // hit 429s. v0.20.0 public-API regression.
  skip: (req) => { const u = req.originalUrl || req.url || ''; return u.startsWith('/api/v1/') || u.startsWith('/api/setup/status') || u.startsWith('/api/ai/usage/me') || u.startsWith('/api/help/') || u.startsWith('/api/health') || u.startsWith('/api/ready'); },
  limit: (req) => {
    // Audit Cluster A P2 (2026-05-16): VERIFY the JWT before granting the
    // higher budget. Pre-fix, any "Bearer <11+ chars>" got 200/min — a
    // garbage string like "Bearer aaaaaaaaaaaaaaaa" let an attacker
    // increase their own IP's quota without ever having a real account.
    // jwt.verify is sub-millisecond on a 256-byte token; cheap enough to
    // run per-request. Failures fall through to the anonymous 30/min.
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ') && auth.length > 10) {
      try {
        const token = auth.slice(7).trim();
        // Quiet verify — algorithms locked, no audience/issuer checks (those
        // are auth-middleware's job; here we just want a forgery filter).
        // verifyToken handles dual-secret rotation windows (v0.37.0 MT-141)
        verifyToken(token);
        return 200; // (S5) authenticated budget
      } catch {
        // forged / expired / malformed — treat as anonymous
      }
    }
    return 30; // (S5) anonymous budget
  },
  message: { success: false, error: 'Too many requests, please slow down and try again.' },
});

// AI/ingest routes: expensive, limit more aggressively.
// Also applied to /api/signature (N4) — same AI-credit cost profile.
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many upload requests — please wait before trying again.' },
});

// v0.67.10 (audit High, 2026-05-22): per-IP rate limit STACKED on top
// of per-user limiters for AI endpoints. Without this, a /register
// cycle that creates a fresh user every minute resets the per-user
// quota too -- one IP could chew through unlimited AI credit by
// rotating throwaway accounts. 100 AI calls per hour per IP covers
// every legitimate single-office use case (a 10-user team firing 10
// AI actions each in an hour = exactly at the limit, with bursting
// room from the per-user limiter which is still primary).
const aiIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    _clientIpKey,
  message: { success: false, error: 'Too many AI requests from this network -- try again in an hour.' },
});


// Feedback limiter: 5 submissions per hour per user. (M10)
// authenticateToken runs before this limiter, so req.user is always populated.
// Keying by userId avoids any IP/IPv6 concerns.
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { success: false, error: 'Too many feedback submissions — please try again later.' },
});

// v0.41 export limiter: 10 XLSX exports per minute per user.
// XLSX generation via exceljs is CPU-bound at the 1000-row cap and
// streams a non-trivial buffer back; a logged-in user can pin a core
// with curl in a loop. The global apiLimiter (200/min authenticated)
// is too loose for this endpoint specifically. Per-user keying matches
// the feedback/ingest pattern — authenticateToken runs first, so
// req.user is always populated.
const exportLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { success: false, error: 'Too many exports — please wait a moment before trying again.' },
});

// CPU-bound PDF generation for leave-behind documents. 20/hr per user keeps
// a busy tech from hammering pdfkit; authenticated so user-keyed rate is accurate.
const leaveBehindLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders:   false,
  // (0.2) wrap the req.ip fallback in ipKeyGenerator so an anonymous IPv6
  // client can't bypass the limit — and so express-rate-limit's
  // keyGeneratorIpFallback validation (ERR_ERL_KEY_GEN_IPV6) stops throwing
  // at startup. req.user is normally set (authenticateToken runs first); the
  // IP path is a defensive fallback.
  keyGenerator: (req) => `user:${req.user?.id || ipKeyGenerator(req.ip)}`,
  message: { success: false, error: 'Too many PDF requests — please wait before generating another leave-behind.' },
});

// â”€â”€ Item 2: central request validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Swap each router's handlers for a wrapper that validates params/query/body
// against schemas/registry BEFORE the handler. Routers are fully populated at
// require-time, so it is safe to instrument them here, before they are mounted.
[
  [authRoutes,             '/api/auth'],
  [twoFactorRoutes,        '/api/auth/2fa'],
  [assetRoutes,            '/api/assets'],
  [siteRoutes,             '/api/sites'],
  [contractorRoutes,       '/api/contractors'],
  [scheduleRoutes,         '/api/schedules'],
  [workOrderRoutes,        '/api/work-orders'],
  [deficiencyRoutes,       '/api/deficiencies'],
  [standardsRoutes,        '/api/standards'],
  [dashboardRoutes,        '/api/dashboard'],
  [userRoutes,             '/api/users'],
  [require('./routes/accounts'), '/api/accounts'],
  [preferencesRoutes,      '/api/preferences'],
  [bootstrapRoutes,        '/api/bootstrap'],
  [alertRoutes,            '/api/alerts'],
  [exportRoutes,           '/api/export'],
  [settingsRoutes,         '/api/settings'],
  [consultantRoutes,       '/api/consultant-access'],
  [feedbackRoutes,         '/api/feedback'],
  [activityRoutes,         '/api/activity'],
  [errorsRoutes,           '/api/errors'],
  [backupRoutes,           '/api/backup'],
  [documentRoutes,         '/api/documents'],
  [setupRoutes,            '/api/setup'],
  [adminRoutes,            '/api/admin'],
  [adminAuditChainRoutes,  '/api/admin/audit-chain'],
  [reportRoutes,           '/api/reports'],
  [customFieldRoutes,      '/api/custom-fields'],
  [earlyAccessRoutes,      '/api/early-access'],
  [helpRoutes,             '/api/help'],
  [aiUsageRoutes,          '/api/ai/usage'],
  [apiKeyRoutes,           '/api/settings/api-keys'],
  [webhookRoutes,          '/api/webhooks'],
  [quoteRequestRoutes,     '/api/quote-requests'],
  [outagePlanRoutes,       '/api/assets/:assetId/outage-plan'],
  [v1AssetRoutes,          '/api/v1/assets'],
  [v1ContractorRoutes,     '/api/v1/contractors'],
].forEach(([r, base]) => { try { installValidation(r, base); } catch (e) { console.error('[validation] install failed for', base, e && e.message); } });

app.use('/api/', apiLimiter);

// ── Setup Routes (S8) — must mount BEFORE the gate below ─────────────────────
// /api/setup/* is reachable on a fresh, unconfigured instance because the
// gate that follows excludes /setup paths. Each setup endpoint additionally
// re-checks isInstanceConfigured() as defence-in-depth.
app.use('/api/setup', setupRoutes);
app.use('/api/help', helpRoutes);

// ── L7: public early-access lead capture — mount BEFORE the setup gate ──────
// The landing page must be able to capture leads even on a brand-new instance
// (the marketing site might point at a not-yet-configured demo box). No auth,
// no setup gate; rate limiting via the apiLimiter anonymous bucket above.
// (Pass-6 W3 MT-026) countryGate runs ahead of the route so non-US lead
// captures are rejected at the gateway with a useful error code rather than
// landing in the queue. Self-host installs see countryGate as a no-op by
// default (mode resolves to 'off' when DEMO_MODE is unset).
app.use('/api/early-access', countryGate, earlyAccessRoutes);

// ── First-run setup gate (S8) ────────────────────────────────────────────────
// Until the wizard finishes (InstanceConfig.setupCompletedAt is set) every
// /api/* request EXCEPT /api/health and /api/setup/* short-circuits with
// 503 needsSetup:true. The SPA's api/client.js interceptor catches this and
// redirects to /setup. This sits AFTER apiLimiter so a misconfigured instance
// still benefits from rate limiting on the setup endpoints, and AFTER the
// /api/setup mount so those routes are never gated against themselves.
app.use('/api', async (req, res, next) => {
  // v0.36.7 (Pass-6 W2 MT-015): use originalUrl-based prefix checks for
  // consistency with the apiLimiter skip-list pattern at line ~523.
  // req.path technically WORKS here inside app.use('/api', ...) because
  // Express strips the /api mount prefix, but the codebase had a real
  // req.path-vs-originalUrl regression at the apiLimiter skip-list
  // (fixed in v0.36.0 commit 36a0a96 by switching to originalUrl).
  // Using one pattern across every gate site removes the foot-gun where
  // a future change to mount layout (e.g. routing through a sub-router)
  // would silently break the gate.
  const u = req.originalUrl || req.url || '';
  // /api/health stays open so ops can liveness-probe an unconfigured box
  if (u.startsWith('/api/health')) return next();
  // /api/setup/* already mounted above; defence-in-depth — skip the gate
  if (u.startsWith('/api/setup')) return next();
  // L7: /api/early-access/* is the public lead form — must work on a
  // fresh instance too (defence-in-depth; the route is mounted above this
  // gate, but we keep the exclusion explicit so a future re-ordering
  // doesn't accidentally lock the form behind setup).
  if (u.startsWith('/api/early-access')) return next();
  try {
    const cfg = await getInstanceConfig();
    if (!cfg.setupCompletedAt) {
      return res.status(503).json({
        success:    false,
        needsSetup: true,
        error:      'Instance not yet configured. Visit /setup to complete first-run setup.',
      });
    }
    next();
  } catch (err) {
    // DB unreachable — fail closed with 503 so the SPA shows a clear error
    // rather than a confusing 500 or routing redirect. The operator's most
    // common fix path here is "fix DATABASE_URL in .env and restart".
    console.error('[setup-gate] DB error:', err.message);
    return res.status(503).json({ success: false, error: 'Database unreachable.' });
  }
});

// ── Demo write guard (A2/A3) ────────────────────────────────────────────────
// No-op when DEMO_MODE !== 'true'. Sits BEFORE every protected route so a
// single mount covers /api/contracts, /api/users/*, etc. Whitelists
// /api/admin/reset-demo (the operator-triggered reset must always work).
// Pre-route bodies are already JSON-parsed at this point (express.json above),
// so req.body is available for status-based filtering.
app.use('/api', demoWriteGuard);

// ── Public Routes ────────────────────────────────────────────────────────────
// auth routes: per-IP credential limiter is applied at route level inside
// auth.js (M1) so /refresh and /logout are exempt from the tight budget.
app.use('/api/auth', authRoutes);
app.use('/api/auth/2fa', twoFactorRoutes);

// ── Health Check (M8: no service banner; B3: version + uptime) ──────────────
// Returns the minimum useful payload: status + version (cached at boot to
// avoid re-reading package.json per request) + uptime in seconds. The
// response intentionally OMITS:
//   - service name / banner / fingerprint
//   - Node.js version
//   - DB version or connection status (this endpoint must succeed even on a
//     misconfigured instance whose tables aren't migrated yet — Docker's
//     HEALTHCHECK runs against /api/health and we can't have it gated by DB)
//
// The reading of package.json happens once at module load; an EPERM or
// missing-file failure falls back to '0.0.0' rather than crashing boot.
let _serviceVersion = '0.0.0';
try {
  // eslint-disable-next-line global-require
  _serviceVersion = require('./package.json').version || '0.0.0';
} catch (e) {
  console.warn('[health] could not read package.json version:', e.message);
}
// Prefer the deployment-pinned SERVICECYCLE_VERSION (compose injects it as a
// server env var) so /api/health reflects the LIVE deployed tag, not the
// baked-in package.json (stale on client-only retag deploys). Strip the 'v'.
if (process.env.SERVICECYCLE_VERSION) {
  _serviceVersion = process.env.SERVICECYCLE_VERSION.replace(/^v/, '');
}

// Pass-6 W4 task #9: capture process start time once, expose via /api/health
// so external monitors (Better Stack, healthchecks.io) can detect restart
// flap by watching processStartedAt change rapidly across consecutive polls.
const _processStartedAt = new Date().toISOString();

app.get('/api/health', (req, res) => {
  // Liveness check ONLY. Returns 200 if the process is up and serving HTTP.
  // Deliberately does NOT touch the DB — that's what /api/ready is for. A
  // server in a "DB connection pool exhausted" state still passes /health
  // so an operator can scrape /metrics, hit /api/config, or otherwise
  // diagnose without being told "the box is dead" by Docker.
  const uptimeSec = Math.floor(process.uptime());
  res.json({
    success: true,
    data: {
      status:           'ok',
      version:          _serviceVersion,
      uptime:           uptimeSec,
      // Pass-6 W4 task #9: structured restart signals for external monitors
      processStartedAt: _processStartedAt,
      processUptimeSec: uptimeSec,
    },
  });
});

// ── Readiness ─────────────────────────────────────────────────────────────────
// Real dependency check. Docker HEALTHCHECK + compose healthcheck use this so
// the container is only marked healthy when /api/* can actually serve traffic.
// Returns 503 (Service Unavailable) if Postgres is unreachable, the canonical
// signal for "do not route requests to me yet" used by every load balancer.
//
// Pre-2026-05-16 the only check was /api/health which was a hard-coded 200 —
// audit finding Cluster C P0 ("`/api/health` is a liar").
app.get('/api/ready', async (req, res) => {
  // S3-FN-06 / S5-FN-06 (v0.74.1): deep readiness check.
  // ?deep=1 additionally probes Brevo + Anthropic reachability so an
  // operator can distinguish "DB dead" from "email broken" or "AI down".
  // The shallow (no ?deep=1) path retains its original behaviour and speed.
  const deep = req.query.deep === '1' || req.query.deep === 'true';
  const checks: any = { http: 'ok', db: 'unknown' };
  let status = 200;
  // ── DB probe (always) ────────────────────────────────────────────────────
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error('db_probe_timeout')), 1500)),
    ]);
    checks.db = 'ok';
  } catch (e) {
    checks.db = `error: ${e.message}`;
    status = 503;
  }
  // ── Deep probes (?deep=1) ────────────────────────────────────────────────
  if (deep) {
    // Brevo probe
    const brevoKey = process.env.BREVO_API_KEY;
    if (brevoKey && process.env.EMAIL_MOCK !== 'true') {
      try {
        const _ac = new AbortController();
        const _t  = setTimeout(() => _ac.abort(), 5_000);
        const _br = await fetch('https://api.brevo.com/v3/account', {
          headers: { 'api-key': brevoKey, 'Accept': 'application/json' },
          signal: _ac.signal,
        }).finally(() => clearTimeout(_t));
        checks.brevo = _br.ok ? 'ok' : `error: HTTP ${_br.status}`;
      } catch (e) {
        checks.brevo = `error: ${e.message}`;
      }
    } else {
      checks.brevo = 'not_configured';
    }
    // Anthropic probe (lightweight: just validate the key via /v1/models)
    const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY;
    const aiProvider   = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
    if (anthropicKey && aiProvider === 'anthropic') {
      try {
        const _ac = new AbortController();
        const _t  = setTimeout(() => _ac.abort(), 5_000);
        const _ar = await fetch('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          signal: _ac.signal,
        }).finally(() => clearTimeout(_t));
        checks.anthropic = _ar.ok ? 'ok' : `error: HTTP ${_ar.status}`;
      } catch (e) {
        checks.anthropic = `error: ${e.message}`;
      }
    } else {
      checks.anthropic = anthropicKey ? 'non_anthropic_provider' : 'not_configured';
    }
  }
  res.status(status).json({
    success: status === 200,
    data: {
      status:  status === 200 ? 'ready' : 'degraded',
      version: _serviceVersion,
      uptime:  Math.floor(process.uptime()),
      deep,
      checks,
    },
  });
});

// ── Responsible-disclosure surface ────────────────────────────────────────────
// RFC 9116 security.txt — points researchers at the disclosure address in
// SECURITY.md. Cached aggressively at the edge (text doesn't change often).
// Audit finding Cluster A P2 ("no /.well-known/security.txt served").
app.get('/.well-known/security.txt', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send([
    'Contact: mailto:security@servicecycle.app',
    'Preferred-Languages: en',
    // 90-day disclosure window per SECURITY.md.
    'Policy: https://github.com/servicecyclehq/servicecycle/blob/main/SECURITY.md',
    'Expires: 2027-06-06T00:00:00.000Z',
    '',
  ].join('\n'));
});

// ── Instance Config (M8: moved behind auth) ──────────────────────────────────
// Previously public — moved behind authenticateToken so the service fingerprint
// and env-based aiEnabled flag are not exposed to unauthenticated callers.
// The client now fetches /api/config after login (in AuthContext.fetchAccountSettings).
// N3: also checks the DB-stored AI key so non-admin users whose admin saved the key
// via Settings UI (stored in account_settings, not env) see aiConfigured: true.
app.get('/api/config', authenticateToken, async (req, res) => { // (N3)
  try {
    // Check DB-stored AI key for this account — don't return the value, only the boolean.
    let dbKeyConfigured = false;
    if (req.user?.accountId) {
      const dbKey = await prisma.accountSetting.findFirst({
        where:  { accountId: req.user.accountId, key: 'AI_API_KEY' },
        select: { value: true },
      });
      dbKeyConfigured = !!(dbKey?.value);
    }
    // v0.90.9: validate response shape so a future refactor that drops/renames
    // a field surfaces as a ContractDrift row in render_errors instead of a
    // silent VersionSkewDetector / AuthContext crash on the client.
    const { validateResponse } = require('./lib/responseValidator');
    const { configSchema }     = require('./schemas/api');
    const payload = {
      success: true,
      data: {
        aiEnabled:    process.env.AI_ENABLED !== 'false',
        aiConfigured: !!(process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || (process.env.CF_WORKERS_AI_API_KEY && process.env.CF_WORKERS_AI_ACCOUNT_ID) || process.env.GROQ_API_KEY || process.env.HF_TOKEN) || dbKeyConfigured, // (N3)
        // v0.90.4: surface server's deployed version so the client can detect skew
        // between its baked-in build-id meta and reality. SPA polls this every 60s.
        servicecycleVersion: process.env.SERVICECYCLE_VERSION || null,
      },
    };
    res.json(validateResponse('/api/config', configSchema, payload, req));
  } catch (err) {
    console.error('/api/config error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Protected Routes (JWT required) ───────────────────────────────────────────
// ServiceCycle equipment-model surface. The asset hierarchy + execution
// routers all apply role middleware internally; tenancy scoping (accountId)
// is enforced inside every handler.
// CSV/XLSX import — mounted at the sub-path BEFORE the general /api/assets
// router so POST /api/assets/import/* lands on the import handler, not the
// assets router's /:id param routes. (Express matches in mount order.)
// ingestLimiter (20/min): file parsing is CPU-bound; same budget the old
// document-ingest path used.
// QR label sheets — mounted BEFORE the /api/assets routers so GET /labels
// isn't swallowed by the assets router's /:id param route.
app.use('/api/assets/labels',   authenticateToken, assetLabelRoutes);
app.use('/api/assets/import',   authenticateToken, ingestLimiter, assetsImportRoutes);
app.use('/api/test-reports/import', authenticateToken, ingestLimiter, testReportImportRoutes);
app.use('/api/assets',          authenticateToken, assetRoutes);
// AI maintenance brief — second router on the same mount; paths don't
// collide (POST /:id/brief only), Express falls through. aiIpLimiter is
// applied INSIDE the router on the brief route only, so asset CRUD traffic
// never burns the AI per-IP budget.
app.use('/api/assets',          authenticateToken, assetBriefRoutes);
// Photo inspection — vision AI on uploaded equipment photos. Same fall-
// through mount pattern; gating (consent/quota/budget) lives in the router.
app.use('/api/assets',          authenticateToken, assetPhotoInspectRoutes);
app.use('/api/sites',           authenticateToken, siteRoutes);
app.use('/api/contractors',     authenticateToken, contractorRoutes);
app.use('/api/schedules/import', authenticateToken, ingestLimiter, schedulesImportRoutes);
app.use('/api/schedules',       authenticateToken, scheduleRoutes);
app.use('/api/work-orders/import', authenticateToken, ingestLimiter, workOrdersImportRoutes);
app.use('/api/work-orders',     authenticateToken, workOrderRoutes);
app.use('/api/deficiencies/import', authenticateToken, ingestLimiter, deficienciesImportRoutes);
app.use('/api/deficiencies',    authenticateToken, deficiencyRoutes);
app.use('/api/standards',       authenticateToken, standardsRoutes);
// Per-standard compliance proof: summary/report reads for any role,
// snapshot generation requireManager inside the router. Snapshot PDFs are
// immutable stored evidence — their SHA-256 is anchored into the
// tamper-evident activity-log hash chain at generation time.
app.use('/api/compliance',      authenticateToken, complianceRoutes);
// Audit visits + loss-control recommendation tracking. Snapshots generated
// for a visit link back via ComplianceSnapshot.auditVisitId.
app.use('/api/audits',          authenticateToken, auditRoutes);
// Industry/regulatory news — global items (no tenant data), auth'd reads,
// manager+ manual refresh. Populated by the 6h cron below.
app.use('/api/news',            authenticateToken, newsRoutes);
// Field Mode read endpoints — slim payloads designed for phones on bad
// signal; the offline outbox replays mutations against the normal routes.
app.use('/api/field',           authenticateToken, fieldRoutes);
app.use('/api/dashboard',       authenticateToken, dashboardRoutes);
// v0.32.4: per-user AI quota state for in-UI helper text. Authenticated;
// no limiter — read-only inspection of the quota counters.
app.use('/api/ai/usage',        authenticateToken, aiUsageRoutes);
app.use('/api/users',           authenticateToken, userRoutes);
app.use('/api/accounts',        authenticateToken, require('./routes/accounts')); // H1 (audit): mfaRequiredForAdmins + future account-level security policy
app.use('/api/preferences',     authenticateToken, preferencesRoutes); // v0.42 — per-user key/value
// v0.47 perf: bundle the 6 fetches ContractsList previously fired on mount
// (contracts page + members + vendors + categories + settings.public + the
// columnVisibility preference) into one round-trip. See routes/bootstrap.js
// for the where-clause/orderBy logic — kept in sync with /api/contracts.
app.use('/api/bootstrap',       authenticateToken, bootstrapRoutes);
app.use('/api/alerts',          authenticateToken, alertRoutes);
app.use('/api/export',          authenticateToken, exportLimiter, exportRoutes); // XLSX/CSV export: assets + work orders (10/min/user)
app.use('/api/settings',        authenticateToken, settingsRoutes);
// feedbackLimiter after authenticateToken so keyGenerator can use req.user.id (M10)
app.use('/api/feedback',        authenticateToken, feedbackLimiter, feedbackRoutes);
// H5: authenticateToken added at mount level; consultant.js also retains its
// internal router.use(authenticateToken) for defense-in-depth.
app.use('/api/consultant-access', authenticateToken, consultantRoutes);
app.use('/api/activity',          authenticateToken, activityRoutes);
app.use('/api/errors',            optionalAuthenticateToken, errorsRoutes); // v0.90.0 render-crash telemetry
app.use('/api/backup',            authenticateToken, backupRoutes);
app.use('/api/documents',         authenticateToken, documentRoutes);
// (A4) admin utilities — currently only /reset-demo. Auth + role + DEMO_MODE
// guards live inside the route handler.
app.use('/api/admin',             authenticateToken, adminRoutes);
app.use('/api/admin/audit-chain', authenticateToken, adminAuditChainRoutes);
const { requireSuperAdmin } = require('./middleware/roles');
app.use('/api/admin/partner-orgs', authenticateToken, requireSuperAdmin, adminPartnerOrgsRoutes);

// T2-N3 (audit-2 2026-05-22): admin endpoint to trigger deep restore test on demand.
// POST /api/admin/restore-test/deep -- admin only; no body required.
// Returns the full comparison result (live vs. restored row counts).
// Requires PG_TEST_DB_URL env var; returns 503 if not configured.
app.post('/api/admin/restore-test/deep', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin only' });
  }
  if (!process.env.PG_TEST_DB_URL) {
    return res.status(503).json({
      success: false,
      error:   'Deep restore test not available: PG_TEST_DB_URL is not configured on this instance.',
    });
  }
  try {
    const { runDeepRestoreTest } = require('./lib/restoreTest');
    const result = await runDeepRestoreTest({ prisma });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[admin] deep restore test error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});
app.use('/api/reports',           authenticateToken, reportRoutes);
app.use('/api/custom-fields',     authenticateToken, customFieldRoutes);

// ── v0.20.0: Public REST API (v1) — API key auth ─────────────────────────────
// All /api/v1/* routes are authenticated with machine-to-machine API keys
// (apiKeyAuth middleware) rather than JWT. The apiKeyLimiter (60 req/min per
// key) runs immediately after auth so a bad/expired key still gets rate-limited
// by the outer apiLimiter (30/min anonymous) before reaching the auth check.
// Read-only — no write endpoints exist in v1.
// v0.37.1 W5 MT-128: public OpenAPI spec + Swagger UI. Registered BEFORE
// the authenticated v1 mounts so the spec endpoints don't get caught by
// apiKeyAuth — integrators need to read API docs before they have a key.
openapiRoute.register(app);

// v0.37.1 W5 MT-129: X-Request-Id middleware on every v1 response so
// integrator support tickets can be cross-referenced against winston
// server logs by request id.
// META-API-002 (Round-6): tag every v1 response so callers / proxies can
// see which version they hit. Single source of truth - when v2 lands, copy
// this for /api/v2 and add Deprecation/Sunset to the v1 middleware.
const v1VersionTag = (req, res, next) => { res.set('API-Version', '1'); next(); };
app.use('/api/v1/assets',      v1VersionTag, requestId, authenticateApiKey, apiKeyLimiter, v1AssetRoutes);
app.use('/api/v1/contractors', v1VersionTag, requestId, authenticateApiKey, apiKeyLimiter, v1ContractorRoutes);

// ── v0.20.0: API key management — admin only, uses JWT auth ──────────────────
// Mounted under /api/settings so it inherits the settings-page UX convention.
// authenticateToken is already set on /api/settings above; requireAdmin is
// applied inside routes/apiKeys.js. This mount is SEPARATE so the router
// doesn't conflict with the existing settingsRoutes at /api/settings.
app.use('/api/settings/api-keys', authenticateToken, apiKeyRoutes);

// ── v0.24.0: Generic outbound webhooks — admin only ───────────────────────────
app.use('/api/webhooks', authenticateToken, webhookRoutes);

// ── OEM Fleet Dashboard — cross-account view for oem_admin users ─────────────
app.use('/api/fleet', authenticateToken, fleetDashboardRoutes);

// ── Partner invite accept — public routes (no auth required) ─────────────────
const partnerInvitePublicRoutes = require('./routes/partnerInvitePublic');
app.use('/api/invite', partnerInvitePublicRoutes);

// ── Quote Request — per-asset service quote lifecycle ────────────────────────
app.use('/api/quote-requests', authenticateToken, quoteRequestRoutes);

// ── Outage Consolidation Planner — clustered task scheduling ─────────────────
app.use('/api/assets/:assetId/outage-plan', authenticateToken, outagePlanRoutes);

// ── Equipment Template Library ────────────────────────────────────────────────
app.use('/api/asset-templates', authenticateToken, assetTemplateRoutes);

// ── Account-wide Outage Planner ───────────────────────────────────────────────
app.use('/api/outage-planner', authenticateToken, outagePlannerRoutes);

// ── LOTO — Lockout/Tagout procedures (asset-scoped) ──────────────────────────
app.use('/api/assets/:assetId/loto', authenticateToken, lotoRoutes);

// ── Leave-Behind PDF — inspection close leave-behind (Task 28) ───────────────
// Mounted at both the canonical work-orders path and the inspections alias.
app.use('/api/work-orders/:id/leave-behind-pdf', authenticateToken, leaveBehindLimiter, leaveBehindRoutes);
app.use('/api/inspections/:id/leave-behind-pdf', authenticateToken, leaveBehindLimiter, leaveBehindRoutes);

// ── Disaster Response Mode — weather alerts + emergency declarations ──────────
app.use('/api/disaster-events', authenticateToken, disasterEventRoutes);

// ── 404 Handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// Global Error Handler: see the H6 Better Stack bridge below (S5-FN-01: legacy handler removed v0.74.0)
// ── Cron mutex helper (audit Cluster C P0) ─────────────────────────────────
// node-cron has no built-in overlap protection. If a scheduled callback
// runs longer than its window the next tick fires concurrently — that
// would double-send digest emails, double-dump pg_dump, double-prune
// activity log rows. Wrap every cron callback in `runOnce(name, fn)`
// which short-circuits if the previous invocation hasn't returned.
const _cronInFlight = Object.create(null);
// Pass-5 Tier 4 / Agent 5 G10: pingHeartbeat wraps every cron with a
// healthchecks.io start/success/fail ping. The module no-ops unless
// HEALTHCHECKS_PING_KEY (or per-check HEALTHCHECKS_URL_<NAME> override) is
// configured in .env, so behavior on un-monitored self-hosted instances is
// unchanged. A silently stopped cron now alarms within minutes of its
// expected next run instead of weeks later when a customer notices the
// missing renewal alert. See docs/observability.md.
async function runOnce(name, fn) {
  if (_cronInFlight[name]) {
    console.warn(`[Cron] ${name} skipped — previous run still in flight`);
    return;
  }
  _cronInFlight[name] = true;
  const t0 = Date.now();
  await pingHeartbeat(name, 'start');
  try {
    await fn();
    const ms = Date.now() - t0;
    if (ms > 5_000) console.log(`[Cron] ${name} completed in ${ms}ms`);
    await pingHeartbeat(name, 'success', `ok ${ms}ms`);
  } catch (e) {
    console.error(`[Cron] ${name} failed:`, e.message);
    await pingHeartbeat(name, 'fail', `error: ${e.message}`);
  } finally {
    _cronInFlight[name] = false;
  }
}

// S5-FN-13 (v0.74.0): quiet variant of runOnce for sub-minute crons.
// Skips healthchecks.io pings so the dashboard signal is not drowned
// by thousands of heartbeats per day (e.g. activityLogChainSettle
// runs every 30s = 5,760 pings/day with the standard runOnce).
async function runOnceQuiet(name, fn) {
  if (_cronInFlight[name]) return;
  _cronInFlight[name] = true;
  try {
    await fn();
  } catch (e) {
    console.error(`[Cron] ${name} failed:`, e.message);
  } finally {
    _cronInFlight[name] = false;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
// H6 (audit High, 2026-05-22): global Express error middleware -- catches
// uncaught throws inside route handlers + bridges them to Better Stack so
// the dashboard sees real-time HTTP 500s without us having to wrap every
// handler in try/catch. The 4-argument signature (err, req, res, next) is
// what tells Express this is an error-handler.
//
// v0.90.8: ALSO persist to render_errors with kind='server' so the same
// dashboard that surfaces client render crashes shows server exceptions.
// Better Stack stays as the realtime stream; render_errors is the queryable
// time-series + investigation tail.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err && err.status ? Number(err.status) : 500;
  const errorCode = Date.now().toString(36).toUpperCase() + '-' +
                    Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0');
  try {
    require('./lib/betterStack').logEvent('error', {
      kind:        'expressHandlerError',
      method:      req.method,
      path:        req.path,
      requestId:   req.id || req.headers['x-request-id'] || undefined,
      message:     err && err.message ? String(err.message).slice(0, 500) : 'unknown',
      stack:       err && err.stack   ? String(err.stack).slice(0, 2000)  : undefined,
      status:      status,
      errorCode:   errorCode,
    });
  } catch (_) { /* noop */ }

  // v0.90.8: persist to render_errors with kind='server'. Only for 5xx --
  // 4xx errors are caller mistakes (validation, auth) and would flood the
  // table during normal use. Fire-and-forget; a telemetry persistence
  // failure must never cascade into the request response path.
  if (status >= 500) {
    try {
      // prisma client is imported at module top (see import above)
      const trunc = (v, max) => {
        if (v == null) return null;
        const s = String(v);
        return s.length > max ? s.slice(0, max) : s;
      };
      const ip = (req.headers['x-forwarded-for'] || req.ip || 'unknown')
        .split(',')[0].trim();
      prisma.renderError.create({
        data: {
          kind:           'server',
          errorCode:      errorCode,
          name:           trunc(err && err.name, 100) || 'ServerError',
          message:        trunc(err && err.message, 1000) || 'unknown server error',
          stack:          trunc(err && err.stack, 4000),
          path:           trunc(req.method + ' ' + (req.path || req.url || ''), 500),
          userId:         req.user && req.user.id        ? req.user.id        : null,
          accountId:      req.user && req.user.accountId ? req.user.accountId : null,
          userAgent:      trunc(req.headers['user-agent'], 500),
          appVersion:     trunc(process.env.SERVICECYCLE_VERSION, 32),
          ip:             trunc(ip, 64),
        },
      }).catch((persistErr) => {
        // Telemetry persistence failure is observable via stdout / Better Stack.
        console.error('[server-error-persist] failed:', persistErr && persistErr.message);
      });
    } catch (_) { /* never throw from the error handler */ }
  }

  res.status(status).json({
    success: false,
    error: 'Internal server error',
    errorCode: errorCode,  // surfaces the same code to client for support tickets
  });
});

// Export app for integration tests (supertest attaches directly without binding a port).
module.exports = app;
module.exports.default = app;

// In test mode, skip listen + crons so supertest can use the express app directly.
let httpServer: any = { close: (cb: any) => { try { cb?.(); } catch {} } };
if (process.env.NODE_ENV !== 'test') {
httpServer = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`ServiceCycle API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);

  // ── M1 (2026-06-09 audit): cron single-instance guard ─────────────────────
  // node-cron registrations live in THIS process. `runOnce()` only prevents a
  // job from overlapping *itself within one process* — it does NOT stop two
  // processes from each firing the same schedule. The moment this app is run
  // as >1 instance (PM2 cluster `instances`, a scaled compose `replicas`, or a
  // second container on the demo droplet) every cron fires N times: double
  // pg_dump backups, double prune deletes, double digest emails, double
  // webhook retries.
  //
  // Guard: grab a Postgres SESSION-level advisory lock. Exactly one instance
  // wins `pg_try_advisory_lock`; the rest skip cron registration entirely and
  // run as web-only workers. The lock is held by the Prisma backend connection
  // for the life of the process and is released automatically when the process
  // exits / `prisma.$disconnect()` runs during graceful shutdown — no explicit
  // unlock needed. Single-instance deployments (the demo box) always win the
  // lock, so behavior there is unchanged.
  const CRON_ADVISORY_LOCK_KEY = 4242000001; // arbitrary stable app-wide constant
  try {
    const lockRows = await prisma.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${CRON_ADVISORY_LOCK_KEY}::bigint) AS locked`;
    if (!lockRows?.[0]?.locked) {
      console.log('[Cron] Another instance holds the scheduler advisory lock — running web-only, skipping cron registration on this instance.');
      return;
    }
    console.log('[Cron] Acquired scheduler advisory lock — this instance owns scheduled jobs.');
  } catch (lockErr: any) {
    // If the lock probe itself fails (DB momentarily unreachable at boot),
    // fail OPEN so a single-instance demo box still runs its crons rather than
    // silently going dark. The trade-off (possible double-fire if the DB blips
    // during a genuine multi-instance boot race) is acceptable versus a demo
    // with no backups/alerts running at all.
    console.error('[Cron] advisory-lock probe failed, proceeding with cron registration (fail-open):', lockErr?.message);
  }

  // ── Nightly alert cron (runs at 7:00 AM server time) ──────────────────────
  // Set EMAIL_MOCK=true in .env to log emails to console without sending
  try {
    const cron = require('node-cron');

    // NFPA 70B §9.3.1 missed-cycle policy. Runs at 06:40 UTC — BEFORE the alert
    // engine (07:00) so any asset newly auto-flagged Condition 3 has its
    // tightened intervals reflected in that morning's overdue alerts. Per
    // account, mirroring the alert-engine pattern.
    cron.schedule('40 6 * * *', () => runOnce('missedCyclePolicyC3', async () => {
      const { applyMissedCyclePolicy } = require('./lib/missedCyclePolicy');
      const accounts = await prisma.account.findMany({ select: { id: true } });
      let set = 0, cleared = 0;
      for (const account of accounts) {
        try {
          const r = await applyMissedCyclePolicy(prisma, account.id);
          set += r.c3Set; cleared += r.c3Cleared;
        } catch (e) {
          console.error('[Cron] missedCyclePolicyC3 error for account', account.id.slice(0, 8), ':', e.message);
        }
      }
      console.log('[Cron] Missed-cycle policy (§9.3.1):', accounts.length, 'account(s) —', set, 'auto-C3 set,', cleared, 'cleared');
    }), { timezone: 'UTC' });
    console.log('[Cron] Missed-cycle Condition-3 policy scheduled — runs daily at 06:40');

    // S2-FN-01 (v0.75.x): per-account alert engine. Mirrors the nightly backup
    // pattern (index.js:1265). A single large-contract account no longer holds
    // other tenants behind one global take:1000 query. runAlertEngine() already
    // accepts { accountId } -- the cron just never passed it until now.
    cron.schedule('0 7 * * *', () => runOnce('alertEngine', async () => {
      console.log('[Cron] Running nightly alert engine (per-account)...');
      const accounts = await prisma.account.findMany({ select: { id: true } });
      const failures = [];
      for (const account of accounts) {
        try { await runAlertEngine({ accountId: account.id }); }
        catch (e) {
          failures.push({ id: account.id, msg: e.message });
          console.error('[Cron] AlertEngine error for account', account.id.slice(0,8), ':', e.message);
        }
      }
      if (failures.length > 0) {
        // Throw so runOnce pings healthchecks.io fail -- same as backup cron.
        const detail = failures.map(f => f.id.slice(0,8) + ':' + f.msg).join(', ');
        throw new Error('[AlertEngine] Failed for ' + failures.length + '/' + accounts.length + ' accounts: ' + detail);
      }
      console.log('[Cron] Alert engine complete:', accounts.length, 'account(s) processed');
    }), { timezone: 'UTC' });
    console.log('[Cron] Alert engine scheduled (per-account) -- runs daily at 07:00')

    // ── Regulatory news scanner (every 6 hours) ─────────────────────────────
    // Pulls OSHA newsroom + electrical trade press RSS, filters to
    // maintenance-compliance terms. Global rows; NEWS_SCANNER_ENABLED=false
    // disables for air-gapped installs.
    cron.schedule('20 */6 * * *', () => runOnce('newsScanner', async () => {
      const { runNewsScanner } = require('./lib/newsScanner');
      const summary = await runNewsScanner();
      console.log('[Cron] News scanner:', JSON.stringify(summary));
    }), { timezone: 'UTC' });
    console.log('[Cron] News scanner scheduled — every 6 hours');

    // ── Weather / disaster scanner (every 15 minutes) ────────────────────────
    // Polls NWS active alerts API for Extreme/Severe weather events, matches
    // affected states against customer site locations, creates/resolves
    // DisasterEvent records, and notifies affected accounts.
    // WEATHER_SCANNER_ENABLED=false disables for air-gapped installs.
    cron.schedule('*/15 * * * *', () => runOnce('weatherScanner', async () => {
      const { runWeatherScanner } = require('./lib/weatherScanner');
      const summary = await runWeatherScanner();
      if (summary.created > 0 || summary.resolved > 0) {
        console.log('[Cron] Weather scanner:', JSON.stringify(summary));
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Weather scanner scheduled — every 15 minutes');

    // -- Cloudflare Workers AI monthly budget reset (v0.35.0) --------
    // The aiBudgetGuard tracks Cloudflare spend + Neuron count per
    // UTC month with a 25 USD/mo cap, 75% alert, 90% hard-stop. The in-
    // memory tracker auto-rolls over on the 1st of each month at the
    // first call after midnight UTC, but a deliberate explicit reset
    // lines up audit logs with a predictable timestamp. Runs at
    // 00:00 UTC on the 1st of every month. No-op on self-host.
    cron.schedule('0 0 1 * *', () => runOnce('aiBudgetMonthlyReset', async () => {
      try {
        const { resetMonthlyCloudflare } = require('./lib/aiBudgetGuard');
        const summary = resetMonthlyCloudflare();
        console.log('[Cron] AI monthly budget reset:', JSON.stringify(summary));
      } catch (e) { console.error('[Cron] AI budget reset failed:', e.message); }
    }), { timezone: 'UTC' });
    console.log('[Cron] AI monthly budget reset scheduled (v0.35.0)');

    // ── Nightly backup cron (runs at 2:00 AM server time) ───────────────────
    cron.schedule('0 2 * * *', () => runOnce('backup', async () => {
      console.log('[Cron] Running nightly database backup...');
      // S5-FN-02 (v0.74.0): collect per-account results; throw if any failed so
      // runOnce pings healthchecks.io 'fail'. Pre-fix, the catch() swallowed all
      // errors and the cron pinged green even when backups failed.
      const accounts = await prisma.account.findMany({ select: { id: true } });
      const failures = [];
      for (const account of accounts) {
        const result = await runBackup(account.id, 'cron');
        if (!result.success) {
          failures.push({ accountId: account.id, error: result.error });
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `Backup failed for ${failures.length} of ${accounts.length} account(s): ` +
          failures.map(f => `${f.accountId.slice(0, 8)}:${f.error}`).join(', ')
        );
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Backup scheduled — runs daily at 02:00');

    // ── ActivityLog retention prune (B2) — runs at 03:00 AM server time ────
    // Deletes activity_logs rows older than ACTIVITY_LOG_RETENTION_DAYS
    // (default 365). Slot is 03:00 to land between the 02:00 backup and the
    // 03:30 demo reset — nothing else competes for that window.
    cron.schedule('0 3 * * *', () => runOnce('activityLogPrune', async () => {
      console.log('[Cron] Pruning activity log...');
      try {
        const result = await pruneActivityLog();
        if (result.error) {
          console.error('[Cron] ActivityLog prune error:', result.error);
        } else {
          console.log(
            `[Cron] ActivityLog prune complete: deleted ${result.deletedCount} rows ` +
            `older than ${result.retentionDays} days (cutoff ${result.cutoff.toISOString()})`
          );
        }
      } catch (e) {
        console.error('[Cron] ActivityLog prune crashed:', e.message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] ActivityLog prune scheduled — runs daily at 03:00');

    // S5-FN-07: NotificationLog retention prune -- runs at 03:05 AM UTC
    // Deletes notification_logs rows older than 180 days.
    cron.schedule('5 3 * * *', () => runOnce('notificationLogPrune', async () => {
      try {
        const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
        const r = await prisma.notificationLog.deleteMany({ where: { sentAt: { lt: cutoff } } });
        console.log('[Cron] NotificationLog prune: deleted', r.count, 'rows older than 180d');
      } catch (e) {
        console.error('[Cron] NotificationLog prune crashed:', e.message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] NotificationLog prune scheduled -- runs daily at 03:05');

    // ── ActivityLog chain settler (W4 MT-127) ─ runs every 30 seconds ────
    // Picks up ActivityLog rows where rowHash IS NULL and computes the
    // per-account hash chain. Decoupled from writeLog so direct
    // prisma.activityLog.create call sites (contracts.js, ingest.js etc.)
    // also get chained automatically. Steady-state load: hundreds of rows
    // per pass on a busy demo, settles in milliseconds.
    cron.schedule('*/30 * * * * *', () => runOnceQuiet('activityLogChainSettle', async () => {
      try {
        const results = await settleAllPending(prisma);
        const total = results.reduce((s, r) => s + (r.settled || 0), 0);
        if (total > 0) {
          console.log(`[Cron] ActivityLog chain settled ${total} rows across ${results.length} account(s)`);
        }
      } catch (e) {
        console.error('[Cron] ActivityLog chain settle crashed:', e.message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] ActivityLog chain settler scheduled — every 30 seconds');

    // ── ActivityLog chain verifier (W4 MT-127) ─ runs daily at 03:45 UTC ─
    // Recomputes each per-account chain end-to-end and writes an
    // audit_chain_break event on detection. Cheap on a small instance
    // (single sweep per account). Heavy instances should reduce cadence.
    cron.schedule('45 3 * * *', () => runOnce('activityLogChainVerify', async () => {
      console.log('[Cron] Verifying ActivityLog hash chains...');
      try {
        const { summary } = await verifyAllChains(prisma);
        console.log(`[Cron] Chain verify: ${summary.accountsChecked} accounts, ` +
                    `${summary.totalRowsChecked} rows, ${summary.totalBreaks} break(s) ` +
                    `across ${summary.accountsBroken} account(s)`);
      } catch (e) {
        console.error('[Cron] ActivityLog chain verify crashed:', e.message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] ActivityLog chain verifier scheduled — runs daily at 03:45');

    // ── BackupLog retention prune (B1 5/02) — runs at 03:15 AM server time ─
    // Deletes backup_logs rows older than BACKUP_LOG_RETENTION_DAYS
    // (default 180). Slot is 03:15 to land between the 03:00 ActivityLog
    // prune and the 03:30 demo reset — nothing else competes for that window.
    cron.schedule('15 3 * * *', () => runOnce('backupLogPrune', async () => {
      console.log('[Cron] Pruning backup log...');
      try {
        const result = await pruneBackupLog();
        if (result.error) {
          console.error('[Cron] BackupLog prune error:', result.error);
        } else {
          console.log(
            `[Cron] BackupLog prune complete: deleted ${result.deletedCount} rows ` +
            `older than ${result.retentionDays} days (cutoff ${result.cutoff.toISOString()})`
          );
        }
      } catch (e) {
        console.error('[Cron] BackupLog prune crashed:', e.message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] BackupLog prune scheduled — runs daily at 03:15');

    // ── Outbound Webhook DLQ prune (v0.37.1 W5 MT-132) — runs at 03:40 AM ──
    // Deletes outbound_webhook_dlq rows older than WEBHOOK_DLQ_RETENTION_DAYS
    // (default 30). The 30-day window is long enough that an operator returning
    // from vacation can still see what failed while they were away, short
    // enough that the table stays cheap to scan in the admin UI.
    cron.schedule('40 3 * * *', () => runOnce('webhookDlqPrune', async () => {
      try {
        const result = await pruneWebhookDlq();
        if (result.error) {
          console.error('[Cron] Webhook DLQ prune error:', result.error);
        } else if (result.deletedCount > 0) {
          console.log(
            `[Cron] Webhook DLQ prune complete: deleted ${result.deletedCount} rows ` +
            `older than ${result.retentionDays} days (cutoff ${result.cutoff.toISOString()})`
          );
        }
      } catch (e) {
        console.error('[Cron] Webhook DLQ prune crashed:', e.message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Webhook DLQ prune scheduled — runs daily at 03:40');

    // S4-FN-04 (v0.74.1): Document orphan prune -- weekly on Sunday at 05:00 UTC.
    // Deletes Document rows whose contractId no longer exists in the Contract table
    // (FK orphans from hard-deletes that bypassed ORM cascade). Low-frequency so
    // runOnceQuiet keeps the healthchecks.io dashboard uncluttered.
    cron.schedule('0 5 * * 0', () => runOnceQuiet('documentOrphanPrune', async () => {
      const result = await pruneDocumentOrphans();
      if (result.deleted > 0) {
        console.log(`[Cron] Document orphan prune: deleted ${result.deleted} orphaned document(s).`);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Document orphan prune scheduled - runs weekly Sunday at 05:00');

    // ── Expired refresh token cleanup (L3) — runs at 03:20 AM server time ──
    // Deletes refresh_tokens rows where expiresAt < (NOW - 30 days).
    // The 30-day grace window ensures we can still detect reuse-attacks on
    // recently-expired tokens. Rows older than that are fully dead weight.
    // CR-3 (audit-2): refreshTokenPrune now stands alone. The three crons that
    // were nested inside its callback (webhookDlqAlarm, webhookDlqRetry,
    // restoreTest) are registered at boot below — they were silently never
    // firing because cron.schedule() called from inside a cron callback does
    // NOT register a new boot-time job; it registers a runtime schedule that
    // is re-created on every tick of the outer cron (03:20 UTC). Production
    // logs confirmed all four "Cron] X scheduled" lines were absent at boot.
    cron.schedule('20 3 * * *', () => runOnce('refreshTokenPrune', async () => {
      try {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const { count } = await prisma.refreshToken.deleteMany({
          where: { expiresAt: { lt: cutoff } },
        });
        if (count > 0) console.log(`[Cron] Expired refresh token prune: deleted ${count} rows`);
      } catch (e) {
        console.error('[Cron] Refresh token prune error:', e.message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Expired refresh token prune scheduled — runs daily at 03:20');

    // v0.67.10 (audit High H12 from H4): retry DLQ rows every 30 min.
    // Walks rows with attemptCount < 10 + lastAttemptAt < now - 30min.
    // Re-fires the delivery via lib/webhook.js. On success the DLQ row
    // is deleted; on failure attemptCount increments + lastAttemptAt
    // stamps so the next 30-min tick picks it up again. After
    // attemptCount reaches 10 the row is left alone until the daily
    // prune at day 30 deletes it.
    // v0.68.1 (audit Medium): daily DLQ-depth alarm. Counts
    // OutboundWebhookDLQ per account; if any account has > 1000 rows
    // we logEvent('webhook_dlq_high', {...}) so Better Stack pages.
    // Catches an integrator whose receiver has been silently failing
    // for days -- the prune cron would eventually delete the rows at
    // day 30 without anyone noticing.
    cron.schedule('5 4 * * *', () => runOnce('webhookDlqAlarm', async () => {
      const groups = await prisma.outboundWebhookDLQ.groupBy({
        by: ['accountId'],
        _count: { id: true },
      });
      const offenders = groups.filter(g => g._count.id > 100);
      if (offenders.length > 0) {
        try {
          require('./lib/betterStack').logEvent('webhook_dlq_high', {
            count: offenders.length,
            offenders: offenders.map(o => ({ accountId: o.accountId, dlqCount: o._count.id })),
          });
        } catch (e) { console.warn('logEvent webhook_dlq_high:', e.message); }
      }
      console.log(`[Cron] webhookDlqAlarm: ${groups.length} accounts have DLQ rows; ${offenders.length} above 100`);
      return { groups: groups.length, offenders: offenders.length };
    }), { timezone: 'UTC' });
    console.log('[Cron] Webhook DLQ alarm scheduled — runs daily at 04:05');

    cron.schedule('*/30 * * * *', () => runOnce('webhookDlqRetry', async () => {
      try {
        const { retryDueRows } = require('./lib/webhookRetry');
        const summary = await retryDueRows();
        if (summary && (summary.delivered || summary.failed)) {
          console.log(`[Cron] webhookDlqRetry: delivered=${summary.delivered} failed=${summary.failed} skipped=${summary.skipped}`);
        }
        return summary;
      } catch (err) {
        console.error('[Cron] webhookDlqRetry error:', err.message);
        throw err;
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Webhook DLQ retry scheduled — runs every 30 minutes');

    // v0.67.11 (audit High H24): weekly backup integrity check.
    // Reads the most recent .pgcustom backup + runs `pg_restore --list`
    // to validate the archive is parseable and has the expected
    // section count. Catches the H9 silent-truncation bug at the
    // wire-format level. Pings Healthchecks (via runOnce wrapper) on
    // success. Full row-count restore is a follow-up that needs a
    // sidecar Postgres container.
    cron.schedule('0 4 * * 0', () => runOnce('restoreTest', async () => {
      const { runRestoreTest } = require('./lib/restoreTest');
      const result = await runRestoreTest();
      if (!result.ok && !result.skipped) {
        // Bubble the failure so runOnce reports it to Better Stack.
        throw new Error(`restoreTest failed: ${result.error || `only ${result.sections}/${result.expected} sections found`}`);
      }
      console.log(`[Cron] restoreTest: ${result.skipped ? 'skipped ('+result.skipped+')' : `ok (${result.sections} sections)`}`);
      return result;
    }), { timezone: 'UTC' });
    console.log('[Cron] Restore test scheduled — runs weekly Sunday 04:00');

    // T2-N3/T1-N9 (audit-2 2026-05-22): deep restore cron -- 1st of month 05:00 UTC.
    // Full row-count assertion against a sidecar Postgres (PG_TEST_DB_URL).
    // Skips gracefully if PG_TEST_DB_URL not set (self-host without sidecar).
    // Opt-out: set RESTORE_TEST_DEEP=false. Enabled by default when PG_TEST_DB_URL present.
    cron.schedule('0 5 1 * *', () => runOnce('deepRestoreTest', async () => {
      if (process.env.RESTORE_TEST_DEEP === 'false') {
        console.log('[Cron] deepRestoreTest: disabled via RESTORE_TEST_DEEP=false');
        return;
      }
      if (!process.env.PG_TEST_DB_URL) {
        console.log('[Cron] deepRestoreTest: skipped (PG_TEST_DB_URL not configured)');
        return;
      }
      const { runDeepRestoreTest } = require('./lib/restoreTest');
      const result = await runDeepRestoreTest({ prisma });
      if (!result.ok) {
        throw new Error('deepRestoreTest failed: ' + (result.error || JSON.stringify(result.compare)));
      }
      console.log('[Cron] deepRestoreTest: ok', JSON.stringify(result.compare));
      return result;
    }), { timezone: 'UTC' });
    console.log('[Cron] Deep restore test scheduled — runs 1st of month 05:00 UTC');

    // ── EarlyAccessRequest 36-month prune (Pass-4 audit L2-10) ─────────────
    // Privacy Policy §5 commits "Early-access form submissions: retained
    // until you ask us to delete them, or until 36 months elapse, whichever
    // is sooner." Pre-fix the 36-month side was unenforced (no cron) and
    // the table grew unbounded. Slot is 03:35 — between the demo reset
    // at 03:30 and the alert engine at 07:00.
    cron.schedule('35 3 * * *', () => runOnce('earlyAccessPrune', async () => {
      console.log('[Cron] Pruning expired early-access form submissions...');
      try {
        const { pruneEarlyAccessRequests } = require('./lib/earlyAccessPrune');
        const result = await pruneEarlyAccessRequests();
        if (result.error) {
          console.error('[Cron] EarlyAccessRequest prune error:', result.error);
        } else {
          console.log(
            `[Cron] EarlyAccessRequest prune complete: deleted ${result.deletedCount} rows ` +
            `older than ${result.retentionDays} days (cutoff ${result.cutoff.toISOString()})`
          );
        }
      } catch (e) {
        console.error('[Cron] EarlyAccessRequest prune crashed:', e.message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] EarlyAccessRequest prune scheduled — runs daily at 03:35 (Pass-4 L2-10)');

    // ── Demo mode crons (S9 + L3) — only when DEMO_MODE=true ──────────────
    // Two daily passes, sequenced so the inactivity prune runs before the
    // legacy seed reset to keep both jobs cheap and deterministic:
    //   03:25  prune per-visitor demo accounts (5d TTL + DEMO_MAX_ACCOUNTS cap)
    //   03:30  reset the legacy DEMO_ACCOUNT_ID + re-seed
    // Slot is between the 03:15 backup-log prune and the 07:00 alert engine
    // so nothing competes. Both jobs are idempotent — running twice in a row
    // (e.g. via a manual SIGTERM + restart at 03:31) is safe.
    if (process.env.DEMO_MODE === 'true') {

      // L3: per-visitor inactivity sweep
      cron.schedule('25 * * * *', () => runOnce('demoPrune', async () => { // H6: hourly (was daily 03:25) so signup-flood evasion window is 1hr not 21hr
        console.log('[Cron][demo] Pruning inactive per-visitor sandboxes…');
        try {
          const { pruneInactiveDemoAccounts } = require('./lib/demoPrune');
          const summary = await pruneInactiveDemoAccounts();
          console.log(`[Cron][demo] Inactivity prune complete: ${JSON.stringify(summary)}`);
        } catch (e) {
          console.error('[Cron][demo] Inactivity prune failed:', e.message);
        }
      }), { timezone: 'UTC' });
      console.log('[Cron] Demo inactivity prune scheduled — runs daily at 03:25 (DEMO_MODE=true, L3)');
      // S9: legacy 4-user shared seed reset
      cron.schedule('30 3 * * *', () => runOnce('demoReset', async () => {
        console.log('[Cron][demo] Resetting demo data…');
        try {
          const { resetAndSeedDemo } = require('./scripts/seed-demo');
          const summary = await resetAndSeedDemo({ trigger: 'cron' });
          await prisma.instanceConfig.update({
            where: { id: 'singleton' },
            data:  { demoLastResetAt: new Date() },
          });
          console.log(`[Cron][demo] Reset complete: ${JSON.stringify(summary)}`);
        } catch (e) {
          console.error('[Cron][demo] Reset failed:', e.message);
        }
      }), { timezone: 'UTC' });
      console.log('[Cron] Demo reset scheduled — runs daily at 03:30 (DEMO_MODE=true)');
    }

    // CR-2 (audit-2): persist aiBudgetGuard monthly counters every 60 seconds.
    // Pre-fix, persistMonthlyCounters() was exported but never called, so
    // alertsFired + monthly $-budget reset to zero on every pm2 restart.
    // The setInterval runs inside the cron try block (same scope as cron) so
    // it shares the same "node-cron not available" guard — if cron requires
    // fail, we simply don't wire the interval (acceptable degradation).
    setInterval(() => {
      require('./lib/aiBudgetGuard').persistMonthlyCounters()
        .catch((e) => console.warn('[aiBudgetGuard] periodic persist error (non-fatal):', e.message));
    }, 60_000);
    console.log('[aiBudgetGuard] 60s persist interval wired (CR-2)');

    // ── Service Opportunity Trigger — daily 02:30 UTC ──────────────────────────
    // Scans all accounts for:
    //   (a) IMMEDIATE deficiencies open 30+ days with no active QuoteRequest
    //   (b) Assets at C3 conditionOverride with no active QuoteRequest
    // Auto-creates a QuoteRequest for each qualifying asset. Deduplicates
    // by skipping assets that already have an open (non-declined) quote.
    cron.schedule('30 2 * * *', () => runOnce('serviceOpportunityTrigger', async () => {
      const ago30 = new Date(Date.now() - 30 * 86_400_000);
      let created = 0, skipped = 0;

      try {
        // ── Find system user to act as requester (use first admin per account) ──
        // We'll batch per account below to avoid a global scan.

        // 1. IMMEDIATE deficiencies open 30+ days
        const escalatedDefs = await prisma.deficiency.findMany({
          where: {
            severity: 'IMMEDIATE',
            resolvedAt: null,
            createdAt: { lte: ago30 },
            asset: { archivedAt: null },
          },
          select: {
            id: true, accountId: true, assetId: true, description: true,
            asset: { select: { name: true } },
          },
          take: 500,
        });

        // 2. C3 condition assets (schedule conditionOverride = C3)
        const c3Schedules = await prisma.maintenanceSchedule.findMany({
          where: {
            conditionOverride: 'C3',
            isActive: true,
            asset: { archivedAt: null },
          },
          select: {
            accountId: true, assetId: true,
            asset: { select: { name: true } },
          },
          take: 500,
        });

        // Build dedup set: assetId of assets already with open quotes
        const allAssetIds = [
          ...new Set([
            ...escalatedDefs.map(d => d.assetId),
            ...c3Schedules.map(s => s.assetId),
          ]),
        ];

        const existingQuotes = await prisma.quoteRequest.findMany({
          where: {
            assetId: { in: allAssetIds },
            status: { in: ['requested', 'quoted'] },
          },
          select: { assetId: true, accountId: true },
        });
        const quotedSet = new Set(existingQuotes.map(q => `${q.accountId}:${q.assetId}`));

        // Build account → first admin user map for requestedById
        const accountIds = [...new Set([
          ...escalatedDefs.map(d => d.accountId),
          ...c3Schedules.map(s => s.accountId),
        ])];
        const adminUsers = await prisma.user.findMany({
          where: {
            accountId: { in: accountIds },
            role: { in: ['admin', 'manager'] },
            isActive: true,
          },
          select: { id: true, accountId: true },
        });
        const adminMap = new Map<string, string>();
        for (const u of adminUsers) {
          if (!adminMap.has(u.accountId)) adminMap.set(u.accountId, u.id);
        }

        // Helper: create quote if not already quoted
        const maybeCreate = async (accountId: string, assetId: string, opts: {
          driver: string; notes: string;
        }) => {
          const key = `${accountId}:${assetId}`;
          if (quotedSet.has(key)) { skipped++; return; }
          const requestedById = adminMap.get(accountId);
          if (!requestedById) { skipped++; return; }
          quotedSet.add(key); // mark in-memory so dupes in same run don't double-create
          await prisma.quoteRequest.create({
            data: {
              accountId,
              assetId,
              requestedById,
              driver:   opts.driver as any,
              timeline: 'within_30_days',
              status:   'requested',
              notes:    opts.notes,
              emergencyMode: false,
            },
          });
          created++;
        };

        // Process escalated deficiencies
        for (const def of escalatedDefs) {
          await maybeCreate(def.accountId, def.assetId, {
            driver: 'suspected_failing',
            notes:  `Auto-triggered: IMMEDIATE deficiency open 30+ days — "${def.description?.slice(0, 120) ?? 'see asset'}". Asset: ${def.asset?.name ?? def.assetId}.`,
          });
        }

        // Process C3 condition assets
        for (const sched of c3Schedules) {
          await maybeCreate(sched.accountId, sched.assetId, {
            driver: 'failed_inspection',
            notes:  `Auto-triggered: Asset "${sched.asset?.name ?? sched.assetId}" in C3 (immediate service required) condition.`,
          });
        }

        console.log(`[Cron][serviceOpportunityTrigger] Done — created: ${created}, skipped: ${skipped}`);
      } catch (e) {
        console.error('[Cron][serviceOpportunityTrigger] Error:', (e as any).message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Service opportunity trigger scheduled — runs daily at 02:30 UTC');

    // ── Deficiency Alerts — daily 08:00 UTC ─────────────────────────────────
    const { runDeficiencyAlerts } = require('./lib/deficiencyAlerts');
    cron.schedule('0 8 * * *', () => runOnce('deficiencyAlerts', async () => {
      pingHeartbeat('deficiencyAlerts');
      try {
        const { accounts, emails, skipped } = await runDeficiencyAlerts();
        console.log(`[Cron][deficiencyAlerts] Done — accounts: ${accounts}, emails: ${emails}, skipped: ${skipped}`);
      } catch (e) {
        console.error('[Cron][deficiencyAlerts] Error:', (e as any).message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Deficiency alerts scheduled — runs daily at 08:00 UTC');

    // ── Modernization Alerts (Task 23) — daily 09:00 UTC ────────────────────
    // Scores every asset by RUL model, stores modernizationRiskScore, fires
    // QuoteRequests + emails for assets >= 0.70 threshold.
    const { runModernizationAlerts } = require('./lib/modernizationAlerts');
    cron.schedule('0 9 * * *', () => runOnce('modernizationAlerts', async () => {
      pingHeartbeat('modernizationAlerts');
      try {
        const r = await runModernizationAlerts();
        console.log(`[Cron][modernizationAlerts] Done — scored: ${r.assetsScored}, quotes: ${r.quoteRequests}, emails: ${r.emailsSent}, skipped: ${r.skipped}`);
      } catch (e) {
        console.error('[Cron][modernizationAlerts] Error:', (e as any).message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Modernization alerts scheduled — runs daily at 09:00 UTC');

    // ── Arc Flash Integrity Engine (Task 25) — daily 09:30 UTC ──────────────
    // Checks 5-yr expiry, load growth, relay/breaker deficiencies.
    const { runArcFlashIntegrity } = require('./lib/arcFlashIntegrity');
    cron.schedule('30 9 * * *', () => runOnce('arcFlashIntegrity', async () => {
      pingHeartbeat('arcFlashIntegrity');
      try {
        const r = await runArcFlashIntegrity();
        console.log(`[Cron][arcFlashIntegrity] Done — expired: ${r.expiredStudies}, loadGrowth: ${r.loadGrowthAlerts}, deficiency: ${r.deficiencyAlerts}, quotes: ${r.quoteRequests}, emails: ${r.emailsSent}`);
      } catch (e) {
        console.error('[Cron][arcFlashIntegrity] Error:', (e as any).message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Arc flash integrity scheduled — runs daily at 09:30 UTC');

    // ── QEMW Credential Alerts (Task 26) — daily 10:00 UTC ──────────────────
    // Fires 60d + 14d expiry alerts; detects compliance gaps for REQUIRE_QEMW accounts.
    const { runQemwAlerts } = require('./lib/qemwAlerts');
    cron.schedule('0 10 * * *', () => runOnce('qemwAlerts', async () => {
      pingHeartbeat('qemwAlerts');
      try {
        const r = await runQemwAlerts();
        console.log(`[Cron][qemwAlerts] Done — expiry: ${r.expiryAlerts}, gaps: ${r.gapAlerts}, quotes: ${r.quoteRequests}, emails: ${r.emailsSent}, skipped: ${r.skipped}`);
      } catch (e) {
        console.error('[Cron][qemwAlerts] Error:', (e as any).message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] QEMW alerts scheduled — runs daily at 10:00 UTC');

    // ── Standard Revision Alerts (Task 27) — daily 10:30 UTC ────────────────
    // Notifies accounts when ComplianceStandard.supersededAt is set.
    const { runStandardRevisionCron } = require('./lib/standardRevisionCron');
    cron.schedule('30 10 * * *', () => runOnce('standardRevisionCron', async () => {
      pingHeartbeat('standardRevisionCron');
      try {
        const r = await runStandardRevisionCron();
        console.log(`[Cron][standardRevisionCron] Done — standards: ${r.standardsChecked}, accounts: ${r.accountsAlerted}, emails: ${r.emailsSent}, skipped: ${r.skipped}`);
      } catch (e) {
        console.error('[Cron][standardRevisionCron] Error:', (e as any).message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Standard revision cron scheduled — runs daily at 10:30 UTC');

    // ── Partner Flywheel: digest cron — daily 7:00 AM UTC ────────────────────
    // Groups undigested PartnerEventLog records by assignedRep and sends one
    // consolidated email per rep per partner org.  IMMEDIATE_DEFICIENCY records
    // are excluded (already emailed at event time).
    const { runPartnerDigestCron } = require('./lib/partnerDigest');
    cron.schedule('0 7 * * *', () => runOnce('partnerDigest', async () => {
      pingHeartbeat('partnerDigest');
      try {
        const result = await runPartnerDigestCron();
        console.log(`[Cron][partnerDigest] Done — orgs: ${result.orgsProcessed}, emails: ${result.emailsSent}, records: ${result.recordsMarked}`);
      } catch (e) {
        console.error('[Cron][partnerDigest] Error:', (e as any).message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Partner digest cron scheduled — runs daily at 07:00 UTC');

    // ── Partner Flywheel: webhook retry cron — every 15 minutes ─────────────
    // Re-attempts failed webhook deliveries with exponential backoff.
    // attempt 1 → after 5 min, attempt 2 → after 10 min, attempt 3 → after 20 min.
    const { runWebhookRetryCron } = require('./lib/partnerWebhookRetry');
    cron.schedule('*/15 * * * *', () => runOnce('partnerWebhookRetry', async () => {
      try {
        const result = await runWebhookRetryCron();
        if (result.checked > 0) {
          console.log(`[Cron][partnerWebhookRetry] checked: ${result.checked}, succeeded: ${result.succeeded}, failed: ${result.failed}, exhausted: ${result.exhausted}`);
        }
      } catch (e) {
        console.error('[Cron][partnerWebhookRetry] Error:', (e as any).message);
      }
    }));
    console.log('[Cron] Partner webhook retry cron scheduled — runs every 15 minutes');

    // ── Partner Flywheel: retention archival cron — daily 2:05 AM UTC ────────
    // Soft-archives PartnerEventLog records past the account's retention window.
    const { runRetentionArchival } = require('./lib/partnerRetentionArchival');
    cron.schedule('5 2 * * *', () => runOnce('partnerRetentionArchival', async () => {
      pingHeartbeat('partnerRetentionArchival');
      try {
        const result = await runRetentionArchival();
        console.log(`[Cron][partnerRetentionArchival] Done — archived: ${result.archived}, accounts: ${result.accountsProcessed}`);
      } catch (e) {
        console.error('[Cron][partnerRetentionArchival] Error:', (e as any).message);
      }
    }), { timezone: 'UTC' });
    console.log('[Cron] Partner retention archival cron scheduled — runs daily at 02:05 UTC');

  } catch (e) {
    console.warn('[Cron] node-cron not available — run npm install to enable scheduled alerts');
  }
}); // end app.listen callback
} // end if NODE_ENV !== 'test'

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Docker `compose down`, Kubernetes rolling deploys, and most orchestrators
// send SIGTERM and wait a grace period (default 10s for Docker) before
// SIGKILL. Without a handler, Node defaults to terminating immediately —
// any in-flight DB write is dropped mid-transaction, and the next boot may
// see partial state. This block:
//   1. Stops accepting new connections (httpServer.close)
//   2. Waits for in-flight requests to drain (with a hard timeout)
//   3. Closes the Prisma pool so PG connections are released cleanly
//   4. Exits 0
const SHUTDOWN_TIMEOUT_MS = 25_000;

let _shuttingDown = false;
async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[shutdown] Received ${signal}. Draining...`);

  // Hard-timeout failsafe — if close() never resolves, kill the process
  // before the orchestrator does it for us (cleaner exit code in logs).
  const killTimer = setTimeout(() => {
    console.error('[shutdown] Drain timeout exceeded — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  killTimer.unref(); // don't keep the loop alive just for this timer

  // Stop accepting new connections; existing keep-alive sockets get closed
  // when their current request completes.
  httpServer.close(async (err) => {
    if (err) {
      console.error('[shutdown] httpServer.close error:', err.message);
    }
    try {
      // CR-2 (audit-2): flush AI budget counters before pool close so the
      // 30/70/90 alertsFired state + monthly usdCost survive the restart.
      try {
        await require('./lib/aiBudgetGuard').persistMonthlyCounters();
        console.log('[shutdown] aiBudgetGuard counters persisted.');
      } catch (e) {
        console.warn('[shutdown] aiBudgetGuard persist error (non-fatal):', e.message);
      }
      await prisma.$disconnect();
      console.log('[shutdown] Prisma pool closed.');
    } catch (e) {
      console.error('[shutdown] Prisma disconnect error:', e.message);
    }
    console.log('[shutdown] Goodbye.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));


// v0.36.7 (Pass-6 W2 promoted-P0): process-level safety net for
// orphaned stream errors (typically pdfkit writing into a closed
// ServerResponse after a HEAD or client abort).
//
// Pre-v0.36.7 a single ERR_STREAM_WRITE_AFTER_END from pdfkit was
// emitted as an UNHANDLED 'error' event on ServerResponse, which Node
// re-raises as an uncaughtException and terminates the process. A
// single bad PDF request from a HEAD-issuing scanner was sufficient
// to DoS the demo server (it would crash + restart every 30-60s for
// the duration of the scan). The route-level fix in lib/pdfHelpDoc.js
// closes the specific bug; this safety net catches the entire CLASS
// of "stream-after-close" failures so a future regression doesn't
// repeat the production-outage shape.
//
// We log and continue for the specific error codes known to be
// recoverable (ERR_STREAM_WRITE_AFTER_END, ERR_STREAM_DESTROYED,
// EPIPE, ECONNRESET). Anything else falls through to default Node
// behavior (which under PM2 / Docker is still a process restart, so
// no behavior change for genuinely fatal errors).
const _RECOVERABLE_STREAM_ERRORS = new Set([
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_DESTROYED',
  'ERR_HTTP_HEADERS_SENT',
  'EPIPE',
  'ECONNRESET',
  'ECANCELED',
]);

process.on('uncaughtException', async (err) => {
  const code = err && (err as any).code;
  if (code && _RECOVERABLE_STREAM_ERRORS.has(code)) {
    try {
      console.warn(
        '[uncaughtException] recoverable stream error swallowed: ' +
        (err && (err as any).code ? (err as any).code : 'unknown') + ' - ' +
        (err && err.message ? err.message : String(err))
      );
    } catch (_) { /* noop */ }
    return;
  }
  // Genuinely fatal: log and let Node terminate so the orchestrator
  // (Docker / PM2) can restart cleanly. Mirrors pre-v0.36.7 behavior.
  try {
    console.error('[uncaughtException] FATAL:', err && err.stack ? err.stack : err);
  } catch (_) { /* noop */ }
  // H6 (audit High, 2026-05-22): fire-and-forget Better Stack event so
  // crashes are visible on the dashboard, not buried in container logs.
  // Wrapped in try because logEvent is best-effort; we must not double-
  // fault during a fatal handler.
  // S5-FN-04 (v0.74.0): await with 2s race so fetch can't be dropped before Node exits.
  try {
    await Promise.race([
      require('./lib/betterStack').logEvent('error', {
        kind:    'uncaughtException',
        message: err && err.message ? String(err.message).slice(0, 500) : 'unknown',
        stack:   err && err.stack   ? String(err.stack).slice(0, 2000)  : undefined,
      }),
      new Promise(r => setTimeout(r, 2000)),
    ]);
  } catch (_) { /* noop */ }
  // Allow Node to crash naturally — do NOT call process.exit here
  // because that would suppress the stack trace from container logs.
  // Re-throw so the default handler fires.
  setImmediate(() => { throw err; });
});

process.on('unhandledRejection', async (reason, promise) => {
  // Log and continue. Treating every unhandled rejection as fatal would
  // make a single forgotten .catch() in a background task kill the
  // server. The pattern this guards is rare-but-real: a fire-and-forget
  // async call in a route handler throws after the response is closed.
  try {
    console.error(
      '[unhandledRejection]',
      reason && (reason as any).stack ? (reason as any).stack : String(reason)
    );
  } catch (_) { /* noop */ }

  // H6 (audit High, 2026-05-22): fire-and-forget Better Stack event.
  // S5-FN-04 (v0.74.0): await with 2s race so fetch can't be dropped before continuing.
  try {
    const errLike = reason instanceof Error ? reason : new Error(String(reason));
    await Promise.race([
      require('./lib/betterStack').logEvent('error', {
        kind:    'unhandledRejection',
        message: errLike.message ? String(errLike.message).slice(0, 500) : 'unknown',
        stack:   errLike.stack   ? String(errLike.stack).slice(0, 2000)  : undefined,
      }),
      new Promise(r => setTimeout(r, 2000)),
    ]);
  } catch (_) { /* noop */ }
});

export {};

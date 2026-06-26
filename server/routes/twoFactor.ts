/**
 * Two-factor authentication routes
 *
 * All management routes require an authenticated user (authenticateToken).
 * The verify-login route is public but requires a short-lived "pending_2fa" JWT.
 *
 * GET  /api/auth/2fa/status                  — is 2FA enabled? how many backup codes left?
 * POST /api/auth/2fa/setup                   — generate secret + QR + backup codes (pre-enable)
 * POST /api/auth/2fa/enable                  — confirm code, persist secret, mark enabled
 * DELETE /api/auth/2fa/disable               — verify TOTP or backup code, then disable
 * POST /api/auth/2fa/backup-codes/regenerate — generate fresh backup codes (requires TOTP)
 * POST /api/auth/2fa/verify-login            — exchange pending token + code for full tokens
 */

const express  = require('express');
const jwt      = require('jsonwebtoken');
const { verifyToken } = require('../lib/jwtSecrets');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const rateLimit = require('express-rate-limit');
const { authenticateToken } = require('../middleware/auth');
import prisma from '../lib/prisma';
const {
  generateSecret, buildOtpUri, generateQrDataUrl,
  verifyCode, verifyCodeWithStep, generateBackupCodes, consumeBackupCode, decryptSecret,
} = require('../lib/totp');
const { encryptIfNeeded } = require('../lib/crypto');
const { writeLog: writeActivityLog } = require('../lib/activityLog');

const router = express.Router();

// ── Rate limiter for verify-login (IP-based) ──────────────────────────────────
// 5 attempts per 15 min per IP — first line of defence
const totpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts — please try again in 15 minutes.' },
});

// ── Per-user TOTP brute-force counter (H2) ────────────────────────────────────
// Supplements the IP limiter: rotated-IP attacks are blocked per userId.
// State is in-process; a restart clears counts — acceptable because the
// pending_2fa token only lives 5 minutes anyway.
const TOTP_USER_MAX_FAILS   = 5;
const TOTP_USER_WINDOW_MS   = 5 * 60 * 1000; // 5 min
const TOTP_USER_MAX_SIZE    = 2000;           // LRU cap
const _totpUserFailMap = new Map(); // userId -> { count, resetAt }

function _checkTotpUserLimit(userId) {
  const now = Date.now();
  const entry = _totpUserFailMap.get(userId);
  if (!entry || now > entry.resetAt) return { blocked: false };
  return entry.count >= TOTP_USER_MAX_FAILS
    ? { blocked: true }
    : { blocked: false };
}

function _recordTotpUserFail(userId) {
  const now = Date.now();
  const entry = _totpUserFailMap.get(userId);
  if (!entry || now > entry.resetAt) {
    // Evict oldest entry if map is full (simple LRU by insertion order)
    if (_totpUserFailMap.size >= TOTP_USER_MAX_SIZE) {
      _totpUserFailMap.delete(_totpUserFailMap.keys().next().value);
    }
    _totpUserFailMap.set(userId, { count: 1, resetAt: now + TOTP_USER_WINDOW_MS });
  } else {
    entry.count++;
  }
}

function _clearTotpUserFails(userId) {
  _totpUserFailMap.delete(userId);
}

// ── Pending-2FA token helpers ─────────────────────────────────────────────────
// A "pending_2fa" JWT is issued during login when 2FA is enabled.
// It is short-lived (5 minutes) and can only be used to verify a TOTP code.
const PENDING_2FA_EXPIRY = '5m';
const PENDING_2FA_TYPE   = 'pending_2fa';

function issuePending2faToken(userId, req) {
  // v0.68.5 (audit Medium "Session & Token Security Lead"): bind the
  // pending_2fa token to a hash of the issuing client's IP + UA so a
  // stolen token can't be replayed from a different network. The hash
  // is short (8 hex chars / 32 bits) -- enough entropy to defeat a
  // blind replay but not enough to fingerprint individual users.
  const crypto = require('crypto');
  let bind = undefined;
  if (req) {
    const ip = req.ip || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '';
    const ua = req.headers['user-agent'] || '';
    bind = crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 16);
  }
  return jwt.sign(
    { userId, type: PENDING_2FA_TYPE, bind },
    process.env.JWT_SECRET,
    { expiresIn: PENDING_2FA_EXPIRY, algorithm: 'HS256' }
  );
}

// v0.68.5: helper that recomputes the bind value for a request so
// verify-login can compare it against the JWT payload.
function _bindForRequest(req) {
  const crypto = require('crypto');
  const ip = req.ip || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '';
  const ua = req.headers['user-agent'] || '';
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 16);
}

function verifyPending2faToken(token, req) {
  try {
    // verifyToken handles dual-secret rotation windows (v0.37.0 MT-141)
    const payload = verifyToken(token);
    if (payload.type !== PENDING_2FA_TYPE) return null;
    // v0.68.5: enforce IP+UA binding if the token was issued with one.
    // Tokens issued by older flows (no bind) still verify -- backward
    // compat during the rollout window. Once every active pending_2fa
    // token in the wild expires (5 min), all new tokens will have bind
    // and this branch becomes always-required.
    if (payload.bind && req && payload.bind !== _bindForRequest(req)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// Re-use the full token pair issuer from auth.js by importing prisma directly
// (the issueTokenPair function is local to auth.js so we duplicate it here).
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

const ACCESS_TOKEN_EXPIRY  = process.env.JWT_EXPIRES_IN  || '1h';
// v0.37.4 W7: see routes/auth.js for the env-driven TTL design notes.
const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS, 10) || 30;
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

async function issueTokenPair(userId, accountId) {
  // L2 (2026-06-09 audit): mirror auth.ts — embed the user's tokenEpoch (`ep`)
  // and a unique `jti` so 2FA-completed sessions honor instant revocation too.
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
  return { accessToken, refreshToken: rawRefresh, refreshTokenId: stored.id };
}

// ── GET /api/auth/2fa/status ──────────────────────────────────────────────────

router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { twoFactorEnabled: true, twoFactorBackupCodes: true },
    });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    let backupCodesRemaining = 0;
    if (user.twoFactorBackupCodes) {
      try { backupCodesRemaining = JSON.parse(user.twoFactorBackupCodes).length; } catch {}
    }

    return res.json({
      success: true,
      data: {
        enabled: user.twoFactorEnabled,
        backupCodesRemaining,
      },
    });
  } catch (err) {
    console.error('2FA status error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch 2FA status' });
  }
});

// ── POST /api/auth/2fa/setup ──────────────────────────────────────────────────
// Generate a new TOTP secret + QR code. Does NOT enable 2FA yet — that happens
// in /enable after the user confirms the code. The secret is stored encrypted in
// the DB at this point so it survives a page refresh before they confirm.

router.post('/setup', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { email: true, twoFactorEnabled: true },
    });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (user.twoFactorEnabled) {
      return res.status(400).json({ success: false, error: '2FA is already enabled. Disable it first to re-configure.' });
    }

    const { secret, encryptedSecret } = generateSecret();
    const otpUri   = buildOtpUri(secret, user.email);
    const qrCode   = await generateQrDataUrl(otpUri);
    const { plainCodes, hashedCodes } = generateBackupCodes();

    // Persist the (still-unconfirmed) secret so it survives a page reload
    await prisma.user.update({
      where: { id: req.user.id },
      data:  {
        twoFactorSecret:      encryptedSecret,
        twoFactorEnabled:     false, // not enabled until /enable is called
        twoFactorBackupCodes: JSON.stringify(hashedCodes),
      },
    });

    return res.json({
      success: true,
      data: {
        secret,      // plaintext — shown to user for manual entry in authenticator app
        qrCode,      // base64 data URL
        backupCodes: plainCodes, // shown ONCE — user must save these
      },
    });
  } catch (err) {
    console.error('2FA setup error:', err);
    return res.status(500).json({ success: false, error: 'Failed to set up 2FA' });
  }
});

// ── POST /api/auth/2fa/enable ─────────────────────────────────────────────────
// Confirm the TOTP code to activate 2FA.

router.post('/enable', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Verification code is required' });

    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { twoFactorSecret: true, twoFactorEnabled: true },
    });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (user.twoFactorEnabled) {
      return res.status(400).json({ success: false, error: '2FA is already enabled' });
    }
    if (!user.twoFactorSecret) {
      return res.status(400).json({ success: false, error: 'No 2FA setup in progress — call /setup first' });
    }

    const secret = decryptSecret(user.twoFactorSecret);
    // H1 (replay): capture the matched time-step and persist it as
    // twoFactorLastUsedStep so the SAME code used to enable 2FA cannot be
    // replayed at the first verify-login (within the ~30s window). Previously
    // /enable left twoFactorLastUsedStep null, so the enable code was a valid,
    // not-yet-recorded login code.
    const totpResult = verifyCodeWithStep(code, secret);
    if (!totpResult.valid) {
      return res.status(400).json({ success: false, error: 'Invalid verification code — please try again' });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data:  { twoFactorEnabled: true, twoFactorLastUsedStep: totpResult.step },
    });

    writeActivityLog({ accountId: req.user.accountId, userId: req.user.id, assetId: null, action: '2fa_enabled', details: null });
    return res.json({ success: true, message: '2FA has been enabled on your account.' });
  } catch (err) {
    console.error('2FA enable error:', err);
    return res.status(500).json({ success: false, error: 'Failed to enable 2FA' });
  }
});

// ── DELETE /api/auth/2fa/disable ──────────────────────────────────────────────
// Disable 2FA. Requires a valid TOTP code or backup code to confirm intent.

router.delete('/disable', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Verification code is required to disable 2FA' });

    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { twoFactorEnabled: true, twoFactorSecret: true, twoFactorBackupCodes: true },
    });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (!user.twoFactorEnabled) {
      return res.status(400).json({ success: false, error: '2FA is not currently enabled' });
    }

    const secret = decryptSecret(user.twoFactorSecret);
    const totpValid = verifyCode(code, secret);

    let backupUpdate: any = {};
    if (!totpValid) {
      // Try backup code
      const result = consumeBackupCode(code, user.twoFactorBackupCodes);
      if (!result.used) {
        return res.status(400).json({ success: false, error: 'Invalid code' });
      }
      backupUpdate = { twoFactorBackupCodes: JSON.stringify(result.remaining) };
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data:  {
        twoFactorEnabled:     false,
        twoFactorSecret:      null,
        twoFactorBackupCodes: null,
        ...backupUpdate,
      },
    });

    writeActivityLog({ accountId: req.user.accountId, userId: req.user.id, assetId: null, action: '2fa_disabled', details: null });
    return res.json({ success: true, message: '2FA has been disabled.' });
  } catch (err) {
    console.error('2FA disable error:', err);
    return res.status(500).json({ success: false, error: 'Failed to disable 2FA' });
  }
});

// ── POST /api/auth/2fa/backup-codes/regenerate ────────────────────────────────
// Invalidate old backup codes and generate a fresh set. Requires a TOTP code.

router.post('/backup-codes/regenerate', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Verification code is required' });

    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { twoFactorEnabled: true, twoFactorSecret: true },
    });
    if (!user?.twoFactorEnabled) {
      return res.status(400).json({ success: false, error: '2FA is not enabled' });
    }

    const secret = decryptSecret(user.twoFactorSecret);
    if (!verifyCode(code, secret)) {
      return res.status(400).json({ success: false, error: 'Invalid verification code' });
    }

    const { plainCodes, hashedCodes } = generateBackupCodes();
    await prisma.user.update({
      where: { id: req.user.id },
      data:  { twoFactorBackupCodes: JSON.stringify(hashedCodes) },
    });

    writeActivityLog({ accountId: req.user.accountId, userId: req.user.id, assetId: null, action: '2fa_backup_codes_regenerated', details: null });
    return res.json({
      success: true,
      data: { backupCodes: plainCodes },
    });
  } catch (err) {
    console.error('Backup codes regenerate error:', err);
    return res.status(500).json({ success: false, error: 'Failed to regenerate backup codes' });
  }
});

// ── POST /api/auth/2fa/verify-login ──────────────────────────────────────────
// Public endpoint (no auth middleware). Accepts a pending_2fa JWT + TOTP code
// and exchanges it for full access + refresh tokens.

router.post('/verify-login', totpLimiter, async (req, res) => {
  try {
    const { twoFactorToken, code } = req.body;
    if (!twoFactorToken || !code) {
      return res.status(400).json({ success: false, error: 'Token and code are required' });
    }

    const payload = verifyPending2faToken(twoFactorToken, req);
    if (!payload) {
      return res.status(401).json({ success: false, error: 'Session expired — please log in again' });
    }

    // H2: per-user brute-force check (IP-based totpLimiter already ran above)
    if (_checkTotpUserLimit(payload.userId).blocked) {
      return res.status(429).json({ success: false, error: 'Too many failed attempts — please try again in 5 minutes.' });
    }

    const user = await prisma.user.findUnique({
      where:  { id: payload.userId },
      select: {
        id: true, accountId: true, isActive: true,
        twoFactorEnabled: true, twoFactorSecret: true, twoFactorBackupCodes: true,
        twoFactorLastUsedStep: true,
        name: true, email: true, role: true, featureFlags: true, hiddenFeatures: true,
        lastLogin: true, createdAt: true,
      },
    });

    if (!user || !user.isActive || !user.twoFactorEnabled) {
      return res.status(401).json({ success: false, error: 'Invalid session' });
    }

    const secret = decryptSecret(user.twoFactorSecret);

    // H1: verify code and capture matched time-step for replay prevention
    const totpResult = verifyCodeWithStep(code, secret);

    let backupUpdate = null;
    let newLastUsedStep = null;

    if (!totpResult.valid) {
      // Try as backup code (backup codes are exempt from step replay — they're one-time)
      const result = consumeBackupCode(code, user.twoFactorBackupCodes);
      if (!result.used) {
        _recordTotpUserFail(user.id); // H2: track failure
        return res.status(401).json({ success: false, error: 'Invalid code — please try again' });
      }
      backupUpdate = JSON.stringify(result.remaining);
    } else {
      // H1: reject if this time-step was already used (replay attack)
      if (user.twoFactorLastUsedStep !== null &&
          user.twoFactorLastUsedStep !== undefined &&
          totpResult.step <= BigInt(user.twoFactorLastUsedStep)) {
        _recordTotpUserFail(user.id);
        return res.status(401).json({ success: false, error: 'Code already used — please wait for the next code.' });
      }
      newLastUsedStep = totpResult.step;
    }

    // Code is valid — clear fail counter, update lastLogin, persist step.
    _clearTotpUserFails(user.id);
    if (newLastUsedStep !== null) {
      // H1 (concurrency-safe replay prevention): the serial pre-check above
      // (totpResult.step <= stored) closes the sequential replay, but two
      // requests carrying the SAME not-yet-used code can both read the same old
      // step before either writes (TOCTOU). Claim the step atomically: only
      // advance when the stored step is still null or strictly older. Postgres
      // serializes the two row updates, so exactly one wins (count===1); the
      // loser matches 0 rows and is rejected as a replay.
      const claim = await prisma.user.updateMany({
        where: {
          id: user.id,
          OR: [
            { twoFactorLastUsedStep: null },
            { twoFactorLastUsedStep: { lt: newLastUsedStep } },
          ],
        },
        data: { lastLogin: new Date(), twoFactorLastUsedStep: newLastUsedStep },
      });
      if (claim.count === 0) {
        _recordTotpUserFail(user.id);
        return res.status(401).json({ success: false, error: 'Code already used — please wait for the next code.' });
      }
    } else {
      // Backup-code path: the one-time code was already consumed in-memory
      // (consumeBackupCode) and is persisted here. Step replay does not apply.
      await prisma.user.update({
        where: { id: user.id },
        data: {
          lastLogin: new Date(),
          ...(backupUpdate !== null ? { twoFactorBackupCodes: backupUpdate } : {}),
        },
      });
    }

    const { accessToken, refreshToken } = await issueTokenPair(user.id, user.accountId);

    // Omit sensitive fields from response
    const { twoFactorSecret: _s, twoFactorBackupCodes: _b, twoFactorLastUsedStep: _step, ...safeUser } = user;

    let parsedBackup: any = null;
    try {
      parsedBackup = backupUpdate ? JSON.parse(backupUpdate) : null;
    } catch {
      parsedBackup = null; // malformed JSON — treat as no backup codes
    }

    return res.json({
      success: true,
      data: {
        token: accessToken,
        refreshToken,
        user: safeUser,
        aiProvider: process.env.AI_PROVIDER || 'anthropic',
        ...(parsedBackup !== null && parsedBackup.length <= 2
          ? { warning: `Only ${parsedBackup.length} backup code(s) remaining — consider regenerating.` }
          : {}),
      },
    });
  } catch (err) {
    console.error('2FA verify-login error:', err);
    return res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// ── Export both the router AND the issuePending2faToken helper ────────────────
// auth.js needs issuePending2faToken without a circular dep.

module.exports = { router, issuePending2faToken };

export {};

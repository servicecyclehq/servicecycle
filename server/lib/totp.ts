/**
 * LapseIQ TOTP helpers
 *
 * Wraps otplib for TOTP generation/verification and handles:
 *   - Secret generation and encryption at rest (reuses lib/crypto.js)
 *   - QR code URI building (for authenticator apps)
 *   - One-time backup code generation, hashing, and verification
 */

const { authenticator } = require('otplib');
const QRCode            = require('qrcode');
const crypto            = require('crypto');
const { encryptIfNeeded, decryptIfEncrypted } = require('./crypto');

// ── TOTP config ───────────────────────────────────────────────────────────────
// 30-second step, 1-step window (accepts the previous and next code to handle
// small clock skew between server and user's phone).
authenticator.options = { step: 30, window: 1 };

const APP_NAME = process.env.APP_NAME || 'LapseIQ';

// ── Secret management ─────────────────────────────────────────────────────────

/**
 * Generate a new Base32 TOTP secret and return both the raw secret (for display
 * to the user during setup) and the encrypted version (for DB storage).
 */
function generateSecret() {
  const secret = authenticator.generateSecret(20); // 160-bit secret = standard
  return { secret, encryptedSecret: encryptIfNeeded(secret) };
}

/**
 * Build a TOTP URI that authenticator apps (Google Authenticator, Authy, etc.)
 * can parse from a QR code.
 */
function buildOtpUri(secret, email) {
  return authenticator.keyuri(email, APP_NAME, secret);
}

/**
 * Generate a QR code as a Base64 data URL from a TOTP URI.
 * Returns a promise that resolves to a data URL string.
 */
async function generateQrDataUrl(otpUri) {
  return QRCode.toDataURL(otpUri, { width: 256, margin: 2 });
}

/**
 * Verify a 6-digit TOTP code against a (plaintext) secret.
 * Returns true/false.
 */
function verifyCode(code, secret) {
  try {
    return authenticator.verify({ token: String(code).replace(/\s/g, ''), secret });
  } catch {
    return false;
  }
}

/**
 * Verify a TOTP code and return the exact time-step that matched.
 * Used for replay prevention (H1): callers persist the matched step and
 * reject any future code whose step <= the stored value.
 *
 * The window is [-1, 0, +1] steps (matches authenticator.options.window = 1).
 * We iterate the window manually using HOTP with the step as counter so we
 * can identify which step the accepted code belongs to.
 *
 * @returns {{ valid: false } | { valid: true, step: bigint }}
 */
function verifyCodeWithStep(code, secret) {
  const token = String(code).replace(/\s/g, '');
  try {
    if (!authenticator.verify({ token, secret })) return { valid: false };

    // Identify the matched step within the window
    const { hotp } = require('otplib');
    const stepSize  = authenticator.options.step ?? 30;
    const window    = authenticator.options.window ?? 1;
    const nowStep   = BigInt(Math.floor(Date.now() / 1000 / stepSize));

    for (let delta = -window; delta <= window; delta++) {
      const candidate = nowStep + BigInt(delta);
      try {
        if (hotp.generate(secret, Number(candidate)) === token) {
          return { valid: true, step: candidate };
        }
      } catch {}
    }

    // Verify passed but step identification failed (shouldn't happen) —
    // use current step as a conservative approximation
    return { valid: true, step: nowStep };
  } catch {
    return { valid: false };
  }
}

// ── Backup codes ──────────────────────────────────────────────────────────────

const BACKUP_CODE_COUNT  = 8;
const BACKUP_CODE_LENGTH = 10; // characters

/**
 * Generate N backup codes.
 * Returns { plainCodes: string[], hashedCodes: string[] }
 * plainCodes are shown to the user ONCE; hashedCodes are stored in the DB.
 */
function generateBackupCodes() {
  const plainCodes  = [];
  const hashedCodes = [];

  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    // Format: XXXXX-XXXXX (easier to read/type)
    const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
    const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
    plainCodes.push(code);
    hashedCodes.push(hashBackupCode(code));
  }

  return { plainCodes, hashedCodes };
}

/**
 * SHA-256 hash a backup code (normalised to uppercase, no spaces/hyphens).
 */
function hashBackupCode(code) {
  const normalised = code.toUpperCase().replace(/[-\s]/g, '');
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

/**
 * Try to consume a backup code from the stored JSON array of hashed codes.
 * Returns { used: true, remaining: string[] } if valid, { used: false } otherwise.
 * The caller must persist the updated `remaining` array back to the DB.
 */
function consumeBackupCode(inputCode, storedHashesJson) {
  let hashes;
  try {
    hashes = JSON.parse(storedHashesJson || '[]');
  } catch {
    return { used: false };
  }

  const inputHash = hashBackupCode(inputCode);
  const idx = hashes.indexOf(inputHash);
  if (idx === -1) return { used: false };

  const remaining = [...hashes];
  remaining.splice(idx, 1);
  return { used: true, remaining };
}

// ── Decrypt helper ────────────────────────────────────────────────────────────

function decryptSecret(encryptedSecret) {
  return decryptIfEncrypted(encryptedSecret);
}

module.exports = {
  generateSecret,
  buildOtpUri,
  generateQrDataUrl,
  verifyCode,
  verifyCodeWithStep,
  generateBackupCodes,
  hashBackupCode,
  consumeBackupCode,
  decryptSecret,
};

export {};

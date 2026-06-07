/**
 * server/lib/crypto.js
 *
 * AES-256-GCM envelope encryption for secrets stored in the DB.
 *
 * Stored format (base64-encoded):
 *   "enc.v1:" prefix + base64( iv[12] || authTag[16] || ciphertext[n] )
 *
 * The "enc.v1:" sentinel lets read paths distinguish encrypted values from
 * legacy plaintext values so migration can be done gracefully.
 *
 * MASTER_KEY env var must be a 32-byte key encoded as base64 (44 chars).
 * Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

'use strict';

const crypto = require('crypto');

const SENTINEL = 'enc.v1:';
const IV_LEN   = 12;  // GCM recommended IV length
const TAG_LEN  = 16;  // GCM auth tag length
const ALGO     = 'aes-256-gcm';

function getMasterKey() {
  const b64 = process.env.MASTER_KEY;
  if (!b64) throw new Error('MASTER_KEY env var is not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`MASTER_KEY must decode to 32 bytes; got ${key.length}`);
  return key;
}

/**
 * Encrypt a plaintext string.
 * Returns a string with the "enc.v1:" sentinel prefix.
 */
function encrypt(plaintext) {
  const key = getMasterKey();
  const iv  = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack: iv(12) || authTag(16) || ciphertext(n)
  const payload = Buffer.concat([iv, tag, encrypted]);
  return SENTINEL + payload.toString('base64');
}

/**
 * Decrypt a value previously produced by encrypt().
 * Throws on auth-tag failure or malformed input.
 */
function decrypt(storedValue) {
  if (!isEncrypted(storedValue)) {
    throw new Error('decrypt() called on a value that is not encrypted (missing sentinel)');
  }
  const key = getMasterKey();
  const payload = Buffer.from(storedValue.slice(SENTINEL.length), 'base64');

  if (payload.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Encrypted payload is too short to be valid');
  }

  const iv         = payload.subarray(0, IV_LEN);
  const tag        = payload.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = payload.subarray(IV_LEN + TAG_LEN);

  // authTagLength explicit so Node won't accept a truncated tag.
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Decryption failed: auth tag mismatch or corrupted ciphertext');
  }
}

/** Returns true if the value was produced by encrypt() (has sentinel). */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(SENTINEL);
}

/**
 * Encrypt only if not already encrypted.
 * Safe to call on both fresh values and values already encrypted (idempotent).
 */
function encryptIfNeeded(plaintext) {
  if (!plaintext) return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  return encrypt(plaintext);
}

/**
 * Decrypt only if the value is encrypted.
 * Returns plaintext unchanged.
 */
function decryptIfEncrypted(value) {
  if (!value) return value;
  if (isEncrypted(value)) return decrypt(value);
  return value;
}

module.exports = { encrypt, decrypt, isEncrypted, encryptIfNeeded, decryptIfEncrypted };

export {};

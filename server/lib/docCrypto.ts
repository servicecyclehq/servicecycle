'use strict';

/**
 * lib/docCrypto.js
 * ----------------
 * AES-256-GCM document encryption for LapseIQ at-rest document storage.
 *
 * ENCRYPTION IS OPT-IN. It is NOT enabled by default.
 * Admins must explicitly enable it in Settings → Security after completing
 * a mandatory acknowledgment flow that requires proving the MASTER_KEY
 * is backed up. This protects customers from accidentally locking themselves
 * out of their own documents.
 *
 * ── What this protects against ───────────────────────────────────────────────
 * Encrypting documents before they reach disk or cloud storage protects
 * against unauthorized access at the storage layer:
 *   - Physical disk/drive theft
 *   - Unauthorized filesystem or S3 bucket access
 *   - Backups of the storage volume landing in the wrong hands
 *
 * It does NOT protect against an attacker who has:
 *   - Full access to the running LapseIQ server process
 *   - Access to the .env file (which contains MASTER_KEY)
 *   - Control of the host OS
 *
 * ── Key derivation ────────────────────────────────────────────────────────────
 * A unique AES-256 key is derived for each document using HKDF-SHA256:
 *   key = HKDF(MASTER_KEY, salt=documentId, info='lapseiq-doc-v1', length=32)
 *
 * This means:
 *   - Each document is encrypted with a distinct key
 *   - Compromising one document's derived key does not affect others
 *   - All keys are derived on demand from MASTER_KEY — no key storage needed
 *   - Rotating to a new MASTER_KEY requires re-encrypting all documents
 *     (not yet automated — a future migration tool would handle this)
 *
 * ── Wire format ───────────────────────────────────────────────────────────────
 * Encrypted blobs use a versioned format:
 *   [version: 1 byte][iv: 12 bytes][authTag: 16 bytes][ciphertext: N bytes]
 *
 * The auth tag provides authenticated encryption — any tampering with the
 * ciphertext will cause decryption to fail with an error.
 */

const crypto = require('crypto');

const VERSION  = 0x01;
const KEY_LEN  = 32;   // AES-256
const IV_LEN   = 12;   // 96-bit IV (optimal for GCM)
const TAG_LEN  = 16;   // 128-bit authentication tag
const HEADER   = 1 + IV_LEN + TAG_LEN;   // 29 bytes total header

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derive a per-document AES-256 key from MASTER_KEY.
 * Uses HKDF-SHA256 with the document ID as salt, ensuring each document
 * gets a cryptographically distinct key.
 *
 * @param {string} documentId — the UUID of the Document record
 * @returns {Buffer} 32-byte derived key
 */
function deriveDocumentKey(documentId) {
  const masterKey = process.env.MASTER_KEY;
  if (!masterKey) throw new Error('MASTER_KEY is not set — cannot derive document encryption key.');

  // MASTER_KEY may be base64 or raw string — normalise to Buffer
  let keyMaterial;
  try {
    keyMaterial = Buffer.from(masterKey, 'base64');
    // If base64 decode yields < 16 bytes it wasn't base64 — treat as utf8
    if (keyMaterial.length < 16) keyMaterial = Buffer.from(masterKey, 'utf8');
  } catch {
    keyMaterial = Buffer.from(masterKey, 'utf8');
  }

  const salt = Buffer.from(documentId, 'utf8');
  const info = Buffer.from('lapseiq-doc-v1', 'utf8');
  return crypto.hkdfSync('sha256', keyMaterial, salt, info, KEY_LEN);
}

// ── Encrypt ───────────────────────────────────────────────────────────────────

/**
 * Encrypt a document buffer with AES-256-GCM.
 *
 * @param {Buffer} plaintext   — raw file bytes
 * @param {string} documentId  — Document record UUID (used for key derivation)
 * @returns {Buffer}           — versioned encrypted blob
 */
function encrypt(plaintext, documentId) {
  const key    = deriveDocumentKey(documentId);
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag    = cipher.getAuthTag();  // 16 bytes

  // Assemble: [version][iv][authTag][ciphertext]
  const out = Buffer.allocUnsafe(HEADER + ciphertext.length);
  out[0] = VERSION;
  iv.copy(out, 1);
  authTag.copy(out, 1 + IV_LEN);
  ciphertext.copy(out, HEADER);

  return out;
}

// ── Decrypt ───────────────────────────────────────────────────────────────────

/**
 * Decrypt a document buffer encrypted by encrypt().
 * Throws if the auth tag doesn't match (tampered or wrong key).
 *
 * @param {Buffer} cipherBlob  — versioned encrypted blob from storage
 * @param {string} documentId  — Document record UUID (used for key derivation)
 * @returns {Buffer}           — original plaintext bytes
 */
function decrypt(cipherBlob, documentId) {
  if (!Buffer.isBuffer(cipherBlob) || cipherBlob.length < HEADER + 1) {
    throw new Error('Invalid encrypted document blob (too short).');
  }

  const version = cipherBlob[0];
  if (version !== VERSION) {
    throw new Error(`Unknown document encryption version: ${version}. This blob may have been created by a newer version of LapseIQ.`);
  }

  const iv         = cipherBlob.slice(1, 1 + IV_LEN);
  const authTag    = cipherBlob.slice(1 + IV_LEN, HEADER);
  const ciphertext = cipherBlob.slice(HEADER);

  const key      = deriveDocumentKey(documentId);
  // authTagLength explicit so Node won't accept a truncated tag.
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Document decryption failed — authentication tag mismatch. The file may be corrupted or the MASTER_KEY may have changed.');
  }
}

// ── MASTER_KEY verification ───────────────────────────────────────────────────

/**
 * Verify that an 8-character input matches the last 8 characters of MASTER_KEY.
 * Used during the encryption opt-in flow to prove the admin has the actual key
 * accessible before enabling encryption.
 *
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param {string} tail — 8 characters the admin entered
 * @returns {boolean}
 */
function verifyMasterKeyTail(tail) {
  if (!tail || typeof tail !== 'string' || tail.length !== 8) return false;
  const actual = process.env.MASTER_KEY || '';
  if (actual.length < 8) return false;
  const expected = actual.slice(-8);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(tail, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Returns the last 4 characters of MASTER_KEY as a hint for the UI
 * (so admins can confirm which key is active without exposing it).
 *
 * @returns {string} e.g. '…X7gQ'
 */
function masterKeyHint() {
  const k = process.env.MASTER_KEY || '';
  if (k.length < 4) return '(not set)';
  return `…${k.slice(-4)}`;
}

module.exports = { encrypt, decrypt, verifyMasterKeyTail, masterKeyHint };

export {};

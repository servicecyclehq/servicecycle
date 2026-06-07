'use strict';

/**
 * server/lib/backupCrypto.js
 *
 * AES-256-GCM encryption for backup blobs (gzipped pg_dump bytes).
 *
 * Distinct from lib/crypto.js (which handles string DB-credential
 * encryption with base64 + sentinel) and lib/docCrypto.js (which derives
 * per-document keys via HKDF). Backups use a single deterministic key
 * derived from MASTER_KEY so restore tooling doesn't need a per-backup
 * salt — the only secret needed is MASTER_KEY itself, which the operator
 * already has to keep safe.
 *
 * On-disk format (binary, no base64):
 *   [magic 8 bytes "LBKE0001"][iv 12 bytes][authTag 16 bytes][ciphertext n bytes]
 *
 * Total overhead: 36 bytes per backup file. The .gz file already inside
 * the ciphertext is unaffected by the wrapper.
 *
 * Why a fresh module instead of extending lib/crypto.js:
 *   - Buffer-in / Buffer-out vs. string-in / string-out — different shapes.
 *   - The backup magic header is binary (not the "enc.v1:" string prefix).
 *   - Backups can be very large (multi-GB); base64 round-tripping inside
 *     lib/crypto.js would double their size on disk.
 *
 * Restore CLI: `node scripts/decrypt-backup.js <encrypted.gz> <output.gz>`
 * (companion script, not yet shipped — reachable via the operator playbook).
 */

const crypto = require('crypto');

const MAGIC    = Buffer.from('LBKE0001', 'utf8'); // 8 bytes
const IV_LEN   = 12;
const TAG_LEN  = 16;
const HEADER   = MAGIC.length + IV_LEN + TAG_LEN; // 36 bytes
const ALGO     = 'aes-256-gcm';
const KEY_INFO = Buffer.from('lapseiq-backup-v1', 'utf8');

/**
 * Derive the AES-256 backup key from MASTER_KEY using HKDF-SHA256. Salt is
 * a constant so the key is deterministic per-instance — restore on the same
 * MASTER_KEY produces the same key without any per-backup metadata.
 */
function deriveBackupKey() {
  const masterKey = process.env.MASTER_KEY;
  if (!masterKey) throw new Error('MASTER_KEY is not set — cannot encrypt backups.');

  // MASTER_KEY may be base64 (44 chars decoding to 32 bytes) or raw string.
  // Normalise to a Buffer the same way docCrypto.js does.
  let keyMaterial;
  try {
    keyMaterial = Buffer.from(masterKey, 'base64');
    if (keyMaterial.length < 16) keyMaterial = Buffer.from(masterKey, 'utf8');
  } catch {
    keyMaterial = Buffer.from(masterKey, 'utf8');
  }

  // Salt is the magic string — stable across the install lifetime.
  const salt = MAGIC;
  return crypto.hkdfSync('sha256', keyMaterial, salt, KEY_INFO, 32);
}

/**
 * Encrypt a backup buffer. Returns a buffer in the on-disk format above.
 */
function encryptBackup(plaintext) {
  if (!Buffer.isBuffer(plaintext)) {
    throw new Error('encryptBackup: plaintext must be a Buffer');
  }
  const key = deriveBackupKey();
  const iv  = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

/**
 * Decrypt a backup buffer produced by encryptBackup. Throws on header
 * mismatch (not a LapseIQ backup), short payload, or auth-tag mismatch
 * (corrupted file or wrong MASTER_KEY).
 */
function decryptBackup(blob) {
  if (!Buffer.isBuffer(blob)) {
    throw new Error('decryptBackup: blob must be a Buffer');
  }
  // Check magic FIRST so a short or unrelated buffer gets the more
  // actionable error ("not a LapseIQ backup") instead of a generic
  // "too short" — the operator running decrypt-backup.js usually
  // pointed it at the wrong file rather than a truncated one.
  if (blob.length < MAGIC.length || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Backup blob is missing the LapseIQ encryption header — not encrypted by this tool, or corrupted.');
  }
  if (blob.length < HEADER) {
    throw new Error('Backup blob is too short to be valid (header truncated).');
  }
  const iv  = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = blob.subarray(MAGIC.length + IV_LEN, HEADER);
  const ciphertext = blob.subarray(HEADER);

  const key = deriveBackupKey();
  // authTagLength MUST be pinned to 16 explicitly — without it, Node's GCM
  // implementation accepts any tag length 4-16 bytes, which would let an
  // attacker truncate the tag and brute-force a forgery on a shorter
  // verifier. Defensive even though our header always carries exactly 16.
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new Error('Backup decryption failed — the file is corrupt OR MASTER_KEY has changed since this backup was taken.');
  }
}

/** True if a buffer starts with the LapseIQ backup magic header. */
function isEncryptedBackup(blob) {
  return Buffer.isBuffer(blob)
      && blob.length >= MAGIC.length
      && blob.subarray(0, MAGIC.length).equals(MAGIC);
}

module.exports = { encryptBackup, decryptBackup, isEncryptedBackup, MAGIC, HEADER };

export {};

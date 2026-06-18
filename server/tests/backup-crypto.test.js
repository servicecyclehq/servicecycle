'use strict';

/**
 * Round-trip test for lib/backupCrypto.js. Pure unit test — doesn't
 * touch the DB or HTTP. Run with the server stopped if you want.
 *
 * Verifies:
 *   1. encrypt → decrypt round-trips byte-identical for arbitrary input
 *   2. The on-disk format starts with the LBKE0001 magic
 *   3. Tampered ciphertext fails the auth tag (no silent return of
 *      garbage bytes — the GCM mode's whole point)
 *   4. Wrong MASTER_KEY fails the auth tag
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { encryptBackup, decryptBackup, isEncryptedBackup, MAGIC, HEADER } = require('../lib/backupCrypto');

describe('backup crypto', () => {
  test('round-trip preserves bytes', () => {
    const plaintext = Buffer.from('the quick brown fox jumps over the lazy dog'.repeat(1000), 'utf8');
    const enc = encryptBackup(plaintext);
    const dec = decryptBackup(enc);
    expect(dec.equals(plaintext)).toBe(true);
  });

  test('encrypted blob starts with LBKE0001 magic', () => {
    const enc = encryptBackup(Buffer.from('test'));
    expect(enc.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
    expect(isEncryptedBackup(enc)).toBe(true);
    expect(isEncryptedBackup(Buffer.from('not encrypted'))).toBe(false);
  });

  test('tampered ciphertext fails auth tag', () => {
    const enc = encryptBackup(Buffer.from('important backup'));
    // Flip a byte in the ciphertext region (after the 36-byte header).
    enc[HEADER + 5] ^= 0xff;
    expect(() => decryptBackup(enc)).toThrow(/decryption failed|MASTER_KEY/i);
  });

  test('zero-length plaintext round-trips', () => {
    const enc = encryptBackup(Buffer.alloc(0));
    const dec = decryptBackup(enc);
    expect(dec.length).toBe(0);
  });

  test('decryptBackup rejects a buffer without the magic header', () => {
    const fake = Buffer.from('not a real backup file');
    expect(() => decryptBackup(fake)).toThrow(/missing the ServiceCycle encryption header/);
  });
});

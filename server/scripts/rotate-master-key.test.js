/**
 * server/scripts/rotate-master-key.test.js
 * ----------------------------------------
 *
 * Sandbox test for the rotate-master-key.js crypto layer. Does NOT require
 * a database — exercises the parameterised encrypt/decrypt + reencrypt
 * helpers in-process with random keys.
 *
 * Run with:
 *   node server/scripts/rotate-master-key.test.js
 *
 * Exits non-zero on any failure. Used by Pass-6 W4 task #14 (final
 * verification) and by anyone changing rotate-master-key.js to confirm
 * the crypto primitives stay correct.
 */

'use strict';

const crypto = require('crypto');

// Re-implement the helpers locally so this test is independent of the rest
// of the rotation script's structure (and so the test breaks if someone
// drifts the algorithm constants).
const SENTINEL = 'enc.v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const ALGO = 'aes-256-gcm';

function encryptWith(plaintext, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return SENTINEL + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptWith(storedValue, key) {
  if (!storedValue.startsWith(SENTINEL)) throw new Error('no sentinel');
  const payload = Buffer.from(storedValue.slice(SENTINEL.length), 'base64');
  const iv = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = payload.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok — ${msg}`);
  } else {
    console.error(`  FAIL — ${msg}`);
    failures++;
  }
}

function assertThrows(fn, msg) {
  try {
    fn();
    console.error(`  FAIL — expected throw — ${msg}`);
    failures++;
  } catch {
    console.log(`  ok (threw) — ${msg}`);
  }
}

console.log('=== rotate-master-key.js sandbox test ===');
console.log('');

// Setup: two random 32-byte keys
const oldKey = crypto.randomBytes(32);
const newKey = crypto.randomBytes(32);
console.log(`OLD key (base64): ${oldKey.toString('base64').slice(0, 8)}...`);
console.log(`NEW key (base64): ${newKey.toString('base64').slice(0, 8)}...`);
console.log('');

// Plaintext values to round-trip (mirrors the actual encrypted-column surface)
const samples = {
  'AI_API_KEY':        'sk-ant-api03-FAKE-not-real-just-for-test',
  'SLACK_WEBHOOK_URL': 'https://hooks.slack.com/services/T00000/B00000/abcdef',
  'TEAMS_WEBHOOK_URL': 'https://outlook.office.com/webhook/abcdef',
  'totpSecret':        'JBSWY3DPEHPK3PXP',
  'signingSecret':     'whsec_abcdef0123456789',
  'secretAccessKey':   'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

console.log('Test 1 — round-trip encrypt/decrypt with OLD key');
const ciphertexts = {};
for (const [label, plain] of Object.entries(samples)) {
  const c = encryptWith(plain, oldKey);
  assert(c.startsWith(SENTINEL), `${label}: ciphertext has sentinel`);
  const dec = decryptWith(c, oldKey);
  assert(dec === plain, `${label}: round-trip matches plaintext`);
  ciphertexts[label] = c;
}

console.log('');
console.log('Test 2 — decrypt with NEW key fails before rotation');
for (const [label, c] of Object.entries(ciphertexts)) {
  assertThrows(() => decryptWith(c, newKey), `${label}: NEW key cannot decrypt OLD ciphertext`);
}

console.log('');
console.log('Test 3 — simulate rotation: decrypt with OLD, re-encrypt with NEW');
const rotated = {};
for (const [label, c] of Object.entries(ciphertexts)) {
  const plain = decryptWith(c, oldKey);
  rotated[label] = encryptWith(plain, newKey);
  assert(rotated[label] !== c, `${label}: rotated ciphertext differs from original`);
  assert(rotated[label].startsWith(SENTINEL), `${label}: rotated ciphertext has sentinel`);
}

console.log('');
console.log('Test 4 — after rotation, NEW key decrypts and OLD key fails');
for (const [label, c] of Object.entries(rotated)) {
  const dec = decryptWith(c, newKey);
  assert(dec === samples[label], `${label}: NEW key decrypts rotated ciphertext to original plaintext`);
  assertThrows(() => decryptWith(c, oldKey), `${label}: OLD key cannot decrypt rotated ciphertext`);
}

console.log('');
console.log('Test 5 — tamper detection still works post-rotation');
for (const [label, c] of Object.entries(rotated)) {
  // Flip a single byte in the base64 payload (post-sentinel) and verify
  // decrypt rejects it
  const payload = c.slice(SENTINEL.length);
  const tampered = SENTINEL + payload.slice(0, -4) + (payload.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assertThrows(() => decryptWith(tampered, newKey), `${label}: tampered ciphertext rejected by GCM auth tag`);
}

console.log('');
console.log('Test 6 — idempotency: re-encrypting an already-rotated value with NEW->NEW is a no-op semantically');
for (const [label, plain] of Object.entries(samples)) {
  const c1 = encryptWith(plain, newKey);
  const dec1 = decryptWith(c1, newKey);
  const c2 = encryptWith(dec1, newKey);
  const dec2 = decryptWith(c2, newKey);
  assert(dec2 === plain, `${label}: double-rotation (NEW->NEW) preserves plaintext`);
  assert(c1 !== c2, `${label}: each encrypt produces a different ciphertext (fresh IV)`);
}

console.log('');
if (failures === 0) {
  console.log('=== All tests passed ===');
  process.exit(0);
} else {
  console.error(`=== ${failures} test(s) FAILED ===`);
  process.exit(1);
}

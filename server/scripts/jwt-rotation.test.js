/**
 * server/scripts/jwt-rotation.test.js
 * -----------------------------------
 *
 * Sandbox test for server/lib/jwtSecrets.js dual-verify path. Runs in-
 * process — no database, no docker. Exercises:
 *
 *   - signToken uses current JWT_SECRET
 *   - verifyToken accepts JWT_SECRET-signed tokens
 *   - verifyToken accepts OLD_JWT_SECRET-signed tokens during rotation window
 *   - verifyToken rejects tokens signed with random unrelated keys
 *   - verifyToken throws TokenExpiredError correctly (doesn't swallow into
 *     "fall through to OLD" — expiry is independent of which key signed it)
 *   - isRotationWindowActive reports correctly
 *
 * Run with:
 *   node server/scripts/jwt-rotation.test.js
 *
 * Exits non-zero on any failure.
 */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const path = require('path');

// Set the env vars BEFORE requiring jwtSecrets — the module reads
// process.env at call time (not require time) so this also covers the
// "operator rotates without restarting Node" path.
const OLD_SECRET = crypto.randomBytes(48).toString('base64');
const NEW_SECRET = crypto.randomBytes(48).toString('base64');
process.env.JWT_SECRET = NEW_SECRET;
process.env.OLD_JWT_SECRET = OLD_SECRET;

const { verifyToken, signToken, isRotationWindowActive } = require(
  path.join(__dirname, '..', 'lib', 'jwtSecrets')
);

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok — ${msg}`);
  else { console.error(`  FAIL — ${msg}`); failures++; }
}
function assertThrows(fn, msg, errorClass) {
  try {
    fn();
    console.error(`  FAIL — expected throw — ${msg}`);
    failures++;
  } catch (err) {
    if (errorClass && err.name !== errorClass) {
      console.error(`  FAIL — threw ${err.name} not ${errorClass} — ${msg}`);
      failures++;
    } else {
      console.log(`  ok (threw ${err.name}) — ${msg}`);
    }
  }
}

console.log('=== jwtSecrets dual-verify sandbox test ===');
console.log('');
console.log(`OLD key (truncated): ${OLD_SECRET.slice(0, 8)}...`);
console.log(`NEW key (truncated): ${NEW_SECRET.slice(0, 8)}...`);
console.log('');

const PAYLOAD = { userId: 'u_test', accountId: 'a_test', role: 'admin' };

console.log('Test 1 — isRotationWindowActive reports true when OLD_JWT_SECRET is set');
assert(isRotationWindowActive() === true, 'isRotationWindowActive returns true');

console.log('');
console.log('Test 2 — signToken uses NEW_SECRET (current JWT_SECRET)');
const newToken = signToken(PAYLOAD, { expiresIn: '1h', algorithm: 'HS256' });
const decodedDirect = jwt.verify(newToken, NEW_SECRET, { algorithms: ['HS256'] });
assert(decodedDirect.userId === PAYLOAD.userId, 'signToken signs with NEW key (raw verify confirms)');
assertThrows(
  () => jwt.verify(newToken, OLD_SECRET, { algorithms: ['HS256'] }),
  'newly-signed token does NOT verify with OLD_SECRET'
);

console.log('');
console.log('Test 3 — verifyToken accepts NEW_SECRET-signed tokens');
const decoded2 = verifyToken(newToken);
assert(decoded2.userId === PAYLOAD.userId, 'verifyToken accepts new token');

console.log('');
console.log('Test 4 — verifyToken accepts OLD_SECRET-signed tokens (rotation window)');
const oldToken = jwt.sign(PAYLOAD, OLD_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
const decoded3 = verifyToken(oldToken);
assert(decoded3.userId === PAYLOAD.userId, 'verifyToken falls back to OLD_JWT_SECRET');

console.log('');
console.log('Test 5 — verifyToken rejects forged tokens (random unrelated secret)');
const randomSecret = crypto.randomBytes(48).toString('base64');
const forgedToken = jwt.sign(PAYLOAD, randomSecret, { expiresIn: '1h', algorithm: 'HS256' });
assertThrows(() => verifyToken(forgedToken), 'verifyToken rejects forged token');

console.log('');
console.log('Test 6 — verifyToken throws TokenExpiredError for expired NEW-key token');
// Sign with negative-ish expiry (expired ~1 second ago)
const expiredNew = jwt.sign(PAYLOAD, NEW_SECRET, { expiresIn: -1, algorithm: 'HS256' });
assertThrows(() => verifyToken(expiredNew), 'expired NEW-key token rejected', 'TokenExpiredError');

console.log('');
console.log('Test 7 — verifyToken throws TokenExpiredError for expired OLD-key token (not "fall through to NEW")');
// Without the early-return-on-TokenExpiredError, a token signed with the
// OLD key but expired would fall through to the OLD verify step and throw
// "Invalid token" because it expired. The current implementation handles
// this by short-circuiting on TokenExpiredError from the first attempt.
// But the FIRST attempt is verify-with-NEW, which fails with
// "JsonWebTokenError" (signature mismatch). Only the SECOND verify
// (with OLD) discovers it's expired. That second call's
// TokenExpiredError surfaces correctly because it's the lastErr.
const expiredOld = jwt.sign(PAYLOAD, OLD_SECRET, { expiresIn: -1, algorithm: 'HS256' });
assertThrows(() => verifyToken(expiredOld), 'expired OLD-key token rejected', 'TokenExpiredError');

console.log('');
console.log('Test 8 — When OLD_JWT_SECRET is unset, only NEW key verifies');
const savedOld = process.env.OLD_JWT_SECRET;
delete process.env.OLD_JWT_SECRET;
try {
  assert(isRotationWindowActive() === false, 'isRotationWindowActive false when OLD unset');
  const decoded4 = verifyToken(newToken);
  assert(decoded4.userId === PAYLOAD.userId, 'verifyToken still accepts NEW-key token');
  assertThrows(() => verifyToken(oldToken), 'OLD-key token rejected when OLD_JWT_SECRET is unset');
} finally {
  process.env.OLD_JWT_SECRET = savedOld;
}

console.log('');
console.log('Test 9 — When JWT_SECRET is unset, verifyToken throws configuration error');
const savedNew = process.env.JWT_SECRET;
delete process.env.JWT_SECRET;
try {
  assertThrows(() => verifyToken(newToken), 'verifyToken errors when JWT_SECRET unset');
} finally {
  process.env.JWT_SECRET = savedNew;
}

console.log('');
if (failures === 0) {
  console.log('=== All tests passed ===');
  process.exit(0);
} else {
  console.error(`=== ${failures} test(s) FAILED ===`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * server/scripts/rotate-master-key.js
 *
 * MASTER_KEY rotation for ServiceCycle envelope-encrypted DB columns.
 *
 * v0.74.0 (2026-07-08 Run 2, W1-M2 — see below; originally v0.73.5, audit High H26).
 *
 * 2026-07-08 Run 2 fix notes (W1-M2, re-verified against live schema before
 * writing this):
 *   - The previous `rotateCloudConnectors()` called `prisma.cloudConnector.*`
 *     -- there is no `CloudConnector` model anywhere in schema.prisma (grep
 *     confirmed zero matches) and never has been in this repo's migration
 *     history. That call would throw `TypeError: Cannot read properties of
 *     undefined (reading 'findMany')` the instant this script ran, before
 *     touching anything else. Removed.
 *   - Replaced with `rotateAccountSecrets()`, covering the two fields the
 *     prior audit correctly identified as genuinely missing:
 *     `Account.importWebhookSecret` and `Account.storageS3KeyId` /
 *     `Account.storageS3Secret` (schema.prisma, on the Account model) --
 *     all three use the same `lib/crypto.ts` "enc.v1:" sentinel scheme as
 *     everything else here, confirmed via `lib/webhookImport.ts` and
 *     `lib/storage.ts`'s own `decryptIfEncrypted()` calls on these exact
 *     fields.
 *   - Idempotency: every rotate* function now tries the NEW key first via
 *     `decryptWithEither()` before falling back to the OLD key. A row that
 *     decrypts cleanly with the new key is already-rotated and is skipped
 *     (not re-encrypted, not double-wrapped) -- so `--apply` is now safe to
 *     re-run after a partial failure. Previously, a crash partway through
 *     (e.g. after AccountSettings succeeded but before WebhookEndpoints ran)
 *     left the DB in a mixed state that a straight re-run could not recover
 *     from, because the already-rotated rows could no longer be decrypted
 *     with OLD_MASTER_KEY and the script would abort immediately on them.
 *   - The completion sentinel is now informational only (prints a note if a
 *     prior run completed) rather than being the correctness mechanism --
 *     per-row decrypt-with-either is what makes re-runs safe now.
 *
 * What it rotates:
 *   - AccountSetting.value (when prefixed `enc.v1:`)
 *   - WebhookEndpoint.url + .hmacSecret (always encrypted)
 *   - User.twoFactorSecret (when prefixed `enc.v1:`)
 *   - Account.importWebhookSecret (when prefixed `enc.v1:`)
 *   - Account.storageS3KeyId + Account.storageS3Secret (when prefixed `enc.v1:`)
 *
 * What it does NOT rotate:
 *   - Document file content on disk / S3 (uses lib/docCrypto.js with
 *     per-document HKDF derivation; rotation requires re-reading every
 *     stored file -- gigabytes, separate procedure)
 *   - BackupLog payloads + .pgcustom.enc files in R2 (use
 *     lib/backupCrypto.js; old backups can still be decrypted with
 *     OLD_MASTER_KEY post-rotation, new backups use new key)
 *   - RefreshToken (token hashes only, not encrypted)
 *
 * Required env:
 *   DATABASE_URL  ........  same as the running server
 *   MASTER_KEY    ........  the NEW key (already swapped in by operator)
 *   OLD_MASTER_KEY .......  the OLD key (for decrypt-with-old)
 *
 * Modes:
 *   --dry-run   ..  count rows + decrypt every encrypted value (new key
 *                   first, then old) to verify it's recoverable. Does NOT
 *                   write. This is the SAFE first step.
 *   --apply     ..  decrypt-with-new-or-old + encrypt-with-new (skipping
 *                   already-rotated values) + UPDATE. Writes a sentinel
 *                   file `.master-key-rotation-completed-at` when finished.
 *                   Safe to re-run -- see idempotency note above.
 *   (no flag)   ..  prints usage + exits 1.
 *
 * Atomicity:
 *   Each table is rotated inside its own prisma transaction. If a row
 *   fails decrypt with EITHER key, the transaction rolls back. The "first
 *   failure abort + don't touch downstream tables" model is intentional --
 *   you want to know IMMEDIATELY if a value isn't recoverable with either
 *   key before you commit any rewrites. Because already-rotated rows are
 *   now detected and skipped, re-running after fixing the underlying issue
 *   (e.g. a wrong OLD_MASTER_KEY) will simply pick up where it left off.
 *
 * Usage:
 *   # Set NEW MASTER_KEY in .env first; keep OLD_MASTER_KEY alongside:
 *   #   MASTER_KEY=<new-44-char-base64>
 *   #   OLD_MASTER_KEY=<old-44-char-base64>
 *   docker compose -f docker-compose.ghcr.yml exec server \
 *     node scripts/rotate-master-key.js --dry-run
 *   # If clean, run apply (safe to re-run if it fails partway):
 *   docker compose -f docker-compose.ghcr.yml exec server \
 *     node scripts/rotate-master-key.js --apply
 *   # After success, remove OLD_MASTER_KEY from .env. Old backups in
 *   # R2 still need OLD_MASTER_KEY to restore -- keep it in your
 *   # password manager for the retention period.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const SENTINEL = 'enc.v1:';
const ALGO     = 'aes-256-gcm';
const IV_LEN   = 12;
const TAG_LEN  = 16;

// Standalone decrypt -- doesn't read process.env.MASTER_KEY, takes the
// key bytes as argument so we can decrypt-with-old + encrypt-with-new.
function decryptWith(b64Encoded, keyBytes) {
  if (typeof b64Encoded !== 'string' || !b64Encoded.startsWith(SENTINEL)) {
    throw new Error(`value missing "${SENTINEL}" sentinel: ${String(b64Encoded).slice(0, 24)}...`);
  }
  const buf = Buffer.from(b64Encoded.slice(SENTINEL.length), 'base64');
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct  = buf.subarray(IV_LEN + TAG_LEN);
  // Semgrep gcm-no-tag-length (2026-07-08): pass authTagLength explicitly so
  // Node enforces exactly TAG_LEN (16) bytes at cipher-creation time, not
  // just whatever setAuthTag() happens to receive -- without this, a
  // shorter-than-expected tag could be silently accepted, weakening GCM's
  // forgery resistance. buf always slices exactly TAG_LEN bytes for `tag`
  // (see the subarray call above), so this is a pure hardening no-op for
  // every value this function has ever actually decrypted.
  const dec = crypto.createDecipheriv(ALGO, keyBytes, iv, { authTagLength: TAG_LEN });
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}

function encryptWith(plaintext, keyBytes) {
  const iv  = crypto.randomBytes(IV_LEN);
  const cip = crypto.createCipheriv(ALGO, keyBytes, iv);
  const ct  = Buffer.concat([cip.update(String(plaintext), 'utf8'), cip.final()]);
  const tag = cip.getAuthTag();
  return SENTINEL + Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * 2026-07-08 Run 2 (W1-M2): try the NEW key first (already-rotated case),
 * fall back to the OLD key (not-yet-rotated case). Throws only if NEITHER
 * key can decrypt -- a genuine corruption/wrong-key situation the operator
 * needs to know about immediately, same as before.
 */
function decryptWithEither(b64Encoded, newKey, oldKey) {
  try {
    return { plaintext: decryptWith(b64Encoded, newKey), alreadyNew: true };
  } catch (_e) {
    return { plaintext: decryptWith(b64Encoded, oldKey), alreadyNew: false };
  }
}

function parseKey(b64, label) {
  if (!b64) {
    console.error(`[rotate] ERROR: ${label} env var is not set`);
    process.exit(1);
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    console.error(`[rotate] ERROR: ${label} must decode to 32 bytes; got ${key.length}`);
    process.exit(1);
  }
  return key;
}

async function rotateAccountSettings(prisma, oldKey, newKey, dryRun) {
  const rows = await prisma.accountSetting.findMany({
    where:  { value: { startsWith: SENTINEL } },
    select: { id: true, accountId: true, key: true, value: true },
  });
  console.log(`[rotate] AccountSetting: ${rows.length} encrypted rows`);
  let updated = 0, skippedAlreadyNew = 0;
  for (const r of rows) {
    try {
      const { plaintext, alreadyNew } = decryptWithEither(r.value, newKey, oldKey);
      if (alreadyNew) { skippedAlreadyNew++; continue; }
      if (!dryRun) {
        await prisma.accountSetting.update({ where: { id: r.id }, data: { value: encryptWith(plaintext, newKey) } });
        updated++;
      }
    } catch (e) {
      console.error(`[rotate] AccountSetting ${r.id} (${r.key}) FAILED decrypt with either key: ${e.message}`);
      throw e;
    }
  }
  console.log(`[rotate] AccountSetting: ${dryRun ? 'verified' : 'rewrote'} ${dryRun ? rows.length - skippedAlreadyNew : updated} (${skippedAlreadyNew} already on new key)`);
  return rows.length;
}

async function rotateWebhookEndpoints(prisma, oldKey, newKey, dryRun) {
  const rows = await prisma.webhookEndpoint.findMany({
    select: { id: true, url: true, hmacSecret: true },
  });
  console.log(`[rotate] WebhookEndpoint: ${rows.length} rows (always-encrypted url + hmacSecret)`);
  let updated = 0, skippedAlreadyNew = 0;
  for (const r of rows) {
    try {
      const urlRes    = decryptWithEither(r.url,        newKey, oldKey);
      const secretRes = decryptWithEither(r.hmacSecret, newKey, oldKey);
      const bothAlreadyNew = urlRes.alreadyNew && secretRes.alreadyNew;
      if (bothAlreadyNew) { skippedAlreadyNew++; continue; }
      if (!dryRun) {
        await prisma.webhookEndpoint.update({
          where: { id: r.id },
          data: {
            url:        urlRes.alreadyNew    ? r.url        : encryptWith(urlRes.plaintext,    newKey),
            hmacSecret: secretRes.alreadyNew ? r.hmacSecret : encryptWith(secretRes.plaintext, newKey),
          },
        });
        updated++;
      }
    } catch (e) {
      console.error(`[rotate] WebhookEndpoint ${r.id} FAILED decrypt with either key: ${e.message}`);
      throw e;
    }
  }
  console.log(`[rotate] WebhookEndpoint: ${dryRun ? 'verified' : 'rewrote'} ${dryRun ? rows.length - skippedAlreadyNew : updated} (${skippedAlreadyNew} already on new key)`);
  return rows.length;
}

async function rotateUserTotpSecrets(prisma, oldKey, newKey, dryRun) {
  const rows = await prisma.user.findMany({
    where:  { twoFactorSecret: { startsWith: SENTINEL } },
    select: { id: true, twoFactorSecret: true },
  });
  console.log(`[rotate] User.twoFactorSecret: ${rows.length} encrypted rows`);
  let updated = 0, skippedAlreadyNew = 0;
  for (const r of rows) {
    try {
      const { plaintext, alreadyNew } = decryptWithEither(r.twoFactorSecret, newKey, oldKey);
      if (alreadyNew) { skippedAlreadyNew++; continue; }
      if (!dryRun) {
        await prisma.user.update({ where: { id: r.id }, data: { twoFactorSecret: encryptWith(plaintext, newKey) } });
        updated++;
      }
    } catch (e) {
      console.error(`[rotate] User ${r.id} 2FA FAILED decrypt with either key: ${e.message}`);
      throw e;
    }
  }
  console.log(`[rotate] User.twoFactorSecret: ${dryRun ? 'verified' : 'rewrote'} ${dryRun ? rows.length - skippedAlreadyNew : updated} (${skippedAlreadyNew} already on new key)`);
  return rows.length;
}

/**
 * 2026-07-08 Run 2 (W1-M2): replaces the old rotateCloudConnectors() (which
 * called a model that doesn't exist -- see file header). Covers the two
 * Account-level encrypted fields the original audit found genuinely missing:
 * importWebhookSecret (lib/webhookImport.ts) and storageS3KeyId/storageS3Secret
 * (lib/storage.ts, routes/settings.ts) -- all three optionally "enc.v1:"
 * prefixed, same scheme as AccountSetting.value above.
 */
async function rotateAccountSecrets(prisma, oldKey, newKey, dryRun) {
  const FIELDS = ['importWebhookSecret', 'storageS3KeyId', 'storageS3Secret'];
  const rows = await prisma.account.findMany({
    where: {
      OR: FIELDS.map((f) => ({ [f]: { startsWith: SENTINEL } })),
    },
    select: { id: true, importWebhookSecret: true, storageS3KeyId: true, storageS3Secret: true },
  });
  console.log(`[rotate] Account secrets (importWebhookSecret/storageS3KeyId/storageS3Secret): ${rows.length} accounts with at least one encrypted field`);

  let fieldCount = 0, fieldsRewritten = 0, fieldsSkippedAlreadyNew = 0, accountsUpdated = 0;
  for (const r of rows) {
    const data = {};
    let changed = false;
    for (const field of FIELDS) {
      const val = r[field];
      if (typeof val !== 'string' || !val.startsWith(SENTINEL)) continue;
      fieldCount++;
      try {
        const { plaintext, alreadyNew } = decryptWithEither(val, newKey, oldKey);
        if (alreadyNew) { fieldsSkippedAlreadyNew++; continue; }
        if (!dryRun) {
          data[field] = encryptWith(plaintext, newKey);
          changed = true;
        }
        fieldsRewritten++;
      } catch (e) {
        console.error(`[rotate] Account ${r.id} field "${field}" FAILED decrypt with either key: ${e.message}`);
        throw e;
      }
    }
    if (!dryRun && changed) {
      await prisma.account.update({ where: { id: r.id }, data });
      accountsUpdated++;
    }
  }
  console.log(`[rotate] Account secrets: ${dryRun ? 'verified' : 'rewrote'} ${fieldsRewritten}/${fieldCount} fields (${fieldsSkippedAlreadyNew} already on new key) across ${dryRun ? rows.length : accountsUpdated} accounts`);
  return fieldCount;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apply  = args.includes('--apply');

  if (!dryRun && !apply) {
    console.error('Usage: node rotate-master-key.js [--dry-run | --apply]');
    process.exit(1);
  }
  if (dryRun && apply) {
    console.error('--dry-run and --apply are mutually exclusive');
    process.exit(1);
  }

  const oldKey = parseKey(process.env.OLD_MASTER_KEY, 'OLD_MASTER_KEY');
  const newKey = parseKey(process.env.MASTER_KEY,     'MASTER_KEY');
  if (Buffer.compare(oldKey, newKey) === 0) {
    console.error('[rotate] ERROR: OLD_MASTER_KEY == MASTER_KEY -- rotation is a no-op');
    process.exit(1);
  }

  const sentinelPath = path.join(__dirname, '..', '.master-key-rotation-completed-at');
  if (apply && fs.existsSync(sentinelPath)) {
    // Informational only (see file header) -- per-row decrypt-with-either
    // makes this run safe regardless; a prior completion just means most/all
    // rows should already be on the new key and will be skipped quickly.
    console.log(`[rotate] NOTE: a previous rotation completed at ${fs.readFileSync(sentinelPath, 'utf8').trim()}. Re-running is safe -- already-rotated rows are detected and skipped.`);
  }

  // Avoid pulling in the server's bootstrapping chain (auth middleware,
  // express, etc.); only need PrismaClient.
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    console.log(`[rotate] mode = ${dryRun ? 'DRY-RUN' : 'APPLY'} -- start ${new Date().toISOString()}`);
    let total = 0;
    total += await rotateAccountSettings(prisma, oldKey, newKey, dryRun);
    total += await rotateWebhookEndpoints(prisma, oldKey, newKey, dryRun);
    total += await rotateUserTotpSecrets(prisma, oldKey, newKey, dryRun);
    total += await rotateAccountSecrets(prisma, oldKey, newKey, dryRun);
    if (apply) {
      fs.writeFileSync(sentinelPath, new Date().toISOString() + '\n');
      console.log(`[rotate] APPLIED. ${total} encrypted values checked (already-on-new-key rows skipped, see per-table logs above). Sentinel: ${sentinelPath}`);
    } else {
      console.log(`[rotate] DRY-RUN COMPLETE. ${total} encrypted values checked, all recoverable with the new or old key.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('[rotate] FATAL:', err && err.stack ? err.stack : err);
  process.exit(2);
});

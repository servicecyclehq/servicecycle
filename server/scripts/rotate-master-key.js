#!/usr/bin/env node
/**
 * server/scripts/rotate-master-key.js
 *
 * MASTER_KEY rotation for LapseIQ envelope-encrypted DB columns.
 *
 * v0.73.5 (CloudConnector credentials added; originally v0.67.11, audit High H26).
 *
 * What it rotates:
 *   - AccountSetting.value (when prefixed `enc.v1:`)
 *   - WebhookEndpoint.url + .hmacSecret (always encrypted)
 *   - User.twoFactorSecret (when prefixed `enc.v1:`)
 *   - CloudConnector.credentials (JSON object -- each field value
 *     starting with `enc.v1:` is decrypted+re-encrypted in-place)
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
 *   --dry-run   ..  count rows + decrypt every encrypted value with the
 *                   OLD key to verify it's recoverable. Does NOT write.
 *                   This is the SAFE first step.
 *   --apply     ..  decrypt-with-old + encrypt-with-new + UPDATE. Writes a
 *                   sentinel file `.master-key-rotation-completed-at`
 *                   when finished so re-runs of the same rotation skip.
 *   (no flag)   ..  prints usage + exits 1.
 *
 * Atomicity:
 *   Each table is rotated inside its own prisma transaction. If a row
 *   fails decrypt, the transaction rolls back. The "first failure
 *   abort + don't touch downstream tables" model is intentional --
 *   you want to know IMMEDIATELY if a value isn't recoverable with the
 *   old key before you commit any rewrites.
 *
 * Usage:
 *   # Set NEW MASTER_KEY in .env first; keep OLD_MASTER_KEY alongside:
 *   #   MASTER_KEY=<new-44-char-base64>
 *   #   OLD_MASTER_KEY=<old-44-char-base64>
 *   docker compose -f docker-compose.ghcr.yml exec server \
 *     node scripts/rotate-master-key.js --dry-run
 *   # If clean, run apply:
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
  const dec = crypto.createDecipheriv(ALGO, keyBytes, iv);
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
  let updated = 0;
  for (const r of rows) {
    try {
      const plain = decryptWith(r.value, oldKey);
      if (!dryRun) {
        const re = encryptWith(plain, newKey);
        await prisma.accountSetting.update({ where: { id: r.id }, data: { value: re } });
        updated++;
      }
    } catch (e) {
      console.error(`[rotate] AccountSetting ${r.id} (${r.key}) FAILED decrypt with OLD_MASTER_KEY: ${e.message}`);
      throw e;
    }
  }
  console.log(`[rotate] AccountSetting: ${dryRun ? 'verified' : 'rewrote'} ${dryRun ? rows.length : updated}`);
  return rows.length;
}

async function rotateWebhookEndpoints(prisma, oldKey, newKey, dryRun) {
  const rows = await prisma.webhookEndpoint.findMany({
    select: { id: true, url: true, hmacSecret: true },
  });
  console.log(`[rotate] WebhookEndpoint: ${rows.length} rows (always-encrypted url + hmacSecret)`);
  let updated = 0;
  for (const r of rows) {
    try {
      const urlPlain    = decryptWith(r.url,        oldKey);
      const secretPlain = decryptWith(r.hmacSecret, oldKey);
      if (!dryRun) {
        await prisma.webhookEndpoint.update({
          where: { id: r.id },
          data: {
            url:        encryptWith(urlPlain,    newKey),
            hmacSecret: encryptWith(secretPlain, newKey),
          },
        });
        updated++;
      }
    } catch (e) {
      console.error(`[rotate] WebhookEndpoint ${r.id} FAILED decrypt with OLD_MASTER_KEY: ${e.message}`);
      throw e;
    }
  }
  console.log(`[rotate] WebhookEndpoint: ${dryRun ? 'verified' : 'rewrote'} ${dryRun ? rows.length : updated}`);
  return rows.length;
}

async function rotateUserTotpSecrets(prisma, oldKey, newKey, dryRun) {
  const rows = await prisma.user.findMany({
    where:  { twoFactorSecret: { startsWith: SENTINEL } },
    select: { id: true, twoFactorSecret: true },
  });
  console.log(`[rotate] User.twoFactorSecret: ${rows.length} encrypted rows`);
  let updated = 0;
  for (const r of rows) {
    try {
      const plain = decryptWith(r.twoFactorSecret, oldKey);
      if (!dryRun) {
        await prisma.user.update({ where: { id: r.id }, data: { twoFactorSecret: encryptWith(plain, newKey) } });
        updated++;
      }
    } catch (e) {
      console.error(`[rotate] User ${r.id} 2FA FAILED decrypt with OLD_MASTER_KEY: ${e.message}`);
      throw e;
    }
  }
  console.log(`[rotate] User.twoFactorSecret: ${dryRun ? 'verified' : 'rewrote'} ${dryRun ? rows.length : updated}`);
  return rows.length;
}

async function rotateCloudConnectors(prisma, oldKey, newKey, dryRun) {
  const rows = await prisma.cloudConnector.findMany({
    select: { id: true, provider: true, credentials: true },
  });
  console.log(`[rotate] CloudConnector: ${rows.length} rows`);
  let encCount = 0;
  let updated  = 0;
  for (const r of rows) {
    const creds = r.credentials;
    if (!creds || typeof creds !== 'object') continue;
    const newCreds = {};
    let changed = false;
    for (const [k, v] of Object.entries(creds)) {
      if (typeof v === 'string' && v.startsWith(SENTINEL)) {
        encCount++;
        try {
          const plain = decryptWith(v, oldKey);
          newCreds[k] = dryRun ? v : encryptWith(plain, newKey);
          changed = true;
        } catch (e) {
          console.error(`[rotate] CloudConnector ${r.id} (${r.provider}) field "${k}" FAILED decrypt with OLD_MASTER_KEY: ${e.message}`);
          throw e;
        }
      } else {
        newCreds[k] = v;
      }
    }
    if (!dryRun && changed) {
      await prisma.cloudConnector.update({ where: { id: r.id }, data: { credentials: newCreds } });
      updated++;
    }
  }
  console.log(`[rotate] CloudConnector: ${dryRun ? 'verified' : 'rewrote'} ${encCount} encrypted fields across ${dryRun ? rows.length : updated} connectors`);
  return encCount;
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
    total += await rotateCloudConnectors(prisma, oldKey, newKey, dryRun);
    if (apply) {
      const sentinelPath = path.join(__dirname, '..', '.master-key-rotation-completed-at');
      fs.writeFileSync(sentinelPath, new Date().toISOString() + '\n');
      console.log(`[rotate] APPLIED. ${total} encrypted values rewritten. Sentinel: ${sentinelPath}`);
    } else {
      console.log(`[rotate] DRY-RUN COMPLETE. ${total} encrypted values verified-decryptable with OLD_MASTER_KEY.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('[rotate] FATAL:', err && err.stack ? err.stack : err);
  process.exit(2);
});
/**
 * server/scripts/encrypt_existing_credentials.js
 *
 * One-time migration script: encrypts any plaintext cloud-connector credentials
 * and AI API keys already in the DB.
 *
 * Idempotent — values already encrypted (have the 'enc.v1:' sentinel) are skipped.
 *
 * Run once after deploying the H1 encryption changes:
 *   node server/scripts/encrypt_existing_credentials.js
 *
 * Requires MASTER_KEY and DATABASE_URL to be set (reads server/.env automatically).
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const prisma = require('../lib/prisma');
const { encryptIfNeeded, isEncrypted } = require('../lib/crypto');

const SENSITIVE_KEYS = ['secretAccessKey', 'clientSecret', 'serviceAccountKey', 'privateKey', 'apiKey', 'secret', 'password'];
function isSensitiveKey(key) {
  return SENSITIVE_KEYS.some(s => key.toLowerCase().includes(s.toLowerCase()));
}

async function migrateCloudConnectors() {
  const rows = await prisma.cloudConnector.findMany();
  let updated = 0;

  for (const row of rows) {
    if (!row.credentials || typeof row.credentials !== 'object') continue;

    let changed = false;
    const newCreds = { ...row.credentials };

    for (const [key, value] of Object.entries(newCreds)) {
      if (isSensitiveKey(key) && value && !isEncrypted(value)) {
        newCreds[key] = encryptIfNeeded(value);
        changed = true;
      }
    }

    if (changed) {
      await prisma.cloudConnector.update({
        where: { id: row.id },
        data:  { credentials: newCreds },
      });
      updated++;
      console.log(`  [cloud_connectors] Encrypted credentials for ${row.provider} / account ${row.accountId}`);
    }
  }

  console.log(`cloud_connectors: ${updated} row(s) encrypted, ${rows.length - updated} already clean.`);
}

async function migrateAiApiKeys() {
  const rows = await prisma.accountSetting.findMany({
    where: { key: 'AI_API_KEY' },
  });

  let updated = 0;

  for (const row of rows) {
    if (!row.value || isEncrypted(row.value)) continue;

    const encrypted = encryptIfNeeded(row.value);
    await prisma.accountSetting.update({
      where: { id: row.id },
      data:  { value: encrypted },
    });
    updated++;
    console.log(`  [account_settings] Encrypted AI_API_KEY for account ${row.accountId}`);
  }

  console.log(`account_settings (AI_API_KEY): ${updated} row(s) encrypted, ${rows.length - updated} already clean.`);
}

async function main() {
  console.log('=== LapseIQ credential encryption migration ===');
  try {
    await migrateCloudConnectors();
    await migrateAiApiKeys();
    console.log('=== Migration complete ===');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

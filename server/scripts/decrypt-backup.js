'use strict';

/**
 * server/scripts/decrypt-backup.js
 *
 * Decrypt a ServiceCycle encrypted backup file (.sql.gz.enc) using MASTER_KEY
 * from the environment. Usage:
 *
 *   node scripts/decrypt-backup.js <encrypted.sql.gz.enc> [output.sql.gz]
 *
 * If no output path is given, strips the .enc suffix from the input and
 * writes alongside.
 *
 * MASTER_KEY must match the one that was active when the backup was
 * taken. If MASTER_KEY has been rotated since, restore is impossible
 * without the OLD MASTER_KEY (this is by design -- encryption isn't
 * meaningful without that property).
 *
 * After decrypting, restore the database with:
 *   gunzip -c output.sql.gz | pg_restore --no-owner --no-acl -d $DATABASE_URL
 *
 * Note: pg_dump uses --format=custom, which requires pg_restore, NOT psql.
 */

const fs    = require('fs');
const path  = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { decryptBackup } = require('../lib/backupCrypto');

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || args[0] === '-h' || args[0] === '--help') {
    console.error('Usage: node scripts/decrypt-backup.js <encrypted.sql.gz.enc> [output.sql.gz]');
    process.exit(2);
  }

  const inputPath = path.resolve(args[0]);
  const outputPath = args[1]
    ? path.resolve(args[1])
    : (inputPath.endsWith('.enc') ? inputPath.slice(0, -4) : inputPath + '.dec');

  if (!process.env.MASTER_KEY) {
    console.error('MASTER_KEY is not set. Either source server/.env or pass MASTER_KEY=... to the command.');
    console.error('Restore on a different host? Copy MASTER_KEY from the host that took the backup.');
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }
  if (fs.existsSync(outputPath)) {
    console.error(`Refusing to overwrite ${outputPath} -- move or delete it first.`);
    process.exit(1);
  }

  console.log(`Decrypting ${inputPath} -> ${outputPath}`);
  const blob = fs.readFileSync(inputPath);

  let plain;
  try {
    plain = decryptBackup(blob);
  } catch (err) {
    console.error('Decryption failed:', err.message);
    console.error('Common causes:');
    console.error('  - MASTER_KEY does not match the key used when this backup was taken.');
    console.error('  - The backup file is corrupted or truncated.');
    console.error('  - The file is not a ServiceCycle encrypted backup (missing LBKE0001 magic).');
    process.exit(1);
  }

  // Write with mode 0600 -- the decrypted .gz still contains every row.
  fs.writeFileSync(outputPath, plain, { mode: 0o600 });
  console.log(`OK -- wrote ${plain.length.toLocaleString()} bytes to ${outputPath}`);
  console.log('Restore with (pg_dump --format=custom requires pg_restore, not psql):');
  console.log(`  gunzip -c "${outputPath}" | pg_restore --no-owner --no-acl -d $DATABASE_URL`);
}

main();
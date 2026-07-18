#!/usr/bin/env node
// One-off: mint a NON-EXPIRING, 'service'-scoped API key for headless automation.
// Run inside the server container:
//   docker compose exec -T server node scripts/mint-service-key.js
// Prints SERVICE_KEY=<plaintext> ONCE; store it, it is not recoverable.
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function hashApiKey(pt) { return crypto.createHash('sha256').update(pt).digest('hex'); }

(async () => {
  const email = process.env.MINT_ADMIN_EMAIL || 'servicecyclehq@gmail.com';
  const admin = await prisma.user.findFirst({ where: { email }, select: { accountId: true } });
  if (!admin) { console.error('ABORT: no user found for ' + email); process.exit(1); }

  const dupes = await prisma.apiKey.count({ where: { accountId: admin.accountId, revokedAt: null, name: 'Cowork automation (service)' } });
  if (dupes > 0) console.log('NOTE: ' + dupes + ' active key(s) named "Cowork automation (service)" already exist. Creating another.');

  const plaintext = 'sc_' + crypto.randomBytes(32).toString('hex');
  const key = await prisma.apiKey.create({
    data: { accountId: admin.accountId, name: 'Cowork automation (service)', keyHash: hashApiKey(plaintext), scopes: ['read', 'write', 'service'], expiresAt: null },
    select: { id: true, name: true, scopes: true, expiresAt: true },
  });

  console.log('MINTED_KEY_ID=' + key.id);
  console.log('SCOPES=' + JSON.stringify(key.scopes));
  console.log('EXPIRES=' + (key.expiresAt || 'never'));
  console.log('SERVICE_KEY=' + plaintext);
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });

/*
 * reset-demo-admin.js — diagnose (and optionally fix) the demo admin login.
 *
 *   node scripts/reset-demo-admin.js         # DIAGNOSE only (read-only)
 *   node scripts/reset-demo-admin.js reset   # reset password to Admin1234! + isActive
 *
 * Read-only by default: reports the servicecyclehq@gmail.com user's account, role, active
 * flag, hash algorithm, and whether Admin1234! verifies against the stored bcrypt hash.
 * With `reset`, sets the password to Admin1234! (standard bcrypt) and re-verifies.
 * NOTE: the nightly demo reseed will reset the password back to the seed default.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');

const EMAIL = 'servicecyclehq@gmail.com';
const PW = 'Admin1234!';
const DEMO_ACCT = '11111111-1111-4111-8111-111111111111';

function getBcrypt() {
  try { return require('bcryptjs'); } catch (e) {}
  try { return require('bcrypt'); } catch (e) {}
  return null;
}

(async () => {
  const prisma = new PrismaClient();
  try {
    const u = await prisma.user.findUnique({
      where: { email: EMAIL },
      select: { id: true, accountId: true, name: true, role: true, isActive: true, createdAt: true, passwordHash: true },
    });
    if (!u) { console.log('DIAG: user NOT FOUND for ' + EMAIL); return; }
    const h = u.passwordHash || '';
    const bc = getBcrypt();
    let verify = 'no-bcrypt-lib';
    if (bc) { try { verify = String(bc.compareSync(PW, h)); } catch (e) { verify = 'err:' + e.message; } }
    console.log('DIAG: id=' + u.id + ' acct=' + u.accountId + ' isDemoAcct=' + (u.accountId === DEMO_ACCT)
      + ' role=' + u.role + ' active=' + u.isActive + ' created=' + u.createdAt.toISOString()
      + ' hashAlgo=' + h.slice(0, 4) + ' hashLen=' + h.length + ' verify(Admin1234!)=' + verify);

    if (process.argv[2] === 'reset') {
      if (!bc) { console.log('RESET: cannot — no bcrypt lib available'); return; }
      const newHash = bc.hashSync(PW, 10);
      await prisma.user.update({ where: { id: u.id }, data: { passwordHash: newHash, isActive: true } });
      const re = await prisma.user.findUnique({ where: { id: u.id }, select: { passwordHash: true } });
      console.log('RESET: password set to Admin1234! (bcrypt 10); reverify=' + String(bc.compareSync(PW, (re && re.passwordHash) || ''))
        + '. NOTE: the nightly reseed resets it to the seed default.');
    }
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => { console.error('ERR', e); process.exit(1); });

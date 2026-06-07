require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('DATABASE_URL:', process.env.DATABASE_URL ? '✓ loaded' : '✗ MISSING');

  const users = await prisma.user.findMany({
    select: { email: true, role: true, passwordHash: true }
  });

  console.log(`Users in DB: ${users.length}`);
  users.forEach(u => console.log(` - ${u.email} (${u.role})`));

  if (users.length > 0) {
    const admin = users.find(u => u.email === 'admin@acme.com');
    if (admin) {
      const match = await bcrypt.compare('Admin1234!', admin.passwordHash);
      console.log(`Password check for admin@acme.com: ${match ? '✓ CORRECT' : '✗ WRONG'}`);
    }
  }
}

main()
  .catch(e => console.error('Error:', e.message))
  .finally(() => prisma.$disconnect());

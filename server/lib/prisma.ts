/**
 * Shared Prisma client singleton.
 *
 * Import this everywhere instead of calling `new PrismaClient()` directly.
 * A single connection pool is reused across all route modules, which prevents
 * connection exhaustion under load and avoids the "too many clients" error on
 * small PostgreSQL plans.
 */
import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

const prisma: PrismaClient = global.__prisma ?? new PrismaClient({
  log: [
    { level: 'warn', emit: 'stdout' },
    { level: 'error', emit: 'stdout' },
  ],
  transactionOptions: {
    timeout: 25000,
    maxWait: 5000,
  },
});

// In development, keep the instance across hot-reloads so we don't exhaust the
// connection pool every time the dev server restarts.
if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

export default prisma;
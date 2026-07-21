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

// -- SC-10: audit-chain attribution --
// canonical() (lib/activityLogChain.ts) commits to details but NOT to the
// userId/accountId/assetId FK columns (onDelete:SetNull for GDPR erase, so
// hashing them would break the chain on a legitimate erasure). Snapshot the
// actor into the IMMUTABLE details at write time -- details is already inside
// canonical(), so there is no canonical()/verifier/migration change and no
// existing hash is disturbed. Central hook so all activityLog.create sites are
// covered (not just writeLog). Mirrors writeLog's details.ip fold. Defensive:
// any failure falls through to an unmodified create -- stamping must never break
// the write that triggered it.
if (!(prisma as any).__actorStampInstalled) {
  (prisma as any).__actorStampInstalled = true;
  prisma.$use(async (params, next) => {
    try {
      if (params.model === 'ActivityLog' && (params.action === 'create' || params.action === 'createMany')) {
        const stamp = (data: any) => {
          if (!data || typeof data !== 'object') return data;
          const actor = { userId: data.userId ?? null, accountId: data.accountId ?? null, assetId: data.assetId ?? null };
          const d = data.details;
          if (d == null) {
            data.details = { _actor: actor };
          } else if (typeof d === 'object' && !Array.isArray(d) && d._actor === undefined) {
            data.details = { ...d, _actor: actor };
          }
          return data;
        };
        if (params.action === 'create' && params.args && params.args.data) {
          params.args.data = stamp(params.args.data);
        } else if (params.action === 'createMany' && params.args && params.args.data) {
          const dm = params.args.data;
          params.args.data = Array.isArray(dm) ? dm.map(stamp) : stamp(dm);
        }
      }
    } catch {
      // never let attribution stamping break the write
    }
    return next(params);
  });
}
export default prisma;
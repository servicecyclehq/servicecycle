/**
 * oemTargetAccount.ts — #14 contractor bulk ingest scoping.
 *
 * Resolves the account a request operates on. Normally that's the caller's own
 * account, but an oem_admin may act on one of its fleet customer accounts by
 * passing targetAccountId (query or body). The target must belong to the OEM's
 * partner org — or any account when the OEM has no partnerOrgId, matching the
 * fleet-dashboard demo scoping. Throws an error carrying httpStatus on a
 * cross-fleet attempt so callers can map it to a 403/404.
 */

import prisma from './prisma';

export class TargetAccountError extends Error {
  httpStatus: number;
  constructor(status: number, message: string) { super(message); this.httpStatus = status; }
}

export async function resolveTargetAccount(req: any): Promise<string> {
  const raw = (req.body && req.body.targetAccountId) || (req.query && req.query.targetAccountId);
  if (raw && req.user?.role === 'oem_admin') {
    const [oem, target] = await Promise.all([
      prisma.account.findUnique({ where: { id: req.user.accountId }, select: { partnerOrgId: true } }),
      prisma.account.findUnique({ where: { id: String(raw) }, select: { id: true, partnerOrgId: true } }),
    ]);
    if (!target) throw new TargetAccountError(404, 'Target account not found');
    if (oem?.partnerOrgId && target.partnerOrgId !== oem.partnerOrgId) {
      throw new TargetAccountError(403, 'Account is not in your fleet');
    }
    return target.id;
  }
  return req.user.accountId;
}

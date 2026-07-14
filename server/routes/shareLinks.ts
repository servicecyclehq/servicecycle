/**
 * routes/shareLinks.ts — #21 auditor / insurer share links (authenticated mgmt).
 *
 * A manager creates a time-boxed, revocable token that exposes a read-only,
 * watermarked compliance package (honest number + Path-to-100 + the latest
 * hash-chained snapshot) to an underwriter/auditor without an account. The
 * public read endpoint lives in routes/shareLinkPublic.
 *
 * Auth: requireManager (admin/manager). TENANCY: every query is accountId-scoped.
 */

const router = require('express').Router();
const crypto = require('crypto');
import prisma from '../lib/prisma';
const { requireManager } = require('../middleware/roles');
const { buildComplianceGap } = require('../lib/complianceReport');
const { buildUnderwritingPackage } = require('../lib/underwritingPackage');
const { writeLog: writeActivityLog } = require('../lib/activityLog');

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

// Allowed break-glass package kinds. 'compliance_package' = the auditor view
// (default, backward-compatible); 'underwriting' = the richer insurer packet (#3).
const SHARE_KINDS = ['compliance_package', 'underwriting'];

/**
 * The read-only package an auditor/insurer sees. No PII beyond the company name +
 * compliance / risk posture. Shared by the public route. `kind` selects the
 * auditor compliance view (default) or the #3 insurer underwriting packet.
 */
async function buildSharePackage(accountId: string, kind: string = 'compliance_package') {
  if (kind === 'underwriting') {
    return buildUnderwritingPackage(prisma, accountId);
  }
  const now = new Date();
  const [account, gap, latestSnapshot] = await Promise.all([
    prisma.account.findUnique({ where: { id: accountId }, select: { companyName: true } }),
    buildComplianceGap(prisma, accountId, { limit: 10 }),
    prisma.complianceSnapshot.findFirst({
      where:   { accountId },
      orderBy: { createdAt: 'desc' },
      select:  { id: true, kind: true, createdAt: true, sha256: true },
    }),
  ]);
  return {
    companyName: account?.companyName || 'Facility',
    generatedAt: now,
    overallRate: gap.overallRate,
    compliance:  gap.compliance,
    coverage:    gap.coverage,
    summary:     gap.summary,
    topActions:  gap.actions.map((a: any) => ({ kind: a.kind, title: a.title })),
    latestSnapshot: latestSnapshot
      ? { kind: latestSnapshot.kind, date: latestSnapshot.createdAt, sha256: latestSnapshot.sha256 }
      : null,
  };
}

// ── POST /api/share-links — create a time-boxed link ─────────────────────────
router.post('/', requireManager, async (req: any, res: any) => {
  try {
    const body = req.body || {};
    let days = Number(body.days);
    if (!Number.isFinite(days) || days <= 0) days = DEFAULT_DAYS;
    days = Math.min(days, MAX_DAYS);
    const label = typeof body.label === 'string' ? body.label.slice(0, 120) : null;
    const kind = SHARE_KINDS.includes(body.kind) ? body.kind : 'compliance_package';

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    const link = await prisma.shareLink.create({
      data: {
        accountId: req.user.accountId, token, label,
        kind, expiresAt, createdById: req.user.id,
      },
      select: { id: true, token: true, label: true, kind: true, expiresAt: true, createdAt: true },
    });
    writeActivityLog({ accountId: req.user.accountId, userId: req.user.id, assetId: null, action: 'share_link_created', details: { id: link.id, kind, expiresAt } });
    return res.status(201).json({ success: true, data: { ...link, path: `/share/${link.token}` } });
  } catch (err: any) {
    console.error('[shareLinks:create]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to create share link' });
  }
});

// ── GET /api/share-links — list this account's links ─────────────────────────
router.get('/', requireManager, async (req: any, res: any) => {
  try {
    const now = new Date();
    const links = await prisma.shareLink.findMany({
      where:   { accountId: req.user.accountId },
      orderBy: { createdAt: 'desc' },
      select:  { id: true, token: true, label: true, kind: true, expiresAt: true, revokedAt: true, viewCount: true, lastViewedAt: true, createdAt: true },
    });
    const decorated = links.map((l: any) => ({
      ...l,
      path: `/share/${l.token}`,
      active: !l.revokedAt && l.expiresAt > now,
    }));
    return res.json({ success: true, data: { links: decorated } });
  } catch (err: any) {
    console.error('[shareLinks:list]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to load share links' });
  }
});

// ── POST /api/share-links/:id/revoke — kill a link immediately ───────────────
router.post('/:id/revoke', requireManager, async (req: any, res: any) => {
  try {
    const existing = await prisma.shareLink.findFirst({
      where:  { id: req.params.id, accountId: req.user.accountId },
      select: { id: true, revokedAt: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });
    if (!existing.revokedAt) {
      // Atomic claim (same guarded-updateMany pattern as workOrders.ts
      // /approve and deficiencies.ts /resolve, 2026-07-12 race-siblings
      // sweep): the where clause re-checks revokedAt===null at write time,
      // not just at the findFirst read above. Unlike the other fixes in this
      // sweep, this endpoint's contract is deliberately idempotent-quiet --
      // revoking an already-revoked link has never been an error here (see
      // the `if (!existing.revokedAt)` no-op branch above, present before
      // this fix) -- so a losing concurrent request still gets
      // `{ success: true }`, same as before. What the guard actually fixes:
      // without it, two concurrent revokes could both pass this pre-write
      // check and both fire writeActivityLog below, double-logging the
      // revoke. The claim ensures the log entry is written at most once.
      const claim = await prisma.shareLink.updateMany({
        where: { id: existing.id, accountId: req.user.accountId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claim.count > 0) {
        writeActivityLog({ accountId: req.user.accountId, userId: req.user.id, assetId: null, action: 'share_link_revoked', details: { id: existing.id } });
      }
    }
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[shareLinks:revoke]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to revoke share link' });
  }
});

module.exports = router;
module.exports.buildSharePackage = buildSharePackage;

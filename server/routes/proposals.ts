/**
 * /api/proposals — #5 multi-year scope / proposal builder (repair/replace/defer).
 *
 *   GET /api/proposals[?accountId=&siteId=]          -> proposal JSON
 *   GET /api/proposals/proposal.pdf[?accountId=&siteId=] -> sellable PDF
 *
 * Manager+ only. By default the proposal is built for the caller's own account
 * (a customer admin/manager planning their program). A contractor oem_admin may
 * pass ?accountId= to build a proposal FOR a customer in their partner org —
 * gated by the same partnerOrg check the fleet routes use. Mounted behind
 * authenticateToken in index.ts.
 */

const router = require('express').Router();
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;
const { buildProposal } = require('../lib/proposalBuilder');
const { renderProposalPdf } = require('../lib/proposalPdf');
const { getAccountBranding } = require('../lib/partnerBranding');

// Resolve the target account: own account by default; a customer account in the
// caller's partner org when an oem_admin passes ?accountId=. Throws coded errors.
async function resolveTargetAccount(req: any): Promise<string> {
  const requested = req.query.accountId ? String(req.query.accountId) : null;
  if (!requested || requested === req.user.accountId) return req.user.accountId;

  // Cross-account: oem_admin only, and the target must share the caller's partner org.
  if (req.user.role !== 'oem_admin') { const e: any = new Error('forbidden'); e.code = 'FORBIDDEN'; throw e; }
  const [caller, target] = await Promise.all([
    prisma.account.findUnique({ where: { id: req.user.accountId }, select: { partnerOrgId: true } }),
    prisma.account.findUnique({ where: { id: requested }, select: { id: true, partnerOrgId: true } }),
  ]);
  if (!target) { const e: any = new Error('not_found'); e.code = 'NOT_FOUND'; throw e; }
  if (!caller?.partnerOrgId || target.partnerOrgId !== caller.partnerOrgId) { const e: any = new Error('forbidden'); e.code = 'FORBIDDEN'; throw e; }
  return target.id;
}

function mapErr(res: any, err: any): boolean {
  if (err?.code === 'FORBIDDEN') { res.status(403).json({ success: false, error: 'Access denied.' }); return true; }
  if (err?.code === 'NOT_FOUND') { res.status(404).json({ success: false, error: 'Account not found.' }); return true; }
  if (err?.code === 'SITE_NOT_FOUND') { res.status(404).json({ success: false, error: 'Site not found.' }); return true; }
  return false;
}

// ── GET /api/proposals ────────────────────────────────────────────────────────
router.get('/', requireManager, async (req: any, res: any) => {
  try {
    const accountId = await resolveTargetAccount(req);
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const data = await buildProposal(prisma, accountId, { siteId });
    return res.json({ success: true, data });
  } catch (err: any) {
    if (mapErr(res, err)) return;
    console.error('[proposals GET /]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build proposal.' });
  }
});

// ── GET /api/proposals/proposal.pdf ───────────────────────────────────────────
router.get('/proposal.pdf', requireManager, async (req: any, res: any) => {
  try {
    const accountId = await resolveTargetAccount(req);
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const data = await buildProposal(prisma, accountId, { siteId });
    const branding = await getAccountBranding(accountId);
    const pdf = await renderProposalPdf(data, {
      generatedAtIso: data.generatedAt.toISOString(),
      brandName: branding?.name || null,
      brandColor: branding?.primaryColor || null,
    });
    const filename = `servicecycle-proposal-${data.generatedAt.toISOString().slice(0, 10)}.pdf`;
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Length', String(pdf.length));
    res.set('Cache-Control', 'private, no-store');
    return res.send(pdf);
  } catch (err: any) {
    if (mapErr(res, err)) return;
    console.error('[proposals proposal.pdf]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to render proposal.' });
  }
});

module.exports = router;

export {};

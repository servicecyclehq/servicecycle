/**
 * /api/proposals â€” #5 multi-year scope / proposal builder (repair/replace/defer).
 *
 *   GET /api/proposals[?accountId=&siteId=]          -> proposal JSON
 *   GET /api/proposals/proposal.pdf[?accountId=&siteId=] -> sellable PDF
 *
 * Manager+ only. By default the proposal is built for the caller's own account
 * (a customer admin/manager planning their program). A contractor oem_admin may
 * pass ?accountId= to build a proposal FOR a customer in their partner org â€”
 * gated by the same partnerOrg check the fleet routes use. Mounted behind
 * authenticateToken in index.ts.
 */

const router = require('express').Router();
const prisma = require('../lib/prisma').default;

// Proposals are for managers/admins (customer-side planning) AND oem_admins (the
// contractor building FOR a customer). The shared requireManager excludes
// oem_admin, so use a local guard that admits all three.
function requireManagerOrOem(req: any, res: any, next: any) {
  if (!['admin', 'manager', 'oem_admin'].includes(req.user.role)) {
    return res.status(403).json({ success: false, error: 'Manager, admin, or OEM access required' });
  }
  next();
}
const { buildProposal, redactProposalCosts } = require('../lib/proposalBuilder');
const { renderProposalPdf } = require('../lib/proposalPdf');
const { getAccountBranding } = require('../lib/partnerBranding');
const { sendEmail } = require('../lib/email');

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

// Costs are contractor-only. An oem_admin (the contractor) sees pricing; a
// customer's own admin/manager sees a value-framed program (what/when/why) with
// no dollar figures and routes to their rep instead.
function callerSeesCosts(req: any): boolean {
  return req.user.role === 'oem_admin';
}

// â”€â”€ GET /api/proposals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/', requireManagerOrOem, async (req: any, res: any) => {
  try {
    const accountId = await resolveTargetAccount(req);
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const full = await buildProposal(prisma, accountId, { siteId });
    const showCosts = callerSeesCosts(req);
    const data = showCosts ? { ...full, costsRedacted: false } : redactProposalCosts(full);

    // For the customer-facing (cost-free) view, include the rep contact so the
    // card can offer "request a quote / call" directly.
    if (!showCosts) {
      const acct = await prisma.account.findUnique({
        where: { id: accountId },
        select: { serviceRepName: true, serviceRepEmail: true, serviceRepPhone: true },
      });
      (data as any).rep = acct?.serviceRepName || acct?.serviceRepEmail || acct?.serviceRepPhone
        ? { name: acct?.serviceRepName ?? null, email: acct?.serviceRepEmail ?? null, phone: acct?.serviceRepPhone ?? null }
        : null;
    }
    return res.json({ success: true, data });
  } catch (err: any) {
    if (mapErr(res, err)) return;
    console.error('[proposals GET /]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build proposal.' });
  }
});

// â”€â”€ POST /api/proposals/request-contact â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Customer-side demand capture: "request a quote / meeting / call" about the
// program. Notifies the account's service rep by email with the customer's
// choice + optional note. Any authenticated user on the account.
router.post('/request-contact', async (req: any, res: any) => {
  try {
    const mode = String(req.body?.mode || 'quote');
    if (!['quote', 'meeting', 'call'].includes(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be quote, meeting, or call' });
    }
    const note = req.body?.note ? String(req.body.note).slice(0, 2000) : null;

    const account = await prisma.account.findUnique({
      where: { id: req.user.accountId },
      select: { companyName: true, serviceRepEmail: true, assignedRepId: true },
    });
    const emails = new Set<string>();
    if (account?.serviceRepEmail) emails.add(account.serviceRepEmail);
    if (account?.assignedRepId) {
      const rep = await prisma.user.findUnique({ where: { id: account.assignedRepId }, select: { email: true } });
      if (rep?.email) emails.add(rep.email);
    }
    if (emails.size === 0) {
      return res.json({ success: true, data: { notified: 0, message: 'No service rep is on file for your account yet â€” please contact your provider directly.' } });
    }

    const label = mode === 'call' ? 'a call' : mode === 'meeting' ? 'a meeting' : 'a quote';
    const subject = `[${account?.companyName || 'Customer'}] Requested ${label} about their maintenance program`;
    const html = `<p><strong>${(req.user.name || 'A user')}</strong> at <strong>${account?.companyName || 'a customer account'}</strong> requested ${label} to discuss their multi-year maintenance proposal.</p>${note ? `<p><strong>Note:</strong> ${note.replace(/</g, '&lt;')}</p>` : ''}<p>Open ServiceCycle to review their program and follow up.</p>`;
    let notified = 0;
    for (const to of emails) {
      try { await sendEmail({ to, subject, html }); notified++; } catch (e: any) { console.error('[proposals request-contact email]', e.message); }
    }
    return res.json({ success: true, data: { notified } });
  } catch (err: any) {
    console.error('[proposals request-contact]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to send request.' });
  }
});

// â”€â”€ GET /api/proposals/proposal.pdf â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/proposal.pdf', requireManagerOrOem, async (req: any, res: any) => {
  try {
    // The PDF is the priced, contractor-issued document. Customers use the
    // on-screen program + "request a quote/call" CTA instead of a priced PDF.
    if (!callerSeesCosts(req)) {
      return res.status(403).json({ success: false, error: 'The priced proposal PDF is generated by your service provider. Use â€œRequest a quoteâ€ to start the conversation.' });
    }
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

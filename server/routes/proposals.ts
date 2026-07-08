/**
 * /api/proposals - #5 multi-year scope / proposal builder (repair/replace/defer).
 *
 *   GET /api/proposals[?accountId=&siteId=]          -> proposal JSON
 *   GET /api/proposals/proposal.pdf[?accountId=&siteId=] -> sellable PDF
 *
 * Manager+ only. By default the proposal is built for the caller's own account
 * (a customer admin/manager planning their program). A contractor oem_admin may
 * pass ?accountId= to build a proposal FOR a customer in their partner org -
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
const { emitPartnerEvent } = require('../lib/partnerEvents');
const { writeLog: writeActivityLog } = require('../lib/activityLog');

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

// - GET /api/proposals -
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

// - POST /api/proposals/request-contact -
// Customer-side demand capture: "request a quote / meeting / call" about the
// program. Notifies the account's service rep by email with the customer's
// choice + optional note. This is a WRITE path (persists a PartnerEventLog
// inbox row + sends rep email), so it carries the same writer-tier gate as the
// rest of the proposal surface — admin/manager/oem_admin only. consultant
// (read-only-with-attribution) and viewer are blocked, matching the in-app
// ProposalCard which is only rendered for those same roles (canSeeProposal).
router.post('/request-contact', requireManagerOrOem, async (req: any, res: any) => {
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
    // Land it as a first-class item in the contractor's Fleet inbox (partner
    // pipeline) - same place quote requests + deficiencies show up. This happens
    // regardless of whether a direct rep email is on file. Consent-gated + dedup'd
    // by emitPartnerEvent; no-op for accounts without a partner org. Awaited but
    // fail-safe so the customer's request still succeeds on error.
    try {
      await emitPartnerEvent(req.user.accountId, 'PROPOSAL_DISCUSSION_REQUESTED', {
        mode, note, requestedByName: req.user.name || null,
      });
    } catch (e: any) { console.error('[proposals request-contact event]', e.message); }

    // Direct immediate email to the rep, when one is on file (the inbox row above
    // is the durable pipeline record either way).
    const emails = new Set<string>();
    if (account?.serviceRepEmail) emails.add(account.serviceRepEmail);
    if (account?.assignedRepId) {
      const rep = await prisma.user.findUnique({ where: { id: account.assignedRepId }, select: { email: true } });
      if (rep?.email) emails.add(rep.email);
    }
    let notified = 0;
    if (emails.size > 0) {
      const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const label = mode === 'call' ? 'a call' : mode === 'meeting' ? 'a meeting' : 'a quote';
      const safeName = esc(req.user.name || 'A user');
      const safeCompany = esc(account?.companyName || 'a customer account');
      const subject = `[${account?.companyName || 'Customer'}] Requested ${label} about their maintenance program`;
      // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format
      // Reviewed 2026-07-08: safeName/safeCompany are already esc()'d above
      // (lines 135-136) and note is esc()'d inline here -- Semgrep's
      // dataflow doesn't see through the local esc() helper or the
      // safe-prefixed variable names, but the HTML-escaping is real.
      const html = `<p><strong>${safeName}</strong> at <strong>${safeCompany}</strong> requested ${label} to discuss their multi-year maintenance proposal.</p>${note ? `<p><strong>Note:</strong> ${esc(note)}</p>` : ''}<p>Open ServiceCycle to review their program and follow up.</p>`;
      for (const to of emails) {
        try { await sendEmail({ to, subject, html }); notified++; } catch (e: any) { console.error('[proposals request-contact email]', e.message); }
      }
    }

    writeActivityLog({ accountId: req.user.accountId, userId: req.user.id, assetId: null, action: 'proposal_contact_requested', details: { mode, notified } });
    return res.json({ success: true, data: { notified, logged: true } });
  } catch (err: any) {
    console.error('[proposals request-contact]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to send request.' });
  }
});

// - GET /api/proposals/proposal.pdf -
router.get('/proposal.pdf', requireManagerOrOem, async (req: any, res: any) => {
  try {
    // The PDF is the priced, contractor-issued document. Customers use the
    // on-screen program + "request a quote/call" CTA instead of a priced PDF.
    if (!callerSeesCosts(req)) {
      return res.status(403).json({ success: false, error: 'The priced proposal PDF is generated by your service provider. Use "Request a quote" to start the conversation.' });
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

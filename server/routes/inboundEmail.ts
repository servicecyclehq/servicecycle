/**
 * routes/inboundEmail.ts -- #6 email-in ingest webhook.
 *
 * A forwarded test report lands here (Resend "email.received" webhook), is routed
 * to the right account by the to-address, and each PDF/photo attachment is stored
 * and enqueued as an AUTO-COMMIT IngestJob -> the worker parses every line and
 * creates the asset card(s). Zero new behaviour downstream: same parser + commit
 * path as a manual upload, just no human in the loop.
 *
 * Auth (either is sufficient):
 *   - Resend/Svix signature  (RESEND_WEBHOOK_SECRET = whsec_...)  -- the live path
 *   - shared-secret header    (INBOUND_WEBHOOK_SECRET via x-inbound-secret / Bearer)
 *     -- for simulation, the CLI, or a non-Svix provider.
 *
 * Routing: reports-<slug>@<domain> -> AccountSetting inbound_slug=<slug>.
 * Attachments: inline base64 if the payload carries it, else fetched from Resend's
 * Attachments API (GET /emails/receiving/:email_id/attachments -> download_url).
 */

'use strict';

const router = require('express').Router();
const crypto = require('crypto');
const prisma = require('../lib/prisma').default;
const { uploadFile } = require('../lib/storage');

const PDFISH_RE = /\.(pdf|jpe?g|png|heic|heif|webp)$/i;
const PDF_TYPES = /(application\/pdf|image\/(jpeg|png|heic|heif|webp))/i;

function isReportAttachment(filename: string, contentType: string): boolean {
  return PDFISH_RE.test(filename || '') || PDF_TYPES.test(contentType || '');
}

// Verify a Resend (Svix) webhook signature. secret = "whsec_<base64>".
// signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`; HMAC-SHA256(base64).
function verifySvix(secret: string, headers: any, rawBody: string): boolean {
  try {
    const id = headers['svix-id']; const ts = headers['svix-timestamp']; const sigHeader = headers['svix-signature'];
    if (!id || !ts || !sigHeader) return false;
    const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
    const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
    return String(sigHeader).split(' ').some((part: string) => {
      const sig = part.split(',')[1];
      if (!sig) return false;
      try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
    });
  } catch { return false; }
}

function constEq(a: string, b: string): boolean {
  try { return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b))); } catch { return false; }
}

// reports-<slug>@... (or bare <slug>@...) -> account via AccountSetting inbound_slug.
async function resolveAccountByTo(toList: any): Promise<{ accountId: string; slug: string } | null> {
  const addrs = (Array.isArray(toList) ? toList : [toList]).filter(Boolean).map(String);
  for (const a of addrs) {
    const local = (a.split('@')[0] || '').toLowerCase().trim();
    const slug = local.startsWith('reports-') ? local.slice('reports-'.length) : local;
    if (!slug) continue;
    const setting = await prisma.accountSetting.findFirst({ where: { key: 'inbound_slug', value: slug }, select: { accountId: true } });
    if (setting) return { accountId: setting.accountId, slug };
  }
  return null;
}

type Att = { filename: string; contentType: string; buffer: Buffer };

async function fetchResendAttachments(emailId: string): Promise<Att[]> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !emailId) return [];
  const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}/attachments`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!r.ok) { console.error('[inbound] attachments list failed', r.status); return []; }
  const j: any = await r.json();
  const out: Att[] = [];
  for (const att of (j?.data || [])) {
    if (!isReportAttachment(att.filename, att.content_type)) continue;
    if (!att.download_url) continue;
    const dl = await fetch(att.download_url);
    if (!dl.ok) { console.error('[inbound] download failed', att.filename, dl.status); continue; }
    out.push({ filename: att.filename || 'report.pdf', contentType: att.content_type || 'application/pdf', buffer: Buffer.from(await dl.arrayBuffer()) });
  }
  return out;
}

// POST /api/inbound/email
router.post('/email', async (req: any, res: any) => {
  try {
    const rawBody = req.rawBody != null ? req.rawBody : JSON.stringify(req.body || {});
    const svixSecret = process.env.RESEND_WEBHOOK_SECRET;
    const sharedSecret = process.env.INBOUND_WEBHOOK_SECRET;

    let authed = false;
    if (svixSecret && req.headers['svix-signature']) authed = verifySvix(svixSecret, req.headers, rawBody);
    if (!authed && sharedSecret) {
      const provided = req.headers['x-inbound-secret'] || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      if (provided) authed = constEq(provided, sharedSecret);
    }
    if (!authed) return res.status(401).json({ success: false, error: 'unauthorized' });

    const event = req.body || {};
    if (event.type && event.type !== 'email.received') return res.status(200).json({ ok: true, ignored: event.type });
    const data = event.data || event;

    const account = await resolveAccountByTo(data.to);
    // Accept-and-drop (202) for un-routable mail so the provider does not retry/bounce.
    if (!account) return res.status(202).json({ ok: true, note: 'no matching inbound account' });

    let attachments: Att[] = [];
    if (Array.isArray(data.attachments) && data.attachments.some((a: any) => a.content)) {
      attachments = data.attachments
        .filter((a: any) => a.content && isReportAttachment(a.filename, a.content_type || a.contentType))
        .map((a: any) => ({ filename: a.filename || 'report.pdf', contentType: a.content_type || a.contentType || 'application/pdf', buffer: Buffer.from(a.content, 'base64') }));
    } else if (data.email_id) {
      attachments = await fetchResendAttachments(data.email_id);
    }
    if (!attachments.length) return res.status(202).json({ ok: true, note: 'no usable attachments' });

    const siteSetting = await prisma.accountSetting.findFirst({ where: { accountId: account.accountId, key: 'inbound_site_id' }, select: { value: true } });
    const siteId = siteSetting?.value || null;

    const jobs: string[] = [];
    for (const att of attachments) {
      const { storageKey } = await uploadFile(account.accountId, null, att.filename, att.buffer, att.contentType);
      const job = await prisma.ingestJob.create({ data: {
        accountId: account.accountId, createdById: null, kind: 'email_in', status: 'queued',
        fileKey: storageKey, fileName: att.filename, autoCommit: true, siteId,
      } });
      jobs.push(job.id);
    }
    console.log(`[inbound/email] queued ${jobs.length} auto-commit job(s) for ${account.slug}`);
    return res.status(202).json({ ok: true, account: account.slug, jobs });
  } catch (err: any) {
    console.error('[inbound/email]', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'inbound processing failed' });
  }
});

module.exports = router;

export {};

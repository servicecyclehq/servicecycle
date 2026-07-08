/**
 * routes/inboundEmail.ts -- #6 email-in ingest webhook.
 *
 * A forwarded test report lands here (Resend "email.received" webhook), is routed
 * to the right account by the to-address, and each PDF/photo attachment is stored
 * and enqueued as an AUTO-COMMIT IngestJob -> the worker parses every line and,
 * subject to the confidence gate (lib/ingestConfidenceGate.ts -- a low-confidence
 * parse is parked as needs_review, never silently committed), creates the asset
 * card(s). Same parser + commit path as a manual upload, just no human in the
 * loop for a high-confidence parse.
 *
 * Auth (either transport check is sufficient, PLUS the sender allowlist below):
 *   - Resend/Svix signature  (RESEND_WEBHOOK_SECRET = whsec_...)  -- the live path
 *   - shared-secret header    (INBOUND_WEBHOOK_SECRET via x-inbound-secret / Bearer)
 *     -- for simulation, the CLI, or a non-Svix provider.
 *
 * [2026-07-08 acquisition audit W1-H1] The Resend/Svix signature (or shared
 * secret) only proves the request really came THROUGH Resend/the configured
 * transport -- it says nothing about who the email's FROM address is. Routing
 * on the `to:` slug alone meant anyone who could reach (or enumerate) a real
 * account's slug could inject arbitrary attachments that auto-commit straight
 * into that account's compliance data. Every inbound message's sender is now
 * checked against a per-account allowlist (AccountSetting
 * inbound_allowed_senders, a JSON array of exact addresses and/or
 * "@domain.com" / "domain.com" entries) and FAILS CLOSED when no allowlist is
 * configured -- see isAllowedSender() below. The 202 accept-and-drop response
 * is also now IDENTICAL for every "nothing enqueued" outcome (unmatched slug,
 * matched slug + disallowed sender, no usable attachments) so a caller can
 * never use the response to enumerate valid slugs.
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
// The acknowledgement to the sender is sent AFTER parsing+gating (lib/ingestAck),
// not here — so it can reflect whether anything was parked for review.

const PDFISH_RE = /\.(pdf|jpe?g|png|heic|heif|webp)$/i;
const PDF_TYPES = /(application\/pdf|image\/(jpeg|png|heic|heif|webp))/i;

// Belt-and-suspenders bounds on a (signature-authenticated) inbound message so
// one email can't fan out into an unbounded number of auto-commit jobs or
// inflate huge buffers in memory. A real forwarded test report carries a
// handful of attachments, each well under these caps.
const MAX_INBOUND_ATTACHMENTS = 25;
const MAX_INBOUND_ATT_BYTES   = 15 * 1024 * 1024;

// Senders we must never auto-reply to — replying would create a mail loop or
// bounce against an unattended mailbox.
const NO_REPLY_RE = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?@|^reports-)/i;

function isReportAttachment(filename: string, contentType: string): boolean {
  return PDFISH_RE.test(filename || '') || PDF_TYPES.test(contentType || '');
}

// Pull a bare email address out of a Resend "from" field, which may be a string
// ("Jane <jane@x.com>" or "jane@x.com") or an object ({ address|email, name }).
function senderEmail(from: any): string | null {
  if (!from) return null;
  let raw = '';
  if (typeof from === 'string') raw = from;
  else if (typeof from === 'object') raw = from.address || from.email || '';
  const m = String(raw).match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) ? addr : null;
}

// Verify a Resend (Svix) webhook signature. secret = "whsec_<base64>".
// signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`; HMAC-SHA256(base64).
function verifySvix(secret: string, headers: any, rawBody: string): boolean {
  try {
    const id = headers['svix-id']; const ts = headers['svix-timestamp']; const sigHeader = headers['svix-signature'];
    if (!id || !ts || !sigHeader) return false;
    // Replay protection: reject a signature whose timestamp is outside a ±5min
    // tolerance window (the Svix-recommended default). Without this, a captured
    // signed payload could be replayed indefinitely since the HMAC stays valid.
    const tsNum = Number(ts);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > 5 * 60) return false;
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
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length === 0 || bb.length === 0) return false;  // empty string is not a valid secret
    return crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
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

// [2026-07-08 audit W1-H1] Per-account inbound sender allowlist. Fails CLOSED:
// an account with no `inbound_allowed_senders` AccountSetting configured yet
// accepts mail from NOBODY -- an admin must opt in an explicit sender/domain
// before email-in will process anything for that account. Entries: an exact
// address ("jane@acme.com"), a bare domain ("acme.com"), or an "@domain"
// form -- any of the three allow every sender at that domain except the exact
// form, which is an exact-address match.
async function isAllowedSender(accountId: string, senderAddr: string | null): Promise<boolean> {
  if (!senderAddr) return false;
  try {
    const setting = await prisma.accountSetting.findFirst({
      where: { accountId, key: 'inbound_allowed_senders' },
      select: { value: true },
    });
    if (!setting?.value) return false;
    let list: any;
    try { list = JSON.parse(setting.value); } catch { return false; }
    if (!Array.isArray(list) || list.length === 0) return false;
    const domain = senderAddr.split('@')[1] || '';
    return list.some((raw: any) => {
      const entry = String(raw || '').trim().toLowerCase();
      if (!entry) return false;
      if (entry.startsWith('@')) return domain === entry.slice(1);
      if (entry.includes('@')) return senderAddr === entry;
      return domain === entry;
    });
  } catch (e: any) {
    console.error('[inbound/email] allowlist lookup failed — failing closed:', e && e.message ? e.message : e);
    return false;
  }
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
    if (out.length >= MAX_INBOUND_ATTACHMENTS) break; // don't fetch more than we'd keep
    if (!isReportAttachment(att.filename, att.content_type)) continue;
    if (!att.download_url) continue;
    const dl = await fetch(att.download_url);
    if (!dl.ok) { console.error('[inbound] download failed', att.filename, dl.status); continue; }
    // Size guard BEFORE buffering: skip a download that declares more than the
    // per-attachment cap so a huge file can't be materialized into memory. A
    // lying Content-Length is still caught by the post-fetch size filter.
    const declaredLen = Number(dl.headers.get('content-length') || 0);
    if (declaredLen > MAX_INBOUND_ATT_BYTES) { console.warn('[inbound] attachment exceeds size cap, skipping', att.filename, declaredLen); continue; }
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

    // [2026-07-08 audit W1-H1] One identical response body for every
    // "nothing was enqueued" outcome — see the file-header note. Resend only
    // cares about the 2xx status (so it doesn't retry/bounce); nothing reads
    // this body.
    const ACCEPT_AND_DROP = { ok: true };

    const account = await resolveAccountByTo(data.to);
    if (!account) return res.status(202).json(ACCEPT_AND_DROP);

    // Sender authorization — see isAllowedSender() + file header. This is the
    // actual injection fix: the transport signature checked above proves the
    // request came through Resend, not who wrote the email.
    const senderAddr = senderEmail(data.from);
    if (!(await isAllowedSender(account.accountId, senderAddr))) {
      console.warn(`[inbound/email] rejected: sender ${senderAddr || '(unparseable)'} is not on the inbound allowlist for account ${account.accountId.slice(0, 8)}`);
      return res.status(202).json(ACCEPT_AND_DROP);
    }

    let attachments: Att[] = [];
    if (Array.isArray(data.attachments) && data.attachments.some((a: any) => a.content)) {
      attachments = data.attachments
        .filter((a: any) => a.content && isReportAttachment(a.filename, a.content_type || a.contentType))
        .map((a: any) => ({ filename: a.filename || 'report.pdf', contentType: a.content_type || a.contentType || 'application/pdf', buffer: Buffer.from(a.content, 'base64') }));
    } else if (data.email_id) {
      attachments = await fetchResendAttachments(data.email_id);
    }
    // Bound count + per-attachment size before we store/enqueue anything.
    attachments = attachments
      .filter((a) => a.buffer && a.buffer.length > 0 && a.buffer.length <= MAX_INBOUND_ATT_BYTES)
      .slice(0, MAX_INBOUND_ATTACHMENTS);
    if (!attachments.length) return res.status(202).json(ACCEPT_AND_DROP);

    const siteSetting = await prisma.accountSetting.findFirst({ where: { accountId: account.accountId, key: 'inbound_site_id' }, select: { value: true } });
    const siteId = siteSetting?.value || null;

    // The sender to acknowledge once the whole message is gated (null for
    // no-reply / loop-prone senders), and a batch id correlating these jobs so
    // the post-parse ack aggregates into one outcome email.
    const notifyEmail = (senderAddr && !NO_REPLY_RE.test(senderAddr)) ? senderAddr : null;
    const batchId = crypto.randomUUID();

    const jobs: string[] = [];
    for (const att of attachments) {
      const { storageKey } = await uploadFile(account.accountId, null, att.filename, att.buffer, att.contentType);
      const job = await prisma.ingestJob.create({ data: {
        accountId: account.accountId, createdById: null, kind: 'email_in', status: 'queued',
        fileKey: storageKey, fileName: att.filename, autoCommit: true, siteId,
        notifyEmail, batchId,
      } });
      jobs.push(job.id);
    }
    console.log(`[inbound/email] queued ${jobs.length} auto-commit job(s) for ${account.slug} (batch ${batchId}) from allowed sender ${senderAddr}`);

    // No ack here — lib/ingestAck sends the outcome email after parsing+gating.
    return res.status(202).json(ACCEPT_AND_DROP);
  } catch (err: any) {
    console.error('[inbound/email]', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'inbound processing failed' });
  }
});

module.exports = router;

export {};

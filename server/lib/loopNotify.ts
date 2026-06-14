export {};
/**
 * loopNotify.ts -- Tier-1 pipeline-loop notifications.
 *
 * Two account-facing, fire-and-forget emails that announce the moments which
 * generate the next job, so a human actually hears about them:
 *   notifyReportIngested      -- a test report finished processing -> fix list.
 *   notifyQuoteStatusChanged  -- a quote request was accepted/declined.
 *
 * Recipients mirror leaveBehindAutoSend: the account service-rep contact plus
 * active admins/managers. Default ON; an account can mute either type via
 * AccountSetting (loop_notify_ingest='false' / loop_notify_quote='false').
 * Never throws -- every failure is swallowed so it can't break the write path.
 */

const prisma = require('./prisma').default;
const { sendEmail } = require('./email');

async function _recipients(accountId: string) {
  const [account, users] = await Promise.all([
    prisma.account.findUnique({ where: { id: accountId }, select: { serviceRepEmail: true, companyName: true } }),
    prisma.user.findMany({ where: { accountId, role: { in: ['admin', 'manager'] }, isActive: true }, select: { email: true } }),
  ]);
  const emails = new Set<string>();
  if (account?.serviceRepEmail) emails.add(account.serviceRepEmail);
  for (const u of users as any[]) if (u.email) emails.add(u.email);
  return { emails: Array.from(emails), companyName: account?.companyName || 'your facility' };
}

// Default ON: only muted when the setting is explicitly 'false'.
async function _muted(accountId: string, key: string) {
  const t = await prisma.accountSetting.findUnique({
    where: { accountId_key: { accountId, key } }, select: { value: true },
  });
  return t?.value === 'false';
}

function _link(assetId?: string | null) {
  const base = process.env.CLIENT_URL || 'http://localhost:5173';
  return assetId ? `${base}/assets/${assetId}` : `${base}/dashboard`;
}

async function notifyReportIngested(accountId: string, s: {
  readings: number; deficiencies: number; immediate?: number;
  assetLabel?: string | null; assetId?: string | null;
}): Promise<void> {
  try {
    if (await _muted(accountId, 'loop_notify_ingest')) return;
    const { emails, companyName } = await _recipients(accountId);
    if (emails.length === 0) return;

    const findings = s.deficiencies > 0
      ? `<p>We flagged <strong>${s.deficiencies}</strong> item${s.deficiencies === 1 ? '' : 's'} to address`
        + `${s.immediate ? ` (<strong style="color:#c0392b;">${s.immediate} immediate</strong>)` : ''}.</p>`
      : `<p>Everything read in spec -- no new deficiencies.</p>`;
    const html =
      `<h2 style="margin:0 0 8px;">Your test report is in</h2>`
      + `<p>We read <strong>${s.readings}</strong> reading${s.readings === 1 ? '' : 's'}`
      + `${s.assetLabel ? ` from <strong>${s.assetLabel}</strong>` : ''}.</p>`
      + findings
      + `<p><a href="${_link(s.assetId)}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;">View your fix-it list &rarr;</a></p>`
      + `<p style="color:#888;font-size:12px;">Sent automatically when a report finished processing.</p>`;
    const subject = `Report processed${s.assetLabel ? ` -- ${s.assetLabel}` : ''} -- ${companyName}`;
    for (const to of emails) {
      try { await sendEmail({ to, subject, html }); }
      catch (e: any) { console.error('[loopNotify ingest] send failed:', e?.message || e); }
    }
  } catch (e: any) {
    console.error('[loopNotify ingest] failed:', e?.message || e);
  }
}

async function notifyQuoteStatusChanged(accountId: string, q: {
  status: string; quoteId: string; assetId?: string | null;
  assetLabel?: string | null; declineReason?: string | null;
}): Promise<void> {
  try {
    if (q.status !== 'accepted' && q.status !== 'declined') return;
    if (await _muted(accountId, 'loop_notify_quote')) return;
    const { emails, companyName } = await _recipients(accountId);
    if (emails.length === 0) return;

    const accepted = q.status === 'accepted';
    const html =
      `<h2 style="margin:0 0 8px;color:${accepted ? '#15803d' : '#b91c1c'};">Quote ${accepted ? 'accepted' : 'declined'}</h2>`
      + `<p>The quote request${q.assetLabel ? ` for <strong>${q.assetLabel}</strong>` : ''} was <strong>${q.status}</strong>.</p>`
      + (accepted
        ? `<p>A work order has been scheduled automatically.</p>`
        : (q.declineReason ? `<p><strong>Reason given:</strong> ${q.declineReason}</p>` : ''))
      + `<p><a href="${_link(q.assetId)}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;">Open the asset &rarr;</a></p>`
      + `<p style="color:#888;font-size:12px;">Sent automatically when a quote request changed status.</p>`;
    const subject = `Quote ${accepted ? 'ACCEPTED' : 'declined'}${q.assetLabel ? ` -- ${q.assetLabel}` : ''} -- ${companyName}`;
    for (const to of emails) {
      try { await sendEmail({ to, subject, html }); }
      catch (e: any) { console.error('[loopNotify quote] send failed:', e?.message || e); }
    }
  } catch (e: any) {
    console.error('[loopNotify quote] failed:', e?.message || e);
  }
}

module.exports = { notifyReportIngested, notifyQuoteStatusChanged };

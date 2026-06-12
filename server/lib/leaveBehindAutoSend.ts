/**
 * leaveBehindAutoSend.ts — #16 auto-send the leave-behind on WO completion.
 *
 * When a work order transitions to COMPLETE and the account has opted in
 * (AccountSetting auto_send_leave_behind = 'true'), generate the leave-behind
 * PDF and email it to the account's contacts (service rep + admins/managers).
 * Fire-and-forget: every failure is swallowed and logged so it can never break
 * the completion transition.
 */

import prisma from './prisma';
import { buildLeaveBehindPdf } from './leaveBehindData';
const { sendEmail } = require('./email');

export async function maybeAutoSendLeaveBehind(accountId: string, workOrderId: string): Promise<void> {
  try {
    const toggle = await prisma.accountSetting.findUnique({
      where:  { accountId_key: { accountId, key: 'auto_send_leave_behind' } },
      select: { value: true },
    });
    if (toggle?.value !== 'true') return; // opt-in only

    // Recipients: the account's service-rep contact + active admins/managers.
    const [account, users] = await Promise.all([
      prisma.account.findUnique({ where: { id: accountId }, select: { serviceRepEmail: true, companyName: true } }),
      prisma.user.findMany({ where: { accountId, role: { in: ['admin', 'manager'] }, isActive: true }, select: { email: true } }),
    ]);
    const emails = new Set<string>();
    if (account?.serviceRepEmail) emails.add(account.serviceRepEmail);
    for (const u of users as any[]) if (u.email) emails.add(u.email);
    if (emails.size === 0) return;

    const built = await buildLeaveBehindPdf(accountId, workOrderId);
    if (!built) return;

    const woShort = workOrderId.slice(-8).toUpperCase();
    const subject = `Service completion report — ${account?.companyName || 'your facility'}`;
    const html =
      `<p>Attached is the service completion leave-behind for work order <strong>${woShort}</strong>:</p>` +
      `<ul><li>What we found</li><li>What we fixed</li><li>What to budget for</li></ul>` +
      `<p>This was sent automatically on completion of the work order.</p><p>— ServiceCycle</p>`;

    for (const to of emails) {
      try {
        await sendEmail({ to, subject, html, attachments: [{ name: built.filename, content: built.pdfBuffer }] });
      } catch (e: any) {
        console.error('[autoSendLeaveBehind] send failed:', e?.message || e);
      }
    }
  } catch (e: any) {
    console.error('[autoSendLeaveBehind] failed:', e?.message || e);
  }
}

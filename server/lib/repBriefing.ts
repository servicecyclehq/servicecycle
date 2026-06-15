export {};
/**
 * repBriefing.ts -- the cadenced, forward-looking rep briefing (default monthly).
 *
 * Runs DAILY via cron but only SENDS to an account when alertCadence says a
 * briefing is due (watermark-driven, self-healing). Content is current-state and
 * forward-looking: everything overdue + due in 30/60/90/180 days, grouped, sent
 * to the account's reps (service-rep contact + active admins/managers) over
 * email and -- if connected -- Teams/Slack (reuses the alert-engine deliverers).
 *
 * This is the INTERNAL "push" lane on a slow cadence. Customer-triggered events
 * (quotes/emergencies via loopNotify + partner flywheel) are a separate IMMEDIATE
 * lane and are NOT throttled here.
 */

const prisma = require('./prisma').default;
const { sendEmail } = require('./email');
const { dueForBriefing, markBriefingSent, getCadence } = require('./alertCadence');
const { deliverTeamsDigest, deliverSlackDigest } = require('./alertEngine');

const LOOK_AHEAD_DAYS = 180;

const BUCKETS = [
  { key: 'overdue', label: 'Overdue',             color: '#dc2626', bg: '#fef2f2' },
  { key: 'd30',     label: 'Due within 30 days',  color: '#d97706', bg: '#fffbeb' },
  { key: 'd60',     label: 'Due within 60 days',  color: '#0d4f6e', bg: '#eaf2f6' },
  { key: 'd90',     label: 'Due within 90 days',  color: '#0d4f6e', bg: '#eaf2f6' },
  { key: 'd180',    label: 'Due within 180 days', color: '#64748b', bg: '#f1f5f9' },
];

function _daysUntil(due: any, now: Date) {
  return Math.ceil((new Date(due).getTime() - now.getTime()) / 86400000);
}
function _alertType(d: number) {
  return d <= -90 ? 'regulatory_breach' : d <= -7 ? 'escalation' : d < 0 ? 'overdue' : 'maintenance_due';
}
function _bucketKey(d: number) {
  if (d < 0) return 'overdue';
  if (d <= 30) return 'd30';
  if (d <= 60) return 'd60';
  if (d <= 90) return 'd90';
  return 'd180';
}

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

function _assetName(a: any) {
  return [a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType || a.serialNumber || 'Asset';
}

function _briefingHtml(companyName: string, items: any[], cadence: string, now: Date) {
  const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const byBucket: Record<string, any[]> = {};
  for (const it of items) (byBucket[_bucketKey(it.daysUntil)] ||= []).push(it);

  const sections = BUCKETS.filter(b => (byBucket[b.key] || []).length).map(b => {
    const rows = byBucket[b.key]
      .sort((x, y) => x.daysUntil - y.daysUntil)
      .map(it => {
        const a = it.asset;
        const when = it.daysUntil < 0 ? `${Math.abs(it.daysUntil)}d overdue` : `due in ${it.daysUntil}d`;
        const task = it.schedule?.taskDefinition?.taskName || 'Maintenance';
        const site = a.site?.name ? ` &middot; ${a.site.name}` : '';
        return `<tr><td style="padding:8px 14px;border-bottom:1px solid #f1f5f9;">`
          + `<a href="${appUrl}/assets/${a.id}" style="color:#1e293b;font-weight:600;text-decoration:none;">${_assetName(a)}</a>`
          + `<span style="color:#94a3b8;font-size:12px;">${site}</span><br>`
          + `<span style="font-size:12px;color:#475569;">${task} &mdash; ${when}</span></td></tr>`;
      }).join('');
    return `<div style="margin:0 0 4px;"><div style="font-weight:700;color:${b.color};background:${b.bg};padding:6px 14px;border-radius:4px;display:inline-block;margin:14px 0 4px;">${b.label} (${byBucket[b.key].length})</div>`
      + `<table style="width:100%;border-collapse:collapse;">${rows}</table></div>`;
  }).join('');

  const cadenceWord = cadence === 'weekly' ? 'weekly' : cadence === 'semimonthly' ? 'twice-monthly' : 'monthly';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>`
    + `<body style="margin:0;font-family:-apple-system,Segoe UI,sans-serif;background:#f8fafc;">`
    + `<div style="max-width:640px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">`
    + `<div style="background:#0f172a;padding:18px 24px;"><div style="font-size:12px;font-weight:700;color:rgba(255,255,255,.6);letter-spacing:.08em;text-transform:uppercase;">ServiceCycle &mdash; Maintenance Briefing</div>`
    + `<div style="font-size:19px;font-weight:700;color:#fff;margin-top:4px;">${items.length} item${items.length === 1 ? '' : 's'} on the horizon</div>`
    + `<div style="font-size:12px;color:rgba(255,255,255,.55);margin-top:4px;">${companyName} &mdash; your ${cadenceWord} look-ahead, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.</div></div>`
    + `<div style="padding:8px 24px 20px;">${sections}</div>`
    + `<div style="padding:16px 24px;border-top:1px solid #e2e8f0;"><a href="${appUrl}/dashboard" style="background:#0f172a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;">Open ServiceCycle &rarr;</a></div>`
    + `<div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;">Cadence is set to ${cadenceWord}. Change it under Settings &rarr; Alerts.</div>`
    + `</div></body></html>`;
}

async function runRepBriefing({ accountId }: any = {}) {
  const now = new Date();
  const lookAhead = new Date(now.getTime() + (LOOK_AHEAD_DAYS + 5) * 86400000);
  const accounts = accountId
    ? [{ id: accountId }]
    : await prisma.account.findMany({ select: { id: true } });

  let sent = 0, skipped = 0;
  for (const acc of accounts) {
    try {
      if (!(await dueForBriefing(acc.id, now))) { skipped++; continue; }

      const schedules = await prisma.maintenanceSchedule.findMany({
        where: {
          accountId: acc.id, isActive: true,
          nextDueDate: { not: null, lte: lookAhead },
          asset: { archivedAt: null, inService: true },
        },
        include: {
          taskDefinition: { select: { taskName: true } },
          asset: { select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true, site: { select: { id: true, name: true } } } },
        },
        take: 2000, orderBy: { nextDueDate: 'asc' },
      });
      // Nothing due -> don't send an empty briefing AND don't advance the
      // watermark, so a schedule that appears tomorrow is still caught promptly.
      if (schedules.length === 0) { skipped++; continue; }

      const { emails, companyName } = await _recipients(acc.id);
      if (emails.length === 0) { skipped++; continue; }

      const items = schedules.map((s: any) => {
        const d = _daysUntil(s.nextDueDate, now);
        return {
          schedule: { id: s.id, nextDueDate: s.nextDueDate, taskDefinition: { taskName: s.taskDefinition?.taskName || 'Maintenance' } },
          asset: s.asset, alertType: _alertType(d), daysUntil: d, leadDays: 0,
        };
      });

      const cadence = await getCadence(acc.id);
      const html = _briefingHtml(companyName, items, cadence, now);
      const subject = `Maintenance briefing -- ${items.length} item${items.length === 1 ? '' : 's'} due -- ${companyName}`;

      let ok = false;
      for (const to of emails) {
        try { await sendEmail({ to, subject, html }); ok = true; }
        catch (e: any) { console.error('[repBriefing] email failed:', e?.message || e); }
      }
      // Reuse the alert-engine channel deliverers (enable-check + decrypt inside).
      try { await deliverTeamsDigest({ accountId: acc.id, alertItems: items }); } catch (e: any) { console.warn('[repBriefing] teams skipped:', e?.message || e); }
      try { await deliverSlackDigest({ accountId: acc.id, alertItems: items }); } catch (e: any) { console.warn('[repBriefing] slack skipped:', e?.message || e); }

      if (ok) { await markBriefingSent(acc.id, now); sent++; console.log(`[repBriefing] sent to ${emails.length} recipient(s) for ${acc.id.slice(0, 8)} (${items.length} items)`); }
    } catch (e: any) {
      console.error('[repBriefing] account failed', acc.id, e?.message || e);
    }
  }
  console.log(`[repBriefing] done -- ${sent} briefings sent, ${skipped} skipped`);
  return { sent, skipped };
}

module.exports = { runRepBriefing };

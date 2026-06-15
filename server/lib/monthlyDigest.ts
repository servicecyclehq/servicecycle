export {};
/**
 * monthlyDigest.ts â€” the two-email monthly digest (manager roll-up + rep email)
 * on the shipped watermark cadence (lib/alertCadence.ts).
 *
 * This SPLITS the old single repBriefing into:
 *   â€¢ Manager roll-up â€” overall compliance %, a compliance bar chart (BY
 *     CUSTOMER for a partner org; BY SITE for a standalone account), totals
 *     (overdue count + pipeline $), and the full Excel of every rep's customers.
 *   â€¢ Rep email â€” that rep's book only: compliance across their customers, a
 *     top-N action list WITH dollars, and the Excel filtered to just theirs.
 *
 * Org model (Model A) â€” PartnerOrg â†’ oem_admin (manager) / assignedRep â†’
 * Account (customer) â†’ Site â†’ Asset:
 *   â€¢ Manager recipients = the partner org's oem_admin users (covers all its
 *     customer accounts).
 *   â€¢ Rep recipients     = each user set as assignedRepId on â‰¥1 account.
 *   â€¢ Standalone fallback (no partnerOrgId, e.g. demo Meridian): manager =
 *     the account's admins/managers; rep = account.serviceRepEmail.
 *
 * Cadence: the unit of throttling stays the CUSTOMER account (existing
 * per-account watermark, self-healing + idempotent). A run gathers the accounts
 * that are due, sends the manager + rep emails covering exactly those, then
 * advances each account's watermark only after a successful send.
 *
 * Charts are inline HTML/CSS bars (green/amber/red by threshold) â€” no remote
 * images (mail clients block them) and no attachments-as-images. Trend lines
 * are deferred to v2 (need history + an image pipeline).
 */

const prisma = require('./prisma').default;
const { sendEmail } = require('./email');
const { dueForBriefing, markBriefingSent, getCadence } = require('./alertCadence');
const { deliverTeamsDigest, deliverSlackDigest } = require('./alertEngine');
const { buildRateResolver } = require('./rateResolver');
const { buildComplianceGap, buildComplianceByCustomer, buildComplianceBySite } = require('./complianceReport');
const { buildDigestXlsxBuffer } = require('./digestExcel');

const LOOK_AHEAD_DAYS = 180;
const APP_URL = () => process.env.CLIENT_URL || 'https://servicecycle.app';

// â”€â”€ small helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _daysUntil(due: any, now: Date) {
  return Math.ceil((new Date(due).getTime() - now.getTime()) / 86400000);
}
function _bucketKey(d: number) {
  if (d < 0) return 'overdue';
  if (d <= 30) return 'd30';
  if (d <= 60) return 'd60';
  if (d <= 90) return 'd90';
  return 'd180';
}
function _statusText(d: number) {
  return d < 0 ? `${Math.abs(d)}d overdue` : `due in ${d}d`;
}
function _assetEquip(a: any) {
  const type = a.equipmentType ? String(a.equipmentType).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase()) : 'Asset';
  const mm = [a.manufacturer, a.model].filter(Boolean).join(' / ');
  return mm ? `${type} Â· ${mm}` : type;
}
function _esc(s: any) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _money(n: number) {
  if (!n) return '$0';
  if (n >= 1000) return `$${Math.round(n / 1000).toLocaleString()}k`;
  return `$${Math.round(n).toLocaleString()}`;
}
function _rateColor(rate: number | null) {
  if (rate == null) return '#94a3b8';
  if (rate >= 90) return '#16a34a';
  if (rate >= 70) return '#d97706';
  return '#dc2626';
}
function _cadenceWord(c: string) {
  return c === 'weekly' ? 'weekly' : c === 'semimonthly' ? 'twice-monthly' : 'monthly';
}

// â”€â”€ per-account data gathering â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Assemble everything the templates + Excel need for ONE customer account.
 * Returns null when the account has nothing on the 180-day horizon (caller
 * skips it WITHOUT advancing the watermark, so a schedule appearing tomorrow
 * is still caught promptly).
 */
async function gatherAccountDigest(account: any, now: Date) {
  const lookAhead = new Date(now.getTime() + (LOOK_AHEAD_DAYS + 5) * 86400000);

  const resolver = await buildRateResolver(prisma, {
    accountId: account.id,
    partnerOrgId: account.partnerOrgId ?? null,
  });

  const schedules = await prisma.maintenanceSchedule.findMany({
    where: {
      accountId: account.id, isActive: true,
      nextDueDate: { not: null, lte: lookAhead },
      asset: { archivedAt: null, inService: true },
    },
    include: {
      taskDefinition: { select: { taskName: true } },
      asset: {
        select: {
          id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true,
          governingCondition: true, priorityScore: true, modernizationRiskScore: true,
          installDate: true, autoConditionC3: true,
          site: { select: { id: true, name: true } },
        },
      },
    },
    take: 2000, orderBy: { nextDueDate: 'asc' },
  });

  if (schedules.length === 0) return null;

  // Worsening-trend assets: ADVISORY deficiencies whose text says "trending"
  // (written by commitAssetReadings in testReportImport).
  const assetIds = [...new Set(schedules.map((s: any) => s.asset.id))];
  const trendRows = assetIds.length === 0 ? [] : await prisma.deficiency.findMany({
    where: {
      accountId: account.id, resolvedAt: null, severity: 'ADVISORY',
      assetId: { in: assetIds }, description: { contains: 'trend', mode: 'insensitive' },
    },
    select: { assetId: true },
  });
  const trendingAssets = new Set(trendRows.map((d: any) => d.assetId));

  // Rep label for this account (Model A: assigned rep user; fallback: serviceRepName).
  const repName = account._assignedRepName || account.serviceRepName || 'Unassigned';

  let pipelineMin = 0, pipelineMax = 0, overdueCount = 0;
  const items: any[] = [];
  const rows: any[] = [];

  for (const s of schedules as any[]) {
    const a = s.asset;
    const d = _daysUntil(s.nextDueDate, now);
    if (d < 0) overdueCount++;
    const rate = resolver.forEquip(a.equipmentType);
    const estMin = rate ? Math.round(rate.minCents / 100) : null;
    const estMax = rate ? Math.round(rate.maxCents / 100) : null;
    if (estMin) pipelineMin += estMin;
    if (estMax) pipelineMax += estMax;
    const ageYears = a.installDate ? Math.round((now.getTime() - new Date(a.installDate).getTime()) / (365 * 86400000)) : null;
    const task = s.taskDefinition?.taskName || 'Maintenance';

    items.push({
      assetId: a.id, equipment: _assetEquip(a), siteName: a.site?.name || 'Unassigned',
      task, daysUntil: d, bucket: _bucketKey(d), status: _statusText(d),
      condition: a.governingCondition || 'C2', priorityScore: a.priorityScore ?? null,
      trend: trendingAssets.has(a.id), estMin, estMax,
    });
    rows.push({
      rep: repName, company: account.companyName, site: a.site?.name || 'Unassigned',
      equipment: _assetEquip(a), serviceNeeded: task, dueDate: s.nextDueDate,
      status: _statusText(d), condition: a.governingCondition || 'C2',
      priorityScore: a.priorityScore ?? null, trend: trendingAssets.has(a.id) ? 'âš  worsening' : '',
      estMinDollars: estMin, estMaxDollars: estMax,
      rulPct: a.modernizationRiskScore != null ? Math.round(a.modernizationRiskScore * 100) : null,
      ageYears, autoC3: !!a.autoConditionC3,
    });
  }

  // Headline compliance (current/(current+overdue)) + coverage, reused from the
  // in-app Path-to-100 so the digest agrees with the dashboard.
  let complianceRate: number | null = null;
  try {
    const gap = await buildComplianceGap(prisma, account.id, { limit: 1 });
    complianceRate = gap?.compliance?.rate ?? null;
  } catch { /* non-fatal â€” chart can render from per-site/customer rollup */ }

  return {
    accountId: account.id, companyName: account.companyName, repName,
    items, rows, totals: { overdueCount, pipelineMin, pipelineMax }, complianceRate,
  };
}

// â”€â”€ HTML building blocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _complianceBars(chartRows: Array<{ label: string; rate: number | null; overdue: number }>) {
  if (!chartRows.length) return '<div style="color:#94a3b8;font-size:13px;padding:8px 0;">No rated schedules yet.</div>';
  return chartRows.map((r) => {
    const pct = r.rate == null ? 0 : Math.max(2, Math.min(100, r.rate));
    const color = _rateColor(r.rate);
    const rateLabel = r.rate == null ? 'n/a' : `${r.rate}%`;
    const overdueTag = r.overdue > 0 ? `<span style="color:#dc2626;font-size:11px;font-weight:600;">${r.overdue} overdue</span>` : '';
    return `<div style="margin:0 0 10px;">`
      + `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px;">`
      + `<span style="font-size:13px;color:#1e293b;font-weight:600;">${_esc(r.label)}</span>`
      + `<span style="font-size:12px;color:${color};font-weight:700;">${rateLabel}&nbsp;&nbsp;${overdueTag}</span></div>`
      + `<div style="background:#f1f5f9;border-radius:4px;height:10px;overflow:hidden;">`
      + `<div style="width:${pct}%;height:10px;background:${color};border-radius:4px;"></div></div></div>`;
  }).join('');
}

function _shell(headerKicker: string, headerTitle: string, headerSub: string, bodyHtml: string, cadence: string) {
  const cadenceWord = _cadenceWord(cadence);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>`
    + `<body style="margin:0;font-family:-apple-system,Segoe UI,sans-serif;background:#f8fafc;">`
    + `<div style="max-width:680px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">`
    + `<div style="background:#0f172a;padding:18px 24px;">`
    + `<div style="font-size:12px;font-weight:700;color:rgba(255,255,255,.6);letter-spacing:.08em;text-transform:uppercase;">${_esc(headerKicker)}</div>`
    + `<div style="font-size:20px;font-weight:700;color:#fff;margin-top:4px;">${_esc(headerTitle)}</div>`
    + `<div style="font-size:12px;color:rgba(255,255,255,.55);margin-top:4px;">${_esc(headerSub)}</div></div>`
    + `<div style="padding:18px 24px;">${bodyHtml}</div>`
    + `<div style="padding:16px 24px;border-top:1px solid #e2e8f0;"><a href="${APP_URL()}/dashboard" style="background:#0f172a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;">Open ServiceCycle &rarr;</a></div>`
    + `<div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;">Digest cadence is ${cadenceWord}. Change it under Settings &rarr; Alerts. The attached spreadsheet has every line item.</div>`
    + `</div></body></html>`;
}

function _totalsStrip(overdueCount: number, pipelineMin: number, pipelineMax: number) {
  const pipe = pipelineMin && pipelineMax && pipelineMin !== pipelineMax
    ? `${_money(pipelineMin)} â€“ ${_money(pipelineMax)}` : _money(pipelineMax || pipelineMin);
  return `<div style="display:flex;gap:12px;margin:0 0 16px;">`
    + `<div style="flex:1;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:12px;">`
    + `<div style="font-size:22px;font-weight:800;color:#dc2626;">${overdueCount}</div>`
    + `<div style="font-size:11px;color:#991b1b;text-transform:uppercase;letter-spacing:.05em;font-weight:600;">Overdue items</div></div>`
    + `<div style="flex:1;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px;">`
    + `<div style="font-size:22px;font-weight:800;color:#1d4ed8;">${pipe}</div>`
    + `<div style="font-size:11px;color:#1e40af;text-transform:uppercase;letter-spacing:.05em;font-weight:600;">Service pipeline</div></div></div>`;
}

// â”€â”€ manager roll-up + rep templates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function managerRollupHtml(opts: any) {
  const { scopeName, chartTitle, chartRows, overallRate, totals, generatedAt, cadence, repCount, customerCount } = opts;
  const overallColor = _rateColor(overallRate);
  const body =
    `<div style="display:flex;align-items:center;gap:14px;margin:0 0 16px;">`
    + `<div style="font-size:40px;font-weight:800;color:${overallColor};line-height:1;">${overallRate == null ? 'n/a' : overallRate + '%'}</div>`
    + `<div style="font-size:13px;color:#475569;">Overall maintenance compliance<br><span style="color:#94a3b8;font-size:12px;">${customerCount} customer${customerCount === 1 ? '' : 's'} Â· ${repCount} rep${repCount === 1 ? '' : 's'} Â· ${generatedAt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span></div></div>`
    + _totalsStrip(totals.overdueCount, totals.pipelineMin, totals.pipelineMax)
    + `<div style="font-size:13px;font-weight:700;color:#0f172a;margin:18px 0 10px;">${_esc(chartTitle)}</div>`
    + _complianceBars(chartRows);
  return _shell('ServiceCycle â€” Manager Roll-up', `${scopeName}: monthly compliance`, 'Your whole book at a glance â€” full line-item detail in the attached spreadsheet.', body, cadence);
}

function repEmailHtml(opts: any) {
  const { repName, chartTitle, chartRows, overallRate, totals, topItems, generatedAt, cadence } = opts;
  const overallColor = _rateColor(overallRate);

  const rowsHtml = topItems.map((it: any) => {
    const est = it.estMin && it.estMax && it.estMin !== it.estMax
      ? `${_money(it.estMin)} â€“ ${_money(it.estMax)}` : it.estMax ? _money(it.estMax) : 'â€”';
    const whenColor = it.daysUntil < 0 ? '#dc2626' : it.daysUntil <= 30 ? '#d97706' : '#475569';
    const trend = it.trend ? ` <span style="color:#dc2626;font-size:11px;">âš  worsening</span>` : '';
    return `<tr><td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;">`
      + `<span style="font-weight:600;color:#1e293b;">${_esc(it.equipment)}</span> `
      + `<span style="color:#94a3b8;font-size:12px;">Â· ${_esc(it.companyName)} Â· ${_esc(it.siteName)}</span><br>`
      + `<span style="font-size:12px;color:#475569;">${_esc(it.task)} â€” <span style="color:${whenColor};font-weight:600;">${_esc(it.status)}</span> Â· ${_esc(it.condition)}${trend}</span></td>`
      + `<td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;text-align:right;white-space:nowrap;font-weight:700;color:#1d4ed8;font-size:13px;">${est}</td></tr>`;
  }).join('');

  const body =
    `<div style="display:flex;align-items:center;gap:14px;margin:0 0 16px;">`
    + `<div style="font-size:40px;font-weight:800;color:${overallColor};line-height:1;">${overallRate == null ? 'n/a' : overallRate + '%'}</div>`
    + `<div style="font-size:13px;color:#475569;">Compliance across your book<br><span style="color:#94a3b8;font-size:12px;">${generatedAt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span></div></div>`
    + _totalsStrip(totals.overdueCount, totals.pipelineMin, totals.pipelineMax)
    + `<div style="font-size:13px;font-weight:700;color:#0f172a;margin:18px 0 10px;">${_esc(chartTitle)}</div>`
    + _complianceBars(chartRows)
    + `<div style="font-size:13px;font-weight:700;color:#0f172a;margin:20px 0 8px;">Top items to act on this month</div>`
    + `<table style="width:100%;border-collapse:collapse;">${rowsHtml || '<tr><td style="padding:10px;color:#94a3b8;font-size:13px;">Nothing outstanding â€” nice.</td></tr>'}</table>`;
  return _shell('ServiceCycle â€” Rep Digest', `${repName}: your month`, 'Your customers, ranked by what needs doing â€” full list attached.', body, cadence);
}

// â”€â”€ send helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _aggregate(bundles: any[]) {
  const items: any[] = [];
  const rows: any[] = [];
  let overdueCount = 0, pipelineMin = 0, pipelineMax = 0;
  for (const b of bundles) {
    for (const it of b.items) items.push({ ...it, companyName: b.companyName });
    rows.push(...b.rows);
    overdueCount += b.totals.overdueCount;
    pipelineMin += b.totals.pipelineMin;
    pipelineMax += b.totals.pipelineMax;
  }
  return { items, rows, totals: { overdueCount, pipelineMin, pipelineMax } };
}

function _topItems(items: any[], n = 14) {
  return items.slice().sort((a, b) => {
    if ((a.daysUntil < 0) !== (b.daysUntil < 0)) return a.daysUntil < 0 ? -1 : 1; // overdue first
    const p = (b.priorityScore || 0) - (a.priorityScore || 0);
    if (p !== 0) return p;
    return (b.estMax || 0) - (a.estMax || 0);
  }).slice(0, n);
}

async function _sendEmails(recipients: string[], subject: string, html: string, attachment: { name: string; content: Buffer } | null) {
  let ok = false;
  for (const to of recipients) {
    if (!to) continue;
    try {
      await sendEmail({ to, subject, html, attachments: attachment ? [attachment] : undefined });
      ok = true;
    } catch (e: any) { console.error('[monthlyDigest] email failed:', e?.message || e); }
  }
  return ok;
}

async function _deliverChannels(accountIds: string[], itemsByAccount: Map<string, any[]>) {
  for (const accId of accountIds) {
    const alertItems = (itemsByAccount.get(accId) || []).map((it) => ({
      asset: { id: it.assetId }, daysUntil: it.daysUntil,
      schedule: { taskDefinition: { taskName: it.task } },
      alertType: it.daysUntil < 0 ? 'overdue' : 'maintenance_due',
    }));
    if (!alertItems.length) continue;
    try { await deliverTeamsDigest({ accountId: accId, alertItems }); } catch (e: any) { console.warn('[monthlyDigest] teams skipped:', e?.message || e); }
    try { await deliverSlackDigest({ accountId: accId, alertItems }); } catch (e: any) { console.warn('[monthlyDigest] slack skipped:', e?.message || e); }
  }
}

// â”€â”€ orchestrator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runMonthlyDigest({ accountId, force }: any = {}) {
  const now = new Date();
  let managerEmails = 0, repEmails = 0, accountsCovered = 0, skipped = 0;

  const accounts = accountId
    ? await prisma.account.findMany({ where: { id: accountId } })
    : await prisma.account.findMany();

  // Resolve due customer accounts (watermark-gated unless forced).
  const due: any[] = [];
  for (const acc of accounts) {
    if (!force && !(await dueForBriefing(acc.id, now))) { skipped++; continue; }
    due.push(acc);
  }
  if (due.length === 0) {
    console.log(`[monthlyDigest] done â€” nothing due (${skipped} skipped)`);
    return { managerEmails, repEmails, accountsCovered, skipped };
  }

  // Pre-resolve assigned-rep names for Model A accounts (one query).
  const repIds = [...new Set(due.map((a) => a.assignedRepId || a.fallbackRepId).filter(Boolean))];
  const repUsers = repIds.length
    ? await prisma.user.findMany({ where: { id: { in: repIds } }, select: { id: true, name: true, email: true, isActive: true } })
    : [];
  const repById = new Map<string, any>(repUsers.map((u: any) => [u.id, u] as [string, any]));

  // Partition due accounts: partner-org vs standalone.
  const standalone = due.filter((a) => !a.partnerOrgId);
  const partnerGroups = new Map<string, any[]>();
  for (const a of due.filter((x) => x.partnerOrgId)) {
    if (!partnerGroups.has(a.partnerOrgId)) partnerGroups.set(a.partnerOrgId, []);
    partnerGroups.get(a.partnerOrgId)!.push(a);
  }

  const cadenceCache = new Map<string, string>();
  const cadenceFor = async (id: string) => {
    if (!cadenceCache.has(id)) cadenceCache.set(id, await getCadence(id));
    return cadenceCache.get(id)!;
  };

  // â”€â”€ Standalone accounts: manager = admins/managers; rep = serviceRepEmail â”€â”€
  for (const acc of standalone) {
    try {
      const bundle = await gatherAccountDigest(acc, now);
      if (!bundle) { skipped++; continue; }
      const cadence = await cadenceFor(acc.id);

      const [bySite, managers] = await Promise.all([
        buildComplianceBySite(prisma, acc.id, { now }),
        prisma.user.findMany({ where: { accountId: acc.id, role: { in: ['admin', 'manager'] }, isActive: true }, select: { email: true } }),
      ]);
      const chartRows = bySite.map((s: any) => ({ label: s.siteName, rate: s.complianceRate, overdue: s.overdueCount }));
      const xlsx = await buildDigestXlsxBuffer(bundle.rows, { title: `${acc.companyName} â€” Monthly Service Digest` });
      const attach = { name: `servicecycle-digest-${now.toISOString().slice(0, 7)}.xlsx`, content: xlsx };

      const managerHtml = managerRollupHtml({
        scopeName: acc.companyName, chartTitle: 'Compliance by site', chartRows,
        overallRate: bundle.complianceRate, totals: bundle.totals, generatedAt: now, cadence,
        repCount: 1, customerCount: 1,
      });
      const managerTo = [...new Set((managers as any[]).map((m) => m.email).filter(Boolean))];
      if (await _sendEmails(managerTo, `Monthly compliance roll-up â€” ${acc.companyName}`, managerHtml, attach)) managerEmails++;

      // Rep email â†’ account.serviceRepEmail (the standalone "rep").
      if (acc.serviceRepEmail) {
        const repHtml = repEmailHtml({
          repName: acc.serviceRepName || 'Service Rep', chartTitle: 'Compliance by site', chartRows,
          overallRate: bundle.complianceRate, totals: bundle.totals,
          topItems: _topItems(bundle.items.map((it: any) => ({ ...it, companyName: acc.companyName }))),
          generatedAt: now, cadence,
        });
        if (await _sendEmails([acc.serviceRepEmail], `Your service book â€” ${acc.companyName}`, repHtml, attach)) repEmails++;
      }

      const itemsByAccount = new Map([[acc.id, bundle.items]]);
      await _deliverChannels([acc.id], itemsByAccount);

      await markBriefingSent(acc.id, now);
      accountsCovered++;
    } catch (e: any) {
      console.error('[monthlyDigest] standalone account failed', acc.id, e?.message || e);
    }
  }

  // â”€â”€ Partner orgs: manager = oem_admin; rep = assignedRep user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  for (const [orgId, orgAccounts] of partnerGroups) {
    try {
      // Attach rep name onto each account for gather/Excel.
      for (const a of orgAccounts) {
        const rep = repById.get(a.assignedRepId) || repById.get(a.fallbackRepId);
        a._assignedRepName = rep?.name || 'Unassigned';
      }

      const bundles: any[] = [];
      const itemsByAccount = new Map<string, any[]>();
      for (const a of orgAccounts) {
        const b = await gatherAccountDigest(a, now);
        if (b) { bundles.push({ ...b, account: a }); itemsByAccount.set(a.id, b.items); }
      }
      if (bundles.length === 0) {
        // Nothing on horizon for any due account â€” skip, don't advance watermark.
        skipped += orgAccounts.length;
        continue;
      }

      const cadence = await cadenceFor(bundles[0].account.id);
      const coveredIds = bundles.map((b) => b.account.id);
      const byCustomer = await buildComplianceByCustomer(prisma, coveredIds, { now });
      const customerChart = byCustomer.map((c: any) => ({ label: c.companyName, rate: c.complianceRate, overdue: c.overdueCount }));

      const org = await prisma.partnerOrganization.findUnique({ where: { id: orgId }, select: { name: true } });
      const orgName = org?.name || 'Partner';

      // Overall = weighted by rated schedules across the org's covered accounts.
      let cur = 0, ovr = 0;
      for (const c of byCustomer) { cur += c.currentCount || 0; ovr += c.overdueCount || 0; }
      const overallRate = (cur + ovr) > 0 ? Math.round((cur / (cur + ovr)) * 1000) / 10 : null;

      const agg = _aggregate(bundles);
      const repNamesCovered = new Set(orgAccounts.map((a: any) => a._assignedRepName));

      // Manager roll-up â€” one email to all oem_admins, full Excel.
      const oemAdmins = await prisma.user.findMany({
        where: { role: 'oem_admin', isActive: true, account: { partnerOrgId: orgId } },
        select: { email: true },
      });
      const managerXlsx = await buildDigestXlsxBuffer(agg.rows, { title: `${orgName} â€” Monthly Service Digest` });
      const managerAttach = { name: `servicecycle-digest-${now.toISOString().slice(0, 7)}.xlsx`, content: managerXlsx };
      const managerHtml = managerRollupHtml({
        scopeName: orgName, chartTitle: 'Compliance by customer', chartRows: customerChart,
        overallRate, totals: agg.totals, generatedAt: now, cadence,
        repCount: repNamesCovered.size, customerCount: coveredIds.length,
      });
      const managerTo = [...new Set((oemAdmins as any[]).map((m) => m.email).filter(Boolean))];
      if (await _sendEmails(managerTo, `Monthly compliance roll-up â€” ${orgName}`, managerHtml, managerAttach)) managerEmails++;

      // Rep emails â€” group covered accounts by assignedRep user.
      const byRep = new Map<string, any[]>();
      for (const b of bundles) {
        const repKey = b.account.assignedRepId || b.account.fallbackRepId || '__unassigned__';
        if (!byRep.has(repKey)) byRep.set(repKey, []);
        byRep.get(repKey)!.push(b);
      }
      for (const [repKey, repBundles] of byRep) {
        const rep = repById.get(repKey);
        if (!rep || !rep.email || !rep.isActive) continue; // unassigned bucket â†’ manager already has it
        const repAgg = _aggregate(repBundles);
        const repCustomerIds = repBundles.map((b) => b.account.id);
        const repByCustomer = await buildComplianceByCustomer(prisma, repCustomerIds, { now });
        const repChart = repByCustomer.map((c: any) => ({ label: c.companyName, rate: c.complianceRate, overdue: c.overdueCount }));
        let rc = 0, ro = 0;
        for (const c of repByCustomer) { rc += c.currentCount || 0; ro += c.overdueCount || 0; }
        const repOverall = (rc + ro) > 0 ? Math.round((rc / (rc + ro)) * 1000) / 10 : null;

        const repXlsx = await buildDigestXlsxBuffer(repAgg.rows, { title: `${rep.name} â€” Monthly Service Digest` });
        const repAttach = { name: `servicecycle-digest-${now.toISOString().slice(0, 7)}.xlsx`, content: repXlsx };
        const repHtml = repEmailHtml({
          repName: rep.name || 'Rep', chartTitle: 'Compliance by customer', chartRows: repChart,
          overallRate: repOverall, totals: repAgg.totals, topItems: _topItems(repAgg.items),
          generatedAt: now, cadence,
        });
        if (await _sendEmails([rep.email], `Your service book â€” ${repBundles.length} customer${repBundles.length === 1 ? '' : 's'}`, repHtml, repAttach)) repEmails++;
      }

      await _deliverChannels(coveredIds, itemsByAccount);
      for (const id of coveredIds) { await markBriefingSent(id, now); accountsCovered++; }
    } catch (e: any) {
      console.error('[monthlyDigest] partner org failed', orgId, e?.message || e);
    }
  }

  console.log(`[monthlyDigest] done â€” ${managerEmails} manager + ${repEmails} rep emails, ${accountsCovered} accounts covered, ${skipped} skipped`);
  return { managerEmails, repEmails, accountsCovered, skipped };
}

module.exports = { runMonthlyDigest, gatherAccountDigest, managerRollupHtml, repEmailHtml };

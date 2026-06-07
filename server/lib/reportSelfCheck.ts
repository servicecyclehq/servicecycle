'use strict';

/**
 * lib/reportSelfCheck.ts
 * ----------------------
 * Periodic self-check that every report (and core page) endpoint still responds
 * on the live data. Driven by the `reportSelfCheck` cron in index.ts (every 6h).
 *
 * Reports break in ways a plain uptime check misses: the page mounts but shows
 * a "Failed to load report" banner because the backing query 500s on a specific
 * data shape. This catches that at the source.
 *
 * For each account that has an active admin/manager user, we mint a short-lived
 * token for that user and GET each report endpoint over localhost (exercising
 * the real route -> auth -> handler -> DB path). A status >= 500 (or a network
 * error) counts as a failure. On any failure we email REPORT_HEALTH_ALERT_EMAIL
 * (if set) via the app's existing mailer; otherwise we log and move on.
 *
 * Env:
 *   REPORT_HEALTH_ALERT_EMAIL   recipient for failure alerts (no email if unset)
 *   PORT                        server port (default 3001) for the localhost call
 *   PUBLIC_HOST / CLIENT_URL    used only to label which instance alerted
 */

import prisma from './prisma';
const { signToken } = require('./jwtSecrets');
const { sendEmail } = require('./email');

// Keep in sync with the client report routes (App.jsx) and e2e/smoke.spec.js.
const REPORT_SLUGS = [
  'renewal-horizon', 'risk-radar', 'savings-ledger', 'license-wastage', 'spend-ledger',
  'executive-spend', 'auto-renewal-exposure', 'vendor-concentration', 'non-saas-categories',
  'application-overlap', 'budget-shock-simulator', 'total-addressable-waste',
  'termination-window-violations', 'license-reclamation-roi', 'cost-per-active-user',
  'negotiation-effectiveness-by-owner', 'vendor-negotiation-difficulty', 'price-escalation-radar',
  'multi-year-commitment-risk', 'contract-health-score', 'department-budget-allocation',
  'price-per-seat-benchmark', 'gl-code-spend', 'walkaway-calculator', 'portfolio-decision-dashboard',
  'renewal-win-rate', 'contract-ownership', 'audit-evidence-pack', 'vendor-heat-map',
  'co-term-opportunity', 'renewal-commitment-forecast',
];

// A handful of core page-backing endpoints, so the check also notices if the
// main surfaces go down (not just reports).
const CORE_ENDPOINTS = [
  '/api/contracts', '/api/vendors', '/api/dashboard', '/api/alerts',
  '/api/news/summary', '/api/activity', '/api/settings',
];

async function checkOne(base: string, path: string, token: string): Promise<number | string> {
  try {
    const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
    return res.status;
  } catch (e: any) {
    return 'ERR:' + (e && e.message ? e.message : 'fetch failed');
  }
}

// Run the full sweep. Returns { ok, checked, accounts, failures:[{account,path,status}] }.
async function runReportSelfCheck() {
  const port = process.env.PORT || 3001;
  const base = `http://127.0.0.1:${port}`;
  const accounts = await prisma.account.findMany({ select: { id: true, companyName: true } });

  const failures: Array<{ account: string; path: string; status: number | string }> = [];
  let checked = 0;
  let accountsTested = 0;

  const targets = [
    ...REPORT_SLUGS.map((s) => `/api/reports/${s}`),
    ...CORE_ENDPOINTS,
  ];

  for (const acct of accounts) {
    // Need an active manager/admin to satisfy requireManager on the report routes.
    const user = await prisma.user.findFirst({
      where: { accountId: acct.id, isActive: true, role: { in: ['admin', 'manager'] } },
      select: { id: true },
    });
    if (!user) continue;
    accountsTested++;

    const token = signToken({ userId: user.id }, { expiresIn: '5m' });
    const label = acct.companyName || acct.id.slice(0, 8);

    for (const path of targets) {
      const status = await checkOne(base, path, token);
      checked++;
      const broken = typeof status === 'string' || status >= 500;
      if (broken) failures.push({ account: label, path, status });
    }
  }

  return { ok: failures.length === 0, checked, accounts: accountsTested, failures };
}

// Cron entry point: run the sweep, log the outcome, and email on failure.
async function reportSelfCheckCron() {
  const result = await runReportSelfCheck();

  if (result.ok) {
    console.log(`[reportSelfCheck] OK - ${result.checked} checks across ${result.accounts} account(s)`);
    return result;
  }

  const summary = result.failures.map((f) => `${f.path} -> ${f.status} (${f.account})`).join('; ');
  console.error(`[reportSelfCheck] ${result.failures.length} failing endpoint(s): ${summary}`);

  const to = process.env.REPORT_HEALTH_ALERT_EMAIL;
  if (!to) {
    console.warn('[reportSelfCheck] REPORT_HEALTH_ALERT_EMAIL not set - logged only, no email sent.');
    return result;
  }

  const host = process.env.PUBLIC_HOST || process.env.CLIENT_URL || require('os').hostname();
  const rows = result.failures
    .map((f) =>
      `<tr><td style="padding:4px 10px;font-family:monospace">${f.path}</td>` +
      `<td style="padding:4px 10px">${f.status}</td>` +
      `<td style="padding:4px 10px">${f.account}</td></tr>`)
    .join('');

  try {
    await sendEmail({
      to,
      subject: `[LapseIQ] ${result.failures.length} report/page health check(s) failing`,
      html:
        `<p><strong>${result.failures.length}</strong> of ${result.checked} health checks failed on ` +
        `<strong>${host}</strong>.</p>` +
        `<table style="border-collapse:collapse;font-size:14px">` +
        `<thead><tr>` +
        `<th style="text-align:left;padding:4px 10px;border-bottom:1px solid #ddd">Endpoint</th>` +
        `<th style="text-align:left;padding:4px 10px;border-bottom:1px solid #ddd">Status</th>` +
        `<th style="text-align:left;padding:4px 10px;border-bottom:1px solid #ddd">Account</th>` +
        `</tr></thead><tbody>${rows}</tbody></table>` +
        `<p style="color:#666;font-size:12px">A status of 500 or ERR means that report/page is ` +
        `currently broken for users. Sent by the reportSelfCheck cron (every 6h).</p>`,
    });
    console.log('[reportSelfCheck] alert email sent to', to);
  } catch (e: any) {
    console.error('[reportSelfCheck] failed to send alert email:', e.message);
  }

  return result;
}

module.exports = { runReportSelfCheck, reportSelfCheckCron, REPORT_SLUGS };

export {};

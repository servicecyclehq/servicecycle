// ─────────────────────────────────────────────────────────────────────────────
// ComplianceStandardsReport.jsx — per-standard compliance hub (/reports/compliance).
//
// GET /api/compliance/summary?siteId= → data.summary: one row per governing
// standard ({code, edition, title, keyMandate}; code 'Account-defined' for
// custom tasks) with assetCount / scheduleCount / currentCount / overdueCount
// / unbaselinedCount / complianceRate / nextDue.
//
// Site filter (GET /api/sites) scopes the whole table. Row click drills into
// /reports/compliance/:standardCode (code is encodeURIComponent-encoded — it
// contains spaces, e.g. "NFPA 70B"). The compliance-rate bar reuses the
// Dashboard treatment: green ≥90, amber ≥70, red below.
//
// C2e (2026-07-13): opts into the shared Field Report print standard
// (styles/print.css): Print button, print-only masthead/footer, one numbered
// section for the summary table. The interactive insight cards are no-print
// -- the printed artifact is the standards table itself.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, Printer, Download } from 'lucide-react';
import api from '../api/client';
import { downloadAuthedFile } from '../api/download';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import EmptyState from '../components/EmptyState';
import BackLink, { useFromState } from '../components/BackLink';
import PathTo100 from '../components/PathTo100';
import MaturityScoreCard from '../components/MaturityScoreCard';
import MaintenanceDebtCard from '../components/MaintenanceDebtCard';
import ChangeBriefCard from '../components/ChangeBriefCard';
import AccessBlockerCard from '../components/AccessBlockerCard';
import EvidenceGapCard from '../components/EvidenceGapCard';
import AuditFailureCard from '../components/AuditFailureCard';
import ForgottenAssetsCard from '../components/ForgottenAssetsCard';
import ProposalCard from '../components/ProposalCard';
import InsurerPackageCard from '../components/InsurerPackageCard';
import DriftDetectorCard from '../components/DriftDetectorCard';
import { useAuth } from '../context/AuthContext';
import { fmtDate } from '../lib/equipment';

// Same thresholds as Dashboard's SiteComplianceRow.
function complianceColor(rate) {
  if (rate >= 90) return 'var(--color-success, #22c55e)';
  if (rate >= 70) return 'var(--color-warning, #f59e0b)';
  return 'var(--color-danger, #dc2626)';
}

function ComplianceRateBar({ rate }) {
  if (rate == null) return <span className="text-muted">—</span>;
  const color = complianceColor(rate);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 160 }}>
      <div style={{ flex: 1, height: 8, background: 'var(--color-border)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, rate))}%`, background: color, borderRadius: 4, transition: 'width 0.4s ease' }} />
      </div>
      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color, flexShrink: 0, minWidth: 38, textAlign: 'right' }}>
        {rate}%
      </span>
    </div>
  );
}

export default function ComplianceStandardsReport() {
  useDocumentTitle('Compliance by Standard');
  const navigate = useNavigate();
  const { role, user } = useAuth();
  const canSeeProposal = ['admin', 'manager', 'oem_admin'].includes(role);
  // #3 insurer package + break-glass links: creation is requireManager (admin/manager).
  const canManageInsurer = ['admin', 'manager'].includes(role);
  // C1: drill-downs record this report as the origin for their BackLink.
  const fromState = useFromState();

  const [sites, setSites]     = useState([]);
  const [siteId, setSiteId]   = useState('');
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    api.get('/api/sites')
      .then(r => setSites(r.data?.data?.sites || []))
      .catch(() => { /* filter just stays empty */ });
  }, []);

  useEffect(() => {
    setLoading(true);
    setError('');
    const params = {};
    if (siteId) params.siteId = siteId;
    api.get('/api/compliance/summary', { params })
      // API returns the rows under `data.standards` (buildStandardsSummary);
      // this page previously read `data.summary`, which is undefined — so every
      // account rendered the empty "No compliance data yet" state despite having
      // full compliance data. Read the correct key (fall back to `summary` in
      // case an older/newer server ever ships that shape).
      .then(r => setRows(r.data?.data?.standards || r.data?.data?.summary || []))
      .catch(err => setError(err.response?.data?.error || 'Failed to load compliance summary.'))
      .finally(() => setLoading(false));
  }, [siteId]);

  const openStandard = (code) => navigate(`/reports/compliance/${encodeURIComponent(code)}`, { state: fromState });

  // C2e print support: masthead/briefline inputs (screen behavior unchanged).
  const companyName = user?.account?.companyName || '';
  const activeSiteName = siteId ? (sites.find(s => String(s.id) === String(siteId))?.name || '') : '';
  const totals = rows.reduce((t, r) => ({
    assets: t.assets + (r.assetCount ?? 0),
    schedules: t.schedules + (r.scheduleCount ?? 0),
    overdue: t.overdue + (r.overdueCount ?? 0),
  }), { assets: 0, schedules: 0, overdue: 0 });

  // Dashboard cleanup pass (2026-07-13): single computed value shared by the
  // print masthead and footer so they can never drift apart. Unlike
  // OverdueReport.jsx / ComplianceStandardDetailReport.jsx, this endpoint
  // (GET /api/compliance/summary) has no server-side generatedAt field to
  // key off of -- verified against buildStandardsSummary in
  // server/lib/complianceReport.ts -- so this is computed client-side once
  // per render instead of two independent `new Date()` calls.
  const generatedAt = new Date();

  // Server-rendered "Field Report" PDF of the standards summary (masthead,
  // posture narrative, per-standard table). Distinct from browser Print: it's
  // the same document an auditor would expect, generated server-side.
  async function handleDownloadPdf() {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      const qs = siteId ? `?siteId=${encodeURIComponent(siteId)}` : '';
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/compliance/standards.pdf${qs}`;
      const scope = (activeSiteName || 'All_Sites').replace(/[^\w-]+/g, '_');
      const stamp = new Date().toISOString().slice(0, 10);
      await downloadAuthedFile(url, `Compliance_by_Standard_${scope}_${stamp}.pdf`);
    } catch (e) {
      setError(e?.message || 'Failed to download the PDF.');
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/reports" fallbackLabel="Reports" />
          <h1 className="page-title">Compliance by Standard</h1>
          <div className="page-subtitle">
            Maintenance compliance rolled up per governing standard. Click a row for the full evidence table.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleDownloadPdf}
            disabled={pdfBusy || loading || rows.length === 0}
            title="Download this report as a PDF"
          >
            <Download size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            {pdfBusy ? 'Building PDF…' : 'Download PDF'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => window.print()}
            title="Print this report"
          >
            <Printer size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Print
          </button>
        </div>
      </div>

      <div className="page-body print-doc">
        {/* C2e: shared Field Report print standard (styles/print.css) */}
        <header className="print-masthead print-only">
          <h1 className="print-masthead-title">Compliance by Standard</h1>
          <div className="print-masthead-meta">
            {companyName ? <>{companyName}<br /></> : null}
            {activeSiteName || 'All sites'}<br />
            Generated {generatedAt.toLocaleDateString()}
          </div>
        </header>
        <div className="print-rule print-only"></div>

        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <label htmlFor="compliance-site-filter" className="form-label" style={{ margin: 0 }}>Site</label>
          <select
            id="compliance-site-filter"
            className="form-control"
            style={{ maxWidth: 280 }}
            value={siteId}
            onChange={e => setSiteId(e.target.value)}
          >
            <option value="">All sites</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {/* C2e: the interactive insight cards (drill-downs, generators, buttons)
            are screen tools, not printed-report content -- excluded from the
            printed artifact wholesale. The printed doc is the standards table. */}
        <div className="no-print">

        {/* #1 — "What will fail an audit": one ranked list of likely findings. */}
        <AuditFailureCard siteId={siteId || null} />

        {/* B1 — NFPA 70B program-maturity score vs the standard. */}
        <MaturityScoreCard siteId={siteId || null} />

        {/* Maintenance Debt Ledger — $ debt + 1/3/5-yr capital plan (account-wide). */}
        <MaintenanceDebtCard />

        {/* #5 Multi-year proposal (manager+; the route is requireManager). */}
        {canSeeProposal && <ProposalCard />}

        {/* #3 Insurer underwriting package + break-glass share link (manager+). */}
        {canManageInsurer && <InsurerPackageCard />}

        {/* #2 Evidence coverage — requirement→evidence gaps (account/site). */}
        <EvidenceGapCard siteId={siteId || null} />

        {/* #4 Compliance drift / repeat failures — program-change recommendations. */}
        <DriftDetectorCard siteId={siteId || null} />

        {/* #2 Forgotten / untracked assets — off-the-radar equipment. */}
        <ForgottenAssetsCard siteId={siteId || null} />

        {/* What changed since last cycle — diff vs the prior snapshot. */}
        <ChangeBriefCard siteId={siteId || null} />

        {/* Missing-access / open-items blocker log (customer-owned). */}
        <AccessBlockerCard />

        {/* Path to 100% — the ranked fix-it list that closes the gap (N2). */}
        <PathTo100 siteId={siteId || null} />

        </div>

        {loading ? (
          <div className="loading">Loading compliance summary…</div>
        ) : rows.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={BarChart3}
              title="No compliance data yet"
              sub="Add assets and apply maintenance schedules — each governing standard then appears here with its compliance rate."
            />
          </div>
        ) : (
          <>
            {/* Summary brief line (print) */}
            <div className="print-briefline print-only">
              <span>standards <b>{rows.length}</b></span>
              <span>assets <b>{totals.assets}</b></span>
              <span>schedules <b>{totals.schedules}</b></span>
              <span>overdue <b>{totals.overdue}</b></span>
            </div>

            {/* Section 1 — compliance summary by standard */}
            <section className="print-sec">
            <div className="print-sec-head print-only">
              <span className="print-sec-no" />
              <h2 className="print-sec-title">Compliance summary by standard</h2>
              <span className="print-sec-aux">{rows.length} standard{rows.length === 1 ? '' : 's'}</span>
            </div>
            <div className="card">
            <div className="table-wrap">
              <table className="print-table">
                <thead>
                  <tr>
                    <th>Standard</th>
                    <th>Title</th>
                    <th className="num" style={{ textAlign: 'right' }}>Assets</th>
                    <th className="num" style={{ textAlign: 'right' }}>Schedules</th>
                    <th>Compliance</th>
                    <th className="num" style={{ textAlign: 'right' }}>Overdue</th>
                    <th>Next Due</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => {
                    const std = row.standard || {};
                    const code = std.code || 'Account-defined';
                    const go = () => openStandard(code);
                    return (
                      <tr
                        key={code}
                        role="button"
                        tabIndex={0}
                        onClick={go}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }}
                        style={{ cursor: 'pointer' }}
                        title={`Open the ${code} compliance report`}
                      >
                        <td>
                          <div style={{ fontWeight: 700 }}>{code}</div>
                          {std.edition && (
                            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                              {std.edition}
                            </div>
                          )}
                        </td>
                        <td className="td-muted">{std.title || '—'}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{row.assetCount ?? 0}</td>
                        <td className="num" style={{ textAlign: 'right' }}>
                          {row.scheduleCount ?? 0}
                          {(row.unbaselinedCount ?? 0) > 0 && (
                            <div style={{ fontSize: 'var(--font-size-xs)', color: '#d97706' }}>
                              {row.unbaselinedCount} unbaselined
                            </div>
                          )}
                        </td>
                        <td><ComplianceRateBar rate={row.complianceRate} /></td>
                        <td className="num" style={{ textAlign: 'right' }}>
                          {(row.overdueCount ?? 0) > 0
                            ? <span style={{ color: 'var(--color-danger)', fontWeight: 700 }}>{row.overdueCount}</span>
                            : <span className="text-muted">0</span>}
                        </td>
                        <td>{fmtDate(row.nextDue)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </div>
            </section>
          </>
        )}

        <footer className="print-footer print-only">
          <span>ServiceCycle</span>
          <span className="print-footer-pages">Generated {generatedAt.toLocaleDateString()}</span>
        </footer>
      </div>
    </>
  );
}

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
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import api from '../api/client';
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
  const { role } = useAuth();
  const canSeeProposal = ['admin', 'manager', 'oem_admin'].includes(role);
  // C1: drill-downs record this report as the origin for their BackLink.
  const fromState = useFromState();

  const [sites, setSites]     = useState([]);
  const [siteId, setSiteId]   = useState('');
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

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
      .then(r => setRows(r.data?.data?.summary || []))
      .catch(err => setError(err.response?.data?.error || 'Failed to load compliance summary.'))
      .finally(() => setLoading(false));
  }, [siteId]);

  const openStandard = (code) => navigate(`/reports/compliance/${encodeURIComponent(code)}`, { state: fromState });

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
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
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

        {/* #1 — "What will fail an audit": one ranked list of likely findings. */}
        <AuditFailureCard siteId={siteId || null} />

        {/* B1 — NFPA 70B program-maturity score vs the standard. */}
        <MaturityScoreCard siteId={siteId || null} />

        {/* Maintenance Debt Ledger — $ debt + 1/3/5-yr capital plan (account-wide). */}
        <MaintenanceDebtCard />

        {/* #5 Multi-year proposal (manager+; the route is requireManager). */}
        {canSeeProposal && <ProposalCard />}

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
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Standard</th>
                    <th>Title</th>
                    <th style={{ textAlign: 'right' }}>Assets</th>
                    <th style={{ textAlign: 'right' }}>Schedules</th>
                    <th>Compliance</th>
                    <th style={{ textAlign: 'right' }}>Overdue</th>
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
                        <td style={{ textAlign: 'right' }}>{row.assetCount ?? 0}</td>
                        <td style={{ textAlign: 'right' }}>
                          {row.scheduleCount ?? 0}
                          {(row.unbaselinedCount ?? 0) > 0 && (
                            <div style={{ fontSize: 'var(--font-size-xs)', color: '#d97706' }}>
                              {row.unbaselinedCount} unbaselined
                            </div>
                          )}
                        </td>
                        <td><ComplianceRateBar rate={row.complianceRate} /></td>
                        <td style={{ textAlign: 'right' }}>
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
        )}
      </div>
    </>
  );
}

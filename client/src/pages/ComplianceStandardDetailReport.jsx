// ─────────────────────────────────────────────────────────────────────────────
// ComplianceStandardDetailReport.jsx — single-standard evidence report
// (/reports/compliance/:standardCode).
//
// GET /api/compliance/report/:standardCode?siteId= → data.report:
//   { standard {code, edition, title, keyMandate}, generatedAt, scope,
//     summary {assetCount, scheduleCount, currentCount, overdueCount,
//              unbaselinedCount, complianceRate, nextDue},
//     rows: [{ asset, task, schedule {status: current|overdue|unbaselined|
//              inactive}, latestWorkOrder|null }],
//     openDeficiencies: [...] }
//
// 'Download audit snapshot' (admin/manager): POST /api/compliance/snapshots
// {standardCode, siteId} → snapshot {id, sha256, filename}, then the PDF is
// auto-downloaded via the authed GET /api/compliance/snapshots/:id/download
// and a toast surfaces the SHA-256 prefix that was anchored in the audit log.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FileCheck2 } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { downloadAuthedFile } from '../api/download';
import Toast from '../components/Toast';
import EmptyState from '../components/EmptyState';
import { SEVERITY_META, DECAL_META, assetLabel, fmtDate } from '../lib/equipment';

// Schedule compliance status chips. Literal hexes, matching the domain
// traffic-light convention in lib/equipment.js (identical in dark mode).
const STATUS_META = {
  current:     { label: 'Current',     color: '#16a34a', bg: '#f0fdf4' },
  overdue:     { label: 'Overdue',     color: '#dc2626', bg: '#fef2f2' },
  unbaselined: { label: 'Unbaselined', color: '#d97706', bg: '#fffbeb' },
  inactive:    { label: 'Inactive',    color: '#64748b', bg: '#f1f5f9' },
};

function Chip({ meta, fallback }) {
  if (!meta) return <span className="text-muted">{fallback || '—'}</span>;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 20,
      fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.03em',
      background: meta.bg, color: meta.color, border: `1px solid ${meta.color}`,
      whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  );
}

// Summary stat chip for the header strip.
function SummaryChip({ label, value, color }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 6,
      padding: '4px 12px', borderRadius: 20,
      background: 'var(--color-bg)', border: '1px solid var(--color-border)',
      fontSize: 'var(--font-size-xs)', whiteSpace: 'nowrap',
    }}>
      <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: color || 'var(--color-text)' }}>{value}</span>
      <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
    </span>
  );
}

export default function ComplianceStandardDetailReport() {
  const { standardCode: rawCode } = useParams();
  // React Router decodes params already; the defensive decode keeps codes
  // with double-encoded characters working and never throws.
  let standardCode = rawCode || '';
  try { standardCode = decodeURIComponent(standardCode); } catch { /* keep raw */ }

  useDocumentTitle(`${standardCode} compliance`);
  const { user } = useAuth();
  const canSnapshot = ['admin', 'manager'].includes(user?.role);

  const [sites, setSites]       = useState([]);
  const [siteId, setSiteId]     = useState('');
  const [report, setReport]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [toast, setToast]       = useState(null);
  const [snapBusy, setSnapBusy] = useState(false);

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
    api.get(`/api/compliance/report/${encodeURIComponent(standardCode)}`, { params })
      .then(r => setReport(r.data?.data?.report || null))
      .catch(err => {
        setError(err.response?.status === 404
          ? `No compliance report found for "${standardCode}".`
          : (err.response?.data?.error || 'Failed to load compliance report.'));
      })
      .finally(() => setLoading(false));
  }, [standardCode, siteId]);

  // Generate an immutable snapshot for THIS standard (+ current site scope),
  // then auto-download the PDF and toast the audit-log integrity hash.
  async function handleSnapshot() {
    if (snapBusy) return;
    setSnapBusy(true);
    setToast({ message: 'Generating audit snapshot…', variant: 'info', duration: 6000 });
    try {
      const res = await api.post('/api/compliance/snapshots', {
        standardCode,
        ...(siteId ? { siteId } : {}),
      });
      const snap = res.data?.data?.snapshot || {};
      const base = import.meta.env.VITE_API_URL ?? '';
      await downloadAuthedFile(
        `${base}/api/compliance/snapshots/${snap.id}/download`,
        snap.filename || `compliance-snapshot-${standardCode}.pdf`,
      );
      const shaPrefix = (snap.sha256 || '').slice(0, 12);
      setToast({
        message: shaPrefix
          ? `Snapshot downloaded. Integrity hash recorded in audit log: ${shaPrefix}…`
          : 'Snapshot downloaded.',
        variant: 'success',
        duration: 10000,
      });
    } catch (err) {
      setToast({
        message: err.response?.data?.error || err.message || 'Failed to generate snapshot.',
        variant: 'error',
      });
    } finally {
      setSnapBusy(false);
    }
  }

  if (loading) {
    return <div className="page-body"><div className="loading">Loading compliance report…</div></div>;
  }
  if (error && !report) {
    return (
      <div className="page-body">
        <div role="alert" className="alert alert-error mb-16">{error}</div>
        <Link to="/reports/compliance" className="btn btn-secondary">← Back to Compliance by Standard</Link>
      </div>
    );
  }
  if (!report) return null;

  const std     = report.standard || {};
  const summary = report.summary || {};
  const rows    = report.rows || [];
  const defs    = report.openDeficiencies || [];

  return (
    <>
      <div className="page-header">
        <div>
          <Link to="/reports/compliance" className="back-link">← Compliance by Standard</Link>
          <h1 className="page-title">
            {std.code || standardCode}
            {std.edition && (
              <span style={{ fontWeight: 400, fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginLeft: 10, verticalAlign: 'middle' }}>
                {std.edition}
              </span>
            )}
          </h1>
          <div className="page-subtitle">
            {std.title || 'Compliance evidence report'}
            {report.scope && <> · Scope: {report.scope}</>}
            {report.generatedAt && <> · Generated {fmtDate(report.generatedAt)}</>}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <SummaryChip label="assets" value={summary.assetCount ?? 0} />
            <SummaryChip label="schedules" value={summary.scheduleCount ?? 0} />
            <SummaryChip label="current" value={summary.currentCount ?? 0} color="#16a34a" />
            <SummaryChip label="overdue" value={summary.overdueCount ?? 0} color={(summary.overdueCount ?? 0) > 0 ? '#dc2626' : undefined} />
            <SummaryChip label="unbaselined" value={summary.unbaselinedCount ?? 0} color={(summary.unbaselinedCount ?? 0) > 0 ? '#d97706' : undefined} />
            {summary.complianceRate != null && <SummaryChip label="compliance" value={`${summary.complianceRate}%`} />}
          </div>
        </div>
        {canSnapshot && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSnapshot}
              disabled={snapBusy}
              title="Generate an immutable PDF snapshot of this report; its SHA-256 hash is anchored in the tamper-evident audit log."
            >
              {snapBusy ? 'Generating…' : 'Download audit snapshot (this standard)'}
            </button>
          </div>
        )}
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {std.keyMandate && (
          <div
            className="card"
            style={{
              padding: '12px 16px', marginBottom: 16,
              fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)',
              lineHeight: 1.55, borderLeft: '3px solid var(--color-primary)',
            }}
          >
            <strong style={{ color: 'var(--color-text)' }}>Key mandate.</strong> {std.keyMandate}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <label htmlFor="compliance-detail-site-filter" className="form-label" style={{ margin: 0 }}>Site</label>
          <select
            id="compliance-detail-site-filter"
            className="form-control"
            style={{ maxWidth: 280 }}
            value={siteId}
            onChange={e => setSiteId(e.target.value)}
          >
            <option value="">All sites</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {/* ── Evidence table ─────────────────────────────────────────────── */}
        <div className="card mb-16">
          <div className="card-header">
            <div className="card-title">Evidence ({rows.length})</div>
          </div>
          {rows.length === 0 ? (
            <EmptyState
              icon={FileCheck2}
              title="No schedules under this standard"
              sub="Assets paired with this standard's maintenance tasks will appear here with their compliance status."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Site</th>
                    <th>Task</th>
                    <th>Last Completed</th>
                    <th>Next Due</th>
                    <th>Status</th>
                    <th>Latest WO</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const asset = r.asset || {};
                    const task = r.task || {};
                    const sched = r.schedule || {};
                    const wo = r.latestWorkOrder;
                    const status = sched.status || 'unbaselined';
                    const overdue = status === 'overdue';
                    return (
                      <tr key={`${asset.id || 'a'}-${task.taskCode || i}`} style={status === 'inactive' ? { opacity: 0.55 } : undefined}>
                        <td>
                          {asset.id ? (
                            <Link to={`/assets/${asset.id}`} style={{ fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none' }}>
                              {assetLabel(asset)}
                            </Link>
                          ) : (
                            <span style={{ fontWeight: 600 }}>{assetLabel(asset)}</span>
                          )}
                          {asset.governingCondition && (
                            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                              Condition {asset.governingCondition}
                            </div>
                          )}
                        </td>
                        <td className="td-muted">{asset.site?.name || '—'}</td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{task.taskName || '—'}</div>
                          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                            {[task.standardRef, task.requiresOutage ? 'Requires outage' : null].filter(Boolean).join(' · ') || null}
                          </div>
                        </td>
                        <td>{fmtDate(sched.lastCompletedDate)}</td>
                        <td>
                          <span style={overdue ? { color: 'var(--color-danger)', fontWeight: 600 } : undefined}>
                            {fmtDate(sched.nextDueDate)}
                          </span>
                        </td>
                        <td><Chip meta={STATUS_META[status]} fallback={status} /></td>
                        <td>
                          {wo ? (
                            <Link
                              to={`/work-orders/${wo.id}`}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
                              title="Open the latest completed work order"
                            >
                              {wo.netaDecal
                                ? <Chip meta={DECAL_META[wo.netaDecal] && { ...DECAL_META[wo.netaDecal], label: `Decal ${DECAL_META[wo.netaDecal].label}` }} fallback={wo.netaDecal} />
                                : <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-primary)' }}>WO →</span>}
                              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                                {fmtDate(wo.completedDate)}
                              </span>
                            </Link>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Open deficiencies ───────────────────────────────────────────── */}
        <div className="card mb-16">
          <div className="card-header">
            <div className="card-title" style={defs.length > 0 ? { color: 'var(--color-danger)' } : undefined}>
              Open Deficiencies ({defs.length})
            </div>
          </div>
          {defs.length === 0 ? (
            <div className="card-body">
              <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
                No open deficiencies on assets governed by this standard.
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Description</th>
                    <th>Asset</th>
                    <th>Logged</th>
                  </tr>
                </thead>
                <tbody>
                  {defs.map((d, i) => (
                    <tr key={d.id || i}>
                      <td><Chip meta={SEVERITY_META[d.severity]} fallback={d.severity} /></td>
                      <td>{d.description || '—'}</td>
                      <td>
                        {d.asset?.id ? (
                          <Link to={`/assets/${d.asset.id}`} style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>
                            {assetLabel(d.asset)}
                          </Link>
                        ) : (
                          <span className="text-muted">{d.asset ? assetLabel(d.asset) : '—'}</span>
                        )}
                      </td>
                      <td className="td-muted">{fmtDate(d.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OverdueReport.jsx — Overdue Maintenance by Severity (/reports/overdue).
//
// GET /api/compliance/overdue-report?siteId= → data.report {
//   generatedAt, scope,
//   overdueSchedules: [{ asset{..., site{name}}, task{taskName, standardRef},
//                        nextDueDate, daysOverdue }],
//   openDeficiencies: [{ severity, items: [...] }],
//   summary,
// }
//
// Section 1: overdue maintenance tasks, worst-first (daysOverdue desc, red
// bold). Section 2: open deficiencies grouped by SEVERITY_META severity.
// Summary chips up top; site filter scopes the whole report; plain tables so
// window.print() produces a usable handout.
//
// Parallel build note: the endpoint is landing in a sibling branch — every
// read is defensive so a missing route or drifted shape degrades to an empty
// state, not a crash.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { downloadAuthedFile } from '../api/download';
import ReportActionBar from '../components/ReportActionBar';
import EmptyState from '../components/EmptyState';
import BackLink, { useFromState } from '../components/BackLink';
import { SEVERITY_META, assetLabel, fmtDate } from '../lib/equipment';

const SEVERITY_ORDER = ['IMMEDIATE', 'RECOMMENDED', 'ADVISORY'];

function SeverityChip({ severity }) {
  const meta = SEVERITY_META[severity] || { label: severity || '—', color: '#64748b', bg: '#f1f5f9' };
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

function SummaryChip({ label, value, danger }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 8,
      padding: '8px 14px', borderRadius: 'var(--radius)',
      background: 'var(--color-surface)',
      border: `1px solid ${danger && value > 0 ? 'var(--color-danger)' : 'var(--color-border)'}`,
    }}>
      <span style={{
        fontSize: 20, fontWeight: 700,
        color: danger && value > 0 ? 'var(--color-danger)' : 'var(--color-text)',
      }}>
        {value}
      </span>
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 600 }}>
        {label}
      </span>
    </div>
  );
}

// Days since a deficiency was opened — tolerant of whichever timestamp field
// the server settles on.
function deficiencyAgeDays(item) {
  const raw = item?.createdAt || item?.reportedAt || item?.discoveredAt || item?.openedAt;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

export default function OverdueReport() {
  useDocumentTitle('Overdue Maintenance by Severity');
  // C1: asset links record this report as the origin for their BackLink.
  const fromState = useFromState();

  const [sites, setSites]     = useState([]);
  const [siteId, setSiteId]   = useState('');
  const [report, setReport]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);

  async function handleDownloadPdf() {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      const qs = siteId ? `?siteId=${encodeURIComponent(siteId)}&format=pdf` : '?format=pdf';
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/compliance/overdue-report${qs}`;
      await downloadAuthedFile(url, `Overdue_by_Severity_${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (e) {
      setError(e?.message || 'Failed to download the PDF.');
    } finally {
      setPdfBusy(false);
    }
  }

  useEffect(() => {
    api.get('/api/sites')
      .then(r => setSites(r.data?.data?.sites || []))
      .catch(() => { /* filter just stays empty */ });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const params = {};
    if (siteId) params.siteId = siteId;
    api.get('/api/compliance/overdue-report', { params })
      .then(r => { if (!cancelled) setReport(r.data?.data?.report || null); })
      .catch(err => {
        if (cancelled) return;
        setReport(null);
        setError(err.response?.data?.error || 'Failed to load the overdue report.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteId]);

  // Defensive unwrap + worst-first ordering.
  const overdueSchedules = (Array.isArray(report?.overdueSchedules) ? report.overdueSchedules : [])
    .slice()
    .sort((a, b) => (b?.daysOverdue ?? 0) - (a?.daysOverdue ?? 0));

  const deficiencyGroups = (Array.isArray(report?.openDeficiencies) ? report.openDeficiencies : [])
    .slice()
    .sort((a, b) => {
      const ai = SEVERITY_ORDER.indexOf(a?.severity); const bi = SEVERITY_ORDER.indexOf(b?.severity);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  const summary = report?.summary || {};
  const totalDeficiencies = deficiencyGroups.reduce((n, g) => n + (g?.items?.length || 0), 0);
  const immediateCount = deficiencyGroups.find(g => g?.severity === 'IMMEDIATE')?.items?.length || 0;
  const chips = [
    { label: 'overdue tasks',          value: summary.overdueCount ?? summary.overdueTasks ?? overdueSchedules.length, danger: true },
    { label: 'open deficiencies',      value: summary.openDeficiencyCount ?? summary.openDeficiencies ?? totalDeficiencies, danger: false },
    { label: 'immediate severity',     value: summary.immediateCount ?? immediateCount, danger: true },
  ];

  const isEmpty = !loading && overdueSchedules.length === 0 && totalDeficiencies === 0;

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/reports" fallbackLabel="Reports" />
          <h1 className="page-title">Overdue Maintenance by Severity</h1>
          <div className="page-subtitle">
            Overdue scheduled tasks and open deficiencies, riskiest first
            {report?.generatedAt ? ` — generated ${fmtDate(report.generatedAt)}` : ''}
            {report?.scope?.siteName ? ` · ${report.scope.siteName}` : ''}.
          </div>
        </div>
        <ReportActionBar
          onDownloadPdf={handleDownloadPdf}
          pdfBusy={pdfBusy}
          pdfDisabled={loading || isEmpty}
        />
      </div>

      <div className="page-body print-doc">
        {/* C2b: shared Field Report print standard (styles/print.css) */}
        <header className="print-masthead print-only">
          <h1 className="print-masthead-title">Overdue Maintenance by Severity</h1>
          <div className="print-masthead-meta">
            {report?.scope?.siteName || 'All sites'}<br />
            Generated {report?.generatedAt ? fmtDate(report.generatedAt) : new Date().toLocaleDateString()}
          </div>
        </header>
        <div className="print-rule print-only"></div>

        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <label htmlFor="overdue-site-filter" className="form-label" style={{ margin: 0 }}>Site</label>
          <select
            id="overdue-site-filter"
            className="form-control"
            style={{ maxWidth: 280 }}
            value={siteId}
            onChange={e => setSiteId(e.target.value)}
          >
            <option value="">All sites</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {loading ? (
          <div className="loading">Loading overdue report…</div>
        ) : isEmpty ? (
          <div className="card">
            <EmptyState
              icon={AlertTriangle}
              title="Nothing overdue"
              sub={siteId
                ? 'No overdue tasks or open deficiencies at this site. Try All sites to check the rest of the portfolio.'
                : 'No overdue maintenance tasks and no open deficiencies — the program is current.'}
            />
          </div>
        ) : (
          <>
            {/* Summary chips (screen) / brief line (print) */}
            <div className="print-briefline print-only">
              {chips.map(c => <span key={c.label}>{c.label} <b>{c.value}</b></span>)}
            </div>
            <div className="no-print" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
              {chips.map(c => <SummaryChip key={c.label} label={c.label} value={c.value} danger={c.danger} />)}
            </div>

            {/* Section 1 — overdue maintenance tasks */}
            <section className="print-sec">
            <div className="print-sec-head print-only">
              <span className="print-sec-no" />
              <h2 className="print-sec-title">Overdue maintenance tasks</h2>
            </div>
            <h2 className="no-print" style={{ fontSize: 'var(--font-size-lg, 17px)', fontWeight: 600, margin: '0 0 10px' }}>
              Overdue maintenance tasks
            </h2>
            <div className="card" style={{ marginBottom: 28 }}>
              {overdueSchedules.length === 0 ? (
                <EmptyState icon={AlertTriangle} title="No overdue tasks" sub="Every scheduled task in scope is current." />
              ) : (
                <div className="table-wrap">
                  <table className="print-table">
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Site</th>
                        <th>Task</th>
                        <th>Due date</th>
                        <th className="num" style={{ textAlign: 'right' }}>Days overdue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overdueSchedules.map((row, i) => {
                        const asset = row?.asset || {};
                        const task  = row?.task || {};
                        return (
                          <tr key={row?.id || `${asset.id || 'a'}-${i}`}>
                            <td>
                              {asset.id ? (
                                <Link to={`/assets/${asset.id}`} state={fromState} style={{ fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none' }}>
                                  {assetLabel(asset)}
                                </Link>
                              ) : (
                                <span style={{ fontWeight: 600 }}>{assetLabel(asset)}</span>
                              )}
                            </td>
                            <td className="td-muted">{asset.site?.name || '—'}</td>
                            <td>
                              <div>{task.taskName || '—'}</div>
                              {task.standardRef && (
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                                  {task.standardRef}
                                </div>
                              )}
                            </td>
                            <td>{fmtDate(row?.nextDueDate)}</td>
                            <td className="num" style={{ textAlign: 'right' }}>
                              <span style={{ color: 'var(--color-danger)', fontWeight: 700 }}>
                                {row?.daysOverdue ?? '—'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            </section>

            {/* Section 2 — open deficiencies by severity */}
            <section className="print-sec">
            <div className="print-sec-head print-only">
              <span className="print-sec-no" />
              <h2 className="print-sec-title">Open deficiencies by severity</h2>
            </div>
            <h2 className="no-print" style={{ fontSize: 'var(--font-size-lg, 17px)', fontWeight: 600, margin: '0 0 10px' }}>
              Open deficiencies by severity
            </h2>
            {totalDeficiencies === 0 ? (
              <div className="card">
                <EmptyState icon={AlertTriangle} title="No open deficiencies" sub="No unresolved findings in scope." />
              </div>
            ) : (
              deficiencyGroups.filter(g => (g?.items?.length || 0) > 0).map(group => (
                <div key={group.severity} className="card" style={{ marginBottom: 16, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <SeverityChip severity={group.severity} />
                    <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', fontWeight: 600 }}>
                      {group.items.length} open
                    </span>
                  </div>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {group.items.map((item, i) => {
                      const age = deficiencyAgeDays(item);
                      const asset = item?.asset || {};
                      return (
                        <li
                          key={item?.id || i}
                          style={{
                            padding: '8px 0',
                            borderTop: i > 0 ? '1px solid var(--color-border)' : 'none',
                            display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 220 }}>
                            <div style={{ fontSize: 'var(--font-size-ui)' }}>
                              {item?.title || item?.description || 'Deficiency'}
                            </div>
                            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                              {asset.id ? (
                                <Link to={`/assets/${asset.id}`} state={fromState} style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>
                                  {assetLabel(asset)}
                                </Link>
                              ) : assetLabel(asset)}
                              {asset.site?.name ? ` · ${asset.site.name}` : ''}
                            </div>
                          </div>
                          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                            {age != null ? `open ${age} day${age === 1 ? '' : 's'}` : '—'}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
            </section>
          </>
        )}

        <footer className="print-footer print-only">
          <span>ServiceCycle</span>
          <span className="print-footer-pages">Generated {report?.generatedAt ? fmtDate(report.generatedAt) : new Date().toLocaleDateString()}</span>
        </footer>
      </div>
    </>
  );
}

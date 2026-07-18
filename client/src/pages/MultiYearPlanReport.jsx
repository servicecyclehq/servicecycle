// ─────────────────────────────────────────────────────────────────────────────
// MultiYearPlanReport.jsx — 1 / 3 / 5-Year Maintenance Plan (/reports/multi-year-plan).
//
// Block 1 #5 (phase 2): the plan is now viewable in-platform, not just an
// instant PDF download. GET /api/reports/multi-year-plan?siteId= → data:
//   { summary { assetsPlanned, sitesPlanned, oneYearTasks, threeYearTasks,
//               fiveYearTasks }, horizonYears, generatedAt,
//     byYear [{ year, label, tasks, outageTasks, netaTasks, assets, sites }],
//     plan  [{ dueDate, year, asset, task, cadence, site, requiresOutage,
//              requiresNeta }],
//     bySite [{ siteName, y1, y3, y5 }],
//     byEquipmentType [{ equipmentType, y1, y3, y5 }] }
//
// Same shared action bar as every report (ReportActionBar): Download PDF hits
// the same route with ?format=pdf (the server-rendered Field Report), Print
// uses the shared styles/print.css standard. The maintenance schedule display
// is capped for readability; the PDF/print carry the full set.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import api from '../api/client';
import { downloadAuthedFile } from '../api/download';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import EmptyState from '../components/EmptyState';
import BackLink from '../components/BackLink';
import ReportActionBar from '../components/ReportActionBar';
import { fmtDate } from '../lib/equipment';

const SCHEDULE_DISPLAY_CAP = 250;

function SummaryChip({ label, value }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 8,
      padding: '8px 14px', borderRadius: 'var(--radius)',
      background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    }}>
      <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)' }}>{value}</span>
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 600 }}>{label}</span>
    </div>
  );
}

export default function MultiYearPlanReport() {
  useDocumentTitle('1 / 3 / 5-Year Maintenance Plan');

  const [sites, setSites]     = useState([]);
  const [siteId, setSiteId]   = useState('');
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);

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
    api.get('/api/reports/multi-year-plan', { params })
      .then(r => { if (!cancelled) setData(r.data?.data || null); })
      .catch(err => {
        if (cancelled) return;
        setData(null);
        setError(err.response?.data?.error || 'Failed to load the maintenance plan.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteId]);

  async function handleDownloadPdf() {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      const qs = siteId ? `?siteId=${encodeURIComponent(siteId)}&format=pdf` : '?format=pdf';
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/reports/multi-year-plan${qs}`;
      await downloadAuthedFile(url, `Maintenance_Plan_1-3-5yr_${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (e) {
      setError(e?.message || 'Failed to download the PDF.');
    } finally {
      setPdfBusy(false);
    }
  }

  const summary = data?.summary || {};
  const byYear  = Array.isArray(data?.byYear) ? data.byYear : [];
  const plan    = Array.isArray(data?.plan) ? data.plan : [];
  const bySite  = Array.isArray(data?.bySite) ? data.bySite : [];
  const byType  = Array.isArray(data?.byEquipmentType) ? data.byEquipmentType : [];
  const horizon = data?.horizonYears || 5;
  const shownPlan = plan.slice(0, SCHEDULE_DISPLAY_CAP);
  const activeSiteName = siteId ? (sites.find(s => String(s.id) === String(siteId))?.name || '') : '';
  const isEmpty = !loading && plan.length === 0;

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/reports" fallbackLabel="Reports" />
          <h1 className="page-title">1 / 3 / 5-Year Maintenance Plan</h1>
          <div className="page-subtitle">
            The forward NFPA 70B maintenance plan — active schedules projected over a {horizon}-year horizon
            {activeSiteName ? ` · ${activeSiteName}` : ''}
            {data?.generatedAt ? ` · generated ${fmtDate(data.generatedAt)}` : ''}.
          </div>
        </div>
        <ReportActionBar
          onDownloadPdf={handleDownloadPdf}
          pdfBusy={pdfBusy}
          pdfDisabled={loading || isEmpty}
        />
      </div>

      <div className="page-body print-doc">
        <header className="print-masthead print-only">
          <h1 className="print-masthead-title">1 / 3 / 5-Year Maintenance Plan</h1>
          <div className="print-masthead-meta">
            {activeSiteName || 'All sites'}<br />
            Generated {data?.generatedAt ? fmtDate(data.generatedAt) : new Date().toLocaleDateString()}
          </div>
        </header>
        <div className="print-rule print-only"></div>

        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <label htmlFor="plan-site-filter" className="form-label" style={{ margin: 0 }}>Site</label>
          <select
            id="plan-site-filter"
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
          <div className="loading">Loading maintenance plan…</div>
        ) : isEmpty ? (
          <div className="card">
            <EmptyState
              icon={CalendarClock}
              title="No schedules to plan"
              sub="Apply maintenance schedules to your assets — the forward plan then projects them across the horizon here."
            />
          </div>
        ) : (
          <>
            <div className="print-briefline print-only">
              <span>assets <b>{summary.assetsPlanned ?? 0}</b></span>
              <span>sites <b>{summary.sitesPlanned ?? 0}</b></span>
              <span>year 1 <b>{summary.oneYearTasks ?? 0}</b></span>
              <span>thru yr 3 <b>{summary.threeYearTasks ?? 0}</b></span>
              <span>thru yr 5 <b>{summary.fiveYearTasks ?? 0}</b></span>
            </div>
            <div className="no-print" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
              <SummaryChip label="assets planned" value={summary.assetsPlanned ?? 0} />
              <SummaryChip label="sites" value={summary.sitesPlanned ?? 0} />
              <SummaryChip label="year 1 tasks" value={summary.oneYearTasks ?? 0} />
              <SummaryChip label="through yr 3" value={summary.threeYearTasks ?? 0} />
              <SummaryChip label="through yr 5" value={summary.fiveYearTasks ?? 0} />
            </div>

            {/* Forecast by year */}
            <section className="print-sec">
            <div className="print-sec-head print-only">
              <span className="print-sec-no" />
              <h2 className="print-sec-title">Forecast by year</h2>
            </div>
            <h2 className="no-print" style={{ fontSize: 'var(--font-size-lg, 17px)', fontWeight: 600, margin: '0 0 10px' }}>Forecast by year</h2>
            <div className="card mb-16">
              <div className="table-wrap">
                <table className="print-table">
                  <thead>
                    <tr>
                      <th>Year</th>
                      <th className="num" style={{ textAlign: 'right' }}>Tasks</th>
                      <th className="num" style={{ textAlign: 'right' }}>Outage</th>
                      <th className="num" style={{ textAlign: 'right' }}>NETA</th>
                      <th className="num" style={{ textAlign: 'right' }}>Assets</th>
                      <th className="num" style={{ textAlign: 'right' }}>Sites</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byYear.map((y, i) => (
                      <tr key={y.year ?? i}>
                        <td style={{ fontWeight: 600 }}>{y.label || `Year ${y.year}`}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{y.tasks || 0}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{y.outageTasks || 0}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{y.netaTasks || 0}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{y.assets || 0}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{y.sites || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            </section>

            {/* Maintenance schedule (capped display) */}
            <section className="print-sec">
            <div className="print-sec-head print-only">
              <span className="print-sec-no" />
              <h2 className="print-sec-title">Maintenance schedule</h2>
              <span className="print-sec-aux">{plan.length} line items</span>
            </div>
            <h2 className="no-print" style={{ fontSize: 'var(--font-size-lg, 17px)', fontWeight: 600, margin: '0 0 10px' }}>
              Maintenance schedule
              <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 500, color: 'var(--color-text-secondary)', marginLeft: 8 }}>
                {plan.length} line item{plan.length === 1 ? '' : 's'}, earliest due first
              </span>
            </h2>
            <div className="card mb-16">
              <div className="table-wrap">
                <table className="print-table">
                  <thead>
                    <tr>
                      <th>Next Due</th>
                      <th>Yr</th>
                      <th>Equipment</th>
                      <th>Maintenance Task</th>
                      <th>Frequency</th>
                      <th>Site</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownPlan.map((p, i) => (
                      <tr key={`${p.asset || 'a'}-${i}`}>
                        <td style={{ whiteSpace: 'nowrap' }}>{p.dueDate || '—'}</td>
                        <td>Y{p.year}</td>
                        <td>{p.asset || '—'}</td>
                        <td>
                          {p.task || '—'}
                          {p.requiresOutage ? <span style={{ color: 'var(--color-warning, #d97706)' }}> (outage)</span> : null}
                          {p.requiresNeta ? <span style={{ color: 'var(--color-text-secondary)' }}> [NETA]</span> : null}
                        </td>
                        <td>{p.cadence || '—'}</td>
                        <td className="td-muted">{p.site || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {plan.length > SCHEDULE_DISPLAY_CAP && (
                <div className="no-print" style={{ padding: '10px 14px', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', borderTop: '1px solid var(--color-border)' }}>
                  Showing the first {SCHEDULE_DISPLAY_CAP} of {plan.length} line items. Download PDF for the full schedule.
                </div>
              )}
            </div>
            </section>

            {/* Load by site */}
            {bySite.length > 0 && (
              <section className="print-sec">
              <div className="print-sec-head print-only">
                <span className="print-sec-no" />
                <h2 className="print-sec-title">Load by site</h2>
              </div>
              <h2 className="no-print" style={{ fontSize: 'var(--font-size-lg, 17px)', fontWeight: 600, margin: '0 0 10px' }}>Load by site</h2>
              <div className="card mb-16">
                <div className="table-wrap">
                  <table className="print-table">
                    <thead>
                      <tr>
                        <th>Site</th>
                        <th className="num" style={{ textAlign: 'right' }}>Year 1</th>
                        <th className="num" style={{ textAlign: 'right' }}>Through Yr 3</th>
                        <th className="num" style={{ textAlign: 'right' }}>Through Yr 5</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bySite.map((r, i) => (
                        <tr key={r.siteName ?? i}>
                          <td>{r.siteName || '—'}</td>
                          <td className="num" style={{ textAlign: 'right' }}>{r.y1 || 0}</td>
                          <td className="num" style={{ textAlign: 'right' }}>{r.y3 || 0}</td>
                          <td className="num" style={{ textAlign: 'right' }}>{r.y5 || 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              </section>
            )}

            {/* Load by equipment type */}
            {byType.length > 0 && (
              <section className="print-sec">
              <div className="print-sec-head print-only">
                <span className="print-sec-no" />
                <h2 className="print-sec-title">Load by equipment type</h2>
              </div>
              <h2 className="no-print" style={{ fontSize: 'var(--font-size-lg, 17px)', fontWeight: 600, margin: '0 0 10px' }}>Load by equipment type</h2>
              <div className="card mb-16">
                <div className="table-wrap">
                  <table className="print-table">
                    <thead>
                      <tr>
                        <th>Equipment Type</th>
                        <th className="num" style={{ textAlign: 'right' }}>Year 1</th>
                        <th className="num" style={{ textAlign: 'right' }}>Through Yr 3</th>
                        <th className="num" style={{ textAlign: 'right' }}>Through Yr 5</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byType.map((r, i) => (
                        <tr key={r.equipmentType ?? i}>
                          <td>{r.equipmentType || '—'}</td>
                          <td className="num" style={{ textAlign: 'right' }}>{r.y1 || 0}</td>
                          <td className="num" style={{ textAlign: 'right' }}>{r.y3 || 0}</td>
                          <td className="num" style={{ textAlign: 'right' }}>{r.y5 || 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              </section>
            )}
          </>
        )}

        <footer className="print-footer print-only">
          <span>ServiceCycle</span>
          <span className="print-footer-pages">Generated {data?.generatedAt ? fmtDate(data.generatedAt) : new Date().toLocaleDateString()}</span>
        </footer>
      </div>
    </>
  );
}

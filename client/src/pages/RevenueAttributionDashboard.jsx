// ─────────────────────────────────────────────────────────────────────────────
// RevenueAttributionDashboard.jsx -- Phase 2 revenue-attribution dashboard.
//
// The closed-loop "engagement -> pipeline -> revenue" story: how platform
// signals (Path-to-100 / modernization / arc-flash / QEMW triggers) become
// quote requests, accepted quotes, and completed work orders, with estimated
// dollar value attributed from asset repair estimates.
//
// GET /api/revenue/attribution?windowDays= -> { funnel, conversionRates, attribution, value, byTrigger, recent }
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import BackLink from '../components/BackLink';
import EmptyState from '../components/EmptyState';

function usd(n) {
  if (n == null || Number.isNaN(Number(n))) return '$0';
  return `$${Math.round(Number(n)).toLocaleString('en-US')}`;
}
function pctStr(n) { return n == null ? '—' : `${n}%`; }
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function Stat({ value, label, color }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 150, padding: '14px 16px' }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: color || 'var(--color-text)' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{label}</div>
    </div>
  );
}

const FUNNEL = [
  { key: 'submitted', label: 'Quote requests', rate: null },
  { key: 'quoted', label: 'Quoted by rep', rate: 'quoteRate' },
  { key: 'accepted', label: 'Accepted', rate: 'acceptRate' },
  { key: 'converted', label: 'Work order created', rate: null },
  { key: 'completed', label: 'Work completed', rate: 'completionRate' },
];

export default function RevenueAttributionDashboard() {
  useDocumentTitle('Revenue Attribution');
  const [windowDays, setWindowDays] = useState(365);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    api.get(`/api/revenue/attribution?windowDays=${windowDays}`)
      .then((r) => setData(r.data.data))
      .catch((e) => setError(e?.response?.data?.error || 'Failed to load revenue attribution.'))
      .finally(() => setLoading(false));
  }, [windowDays]);

  const f = data?.funnel || {};
  const cr = data?.conversionRates || {};
  const at = data?.attribution || {};
  const v = data?.value || {};
  const maxFunnel = Math.max(1, f.submitted || 0);

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/reports" fallbackLabel="Reports" />
          <h1 className="page-title">Revenue Attribution</h1>
          <div className="page-subtitle">
            How platform signals turn into quotes and completed work — the closed loop from a Path-to-100 alert to a paid work order.
          </div>
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <label htmlFor="rev-window" className="form-label" style={{ margin: 0 }}>Window</label>
          <select id="rev-window" className="form-control" style={{ maxWidth: 200 }} value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 12 months</option>
            <option value={730}>Last 24 months</option>
          </select>
        </div>

        {loading ? (
          <div className="loading">Loading revenue attribution…</div>
        ) : !data ? null : data.summary.clean ? (
          <div className="card">
            <EmptyState
              icon={TrendingUp}
              title="No quote activity yet"
              sub="Once customers submit quote requests (from a Path-to-100 alert or manually) and work orders are created from them, the engagement-to-revenue loop appears here."
            />
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
              <Stat value={usd(v.realized)} label="Realized (completed work)" color="#15803d" />
              <Stat value={usd(v.pipeline)} label="Open pipeline (est.)" color="#1d4ed8" />
              <Stat value={pctStr(at.platformDrivenPct)} label="Quotes from a platform signal" />
              <Stat value={pctStr(at.alertConversionShare)} label="Completed work from an alert" />
              <Stat value={pctStr(cr.overallConversion)} label="Request → completed" />
            </div>

            {/* Closed-loop funnel */}
            <div className="card mb-16">
              <div className="card-header"><div className="card-title">Engagement → revenue funnel</div></div>
              <div className="card-body">
                {FUNNEL.map((stage) => {
                  const n = f[stage.key] || 0;
                  const w = Math.max(2, Math.round((n / maxFunnel) * 100));
                  const rate = stage.rate ? cr[stage.rate] : null;
                  return (
                    <div key={stage.key} style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
                        <span style={{ fontWeight: 600 }}>{stage.label}</span>
                        <span style={{ color: 'var(--color-text-secondary)' }}>
                          {n}{rate != null ? ` · ${rate}% of prior` : ''}
                        </span>
                      </div>
                      <div style={{ height: 10, background: 'var(--color-border)', borderRadius: 5, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${w}%`, background: 'var(--color-primary)', borderRadius: 5, transition: 'width .4s ease' }} />
                      </div>
                    </div>
                  );
                })}
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 6 }}>
                  {at.systemTriggered} of {f.submitted} request(s) originated from a platform signal · {at.completedFromAlert} completed.
                </div>
              </div>
            </div>

            {/* Attribution by trigger */}
            <div className="card mb-16">
              <div className="card-header"><div className="card-title">By platform signal</div></div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Signal</th>
                      <th style={{ textAlign: 'right' }}>Requests</th>
                      <th style={{ textAlign: 'right' }}>Accepted</th>
                      <th style={{ textAlign: 'right' }}>Completed</th>
                      <th style={{ textAlign: 'right' }}>Realized (est.)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byTrigger.map((t) => (
                      <tr key={t.trigger}>
                        <td style={{ fontWeight: 600 }}>{t.label}</td>
                        <td style={{ textAlign: 'right' }}>{t.count}</td>
                        <td style={{ textAlign: 'right' }}>{t.accepted}</td>
                        <td style={{ textAlign: 'right' }}>{t.completed}</td>
                        <td style={{ textAlign: 'right' }}>{usd(t.realizedValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Recent quote-driven completed work */}
            {data.recent.length > 0 && (
              <div className="card mb-16">
                <div className="card-header"><div className="card-title">Recent quote-driven work completed</div></div>
                <div className="card-body" style={{ paddingTop: 0 }}>
                  {data.recent.map((r) => (
                    <div key={r.quoteId} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--color-border)' }}>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <Link to={`/assets/${r.assetId}`} style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)' }}>{r.assetLabel}</Link>
                        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{r.triggerLabel} · completed {fmtDate(r.completedDate)}</div>
                      </div>
                      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700 }}>{r.value == null ? 'unpriced' : usd(r.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
              Dollar figures are estimates from each asset's repair-cost estimate (the same basis as the Maintenance Debt Ledger);
              {' '}{v.unpricedOpen} open and {v.unpricedCompleted} completed quote(s) have no estimate and are excluded from the totals. Not a quote or guarantee.
            </div>
          </>
        )}
      </div>
    </>
  );
}

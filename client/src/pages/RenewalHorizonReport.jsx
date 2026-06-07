import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

// Pass-3 audit HIGH #4 (2026-05-17): Recharts default JS animations bypass
// prefers-reduced-motion. This module-level check is recomputed on each
// import; an `isAnimationActive={!prefersReducedMotion}` prop on every
// chart element in this file honours the OS preference. Browsers without
// matchMedia (SSR) fall through to animations-on which is safe.
const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
  : false;

function fmtMoney(n) {
  if (n == null || isNaN(n) || n === 0) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const RISK_META = {
  trap:   { label: 'Auto-renewal exposure',    color: '#b91c1c', bg: 'rgba(220,38,38,0.08)',   border: 'rgba(220,38,38,0.25)',  desc: 'Cancel window has passed. If auto-renewal is on, you may already be locked in.' },
  urgent: { label: 'Window closing soon',  color: 'var(--color-warning)', bg: 'rgba(217,119,6,0.08)',   border: 'rgba(217,119,6,0.25)',  desc: 'Cancel-by date within 14 days. Act now.' },
  soon:   { label: 'Coming up',            color: '#0d4f6e', bg: 'rgba(13,79,110,0.07)',   border: 'rgba(13,79,110,0.22)',  desc: 'Cancel-by date within 30 days.' },
  ok:     { label: 'On track',             color: 'var(--color-success)', bg: 'rgba(22,163,74,0.07)',   border: 'rgba(22,163,74,0.22)',  desc: 'Sufficient lead time to review and negotiate.' },
};

function RiskBadge({ risk }) {
  const m = RISK_META[risk] || RISK_META.ok;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px', borderRadius: 10,
      fontSize: 'var(--font-size-xs)', fontWeight: 600,
      background: m.bg, color: m.color,
      border: `1px solid ${m.border}`,
      whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  );
}

function SummaryCard({ label, value, subtitle, color }) {
  return (
    <div className="card" style={{ padding: '14px 18px', flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: color || 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </div>
      {subtitle && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{subtitle}</div>}
    </div>
  );
}

function ContractRow({ c }) {
  const navigate = useNavigate();
  return (
    <tr
      onClick={() => navigate(`/contracts/${c.id}`)}
      style={{ cursor: 'pointer' }}
      className="hover-row"
    >
      <td style={{ fontWeight: 600 }}>{c.vendorName || '—'}</td>
      <td>{c.product || '—'}</td>
      <td>{c.categoryName || '—'}</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtDate(c.endDate)}</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {c.cancelByDate
          ? <span style={{ color: c.risk === 'trap' ? '#b91c1c' : c.risk === 'urgent' ? 'var(--color-warning)' : undefined }}>
              {fmtDate(c.cancelByDate)}
            </span>
          : <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}
      </td>
      <td style={{ textAlign: 'center' }}>
        <RiskBadge risk={c.risk} />
      </td>
      <td style={{ textAlign: 'right' }}>{fmtMoney(c.renewalValue)}</td>
      <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>
        {c.ownerDisplay || '—'}
      </td>
    </tr>
  );
}

export default function RenewalHorizonReport() {
  useDocumentTitle('Renewal horizon');
  const [horizon, setHorizon] = useState(90);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta]       = useState(null); // v0.90.5: fix ReferenceError - missing state declaration
  const [error, setError]     = useState('');
  const [downloading, setDownloading] = useState(false);
  const [pdfing, setPdfing]           = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get('/api/reports/renewal-horizon', { params: { horizon } });
      setData(res.data.data); setMeta(res.data.meta ?? null);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load report.');
    } finally {
      setLoading(false);
    }
  }, [horizon]);

  useEffect(() => { load(); }, [load]);

  async function handlePDF() {
    setPdfing(true);
    try {
      const res = await api.get('/api/reports/renewal-horizon/pdf', { params: { horizon }, responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `LapseIQ_Renewal_Horizon_${horizon}d_${new Date().toISOString().split('T')[0]}.pdf`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('PDF download failed.'); }
    finally { setPdfing(false); }
  }

  async function handleCSV() {
    setDownloading(true);
    try {
      const res = await api.get('/api/reports/renewal-horizon/csv', {
        params: { horizon }, responseType: 'blob',
      });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `LapseIQ_Renewal_Horizon_${horizon}d_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  }

  const chartData = data ? [
    { name: 'Exposure',    value: data.byRisk.trap.length,   color: '#b91c1c' },
    { name: 'Urgent',  value: data.byRisk.urgent.length, color: 'var(--color-warning)' },
    { name: 'Soon',    value: data.byRisk.soon.length,   color: '#0d4f6e' },
    { name: 'On Track',value: data.byRisk.ok.length,     color: 'var(--color-success)' },
  ] : [];

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Renewal Horizon</h1>
          <div className="page-subtitle">
            {data
              ? `${data.totalContracts} contract${data.totalContracts === 1 ? '' : 's'} renewing in the next ${horizon} days · ${data.companyName}`
              : 'Upcoming renewals with risk classification'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            aria-label="Horizon range"
            value={horizon}
            onChange={e => setHorizon(Number(e.target.value))}
            style={{ fontSize: 'var(--font-size-ui)', padding: '5px 10px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
          >
            <option value={30}>Next 30 days</option>
            <option value={60}>Next 60 days</option>
            <option value={90}>Next 90 days</option>
            <option value={180}>Next 180 days</option>
          </select>
          <button className="btn" onClick={handlePDF} disabled={loading || pdfing || !data}>
            {pdfing ? 'Generating…' : '↓ PDF'}
          </button>
          <button className="btn" onClick={handleCSV} disabled={loading || downloading || !data}>
            {downloading ? 'Exporting…' : '↓ CSV'}
          </button>
        </div>
      </div>

      <div className="page-body">
        <TruncationBanner meta={meta} />
            <ReportAiNarrative reportId="renewal-horizon" params={{ horizon }} paramsKey={String(horizon)} />
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
        {loading && <div className="loading">Building report…</div>}

        {data && !loading && (
          <>
            {/* Summary cards */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
              <SummaryCard
                label="Total Renewing"
                value={data.totalContracts}
                subtitle={`Next ${horizon} days`}
              />
              <SummaryCard
                label="At-Risk Value"
                value={fmtMoney(
                  (data.byRisk.trap.reduce((s, c) => s + c.renewalValue, 0)) +
                  (data.byRisk.urgent.reduce((s, c) => s + c.renewalValue, 0))
                )}
                subtitle="Exposures + urgent"
                color="#b91c1c"
              />
              <SummaryCard
                label="Auto-Renewal Exposures"
                value={data.byRisk.trap.length}
                subtitle="Cancel window closed"
                color={data.byRisk.trap.length > 0 ? '#b91c1c' : undefined}
              />
              <SummaryCard
                label="Total Pipeline Value"
                value={fmtMoney(data.totalValue)}
                subtitle={`${data.totalContracts} contracts`}
              />
            </div>

            {/* Chart */}
            {chartData.some(d => d.value > 0) && (
              <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
                <h3 style={{ margin: '0 0 14px', fontSize: 'var(--font-size-data)', fontWeight: 700 }}>Contracts by risk level</h3>
                <ResponsiveContainer width="100%" height={80}>
                  <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 20 }}>
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 'var(--font-size-xs)', fill: 'var(--color-text)' }} />
                    <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 'var(--font-size-sm)', fill: 'var(--color-text)' }} />
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <Tooltip formatter={(v, n) => [v, 'Contracts']} />
                    <Bar dataKey="value" radius={[0, 3, 3, 0]} isAnimationActive={!prefersReducedMotion}>
                      {chartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Risk sections */}
            {(['trap', 'urgent', 'soon', 'ok']).map(riskKey => {
              const rows = data.byRisk[riskKey];
              if (!rows.length) return null;
              const meta = RISK_META[riskKey];
              return (
                <div key={riskKey} className="card" style={{ marginBottom: 16, overflow: 'hidden' }}>
                  <div style={{
                    padding: '12px 18px',
                    borderBottom: '1px solid var(--color-border)',
                    background: meta.bg,
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
                    <span style={{ fontWeight: 700, fontSize: 'var(--font-size-data)', color: meta.color }}>{meta.label}</span>
                    <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{meta.desc}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-sm)', fontWeight: 600, color: meta.color }}>
                      {rows.length} contract{rows.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Vendor</th>
                          <th>Product</th>
                          <th>Category</th>
                          <th style={{ textAlign: 'right' }}>End Date</th>
                          <th style={{ textAlign: 'right' }}>Cancel By</th>
                          <th style={{ textAlign: 'center' }}>Risk</th>
                          <th style={{ textAlign: 'right' }}>Annual Value</th>
                          <th style={{ textAlign: 'right' }}>Owner</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(c => <ContractRow key={c.id} c={c} />)}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}

            {data.totalContracts === 0 && (
              <div className="empty-state">
                <div className="empty-state-title">No contracts renewing in the next {horizon} days</div>
              </div>
            )}

            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textAlign: 'right', marginTop: 8 }}>
              Generated {fmtDate(data.generatedAt)}{data.generatedBy ? ` · by ${data.generatedBy}` : ''}
            </div>
          </>
        )}
      </div>
    </>
  );
}

import ReportBackLink from '../components/ReportBackLink';
// ─────────────────────────────────────────────────────────────────────────────
// RenewalCommitmentForecastReport.jsx — v0.59.0 Tier-2 executive report
//
// Forward-looking 12 / 24-month forecast of renewal commitments. For each
// month in the horizon, sums the annual value of contracts whose endDate
// falls in that month, with a cumulative running total and an auto-renew
// share callout (autoRenew = passive commitment, harder to walk away from).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Download, FileSpreadsheet, FileText, LineChart as LineIcon } from 'lucide-react';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';

const HORIZON_CHIPS = [
  { value: 12, label: 'Next 12 months' },
  { value: 24, label: 'Next 24 months' },
];

function fmtCurrency(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmtMonth(ym) {
  if (!ym) return '—';
  const [y, m] = ym.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

export default function RenewalCommitmentForecastReport() {
  const navigate = useNavigate();
  const [horizon, setHorizon] = useState(12);
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get('/api/reports/renewal-commitment-forecast', { params: { horizon } })
      .then(r => { if (!cancelled) { setData(r?.data?.data || null); setMeta(r?.data?.meta ?? null); } })
      .catch(err => { if (!cancelled) setError(err?.response?.data?.error || 'Failed to load report'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [horizon]);

  async function downloadExport(format) {
    try {
      const res = await api.get(`/api/reports/renewal-commitment-forecast/${format}`, {
        params: { horizon }, responseType: 'blob',
      });
      const cd = res.headers['content-disposition'] || '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m ? m[1] : `renewal-commitment-forecast.${format}`;
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setError('Export failed');
    }
  }

  // Inline bar visualisation — keep it dependency-free (no charting library)
  // so this report stays in the existing client bundle. Each month is a
  // vertical bar coloured by auto-renew share so the eye can pick out months
  // that are mostly passive commitment vs. months that are mostly negotiable.
  const maxValue = useMemo(() => {
    if (!data?.months?.length) return 0;
    return Math.max(...data.months.map(m => m.renewalValue || 0));
  }, [data]);

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Renewal Commitment Forecast</h1>
          <div className="page-subtitle">
            Forward-looking cash-outflow forecast based on current contract end-dates.
            Auto-renewing contracts are flagged as passive commitment.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => downloadExport('csv')}>
            <Download size={14} /> CSV
          </button>
          <button className="btn btn-secondary" onClick={() => downloadExport('xlsx')}>
            <FileSpreadsheet size={14} /> XLSX
          </button>
          <button className="btn btn-secondary" onClick={() => downloadExport('pdf')}>
            <FileText size={14} /> PDF
          </button>
        </div>
      </div>

      <div className="page-body">
        <TruncationBanner meta={meta} />
        {/* Horizon chips */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {HORIZON_CHIPS.map(chip => (
            <button
              key={chip.value}
              onClick={() => setHorizon(chip.value)}
              style={{
                padding: '6px 12px', fontSize: 'var(--font-size-sm)', borderRadius: 999,
                border: '1px solid ' + (horizon === chip.value ? '#0d4f6e' : 'var(--color-border)'),
                background: horizon === chip.value ? '#0d4f6e' : 'var(--color-card-bg)',
                color: horizon === chip.value ? '#fff' : 'var(--color-text)',
                fontWeight: horizon === chip.value ? 600 : 500,
                cursor: 'pointer',
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <ReportAiNarrative reportId="renewal-commitment-forecast" params={{ horizon }} paramsKey={String(horizon)} />

        {error && (
          <div className="card" style={{ padding: 16, marginBottom: 16, color: '#991b1b', background: '#fee2e2' }}>
            {error}
          </div>
        )}

        {/* KPI band */}
        <div className="card" style={{ padding: 0, marginBottom: 20, overflow: 'hidden' }}>
          <div style={{ height: 3, background: '#0891b2' }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 0 }}>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Total Commitment</div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>{fmtCurrency(data?.totalCommitment)}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>over {horizon} months</div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Contracts Renewing</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>{data?.totalContracts ?? 0}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>in the horizon</div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontWeight: 600 }}>Auto-Renew Share</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-warning)', lineHeight: 1 }}>{data?.autoRenewSharePct != null ? `${data.autoRenewSharePct.toFixed(1)}%` : '—'}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{fmtCurrency(data?.autoRenewValue)}</div>
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: '#0891b2', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontWeight: 600 }}>Biggest Month</div>
              <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: '#0891b2', lineHeight: 1.1 }}>{fmtMonth(data?.biggestMonth?.yyyy_mm)}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{fmtCurrency(data?.biggestMonth?.renewalValue)}</div>
            </div>
          </div>
        </div>

        {/* Bar chart */}
        <div className="card" style={{ padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--color-text)', marginBottom: 12 }}>Renewals by month</div>
          {loading || !data?.months?.length ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
              {loading ? 'Loading…' : 'No renewals in this horizon.'}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 180, paddingTop: 12 }}>
              {data.months.map(m => {
                const heightPct = maxValue > 0 ? (m.renewalValue / maxValue) * 100 : 0;
                const autoSharePct = m.renewalValue > 0 ? (m.autoRenewValue / m.renewalValue) * 100 : 0;
                return (
                  <div key={m.yyyy_mm} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 28 }}>
                    <div style={{ fontSize: 9, color: 'var(--color-text-secondary)', marginBottom: 4, whiteSpace: 'nowrap' }}>
                      {m.renewalValue > 0 ? `${Math.round(m.renewalValue/1000)}K` : ''}
                    </div>
                    <div
                      title={`${fmtMonth(m.yyyy_mm)}: ${fmtCurrency(m.renewalValue)} (${m.contractCount} contract${m.contractCount===1?'':'s'}, ${m.autoRenewCount} auto-renew)`}
                      style={{
                        width: '100%', height: `${heightPct}%`, minHeight: heightPct > 0 ? 2 : 0,
                        background: `linear-gradient(to top, var(--color-warning) 0%, var(--color-warning) ${autoSharePct}%, #0891b2 ${autoSharePct}%, #0891b2 100%)`,
                        borderRadius: '3px 3px 0 0',
                      }}
                    />
                    <div style={{ fontSize: 9, color: 'var(--color-text-secondary)', marginTop: 4, transform: 'rotate(-45deg)', transformOrigin: 'top right', whiteSpace: 'nowrap' }}>
                      {fmtMonth(m.yyyy_mm)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ marginTop: 32, display: 'flex', gap: 16, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
            <span><span style={{ display:'inline-block', width:10, height:10, background:'#0891b2', marginRight:4, verticalAlign:'middle' }}/>Manual renewal</span>
            <span><span style={{ display:'inline-block', width:10, height:10, background:'var(--color-warning)', marginRight:4, verticalAlign:'middle' }}/>Auto-renew (passive commitment)</span>
          </div>
        </div>

        {/* Detail table */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Loading…</div>
          ) : !data?.months?.length ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
              <LineIcon size={28} style={{ marginBottom: 8, opacity: 0.6 }} />
              <div>No renewals in the selected horizon.</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-ui)' }}>
                <thead>
                  <tr style={{ background: 'var(--color-bg-subtle, #f1f5f9)', borderBottom: '1px solid var(--color-border)' }}>
                    <th style={{ textAlign: 'left',  padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Month</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Contracts</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Renewal Value</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Cumulative</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Auto-Renew</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Auto $</th>
                  </tr>
                </thead>
                <tbody>
                  {data.months.map(m => (
                    <tr key={m.yyyy_mm} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '10px 12px', color: 'var(--color-text)' }}>{fmtMonth(m.yyyy_mm)}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--color-text)' }}>{m.contractCount}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--color-text)', fontWeight: 600 }}>{fmtCurrency(m.renewalValue)}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--color-text-secondary)' }}>{fmtCurrency(m.cumulativeValue)}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: m.autoRenewCount > 0 ? 'var(--color-warning)' : 'var(--color-text-secondary)' }}>{m.autoRenewCount}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: m.autoRenewValue > 0 ? 'var(--color-warning)' : 'var(--color-text-secondary)' }}>{fmtCurrency(m.autoRenewValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

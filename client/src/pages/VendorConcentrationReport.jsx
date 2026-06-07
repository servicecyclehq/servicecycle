import ReportBackLink from '../components/ReportBackLink';
// ─────────────────────────────────────────────────────────────────────────────
// VendorConcentrationReport.jsx — v0.58.0 Tier-1 white-space report
//
// Pareto distribution of spend by vendor with cumulative % and the 80% cutoff
// line marked. Layout is PDF-ready: top KPI band, optional inline bar, single
// wide table.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Download, FileSpreadsheet, PieChart, FileText } from 'lucide-react';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';

const PERIOD_CHIPS = [
  { value: 'fy',    label: 'Fiscal Year' },
  { value: 'ytd',   label: 'YTD' },
  { value: 'l12m',  label: 'Last 12 months' },
];

function fmtCurrency(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(1) + '%';
}

export default function VendorConcentrationReport() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState('ytd');
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get('/api/reports/vendor-concentration', { params: { period } })
      .then(r => { if (!cancelled) { setData(r?.data?.data || null); setMeta(r?.data?.meta ?? null); } })
      .catch(err => { if (!cancelled) setError(err?.response?.data?.error || 'Failed to load report'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  async function downloadExport(format) {
    try {
      const res = await api.get(`/api/reports/vendor-concentration/${format}`, {
        params: { period }, responseType: 'blob',
      });
      const cd = res.headers['content-disposition'] || '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m ? m[1] : `vendor-concentration.${format}`;
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setError('Export failed');
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Vendor Concentration</h1>
          <div className="page-subtitle">
            Pareto distribution of spend by vendor. The 80% cutoff is the head of the distribution.
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
        {/* Period chips */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {PERIOD_CHIPS.map(chip => (
            <button
              key={chip.value}
              onClick={() => setPeriod(chip.value)}
              style={{
                padding: '6px 12px', fontSize: 'var(--font-size-sm)', borderRadius: 999,
                border: '1px solid ' + (period === chip.value ? '#0d4f6e' : 'var(--color-border)'),
                background: period === chip.value ? '#0d4f6e' : 'var(--color-card-bg)',
                color: period === chip.value ? '#fff' : 'var(--color-text)',
                fontWeight: period === chip.value ? 600 : 500,
                cursor: 'pointer',
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <ReportAiNarrative reportId="vendor-concentration" params={{ period }} paramsKey={period} />

        {error && (
          <div className="card" style={{ padding: 16, marginBottom: 16, color: '#991b1b', background: '#fee2e2' }}>
            {error}
          </div>
        )}

        {/* KPI band */}
        <div className="card" style={{ padding: 0, marginBottom: 20, overflow: 'hidden' }}>
          <div style={{ height: 3, background: '#0d4f6e' }} />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          }}>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                Top 5 Vendors
              </div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>
                {loading ? '—' : fmtPct(data?.top5Pct)}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                {fmtCurrency(data?.top5Spend)} of total
              </div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                Top 10 Vendors
              </div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>
                {loading ? '—' : fmtPct(data?.top10Pct)}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                {fmtCurrency(data?.top10Spend)} of total
              </div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                Head (≤80%)
              </div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>
                {data?.headCount ?? '—'}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                vendors
              </div>
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                Tail
              </div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>
                {data?.tailCount ?? '—'}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                long-tail vendors
              </div>
            </div>
          </div>
        </div>

        {/* Detail table — sorted Pareto */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Loading…</div>
          ) : !data || data.rows.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
              <PieChart size={28} style={{ marginBottom: 8, opacity: 0.6 }} />
              <div>No vendor spend in the selected period.</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-ui)' }}>
                <thead>
                  <tr style={{ background: 'var(--color-bg-subtle, #f1f5f9)', borderBottom: '1px solid var(--color-border)' }}>
                    <th style={{ textAlign: 'right', padding: '10px 12px', width: 60, fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>#</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Vendor</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Spend</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Contracts</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Share</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Cumulative</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => {
                    const isCutoff = r.atCutoff;
                    return (
                      <tr
                        key={r.rank}
                        style={{
                          borderBottom: isCutoff ? '2px solid #f59e0b' : '1px solid var(--color-border)',
                          background: isCutoff ? '#fffbeb' : 'transparent',
                        }}
                      >
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                          {r.rank}
                        </td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text)', fontWeight: r.rank <= 5 ? 600 : 400 }}>
                          {r.vendorName}
                          {isCutoff && (
                            <span style={{ marginLeft: 8, fontSize: 'var(--font-size-2xs)', fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '2px 6px', borderRadius: 4, letterSpacing: '0.04em' }}>
                              80% LINE
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--color-text)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                          {fmtCurrency(r.spend)}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--color-text)', fontVariantNumeric: 'tabular-nums' }}>
                          {r.contractCount}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--color-text)', fontVariantNumeric: 'tabular-nums' }}>
                          {fmtPct(r.pct)}
                        </td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)' }}>
                          {/* Inline cumulative bar */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ flex: 1, height: 6, background: 'var(--color-bg-subtle, #f1f5f9)', borderRadius: 3, overflow: 'hidden', minWidth: 80 }}>
                              <div style={{
                                width: `${Math.min(100, r.cumulativePct)}%`,
                                height: '100%',
                                background: r.cumulativePct >= 80 ? '#f59e0b' : '#0d4f6e',
                              }} />
                            </div>
                            <span style={{ fontSize: 'var(--font-size-sm)', fontVariantNumeric: 'tabular-nums', minWidth: 50, textAlign: 'right' }}>
                              {fmtPct(r.cumulativePct)}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

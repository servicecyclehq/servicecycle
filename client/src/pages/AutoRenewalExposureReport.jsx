import ReportBackLink from '../components/ReportBackLink';
// ─────────────────────────────────────────────────────────────────────────────
// AutoRenewalExposureReport.jsx — v0.58.0 Tier-1 white-space report
//
// Layout is PDF-ready: single-column wide table, KPI band as header,
// "headline → context → detail" ordering so v0.58.1's PDF rendering can be
// added without a layout rewrite.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Download, FileSpreadsheet, AlertOctagon, FileText } from 'lucide-react';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';

const HORIZON_CHIPS = [
  { value: 30,  label: 'Next 30 days' },
  { value: 90,  label: 'Next 90 days' },
  { value: 180, label: 'Next 180 days' },
  { value: 365, label: 'All' },
];

function fmtCurrency(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmtDate(v) {
  if (!v) return '—';
  return new Date(v).toISOString().split('T')[0];
}

function RiskBadge({ risk }) {
  const config = {
    critical: { bg: '#fee2e2', fg: '#991b1b', label: 'Critical' },
    warning:  { bg: '#fef3c7', fg: '#92400e', label: 'Warning' },
    ok:       { bg: 'var(--color-bg-subtle, #f1f5f9)', fg: 'var(--color-text-secondary)', label: 'OK' },
  };
  const c = config[risk] || config.ok;
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em',
      padding: '3px 8px', borderRadius: 4,
      background: c.bg, color: c.fg, textTransform: 'uppercase',
    }}>
      {c.label}
    </span>
  );
}

export default function AutoRenewalExposureReport() {
  const navigate = useNavigate();
  const [horizon, setHorizon] = useState(90);
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get('/api/reports/auto-renewal-exposure', { params: { horizon } })
      .then(r => { if (!cancelled) { setData(r?.data?.data || null); setMeta(r?.data?.meta ?? null); } })
      .catch(err => { if (!cancelled) setError(err?.response?.data?.error || 'Failed to load report'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [horizon]);

  async function downloadExport(format) {
    try {
      const res = await api.get(`/api/reports/auto-renewal-exposure/${format}`, {
        params: { horizon }, responseType: 'blob',
      });
      const cd = res.headers['content-disposition'] || '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m ? m[1] : `auto-renewal-exposure.${format}`;
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
          <h1 className="page-title">Auto-Renewal Exposure</h1>
          <div className="page-subtitle">
            Capital at risk from auto-renewing contracts whose cancel window is approaching.
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

        <ReportAiNarrative reportId="auto-renewal-exposure" params={{ horizon }} paramsKey={String(horizon)} />

        {error && (
          <div className="card" style={{ padding: 16, marginBottom: 16, color: '#991b1b', background: '#fee2e2' }}>
            {error}
          </div>
        )}

        {/* KPI band */}
        <div className="card" style={{
          padding: 0, marginBottom: 20, overflow: 'hidden',
        }}>
          <div style={{ height: 3, background: '#dc2626' }} />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 0,
          }}>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                Total Exposure
              </div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>
                {loading ? '—' : fmtCurrency(data?.totalExposure)}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                across {data?.totalContracts || 0} contract{data?.totalContracts === 1 ? '' : 's'}
              </div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: '#991b1b', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontWeight: 600 }}>
                Critical (≤7 days)
              </div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: '#dc2626', lineHeight: 1 }}>
                {data?.criticalCount || 0}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                {fmtCurrency(data?.criticalExposure)}
              </div>
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontWeight: 600 }}>
                Warning (≤30 days)
              </div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-warning)', lineHeight: 1 }}>
                {data?.warningCount || 0}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                {fmtCurrency(data?.warningExposure)}
              </div>
            </div>
          </div>
        </div>

        {/* Detail table */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Loading…</div>
          ) : !data || data.rows.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
              <AlertOctagon size={28} style={{ marginBottom: 8, opacity: 0.6 }} />
              <div>No auto-renewing contracts in the selected window.</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-ui)' }}>
                <thead>
                  <tr style={{ background: 'var(--color-bg-subtle, #f1f5f9)', borderBottom: '1px solid var(--color-border)' }}>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Vendor</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Product</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Cancel By</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Days Left</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Renewal Value</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Risk</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => {
                    const rowBg = r.risk === 'critical' ? '#fef2f2' : r.risk === 'warning' ? '#fffbeb' : 'transparent';
                    return (
                      <tr
                        key={r.id}
                        style={{ borderBottom: '1px solid var(--color-border)', background: rowBg, cursor: 'pointer' }}
                        onClick={() => navigate(`/contracts/${r.id}`)}
                      >
                        <td style={{ padding: '10px 12px', color: 'var(--color-text)' }}>{r.vendorName || '—'}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text)' }}>{r.product}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text)', fontFamily: 'monospace', fontSize: 'var(--font-size-sm)' }}>{fmtDate(r.cancelByDate)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--color-text)' }}>{r.daysToCancelBy ?? '—'}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--color-text)', fontWeight: 600 }}>{fmtCurrency(r.renewalValue)}</td>
                        <td style={{ padding: '10px 12px' }}><RiskBadge risk={r.risk} /></td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)' }}>{r.ownerDisplay || '—'}</td>
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

import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

function SeverityBadge({ days }) {
  if (days < 0) return <span style={{ background:'#fef2f2', color:'#dc2626', padding:'2px 8px', borderRadius:99, fontSize: 'var(--font-size-sm)', fontWeight:600 }}>Missed ({Math.abs(days)}d ago)</span>;
  if (days <= 14) return <span style={{ background:'#fef2f2', color:'#dc2626', padding:'2px 8px', borderRadius:99, fontSize: 'var(--font-size-sm)' }}>Critical — {days} days left</span>;
  return <span style={{ background:'#fffbeb', color:'#92400e', padding:'2px 8px', borderRadius:99, fontSize: 'var(--font-size-sm)' }}>Warning — {days} days left</span>;
}

function ContractTable({ rows, showDaysPast }) {
  const navigate = useNavigate();
  if (!rows.length) return <div style={{ padding: 24, color: 'var(--color-text-secondary)', textAlign: 'center' }}>None in this bucket</div>;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Vendor</th><th>Product</th><th>Owner</th><th>Department</th>
          <th>Cancel Deadline</th><th>Renewal Date</th>
          <th style={{textAlign:'right'}}>Value</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.id} style={{cursor:'pointer'}} onClick={() => navigate(`/contracts/${r.id}`)}>
            <td>{r.vendorName}</td>
            <td>{r.productName || '—'}</td>
            <td>{r.contractOwner || '—'}</td>
            <td>{r.department || '—'}</td>
            <td>{fmtDate(r.cancellationDeadline)}</td>
            <td>{fmtDate(r.endDate)}</td>
            <td style={{textAlign:'right'}}>{fmt(r.totalValue)}</td>
            <td><SeverityBadge days={showDaysPast ? -(r.daysPastDeadline) : r.daysToDeadline} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function TerminationWindowViolationsReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/termination-window-violations');
      setData(res.data.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCSV() {
    setDownloading(true);
    try {
      const res = await api.get('/api/reports/termination-window-violations/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'LapseIQ_Termination_Window_Violations_' + new Date().toISOString().split('T')[0] + '.csv';
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  }

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Termination Window Violations</h1>
          <div className="page-subtitle">Auto-renewing contracts whose cancel window has passed or is closing — capital locked in without intervention</div>
        </div>
        <button className="btn" onClick={handleCSV} disabled={loading || downloading || !data}>
          {downloading ? 'Exporting' : 'Export CSV'}
        </button>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {error   && <div className="alert alert-error">{error}</div>}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Missed Windows',    value: data.summary.missedCount,                             color: '#dc2626' },
              { label: 'Missed Value',      value: fmt(data.summary.missedValue),                        color: '#dc2626' },
              { label: 'Critical (≤14d)',   value: data.summary.criticalCount,                           color: 'var(--color-warning)' },
              { label: 'Warning (≤30d)',    value: data.summary.warningCount,                            color: '#0d4f6e' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border)', fontWeight: 600, color: '#dc2626' }}>
              🔴 Missed — Cancel window has passed ({data.summary.missedCount} contracts, {fmt(data.summary.missedValue)})
            </div>
            <ContractTable rows={data.missed} showDaysPast />
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border)', fontWeight: 600, color: 'var(--color-warning)' }}>
              🟡 Critical — Window closes within 14 days ({data.summary.criticalCount} contracts)
            </div>
            <ContractTable rows={data.critical} />
          </div>

          <div className="card">
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border)', fontWeight: 600, color: '#0d4f6e' }}>
              🔵 Warning — Window closes within 30 days ({data.summary.warningCount} contracts)
            </div>
            <ContractTable rows={data.warning} />
          </div>
        </>
      )}
    </div>
  );
}
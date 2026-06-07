import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const pct = (n) => n == null ? '—' : `${n.toFixed(1)}%`;

function EscalationBar({ value, threshold }) {
  const clamped = Math.min(Math.abs(value || 0), 200);
  const color   = value >= threshold * 2 ? '#dc2626' : value >= threshold ? 'var(--color-warning)' : 'var(--color-success)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, background: 'var(--color-bg-secondary)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(clamped / 2, 100)}%`, background: color, height: '100%', borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color, minWidth: 44, textAlign: 'right' }}>{pct(value)}</span>
    </div>
  );
}

export default function PriceEscalationRadarReport() {
  const navigate = useNavigate();
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [threshold, setThreshold] = useState(10);
  const [filter, setFilter]     = useState('all');

  const [downloading, setDownloading] = useState(false);
  const [pdfing, setPdfing]           = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/price-escalation-radar', { params: { thresholdPct: threshold } });
      setData(res.data.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [threshold]);

  useEffect(() => { load(); }, [load]);

  const rows = data
    ? (filter === 'all' ? data.rows : filter === 'flagged' ? data.rows.filter(r => r.flagged) : data.rows.filter(r => !r.flagged))
    : [];

  const handlePDF = async () => {
    setPdfing(true); setError(null);
    try {
      const res = await api.get('/api/reports/price-escalation-radar/pdf', { params: { thresholdPct: threshold }, responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Price_Escalation_Radar_${new Date().toISOString().split('T')[0]}.pdf`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('PDF download failed.'); }
    finally { setPdfing(false); }
  };
  const handleCSV = async () => {
    setDownloading(true); setError(null);
    try {
      const res = await api.get('/api/reports/price-escalation-radar/csv', { params: { thresholdPct: threshold }, responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Price_Escalation_Radar_${new Date().toISOString().split('T')[0]}.csv`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  };

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Price Escalation Radar</h1>
          <div className="page-subtitle">Contracts where current value has grown significantly beyond the original ask — spot hidden price creep</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={handlePDF} disabled={loading || pdfing || !data}>{pdfing ? 'Generating…' : '↓ PDF'}</button>
          <button className="btn" onClick={handleCSV} disabled={loading || downloading || !data}>{downloading ? 'Exporting…' : '↓ CSV'}</button>
        </div>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {error   && <div className="alert alert-error">{error}</div>}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Contracts Scanned', value: data.summary.totalScanned,    color: '#0d4f6e' },
              { label: 'Flagged',           value: data.summary.flaggedCount,     color: '#dc2626' },
              { label: 'Total Excess Cost', value: fmt(data.summary.totalExcessCost), color: '#dc2626' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
            {[['all','All'],['flagged','Flagged'],['clean','Clean']].map(([id, label]) => (
              <button key={id} className={`btn ${filter === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(id)}>{label}</button>
            ))}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Threshold %</label>
              <input
                type="number" min={1} max={100} value={threshold}
                onChange={e => setThreshold(Number(e.target.value))}
                style={{ width: 64, padding: '4px 8px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 'var(--font-size-ui)' }}
              />
              <button className="btn btn-ghost" onClick={load}>Apply</button>
            </div>
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Vendor</th><th>Product</th><th>Category</th>
                  <th style={{textAlign:'right'}}>Original Ask</th>
                  <th style={{textAlign:'right'}}>Current Value</th>
                  <th style={{textAlign:'right'}}>Excess Cost</th>
                  <th style={{minWidth:160}}>Escalation %</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${r.id}`)}>
                    <td style={{ fontWeight: 500 }}>{r.vendorName}</td>
                    <td>{r.productName || '—'}</td>
                    <td>{r.category || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.originalAsk)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.currentValue)}</td>
                    <td style={{ textAlign: 'right', color: r.excessCost > 0 ? '#dc2626' : 'var(--color-success)', fontWeight: 600 }}>{fmt(r.excessCost)}</td>
                    <td style={{ minWidth: 160, paddingRight: 16 }}>
                      <EscalationBar value={r.escalationPct} threshold={threshold} />
                    </td>
                    <td>
                      {r.flagged
                        ? <span style={{ background:'#fef2f2', color:'#dc2626', padding:'2px 8px', borderRadius:99, fontSize: 'var(--font-size-sm)', fontWeight:600 }}>Flagged</span>
                        : <span style={{ background:'#f0fdf4', color:'var(--color-success)', padding:'2px 8px', borderRadius:99, fontSize: 'var(--font-size-sm)', fontWeight:600 }}>Clean</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                No contracts match this filter
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

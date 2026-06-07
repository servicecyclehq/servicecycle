import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const pct = (n) => n == null ? '—' : `${n.toFixed(1)}%`;

const VERDICT_COLOR = { walkaway: 'var(--color-success)', borderline: 'var(--color-warning)', renew: '#0d4f6e' };
const VERDICT_BG    = { walkaway: '#f0fdf4', borderline: '#fffbeb', renew: '#eff6ff' };

export default function WalkawayCalculatorReport() {
  const navigate = useNavigate();
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [horizon, setHorizon]     = useState(12);
  const [switchCostPct, setSwitchCostPct] = useState('');
  const [filter, setFilter]       = useState('all');

  const [downloading, setDownloading] = useState(false);
  const [pdfing, setPdfing]           = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = { horizonMonths: horizon };
      if (switchCostPct !== '') params.switchCostPct = switchCostPct;
      const res = await api.get('/api/reports/walkaway-calculator', { params });
      setData(res.data.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [horizon, switchCostPct]);

  useEffect(() => { load(); }, [load]);

  const rows = data
    ? (filter === 'all' ? data.rows : data.rows.filter(r => r.verdict === filter))
    : [];

  const handlePDF = async () => {
    setPdfing(true); setError(null);
    try {
      const res = await api.get('/api/reports/walkaway-calculator/pdf', { params: { horizonMonths: horizon, ...(switchCostPct !== '' ? { switchCostPct } : {}) }, responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Walkaway_Calculator_${new Date().toISOString().split('T')[0]}.pdf`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('PDF download failed.'); }
    finally { setPdfing(false); }
  };
  const handleCSV = async () => {
    setDownloading(true); setError(null);
    try {
      const res = await api.get('/api/reports/walkaway-calculator/csv', { params: { horizonMonths: horizon, ...(switchCostPct !== '' ? { switchCostPct } : {}) }, responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Walkaway_Calculator_${new Date().toISOString().split('T')[0]}.csv`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  };

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Walkaway Calculator</h1>
          <div className="page-subtitle">At what price does switching beat renewing? Compares renewal cost vs. estimated migration cost by category</div>
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
              { label: 'Walk Away',  value: data.summary.walkawayCount,  color: 'var(--color-success)' },
              { label: 'Borderline', value: data.summary.borderlineCount, color: 'var(--color-warning)' },
              { label: 'Renew',      value: data.summary.renewCount,      color: '#0d4f6e' },
              { label: 'Contracts',  value: data.summary.totalContracts,  color: '#0d4f6e' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
            {[['all','All'],['walkaway','Walk Away'],['borderline','Borderline'],['renew','Renew']].map(([id, label]) => (
              <button key={id} className={`btn ${filter === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(id)}>{label}</button>
            ))}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Horizon (mo)</label>
              <input
                type="number" min={1} max={60} value={horizon}
                onChange={e => setHorizon(Number(e.target.value))}
                style={{ width: 60, padding: '4px 8px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 'var(--font-size-ui)' }}
              />
              <label style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Switch Cost %</label>
              <input
                type="number" min={0} max={100} placeholder="auto" value={switchCostPct}
                onChange={e => setSwitchCostPct(e.target.value)}
                style={{ width: 72, padding: '4px 8px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 'var(--font-size-ui)' }}
              />
              <button className="btn btn-ghost" onClick={load}>Recalculate</button>
            </div>
          </div>

          <div style={{ marginBottom: 12, fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
            Default switch cost by category: SaaS 15% · Telecom 25% · Hardware 20% · Services 10% · Insurance 5% · Lease/Rent 30%
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Vendor</th><th>Category</th>
                  <th style={{textAlign:'right'}}>Renewal Cost</th>
                  <th style={{textAlign:'right'}}>Switch Cost</th>
                  <th style={{textAlign:'right'}}>Switch Cost %</th>
                  <th style={{textAlign:'right'}}>Net Savings if Walk</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${r.id}`)}>
                    <td style={{ fontWeight: 500 }}>{r.vendorName}</td>
                    <td>{r.category || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.renewalCost)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.switchCost)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>{pct(r.switchCostPct)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: r.netSavingsIfWalk > 0 ? 'var(--color-success)' : '#dc2626' }}>{fmt(r.netSavingsIfWalk)}</td>
                    <td>
                      <span style={{
                        background: VERDICT_BG[r.verdict] || '#f3f4f6',
                        color: VERDICT_COLOR[r.verdict] || '#374151',
                        padding: '2px 8px', borderRadius: 99, fontSize: 'var(--font-size-sm)', fontWeight: 600, textTransform: 'capitalize',
                      }}>{r.verdict === 'walkaway' ? 'Walk Away' : r.verdict === 'borderline' ? 'Borderline' : 'Renew'}</span>
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

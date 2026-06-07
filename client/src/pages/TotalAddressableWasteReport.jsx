import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const pct = (n) => (n == null ? '—' : `${n.toFixed(1)}%`);

export default function TotalAddressableWasteReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [tab, setTab]         = useState('contracts'); // contracts | category | department

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/total-addressable-waste');
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
      const res = await api.get('/api/reports/total-addressable-waste/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'LapseIQ_Total_Addressable_Waste_' + new Date().toISOString().split('T')[0] + '.csv';
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
          <h1 className="page-title">Total Addressable Waste</h1>
          <div className="page-subtitle">Unused licensed seats across the portfolio — annual dollars recoverable through right-sizing</div>
        </div>
        <button className="btn" onClick={handleCSV} disabled={loading || downloading || !data}>
          {downloading ? 'Exporting' : 'Export CSV'}
        </button>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {error   && <div className="alert alert-error">{error}</div>}

      {data && (
        <>
          {/* KPI strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Total Waste',       value: fmt(data.totals.totalWaste),         color: '#dc2626' },
              { label: 'Portfolio Value',   value: fmt(data.totals.totalValue),          color: '#0d4f6e' },
              { label: 'Waste Rate',        value: pct(data.totals.wastePct),            color: 'var(--color-warning)' },
              { label: 'Contracts Scanned', value: data.totals.contractCount,            color: 'var(--color-success)' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[['contracts','By Contract'],['category','By Category'],['department','By Department']].map(([id, label]) => (
              <button key={id} className={`btn ${tab === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>

          {tab === 'contracts' && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vendor</th><th>Product</th><th>Department</th>
                    <th style={{textAlign:'right'}}>Licensed</th>
                    <th style={{textAlign:'right'}}>Active</th>
                    <th style={{textAlign:'right'}}>Wasted</th>
                    <th style={{textAlign:'right'}}>Utilisation</th>
                    <th style={{textAlign:'right'}}>Annual Waste</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => (
                    <tr key={r.id} style={{cursor:'pointer'}} onClick={() => navigate(`/contracts/${r.id}`)}>
                      <td>{r.vendorName}</td>
                      <td>{r.productName || '—'}</td>
                      <td>{r.department  || '—'}</td>
                      <td style={{textAlign:'right'}}>{r.seatsLicensed}</td>
                      <td style={{textAlign:'right'}}>{r.seatsActivelyInUse}</td>
                      <td style={{textAlign:'right', color: r.wastedSeats > 0 ? '#dc2626' : 'inherit'}}>{r.wastedSeats}</td>
                      <td style={{textAlign:'right'}}>
                        <span style={{
                          background: r.utilizationPct < 50 ? '#fef2f2' : r.utilizationPct < 75 ? '#fffbeb' : '#f0fdf4',
                          color:      r.utilizationPct < 50 ? '#dc2626' : r.utilizationPct < 75 ? '#92400e' : '#166534',
                          padding: '2px 8px', borderRadius: 99, fontSize: 'var(--font-size-sm)',
                        }}>{r.utilizationPct}%</span>
                      </td>
                      <td style={{textAlign:'right', fontWeight:600, color:'#dc2626'}}>{fmt(r.annualWaste)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'category' && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>Category</th><th style={{textAlign:'right'}}>Contracts</th><th style={{textAlign:'right'}}>Total Waste</th></tr></thead>
                <tbody>
                  {data.byCategory.map(r => (
                    <tr key={r.category}>
                      <td>{r.category}</td>
                      <td style={{textAlign:'right'}}>{r.contractCount}</td>
                      <td style={{textAlign:'right', fontWeight:600, color:'#dc2626'}}>{fmt(r.totalWaste)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'department' && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>Department</th><th style={{textAlign:'right'}}>Contracts</th><th style={{textAlign:'right'}}>Total Waste</th></tr></thead>
                <tbody>
                  {data.byDepartment.map(r => (
                    <tr key={r.department}>
                      <td>{r.department}</td>
                      <td style={{textAlign:'right'}}>{r.contractCount}</td>
                      <td style={{textAlign:'right', fontWeight:600, color:'#dc2626'}}>{fmt(r.totalWaste)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
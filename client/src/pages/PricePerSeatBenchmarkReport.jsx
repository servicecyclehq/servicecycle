import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const fmtDec = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
const pct = (n) => n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;

function DeltaBadge({ value }) {
  if (value == null) return <span style={{ color: 'var(--color-text-secondary)' }}>—</span>;
  const color = value > 20 ? '#dc2626' : value > 0 ? 'var(--color-warning)' : 'var(--color-success)';
  return <span style={{ color, fontWeight: 600 }}>{pct(value)}</span>;
}

export default function PricePerSeatBenchmarkReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [filter, setFilter]   = useState('all');

  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/price-per-seat-benchmark');
      setData(res.data.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = data
    ? (filter === 'all' ? data.rows : filter === 'outlier' ? data.rows.filter(r => r.outlier) : data.rows.filter(r => !r.outlier))
    : [];

  const handleCSV = async () => {
    setDownloading(true); setError(null);
    try {
      const res = await api.get('/api/reports/price-per-seat-benchmark/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Price_Per_Seat_Benchmark_${new Date().toISOString().split('T')[0]}.csv`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  };

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Price Per Seat Benchmark</h1>
          <div className="page-subtitle">Per-seat cost across all quantity-based contracts, ranked within category — arm negotiators with internal benchmark data</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={handleCSV} disabled={loading || downloading || !data}>{downloading ? 'Exporting…' : '↓ CSV'}</button>
        </div>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {error   && <div className="alert alert-error">{error}</div>}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Contracts Analysed', value: data.summary.totalContracts, color: '#0d4f6e' },
              { label: 'Outliers (>20% above avg)', value: data.summary.outlierCount, color: '#dc2626' },
              { label: 'Total Seats',          value: data.summary.totalSeats?.toLocaleString() ?? '—', color: '#0d4f6e' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[['all','All'],['outlier','Outliers'],['ok','Within Benchmark']].map(([id, label]) => (
              <button key={id} className={`btn ${filter === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Vendor</th><th>Product</th><th>Category</th>
                  <th style={{textAlign:'right'}}>Seats</th>
                  <th style={{textAlign:'right'}}>Annual Value</th>
                  <th style={{textAlign:'right'}}>Cost / Seat</th>
                  <th style={{textAlign:'right'}}>Category Avg</th>
                  <th style={{textAlign:'right'}}>vs Avg</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${r.id}`)}>
                    <td style={{ fontWeight: 500 }}>{r.vendorName}</td>
                    <td>{r.productName || '—'}</td>
                    <td>{r.category || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{r.seatsLicensed?.toLocaleString() ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.annualValue)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtDec(r.costPerSeat)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>{fmtDec(r.categoryAvg)}</td>
                    <td style={{ textAlign: 'right' }}><DeltaBadge value={r.vsAvgPct} /></td>
                    <td>
                      {r.outlier
                        ? <span style={{ background:'#fef2f2', color:'#dc2626', padding:'2px 8px', borderRadius:99, fontSize: 'var(--font-size-sm)', fontWeight:600 }}>Outlier</span>
                        : <span style={{ background:'#f0fdf4', color:'var(--color-success)', padding:'2px 8px', borderRadius:99, fontSize: 'var(--font-size-sm)', fontWeight:600 }}>OK</span>}
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

          {data.categoryBreakdown && data.categoryBreakdown.length > 0 && (
            <>
              <h2 style={{ fontSize: 16, fontWeight: 600, marginTop: 32, marginBottom: 12 }}>Category Averages</h2>
              <div className="card" style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th style={{textAlign:'right'}}>Contracts</th>
                      <th style={{textAlign:'right'}}>Avg Cost / Seat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.categoryBreakdown.map(r => (
                      <tr key={r.category}>
                        <td>{r.category}</td>
                        <td style={{ textAlign: 'right' }}>{r.contractCount}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtDec(r.avgCostPerSeat)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);

function DeltaBadge({ pct }) {
  if (pct == null) return <span style={{ color: 'var(--color-text-secondary)' }}>—</span>;
  const color = pct > 20 ? '#dc2626' : pct > 0 ? 'var(--color-warning)' : 'var(--color-success)';
  const sign  = pct > 0 ? '+' : '';
  return <span style={{ color, fontWeight: 600 }}>{sign}{pct.toFixed(1)}%</span>;
}

export default function CostPerActiveUserReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [tab, setTab]         = useState('contracts');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/cost-per-active-user');
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
      const res = await api.get('/api/reports/cost-per-active-user/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'LapseIQ_Cost_Per_Active_User_' + new Date().toISOString().split('T')[0] + '.csv';
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
          <h1 className="page-title">Cost-per-Active-User</h1>
          <div className="page-subtitle">Annual cost divided by active seats — with internal category benchmarks to spot outliers</div>
        </div>
        <button className="btn" onClick={handleCSV} disabled={loading || downloading || !data}>
          {downloading ? 'Exporting' : 'Export CSV'}
        </button>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {error   && <div className="alert alert-error">{error}</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[['contracts','By Contract'],['category','Category Benchmark']].map(([id, label]) => (
              <button key={id} className={`btn ${tab === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>

          {tab === 'contracts' && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vendor</th><th>Product</th><th>Category</th><th>Department</th>
                    <th style={{textAlign:'right'}}>Active Users</th>
                    <th style={{textAlign:'right'}}>Annual Value</th>
                    <th style={{textAlign:'right'}}>Cost / User</th>
                    <th style={{textAlign:'right'}}>Cat. Avg</th>
                    <th style={{textAlign:'right'}}>vs Benchmark</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => (
                    <tr key={r.id} style={{cursor:'pointer'}} onClick={() => navigate(`/contracts/${r.id}`)}>
                      <td>{r.vendorName}</td>
                      <td>{r.productName || '—'}</td>
                      <td>{r.category    || '—'}</td>
                      <td>{r.department  || '—'}</td>
                      <td style={{textAlign:'right'}}>{r.seatsActivelyInUse}</td>
                      <td style={{textAlign:'right'}}>{fmt(r.totalValue)}</td>
                      <td style={{textAlign:'right', fontWeight:600}}>{fmt(r.costPerActiveUser)}</td>
                      <td style={{textAlign:'right', color:'var(--color-text-secondary)'}}>{fmt(r.categoryBenchmark)}</td>
                      <td style={{textAlign:'right'}}><DeltaBadge pct={r.vsBenchmarkPct} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'category' && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th style={{textAlign:'right'}}>Contracts</th>
                    <th style={{textAlign:'right'}}>Avg Cost / Active User</th>
                  </tr>
                </thead>
                <tbody>
                  {data.categoryBreakdown.map(r => (
                    <tr key={r.category}>
                      <td>{r.category}</td>
                      <td style={{textAlign:'right'}}>{r.contractCount}</td>
                      <td style={{textAlign:'right', fontWeight:600}}>{fmt(r.avgCostPerActiveUser)}</td>
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
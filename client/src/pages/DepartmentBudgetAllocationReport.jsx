import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);

function SpendBar({ value, max }) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, background: 'var(--color-bg-secondary)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
        <div style={{ width: `${width}%`, background: '#0d4f6e', height: '100%', borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: '#0d4f6e', minWidth: 80, textAlign: 'right' }}>{fmt(value)}</span>
    </div>
  );
}

export default function DepartmentBudgetAllocationReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [tab, setTab]         = useState('summary');

  const [downloading, setDownloading] = useState(false);
  const [pdfing, setPdfing]           = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/department-budget-allocation');
      setData(res.data.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const maxSpend = data ? Math.max(...data.rows.map(r => r.totalSpend), 1) : 1;

  const handlePDF = async () => {
    setPdfing(true); setError(null);
    try {
      const res = await api.get('/api/reports/department-budget-allocation/pdf', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Department_Budget_Allocation_${new Date().toISOString().split('T')[0]}.pdf`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('PDF download failed.'); }
    finally { setPdfing(false); }
  };
  const handleCSV = async () => {
    setDownloading(true); setError(null);
    try {
      const res = await api.get('/api/reports/department-budget-allocation/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Department_Budget_Allocation_${new Date().toISOString().split('T')[0]}.csv`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  };

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Department Budget Allocation</h1>
          <div className="page-subtitle">Software and vendor spend broken down by department — who's spending what and what's renewing soon</div>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Departments',     value: data.summary.deptCount,          color: '#0d4f6e' },
              { label: 'Total Contracts', value: data.summary.totalContracts,      color: '#0d4f6e' },
              { label: 'Total Spend',     value: fmt(data.summary.totalSpend),     color: '#0d4f6e' },
              { label: 'Renewing in 90d', value: data.summary.renewalsIn90d,       color: 'var(--color-warning)' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[['summary','Summary'],['contracts','All Contracts']].map(([id, label]) => (
              <button key={id} className={`btn ${tab === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>

          {tab === 'summary' && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th style={{textAlign:'right'}}>Contracts</th>
                    <th style={{textAlign:'right'}}>Renewing 90d</th>
                    <th style={{minWidth:220}}>Annual Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => (
                    <tr key={r.department}>
                      <td style={{ fontWeight: 500 }}>{r.department}</td>
                      <td style={{ textAlign: 'right' }}>{r.contractCount}</td>
                      <td style={{ textAlign: 'right' }}>
                        {r.renewalsIn90d > 0
                          ? <span style={{ color: 'var(--color-warning)', fontWeight: 600 }}>{r.renewalsIn90d}</span>
                          : r.renewalsIn90d}
                      </td>
                      <td style={{ minWidth: 220, paddingRight: 16 }}>
                        <SpendBar value={r.totalSpend} max={maxSpend} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'contracts' && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vendor</th><th>Product</th><th>Department</th><th>Category</th>
                    <th style={{textAlign:'right'}}>End Date</th>
                    <th style={{textAlign:'right'}}>Annual Value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.contracts.map(r => (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${r.id}`)}>
                      <td style={{ fontWeight: 500 }}>{r.vendorName}</td>
                      <td>{r.productName || '—'}</td>
                      <td>{r.department || '—'}</td>
                      <td>{r.category || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.endDate ? new Date(r.endDate).toLocaleDateString() : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(r.totalValue)}</td>
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

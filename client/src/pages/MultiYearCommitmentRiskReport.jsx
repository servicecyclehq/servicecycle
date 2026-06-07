import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);

const TIER_COLOR = { critical: '#dc2626', high: '#9333ea', medium: 'var(--color-warning)' };
const TIER_BG    = { critical: '#fef2f2', high: '#faf5ff', medium: '#fffbeb' };

function LockInBadge({ tier }) {

  return (
    <span style={{
      background: TIER_BG[tier] || '#f3f4f6',
      color: TIER_COLOR[tier] || '#374151',
      padding: '2px 8px', borderRadius: 99, fontSize: 'var(--font-size-sm)', fontWeight: 600, textTransform: 'capitalize',
    }}>{tier}</span>
  );
}

export default function MultiYearCommitmentRiskReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [filter, setFilter]   = useState('all');

  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/multi-year-commitment-risk');
      setData(res.data.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = data
    ? (filter === 'all' ? data.rows : data.rows.filter(r => r.lockInTier === filter))
    : [];

  const handleCSV = async () => {
    setDownloading(true); setError(null);
    try {
      const res = await api.get('/api/reports/multi-year-commitment-risk/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Multi_Year_Commitment_Risk_${new Date().toISOString().split('T')[0]}.csv`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  };

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Multi-Year Commitment Risk</h1>
          <div className="page-subtitle">Active contracts with 24+ month terms — total capital committed beyond the current fiscal year</div>
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
              { label: 'Long-Term Contracts', value: data.summary.totalContracts,           color: '#0d4f6e' },
              { label: 'Critical (60mo+)',    value: data.summary.criticalCount,             color: '#dc2626' },
              { label: 'High (36-60mo)',      value: data.summary.highCount,                 color: '#9333ea' },
              { label: 'Medium (24-36mo)',    value: data.summary.mediumCount,               color: 'var(--color-warning)' },
              { label: 'Total Committed',     value: fmt(data.summary.totalCommitted),       color: '#0d4f6e' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[['all','All'],['critical','Critical'],['high','High'],['medium','Medium']].map(([id, label]) => (
              <button key={id} className={`btn ${filter === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Vendor</th><th>Product</th><th>Category</th><th>Department</th>
                  <th style={{textAlign:'right'}}>End Date</th>
                  <th style={{textAlign:'right'}}>Months Remaining</th>
                  <th style={{textAlign:'right'}}>Annual Value</th>
                  <th style={{textAlign:'right'}}>Total Remaining</th>
                  <th>Lock-In Tier</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${r.id}`)}>
                    <td style={{ fontWeight: 500 }}>{r.vendorName}</td>
                    <td>{r.productName || '—'}</td>
                    <td>{r.category || '—'}</td>
                    <td>{r.department || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{r.endDate ? new Date(r.endDate).toLocaleDateString() : '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.monthsRemaining}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.annualValue)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: TIER_COLOR[r.lockInTier] }}>{fmt(r.remainingCommitment)}</td>
                    <td><LockInBadge tier={r.lockInTier} /></td>
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

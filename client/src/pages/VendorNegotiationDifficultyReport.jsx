import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const pct = (n) => n == null ? '—' : `${n.toFixed(1)}%`;

const TIER_COLOR = { hard: '#dc2626', moderate: 'var(--color-warning)', easy: 'var(--color-success)' };
const TIER_BG    = { hard: '#fef2f2', moderate: '#fffbeb', easy: '#f0fdf4' };

function DifficultyBar({ score }) {
  const color = score >= 80 ? '#dc2626' : score >= 50 ? 'var(--color-warning)' : 'var(--color-success)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, background: 'var(--color-bg-secondary)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, background: color, height: '100%', borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color, minWidth: 28, textAlign: 'right' }}>{score}</span>
    </div>
  );
}

export default function VendorNegotiationDifficultyReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [filter, setFilter]   = useState('all');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/vendor-negotiation-difficulty');
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
      const res = await api.get('/api/reports/vendor-negotiation-difficulty/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'LapseIQ_Vendor_Negotiation_Difficulty_' + new Date().toISOString().split('T')[0] + '.csv';
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  }

  const rows = data ? (filter === 'all' ? data.rows : data.rows.filter(r => r.difficultyTier === filter)) : [];
  const hardCount     = data ? data.rows.filter(r => r.difficultyTier === 'hard').length     : 0;
  const moderateCount = data ? data.rows.filter(r => r.difficultyTier === 'moderate').length : 0;
  const easyCount     = data ? data.rows.filter(r => r.difficultyTier === 'easy').length     : 0;

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Vendor Negotiation Difficulty</h1>
          <div className="page-subtitle">Vendors ranked by how rarely they concede — difficulty score 0 (easy) to 100 (never budges)</div>
        </div>
        <button className="btn" onClick={handleCSV} disabled={loading || downloading || !data}>
          {downloading ? 'Exporting' : 'Export CSV'}
        </button>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {error   && <div className="alert alert-error">{error}</div>}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Hard Vendors',     value: hardCount,             color: '#dc2626' },
              { label: 'Moderate Vendors', value: moderateCount,         color: 'var(--color-warning)' },
              { label: 'Easy Vendors',     value: easyCount,             color: 'var(--color-success)' },
              { label: 'Deals Analysed',   value: data.contractCount,    color: '#0d4f6e' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[['all','All'],['hard','Hard'],['moderate','Moderate'],['easy','Easy']].map(([id, label]) => (
              <button key={id} className={`btn ${filter === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Vendor</th><th>Category</th>
                  <th style={{textAlign:'right'}}>Deals</th>
                  <th style={{textAlign:'right'}}>Total Asked</th>
                  <th style={{textAlign:'right'}}>Total Saved</th>
                  <th style={{textAlign:'right'}}>Avg Savings</th>
                  <th style={{minWidth:160}}>Difficulty Score</th>
                  <th>Tier</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.vendorName}>
                    <td style={{ fontWeight: 500 }}>{r.vendorName}</td>
                    <td>{r.category || '—'}</td>
                    <td style={{textAlign:'right'}}>{r.dealCount}</td>
                    <td style={{textAlign:'right'}}>{fmt(r.totalAsk)}</td>
                    <td style={{textAlign:'right', color:'var(--color-success)', fontWeight:600}}>{fmt(r.totalSaved)}</td>
                    <td style={{textAlign:'right'}}>{pct(r.avgSavingsPct)}</td>
                    <td style={{ minWidth: 160, paddingRight: 16 }}>
                      <DifficultyBar score={r.difficultyScore} />
                    </td>
                    <td>
                      <span style={{
                        background: TIER_BG[r.difficultyTier], color: TIER_COLOR[r.difficultyTier],
                        padding:'2px 8px', borderRadius:99, fontSize: 'var(--font-size-sm)', fontWeight:600, textTransform:'capitalize',
                      }}>{r.difficultyTier}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                No vendors in this tier
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
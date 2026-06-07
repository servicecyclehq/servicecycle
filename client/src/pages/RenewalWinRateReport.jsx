import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const pct = (n) => n == null ? '—' : `${n.toFixed(1)}%`;

function SavingsBar({ value, max }) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  const color = value >= 15 ? 'var(--color-success)' : value >= 5 ? 'var(--color-warning)' : '#dc2626';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, background: 'var(--color-bg-secondary)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
        <div style={{ width: `${width}%`, background: color, height: '100%', borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color, minWidth: 44, textAlign: 'right' }}>{pct(value)}</span>
    </div>
  );
}

export default function RenewalWinRateReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [tab, setTab]         = useState('trend');

  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/renewal-win-rate');
      setData(res.data.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const maxSavings = data ? Math.max(...data.trend.map(r => r.avgSavingsPct || 0), 1) : 1;

  const handleCSV = async () => {
    setDownloading(true); setError(null);
    try {
      const res = await api.get('/api/reports/renewal-win-rate/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Renewal_Win_Rate_${new Date().toISOString().split('T')[0]}.csv`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  };

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Renewal Win Rate</h1>
          <div className="page-subtitle">Historical tracking of vendor ask vs. final negotiated price — trend over time and best deals surfaced</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={handleCSV} disabled={loading || downloading || !data}>{downloading ? 'Exporting…' : '↓ CSV'}</button>
        </div>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {error   && <div className="alert alert-error">{error}</div>}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Deals Analysed',        value: data.summary.totalDeals,                     color: '#0d4f6e' },
              { label: 'Total Saved',            value: fmt(data.summary.totalSaved),                color: 'var(--color-success)' },
              { label: 'Portfolio Avg Savings',  value: pct(data.summary.portfolioAvgSavingsPct),    color: 'var(--color-success)' },
              { label: 'Best Single Deal',       value: pct(data.summary.bestDealSavingsPct),        color: 'var(--color-success)' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[['trend','Quarterly Trend'],['best','Best Deals']].map(([id, label]) => (
              <button key={id} className={`btn ${tab === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>

          {tab === 'trend' && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Quarter</th>
                    <th style={{textAlign:'right'}}>Deals</th>
                    <th style={{textAlign:'right'}}>Total Ask</th>
                    <th style={{textAlign:'right'}}>Total Saved</th>
                    <th style={{minWidth:180}}>Avg Savings Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.trend.map(r => (
                    <tr key={r.quarter}>
                      <td style={{ fontWeight: 500 }}>{r.quarter}</td>
                      <td style={{ textAlign: 'right' }}>{r.dealCount}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(r.totalAsk)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--color-success)', fontWeight: 600 }}>{fmt(r.totalSaved)}</td>
                      <td style={{ minWidth: 180, paddingRight: 16 }}>
                        <SavingsBar value={r.avgSavingsPct} max={maxSavings} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.trend.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                  No completed deals with both original ask and final price recorded
                </div>
              )}
            </div>
          )}

          {tab === 'best' && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vendor</th><th>Category</th><th>Owner</th>
                    <th style={{textAlign:'right'}}>Original Ask</th>
                    <th style={{textAlign:'right'}}>Final Price</th>
                    <th style={{textAlign:'right'}}>Saved</th>
                    <th style={{textAlign:'right'}}>Savings %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bestDeals.map(r => (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${r.id}`)}>
                      <td style={{ fontWeight: 500 }}>{r.vendorName}</td>
                      <td>{r.category || '—'}</td>
                      <td>{r.contractOwner || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(r.originalAsk)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(r.finalPrice)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--color-success)', fontWeight: 600 }}>{fmt(r.saved)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--color-success)', fontWeight: 700 }}>{pct(r.savingsPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.bestDeals.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                  No deals with savings data recorded
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

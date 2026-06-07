import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const pct = (n) => n == null ? '—' : `${n.toFixed(1)}%`;

function Bar({ value, max, color }) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, background: 'var(--color-bg-secondary)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
        <div style={{ width: `${width}%`, background: color, height: '100%', borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color, minWidth: 44, textAlign: 'right' }}>{pct(value)}</span>
    </div>
  );
}

export default function NegotiationEffectivenessByOwnerReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/negotiation-effectiveness-by-owner');
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
      const res = await api.get('/api/reports/negotiation-effectiveness-by-owner/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'LapseIQ_Negotiation_Effectiveness_By_Owner_' + new Date().toISOString().split('T')[0] + '.csv';
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  }

  const maxPct = data ? Math.max(...data.rows.map(r => r.blendedSavingsPct), 1) : 1;

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Negotiation Effectiveness by Owner</h1>
          <div className="page-subtitle">Average savings rate per contract owner — who's beating the ask and by how much</div>
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
              { label: 'Owners Tracked',       value: data.summary.ownerCount,                          color: '#0d4f6e' },
              { label: 'Total Deals',          value: data.summary.totalDeals,                          color: '#0d4f6e' },
              { label: 'Portfolio Avg Savings', value: pct(data.summary.portfolioAvgSavingsPct),        color: 'var(--color-success)' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Owner</th>
                  <th style={{textAlign:'right'}}>Deals</th>
                  <th style={{textAlign:'right'}}>Total Ask</th>
                  <th style={{textAlign:'right'}}>Total Saved</th>
                  <th style={{textAlign:'right'}}>Avg Deal %</th>
                  <th style={{minWidth:180}}>Blended Rate</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(r => (
                  <tr key={r.owner}>
                    <td style={{ fontWeight: 500 }}>{r.owner}</td>
                    <td style={{textAlign:'right'}}>{r.dealCount}</td>
                    <td style={{textAlign:'right'}}>{fmt(r.totalAsk)}</td>
                    <td style={{textAlign:'right', color:'var(--color-success)', fontWeight:600}}>{fmt(r.totalSaved)}</td>
                    <td style={{textAlign:'right'}}>{pct(r.avgSavingsPct)}</td>
                    <td style={{ minWidth: 180, paddingRight: 16 }}>
                      <Bar value={r.blendedSavingsPct} max={maxPct} color="var(--color-success)" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.rows.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                No contracts with both original ask and final negotiated price recorded
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
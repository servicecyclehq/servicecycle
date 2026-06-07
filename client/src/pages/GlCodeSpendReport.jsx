import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const pct = (n) => n == null ? '—' : `${n.toFixed(1)}%`;

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

export default function GlCodeSpendReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [selected, setSelected] = useState(null);

  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/gl-code-spend');
      setData(res.data.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const maxSpend = data ? Math.max(...data.rows.map(r => r.totalSpend), 1) : 1;
  const detail   = selected && data ? data.rows.find(r => r.glCode === selected) : null;

  const handleCSV = async () => {
    setDownloading(true); setError(null);
    try {
      const res = await api.get('/api/reports/gl-code-spend/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_GL_Code_Spend_${new Date().toISOString().split('T')[0]}.csv`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  };

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">GL Code Spend Breakdown</h1>
          <div className="page-subtitle">Contract spend organized by general ledger code — for chargeback, quarterly close, and AP alignment</div>
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
              { label: 'GL Codes',        value: data.summary.glCodeCount,       color: '#0d4f6e' },
              { label: 'Tagged Spend',    value: fmt(data.summary.taggedSpend),   color: '#0d4f6e' },
              { label: 'Untagged Spend',  value: fmt(data.summary.untaggedSpend), color: data.summary.untaggedSpend > 0 ? 'var(--color-warning)' : 'var(--color-success)' },
              { label: 'Total Contracts', value: data.summary.totalContracts,     color: '#0d4f6e' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1fr' : '1fr', gap: 16 }}>
            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>GL Code</th>
                    <th style={{textAlign:'right'}}>Contracts</th>
                    <th style={{textAlign:'right'}}>Share %</th>
                    <th style={{minWidth:200}}>Total Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => (
                    <tr
                      key={r.glCode}
                      style={{ cursor: 'pointer', background: selected === r.glCode ? 'var(--color-bg-secondary)' : undefined }}
                      onClick={() => setSelected(selected === r.glCode ? null : r.glCode)}
                    >
                      <td style={{ fontWeight: 500 }}>
                        {r.glCode === '__untagged__'
                          ? <span style={{ color: 'var(--color-warning)', fontStyle: 'italic' }}>Untagged</span>
                          : r.glCode}
                      </td>
                      <td style={{ textAlign: 'right' }}>{r.contractCount}</td>
                      <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>{pct(r.sharePct)}</td>
                      <td style={{ minWidth: 200, paddingRight: 16 }}><SpendBar value={r.totalSpend} max={maxSpend} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {detail && (
              <div className="card" style={{ overflowX: 'auto' }}>
                <div style={{ padding: '16px 16px 8px', fontWeight: 600, fontSize: 'var(--font-size-data)', borderBottom: '1px solid var(--color-border)' }}>
                  {detail.glCode === '__untagged__' ? 'Untagged Contracts' : `GL ${detail.glCode}`} — {detail.contractCount} contracts
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Vendor</th><th>Product</th>
                      <th style={{textAlign:'right'}}>Annual Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.contracts.map(c => (
                      <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${c.id}`)}>
                        <td style={{ fontWeight: 500 }}>{c.vendorName}</td>
                        <td>{c.productName || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{fmt(c.totalValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);

function LoadBadge({ overloaded, renewalsIn90d }) {
  if (overloaded) return (
    <span style={{ background: '#fef2f2', color: '#dc2626', padding: '2px 8px', borderRadius: 99, fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>
      Overloaded ({renewalsIn90d} renewals)
    </span>
  );
  if (renewalsIn90d > 0) return (
    <span style={{ background: '#fffbeb', color: 'var(--color-warning)', padding: '2px 8px', borderRadius: 99, fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>
      {renewalsIn90d} renewing
    </span>
  );
  return <span style={{ background: '#f0fdf4', color: 'var(--color-success)', padding: '2px 8px', borderRadius: 99, fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>Clear</span>;
}

export default function ContractOwnershipReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [selected, setSelected] = useState(null);
  const [tab, setTab]         = useState('owners');

  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/contract-ownership');
      setData(res.data.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const detail = selected && data ? data.rows.find(r => (r.owner || '__unassigned__') === selected) : null;

  const handleCSV = async () => {
    setDownloading(true); setError(null);
    try {
      const res = await api.get('/api/reports/contract-ownership/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Contract_Ownership_${new Date().toISOString().split('T')[0]}.csv`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  };

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Contract Ownership Report</h1>
          <div className="page-subtitle">Active contracts by assigned owner — surfaces gaps, overload, and unassigned contracts before renewals slip</div>
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
              { label: 'Owners',          value: data.summary.ownerCount,      color: '#0d4f6e' },
              { label: 'Unassigned',      value: data.summary.unassignedCount, color: data.summary.unassignedCount > 0 ? '#dc2626' : 'var(--color-success)' },
              { label: 'Overloaded',      value: data.summary.overloadedCount, color: data.summary.overloadedCount > 0 ? '#dc2626' : 'var(--color-success)' },
              { label: 'Total Contracts', value: data.summary.totalContracts,  color: '#0d4f6e' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[['owners','By Owner'],['unassigned','Unassigned']].map(([id, label]) => (
              <button key={id} className={`btn ${tab === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab(id); setSelected(null); }}>{label}</button>
            ))}
          </div>

          {tab === 'owners' && (
            <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1fr' : '1fr', gap: 16 }}>
              <div className="card" style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Owner</th>
                      <th style={{textAlign:'right'}}>Contracts</th>
                      <th style={{textAlign:'right'}}>Total Value</th>
                      <th>90-Day Load</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.filter(r => r.owner).map(r => (
                      <tr
                        key={r.owner}
                        style={{ cursor: 'pointer', background: selected === r.owner ? 'var(--color-bg-secondary)' : undefined }}
                        onClick={() => setSelected(selected === r.owner ? null : r.owner)}
                      >
                        <td style={{ fontWeight: 500 }}>{r.owner}</td>
                        <td style={{ textAlign: 'right' }}>{r.contractCount}</td>
                        <td style={{ textAlign: 'right' }}>{fmt(r.totalValue)}</td>
                        <td><LoadBadge overloaded={r.overloaded} renewalsIn90d={r.renewalsIn90d} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.rows.filter(r => r.owner).length === 0 && (
                  <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>No owners assigned</div>
                )}
              </div>

              {detail && (
                <div className="card" style={{ overflowX: 'auto' }}>
                  <div style={{ padding: '16px 16px 8px', fontWeight: 600, fontSize: 'var(--font-size-data)', borderBottom: '1px solid var(--color-border)' }}>
                    {detail.owner}'s contracts ({detail.contractCount})
                  </div>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Vendor</th>
                        <th style={{textAlign:'right'}}>End Date</th>
                        <th style={{textAlign:'right'}}>Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.contracts.map(c => (
                        <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${c.id}`)}>
                          <td style={{ fontWeight: 500 }}>{c.vendorName}</td>
                          <td style={{ textAlign: 'right' }}>{c.endDate ? new Date(c.endDate).toLocaleDateString() : '—'}</td>
                          <td style={{ textAlign: 'right' }}>{fmt(c.totalValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === 'unassigned' && (
            <div className="card" style={{ overflowX: 'auto' }}>
              {data.unassignedContracts.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-success)', fontWeight: 600 }}>
                  All contracts have an assigned owner
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Vendor</th>
                      <th style={{textAlign:'right'}}>End Date</th>
                      <th style={{textAlign:'right'}}>Annual Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.unassignedContracts.map(c => (
                      <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${c.id}`)}>
                        <td style={{ fontWeight: 500 }}>{c.vendorName}</td>
                        <td style={{ textAlign: 'right' }}>{c.endDate ? new Date(c.endDate).toLocaleDateString() : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{fmt(c.totalValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

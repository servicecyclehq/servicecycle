import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt  = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

const ROI_COLOR = { high: 'var(--color-success)', medium: 'var(--color-warning)', low: '#6b7280' };
const ROI_BG    = { high: '#f0fdf4', medium: '#fffbeb', low: '#f9fafb' };

export default function LicenseReclamationRoiReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [filter, setFilter]   = useState('all');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/license-reclamation-roi');
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
      const res = await api.get('/api/reports/license-reclamation-roi/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'LapseIQ_License_Reclamation_ROI_' + new Date().toISOString().split('T')[0] + '.csv';
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  }

  const rows = data ? (filter === 'all' ? data.rows : data.rows.filter(r => r.roiTier === filter)) : [];

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">License Reclamation ROI</h1>
          <div className="page-subtitle">Per-contract value recoverable by cutting unused seats — ranked by annual reclamation opportunity</div>
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
              { label: 'Total Reclaimable',   value: fmt(data.summary.totalReclaimable), color: 'var(--color-success)' },
              { label: 'Contracts Scanned',   value: data.summary.contractCount,          color: '#0d4f6e' },
              { label: 'High ROI (>$10k)',    value: data.summary.highCount,              color: '#dc2626' },
              { label: 'Medium ROI ($2-10k)', value: data.summary.mediumCount,            color: 'var(--color-warning)' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[['all','All'],['high','High ROI'],['medium','Medium ROI'],['low','Low ROI']].map(([id, label]) => (
              <button key={id} className={`btn ${filter === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Vendor</th><th>Product</th><th>Department</th>
                  <th style={{textAlign:'right'}}>Licensed</th>
                  <th style={{textAlign:'right'}}>Active</th>
                  <th style={{textAlign:'right'}}>Wasted</th>
                  <th style={{textAlign:'right'}}>Utilisation</th>
                  <th style={{textAlign:'right'}}>Cost/Seat</th>
                  <th style={{textAlign:'right'}}>Reclaimable</th>
                  <th>ROI</th>
                  <th>Renewal</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{cursor:'pointer'}} onClick={() => navigate(`/contracts/${r.id}`)}>
                    <td>{r.vendorName}</td>
                    <td>{r.productName || '—'}</td>
                    <td>{r.department  || '—'}</td>
                    <td style={{textAlign:'right'}}>{r.seatsLicensed}</td>
                    <td style={{textAlign:'right'}}>{r.seatsActivelyInUse}</td>
                    <td style={{textAlign:'right', color:'#dc2626'}}>{r.wastedSeats}</td>
                    <td style={{textAlign:'right'}}>{r.utilizationPct}%</td>
                    <td style={{textAlign:'right'}}>{fmt(r.costPerSeat)}</td>
                    <td style={{textAlign:'right', fontWeight:600, color:'var(--color-success)'}}>{fmt(r.reclaimableValue)}</td>
                    <td>
                      <span style={{
                        background: ROI_BG[r.roiTier], color: ROI_COLOR[r.roiTier],
                        padding:'2px 8px', borderRadius:99, fontSize: 'var(--font-size-sm)', fontWeight:600, textTransform:'capitalize',
                      }}>{r.roiTier}</span>
                    </td>
                    <td>{fmtDate(r.endDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>No contracts in this tier</div>}
          </div>
        </>
      )}
    </div>
  );
}
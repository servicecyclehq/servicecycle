import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);

const VERDICT_COLOR = { renew: 'var(--color-success)', negotiate: 'var(--color-warning)', escalate: '#dc2626', review: '#9333ea' };
const VERDICT_BG    = { renew: '#f0fdf4', negotiate: '#fffbeb', escalate: '#fef2f2', review: '#faf5ff' };

function VerdictBadge({ verdict }) {
  if (!verdict) return <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>Not analysed</span>;

  return (
    <span style={{
      background: VERDICT_BG[verdict] || '#f3f4f6',
      color: VERDICT_COLOR[verdict] || '#374151',
      padding: '2px 8px', borderRadius: 99, fontSize: 'var(--font-size-sm)', fontWeight: 600, textTransform: 'capitalize',
    }}>{verdict}</span>
  );
}

function ScoreDot({ score }) {
  if (score == null) return <span style={{ color: 'var(--color-text-secondary)' }}>—</span>;
  const color = score >= 70 ? 'var(--color-success)' : score >= 40 ? 'var(--color-warning)' : '#dc2626';
  return <span style={{ color, fontWeight: 700 }}>{score}</span>;
}

export default function PortfolioDecisionDashboardReport() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [filter, setFilter]   = useState('all');

  const [downloading, setDownloading] = useState(false);
  const [pdfing, setPdfing]           = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/api/reports/portfolio-decision-dashboard');
      setData(res.data.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = data
    ? (filter === 'all' ? data.rows
      : filter === 'unanalysed' ? data.rows.filter(r => !r.aiAnalyzed)
      : data.rows.filter(r => r.aiVerdict === filter))
    : [];

  const handlePDF = async () => {
    setPdfing(true); setError(null);
    try {
      const res = await api.get('/api/reports/portfolio-decision-dashboard/pdf', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Portfolio_Decision_Dashboard_${new Date().toISOString().split('T')[0]}.pdf`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('PDF download failed.'); }
    finally { setPdfing(false); }
  };
  const handleCSV = async () => {
    setDownloading(true); setError(null);
    try {
      const res = await api.get('/api/reports/portfolio-decision-dashboard/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Portfolio_Decision_Dashboard_${new Date().toISOString().split('T')[0]}.csv`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  };

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Portfolio Decision Dashboard</h1>
          <div className="page-subtitle">All active contracts with AI negotiation verdicts — renew, negotiate, escalate, or review at a glance</div>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Total Contracts', value: data.summary.totalContracts,  color: '#0d4f6e' },
              { label: 'AI Analysed',     value: data.summary.analysedCount,   color: '#0d4f6e' },
              { label: 'Escalate',        value: data.summary.escalateCount,   color: '#dc2626' },
              { label: 'Negotiate',       value: data.summary.negotiateCount,  color: 'var(--color-warning)' },
              { label: 'Renew',           value: data.summary.renewCount,      color: 'var(--color-success)' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          {data.summary.analysedCount < data.summary.totalContracts && (
            <div className="alert" style={{ marginBottom: 16, background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 8, padding: '12px 16px', fontSize: 'var(--font-size-ui)' }}>
              {data.summary.totalContracts - data.summary.analysedCount} contract(s) not yet AI-analysed. Open each contract and run a debate to populate its verdict.
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[['all','All'],['escalate','Escalate'],['negotiate','Negotiate'],['renew','Renew'],['review','Review'],['unanalysed','Not Analysed']].map(([id, label]) => (
              <button key={id} className={`btn ${filter === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Vendor</th><th>Category</th><th>Owner</th>
                  <th style={{textAlign:'right'}}>End Date</th>
                  <th style={{textAlign:'right'}}>Annual Value</th>
                  <th style={{textAlign:'right'}}>AI Score</th>
                  <th>AI Verdict</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${r.id}`)}>
                    <td style={{ fontWeight: 500 }}>{r.vendorName}</td>
                    <td>{r.category || '—'}</td>
                    <td>{r.contractOwner || <span style={{ color: 'var(--color-warning)' }}>—</span>}</td>
                    <td style={{ textAlign: 'right' }}>
                      {r.endDate ? new Date(r.endDate).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.totalValue)}</td>
                    <td style={{ textAlign: 'right' }}><ScoreDot score={r.aiScore} /></td>
                    <td><VerdictBadge verdict={r.aiVerdict} /></td>
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

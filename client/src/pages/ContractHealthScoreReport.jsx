import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);

const GRADE_COLOR = { A: 'var(--color-success)', B: '#65a30d', C: 'var(--color-warning)', D: '#ea580c', F: '#dc2626' };
const GRADE_BG    = { A: '#f0fdf4', B: '#f7fee7', C: '#fffbeb', D: '#fff7ed', F: '#fef2f2' };

function ScoreBar({ score }) {
  const color = score >= 80 ? 'var(--color-success)' : score >= 60 ? 'var(--color-warning)' : '#dc2626';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, background: 'var(--color-bg-secondary)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, background: color, height: '100%', borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color, minWidth: 28, textAlign: 'right' }}>{score}</span>
    </div>
  );
}

function CheckDot({ ok }) {
  return (
    <span style={{
      display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
      background: ok ? 'var(--color-success)' : '#dc2626', marginRight: 4,
    }} />
  );
}

export default function ContractHealthScoreReport() {
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
      const res = await api.get('/api/reports/contract-health-score');
      setData(res.data.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = data
    ? (filter === 'all' ? data.rows : data.rows.filter(r => r.grade === filter))
    : [];

  const handlePDF = async () => {
    setPdfing(true); setError(null);
    try {
      const res = await api.get('/api/reports/contract-health-score/pdf', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Contract_Health_Score_${new Date().toISOString().split('T')[0]}.pdf`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('PDF download failed.'); }
    finally { setPdfing(false); }
  };
  const handleCSV = async () => {
    setDownloading(true); setError(null);
    try {
      const res = await api.get('/api/reports/contract-health-score/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `LapseIQ_Contract_Health_Score_${new Date().toISOString().split('T')[0]}.csv`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  };

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Contract Health Score</h1>
          <div className="page-subtitle">Every active contract scored 0–100 across four data-quality dimensions — find the gaps before they become problems</div>
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
              { label: 'Contracts Scored', value: data.summary.totalContracts,            color: '#0d4f6e' },
              { label: 'Portfolio Score',  value: `${data.summary.portfolioAvgScore}/100`, color: data.summary.portfolioAvgScore >= 80 ? 'var(--color-success)' : 'var(--color-warning)' },
              { label: 'Perfect (A)',      value: data.summary.perfectCount,               color: 'var(--color-success)' },
              { label: 'At-Risk (D/F)',    value: data.summary.atRiskCount,                color: '#dc2626' },
            ].map(k => (
              <div key={k.label} className="card" style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 16, padding: 16, background: 'var(--color-bg-secondary)', borderRadius: 8, fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
            <strong>Scoring criteria (25 pts each):</strong> Required fields (vendor, end date, value, category) · Owner assigned · Auto-renews flag set · Cancellation deadline set when auto-renews is on
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[['all','All'],['A','A'],['B','B'],['C','C'],['D','D'],['F','F']].map(([id, label]) => (
              <button key={id} className={`btn ${filter === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Vendor</th><th>Category</th><th>Owner</th>
                  <th style={{textAlign:'center'}}>Fields</th>
                  <th style={{textAlign:'center'}}>Owner</th>
                  <th style={{textAlign:'center'}}>AutoRenew</th>
                  <th style={{textAlign:'center'}}>Deadline</th>
                  <th style={{minWidth:160}}>Score</th>
                  <th>Grade</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${r.id}`)}>
                    <td style={{ fontWeight: 500 }}>{r.vendorName}</td>
                    <td>{r.category || '—'}</td>
                    <td>{r.contractOwner || <span style={{ color: '#dc2626' }}>Unassigned</span>}</td>
                    <td style={{ textAlign: 'center' }}><CheckDot ok={r.checks.requiredFields} /></td>
                    <td style={{ textAlign: 'center' }}><CheckDot ok={r.checks.ownerAssigned} /></td>
                    <td style={{ textAlign: 'center' }}><CheckDot ok={r.checks.autoRenewSet} /></td>
                    <td style={{ textAlign: 'center' }}><CheckDot ok={r.checks.deadlineSet} /></td>
                    <td style={{ minWidth: 160, paddingRight: 16 }}><ScoreBar score={r.score} /></td>
                    <td>
                      <span style={{
                        background: GRADE_BG[r.grade] || '#f3f4f6',
                        color: GRADE_COLOR[r.grade] || '#374151',
                        padding: '2px 10px', borderRadius: 99, fontSize: 'var(--font-size-ui)', fontWeight: 700,
                      }}>{r.grade}</span>
                    </td>
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

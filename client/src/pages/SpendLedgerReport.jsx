import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function deltaColor(n) {
  if (n == null || n === 0) return 'var(--color-text-secondary)';
  return n > 0 ? 'var(--color-danger)' : 'var(--color-success)';
}

function SummaryCard({ label, value, subtitle, color }) {
  return (
    <div className="card" style={{ padding: '14px 18px', flex: 1, minWidth: 150 }}>
      <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: color || 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </div>
      {subtitle && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{subtitle}</div>}
    </div>
  );
}

function SpendTable({ rows, nameKey, nameHeader, currentLabel, priorLabel }) {
  if (!rows || !rows.length) {
    return <div className="empty-state"><div className="empty-state-title">No data</div></div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ maxWidth: 200 }}>{nameHeader}</th>
            <th style={{ textAlign: 'right' }}>Contracts</th>
            <th style={{ textAlign: 'right' }}>{currentLabel}</th>
            {priorLabel && <th style={{ textAlign: 'right' }}>{priorLabel}</th>}
            {priorLabel && <th style={{ textAlign: 'right' }}>Δ $</th>}
            {priorLabel && <th style={{ textAlign: 'right' }}>Δ %</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r[nameKey] || r.categoryName || i}>
              <td style={{ fontWeight: 600, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r[nameKey] || r.categoryName || '—'}</td>
              <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>
                {r.contractCount ?? r.poCount ?? '—'}
              </td>
              <td style={{ textAlign: 'right', fontWeight: 600 }}>
                {fmtMoney(r.current ?? r.spend)}
              </td>
              {priorLabel && <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>{fmtMoney(r.prior)}</td>}
              {priorLabel && (
                <td style={{ textAlign: 'right', color: deltaColor(r.delta), fontWeight: 600 }}>
                  {fmtMoney(r.delta)}
                </td>
              )}
              {priorLabel && (
                <td style={{ textAlign: 'right', color: deltaColor(r.delta) }}>
                  {fmtPct(r.percent)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SpendLedgerReport() {
  const [mode, setMode]       = useState('commitments');
  const [fyOffset, setFyOffset] = useState(0);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta]       = useState(null); // v0.90.5: fix ReferenceError - missing state declaration
  const [error, setError]     = useState('');
  const [downloading, setDownloading] = useState(false);
  const [pdfing, setPdfing]           = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get('/api/reports/spend-ledger', { params: { mode, fyOffset } });
      setData(res.data.data); setMeta(res.data.meta ?? null);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load report.');
    } finally {
      setLoading(false);
    }
  }, [mode, fyOffset]);

  useEffect(() => { load(); }, [load]);

  async function handlePDF() {
    setPdfing(true);
    try {
      const res = await api.get('/api/reports/spend-ledger/pdf', { params: { mode, fyOffset }, responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `LapseIQ_Spend_Ledger_${mode}_${new Date().toISOString().split('T')[0]}.pdf`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('PDF download failed.'); }
    finally { setPdfing(false); }
  }

  async function handleCSV() {
    setDownloading(true);
    try {
      const res = await api.get('/api/reports/spend-ledger/csv', { params: { mode, fyOffset }, responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `LapseIQ_Spend_Ledger_${mode}_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  }

  // Category chart — top 8 by current spend
  const categoryChart = (data?.byCategory || []).slice(0, 8).map(r => ({
    name: r.categoryName || r.vendorName || 'Other',
    current: Math.round(r.current ?? r.spend ?? 0),
    prior: r.prior != null ? Math.round(r.prior) : undefined,
  }));

  const isCommitments = data?.mode === 'commitments';

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Spend Ledger</h1>
          <div className="page-subtitle">
            {data
              ? `${data.fyLabel}${isCommitments ? ` commitments` : ` actuals (POs)`} · ${fmtMoney(data.totalSpend)} · ${data.companyName}`
              : 'Portfolio spend by vendor, category, and department'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Mode toggle */}
          <div style={{ display: 'flex', border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden' }}>
            {(['commitments', 'actuals']).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  padding: '5px 12px', fontSize: 'var(--font-size-sm)', border: 'none', cursor: 'pointer',
                  background: mode === m ? 'var(--color-primary)' : 'var(--color-surface)',
                  color: mode === m ? '#fff' : 'var(--color-text)',
                  fontWeight: mode === m ? 600 : 400,
                  transition: 'background 0.1s',
                  textTransform: 'capitalize',
                }}
              >
                {m}
              </button>
            ))}
          </div>
          <select
            aria-label="Fiscal year"
            value={fyOffset}
            onChange={e => setFyOffset(Number(e.target.value))}
            style={{ fontSize: 'var(--font-size-ui)', padding: '5px 10px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
          >
            <option value={0}>Current FY</option>
            <option value={-1}>Prior FY</option>
            <option value={-2}>2 years ago</option>
          </select>
          <button className="btn" onClick={handlePDF} disabled={loading || pdfing || !data}>
            {pdfing ? 'Generating…' : '↓ PDF'}
          </button>
          <button className="btn" onClick={handleCSV} disabled={loading || downloading || !data}>
            {downloading ? 'Exporting…' : '↓ CSV'}
          </button>
        </div>
      </div>

      <div className="page-body">
        <TruncationBanner meta={meta} />
            <ReportAiNarrative reportId="spend-ledger" params={{ mode, fyOffset }} paramsKey={mode + ":" + fyOffset} />
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

        {/* Commitments vs actuals explainer */}
        {!loading && (
          <div style={{
            marginBottom: 16, padding: '10px 14px', borderRadius: 6, fontSize: 'var(--font-size-sm)',
            background: 'rgba(13,79,110,0.06)', border: '1px solid rgba(13,79,110,0.2)',
            color: 'var(--color-text)',
          }}>
            {mode === 'commitments'
              ? <><strong>Commitments view:</strong> Uses the final negotiated price on each contract — what you agreed to pay, normalized to full annual cost. For co-term programs (MPSA, Adobe VIP), this reflects the renewal-basis cost, not the prorated Year 1 actuals.</>
              : <><strong>Actuals view:</strong> Sums purchase order amounts within the selected period — what was actually invoiced. For co-term programs, Year 1 actuals may be lower than the renewal cost due to proration of mid-year additions.</>
            }
          </div>
        )}

        {loading && <div className="loading">Building spend ledger…</div>}

        {data && !loading && (
          <>
            {/* Summary cards */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
              <SummaryCard
                label={`${data.fyLabel} Spend`}
                value={fmtMoney(data.totalSpend)}
                subtitle={isCommitments ? `${data.contractCount ?? ''} contracts` : `${data.totalPOs ?? ''} POs`}
              />
              {isCommitments && data.priorSpend != null && (
                <SummaryCard label={`${data.priorFYLabel} Spend`} value={fmtMoney(data.priorSpend)} subtitle="Prior FY" />
              )}
              {isCommitments && data.yoy && (
                <SummaryCard
                  label="YoY Change"
                  value={fmtMoney(data.yoy.absolute)}
                  subtitle={fmtPct(data.yoy.percent)}
                  color={deltaColor(data.yoy.absolute)}
                />
              )}
            </div>

            {/* Category chart */}
            {categoryChart.length > 0 && (
              <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
                <h3 style={{ margin: '0 0 14px', fontSize: 'var(--font-size-data)', fontWeight: 700 }}>Spend by category</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={categoryChart} margin={{ bottom: 28 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 'var(--font-size-xs)', fill: 'var(--color-text)' }} interval={0} angle={-30} textAnchor="end" />
                    <YAxis tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 'var(--font-size-xs)', fill: 'var(--color-text)' }} />
                    <Tooltip formatter={v => [new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v)]} />
                    <Bar dataKey="current" name={data.fyLabel} fill="#0d4f6e" radius={[3, 3, 0, 0]} />
                    {categoryChart[0]?.prior != null && (
                      <Bar dataKey="prior" name={data.priorFYLabel} fill="#94a3b8" radius={[3, 3, 0, 0]} />
                    )}
                  </BarChart>
                </ResponsiveContainer>
                {/* Legend — always shown so users know which bar is which */}
                <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 10, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ display: 'inline-block', width: 12, height: 12, background: '#0d4f6e', borderRadius: 2, flexShrink: 0 }} />
                    {data.fyLabel}
                  </span>
                  {categoryChart[0]?.prior != null && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ display: 'inline-block', width: 12, height: 12, background: '#94a3b8', borderRadius: 2, flexShrink: 0 }} />
                      {data.priorFYLabel}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* By vendor */}
            <div className="card" style={{ marginBottom: 16, overflow: 'hidden' }}>
              <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <h3 style={{ margin: 0, fontSize: 'var(--font-size-data)', fontWeight: 700 }}>By vendor</h3>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{(data.byVendor || []).length} vendors</span>
              </div>
              <SpendTable rows={data.byVendor || []} nameKey="vendorName" nameHeader="Vendor" currentLabel={data.fyLabel} priorLabel={isCommitments ? data.priorFYLabel : null} />
            </div>

            {/* By category */}
            <div className="card" style={{ marginBottom: 16, overflow: 'hidden' }}>
              <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <h3 style={{ margin: 0, fontSize: 'var(--font-size-data)', fontWeight: 700 }}>By category</h3>
              </div>
              <SpendTable rows={data.byCategory || []} nameKey="categoryName" nameHeader="Category" currentLabel={data.fyLabel} priorLabel={isCommitments ? data.priorFYLabel : null} />
            </div>

            {/* By department */}
            <div className="card" style={{ overflow: 'hidden' }}>
              <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <h3 style={{ margin: 0, fontSize: 'var(--font-size-data)', fontWeight: 700 }}>By department</h3>
              </div>
              <SpendTable rows={data.byDepartment || []} nameKey="department" nameHeader="Department" currentLabel={data.fyLabel} priorLabel={isCommitments ? data.priorFYLabel : null} />
            </div>

            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textAlign: 'right', marginTop: 8 }}>
              Generated {fmtDate(data.generatedAt)}{data.generatedBy ? ` · by ${data.generatedBy}` : ''}
            </div>
          </>
        )}
      </div>
    </>
  );
}

import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
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

function SummaryCard({ label, value, subtitle, color }) {
  return (
    <div className="card" style={{ padding: '14px 18px', flex: 1, minWidth: 160 }}>
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

// Build a 4-FY picker plus "All time"
function useFYOptions() {
  const now = new Date();
  const year = now.getFullYear();
  return [
    { label: 'All time',      dateFrom: null, dateTo: null },
    { label: `FY${year}`,     dateFrom: `${year}-01-01`, dateTo: `${year + 1}-01-01` },
    { label: `FY${year - 1}`, dateFrom: `${year - 1}-01-01`, dateTo: `${year}-01-01` },
    { label: `FY${year - 2}`, dateFrom: `${year - 2}-01-01`, dateTo: `${year - 1}-01-01` },
  ];
}

export default function SavingsLedgerReport() {
  const fyOptions = useFYOptions();
  const [fyIdx, setFyIdx]         = useState(0);
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(false);
  const [meta, setMeta]       = useState(null); // v0.90.5: fix ReferenceError - missing state declaration
  const [error, setError]         = useState('');
  const [downloading, setDownloading] = useState(false);
  const [pdfing, setPdfing]           = useState(false);
  const [activeTab, setActiveTab]     = useState('ledger');
  const [attrData, setAttrData]       = useState(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const opt = fyOptions[fyIdx];
    try {
      const params = {};
      if (opt.dateFrom) params.dateFrom = opt.dateFrom;
      if (opt.dateTo)   params.dateTo   = opt.dateTo;
      const res = await api.get('/api/reports/savings-ledger', { params });
      setData(res.data.data); setMeta(res.data.meta ?? null);
      const attrRes = await api.get('/api/reports/savings-attribution', { params });
      setAttrData(attrRes.data.data);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load report.');
    } finally {
      setLoading(false);
    }
  }, [fyIdx]);

  useEffect(() => { load(); }, [load]);

  async function handlePDF() {
    setPdfing(true);
    const opt = fyOptions[fyIdx];
    const params = {};
    if (opt.dateFrom) params.dateFrom = opt.dateFrom;
    if (opt.dateTo)   params.dateTo   = opt.dateTo;
    try {
      const res = await api.get('/api/reports/savings-ledger/pdf', { params, responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `LapseIQ_Savings_Ledger_${new Date().toISOString().split('T')[0]}.pdf`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('PDF download failed.'); }
    finally { setPdfing(false); }
  }

  async function handleCSV() {
    setDownloading(true);
    const opt = fyOptions[fyIdx];
    const params = {};
    if (opt.dateFrom) params.dateFrom = opt.dateFrom;
    if (opt.dateTo)   params.dateTo   = opt.dateTo;
    try {
      const res = await api.get('/api/reports/savings-ledger/csv', { params, responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `LapseIQ_Savings_Ledger_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  }

  const chartData = data?.byCategory?.slice(0, 8).map((c, i) => ({
    name: c.categoryName,
    savings: Math.round(c.savings),
    // v0.38.1: brand-petrol (#0d4f6e) swapped in for slot 1 to align
    // with the brand-blue consolidation pass; rest of the palette stays
    // multi-color (intentional chart-slice rotation, not brand surface).
    fill: ['var(--color-success)','#0d4f6e','var(--color-renewal-text)','var(--color-warning)','#dc2626','#0891b2','#c026d3','#64748b'][i % 8],
  })) || [];

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Savings Ledger</h1>
          <div className="page-subtitle">
            {data
              ? `${data.totalContracts} negotiated contract${data.totalContracts === 1 ? '' : 's'} · ${fmtMoney(data.totalSavings)} total savings · ${data.companyName}`
              : 'Negotiated savings across the portfolio'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            aria-label="Fiscal year"
            value={fyIdx}
            onChange={e => setFyIdx(Number(e.target.value))}
            style={{ fontSize: 'var(--font-size-ui)', padding: '5px 10px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
          >
            {fyOptions.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
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
            <ReportAiNarrative reportId="savings-ledger" params={{ dateFrom: fyOptions[fyIdx]?.dateFrom, dateTo: fyOptions[fyIdx]?.dateTo }} paramsKey={String(fyIdx)} />
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
        {loading && <div className="loading">Building savings ledger…</div>}

        {data && !loading && (
          <>
            {/* Summary cards */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
              <SummaryCard label="Total Savings" value={fmtMoney(data.totalSavings)} subtitle={`${data.totalContracts} contract${data.totalContracts === 1 ? '' : 's'}`} color="var(--color-success)" />
              <SummaryCard label="Total Ask"       value={fmtMoney(data.totalAsk)}       subtitle="Vendor initial quotes" />
              <SummaryCard label="Total Negotiated" value={fmtMoney(data.totalNegotiated)} subtitle="What was agreed" />
              <SummaryCard label="Blended Rate"    value={fmtPct(data.blendedSavingsPct)}  subtitle="Avg savings %" color={data.blendedSavingsPct > 0 ? 'var(--color-success)' : undefined} />
            </div>

            {/* Savings by category chart */}
            {chartData.length > 0 && (
              <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
                <h3 style={{ margin: '0 0 14px', fontSize: 'var(--font-size-data)', fontWeight: 700 }}>Savings by category</h3>
                <ResponsiveContainer width="100%" height={Math.max(80, chartData.length * 36)}>
                  <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 60 }}>
                    <XAxis type="number" tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 'var(--font-size-xs)', fill: 'var(--color-text)' }} />
                    <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 'var(--font-size-sm)', fill: 'var(--color-text)' }} />
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <Tooltip formatter={v => [new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v), 'Savings']} />
                    <Bar dataKey="savings" radius={[0, 3, 3, 0]}>
                      {chartData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Line-by-line ledger */}
            <div className="card" style={{ overflow: 'hidden' }}>
              <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <h3 style={{ margin: 0, fontSize: 'var(--font-size-data)', fontWeight: 700 }}>Contract ledger</h3>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{data.rows.length} records</span>
              </div>
              {data.rows.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-title">No savings data for this period</div>
                  <div className="empty-state-body">Enter original ask and final negotiated price on contracts to track savings.</div>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Vendor</th>
                        <th>Product</th>
                        <th>Category</th>
                        <th style={{ textAlign: 'right' }}>Original Ask</th>
                        <th style={{ textAlign: 'right' }}>Final Price</th>
                        <th style={{ textAlign: 'right' }}>Savings $</th>
                        <th style={{ textAlign: 'right' }}>Savings %</th>
                        <th>Owner</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map(r => (
                        <tr key={r.id} onClick={() => navigate(`/contracts/${r.id}`)} style={{ cursor: 'pointer' }} className="hover-row">
                          <td style={{ fontWeight: 600 }}>{r.vendorName || '—'}</td>
                          <td>{r.product || '—'}</td>
                          <td style={{ color: 'var(--color-text-secondary)' }}>{r.categoryName || '—'}</td>
                          <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>{fmtMoney(r.originalAsk)}</td>
                          <td style={{ textAlign: 'right' }}>{fmtMoney(r.finalNegotiatedPrice)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: r.savings > 0 ? 'var(--color-success)' : r.savings < 0 ? '#dc2626' : undefined }}>
                            {fmtMoney(r.savings)}
                          </td>
                          <td style={{ textAlign: 'right', color: r.savingsPct > 0 ? 'var(--color-success)' : r.savingsPct < 0 ? '#dc2626' : undefined }}>
                            {r.savingsPct != null ? `${r.savingsPct.toFixed(1)}%` : '—'}
                          </td>
                          <td style={{ color: 'var(--color-text-secondary)' }}>{r.ownerDisplay || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Tab bar */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 12, borderBottom: '1px solid var(--color-border)', paddingBottom: 0 }}>
              {[['ledger','Contract Ledger'],['by_lever','By Lever']].map(([id,label]) => (
                <button key={id} onClick={() => setActiveTab(id)} style={{
                  padding: '6px 14px', fontSize: 'var(--font-size-ui)', fontWeight: activeTab === id ? 600 : 400,
                  background: 'transparent', border: 'none', borderBottom: activeTab === id ? '2px solid var(--color-primary)' : '2px solid transparent',
                  cursor: 'pointer', color: activeTab === id ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                }}>{label}</button>
              ))}
            </div>

            {/* By Lever tab */}
            {activeTab === 'by_lever' && attrData && (
              <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
                <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <h3 style={{ margin: 0, fontSize: 'var(--font-size-data)', fontWeight: 700 }}>Savings by lever</h3>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                    {attrData.taggedCount} of {attrData.totalContracts} contracts tagged · {attrData.untaggedCount} untagged
                  </span>
                </div>
                {attrData.byLever.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state-title">No levers tagged yet</div>
                    <div className="empty-state-body">Edit a negotiated contract and select "What drove the saving?" to start building your playbook.</div>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Lever</th>
                          <th style={{ textAlign: 'right' }}>Deals</th>
                          <th style={{ textAlign: 'right' }}>Total Savings</th>
                          <th style={{ textAlign: 'right' }}>Avg Savings %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attrData.byLever.map(b => (
                          <tr key={b.lever}>
                            <td style={{ fontWeight: 600 }}>{b.leverLabel}</td>
                            <td style={{ textAlign: 'right' }}>{b.count}</td>
                            <td style={{ textAlign: 'right', color: 'var(--color-success)', fontWeight: 600 }}>{fmtMoney(b.totalSavings)}</td>
                            <td style={{ textAlign: 'right' }}>{b.avgSavingsPct != null ? `${b.avgSavingsPct.toFixed(1)}%` : '—'}</td>
                          </tr>
                        ))}
                        {attrData.untaggedCount > 0 && (
                          <tr style={{ color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
                            <td>Untagged</td>
                            <td style={{ textAlign: 'right' }}>{attrData.untaggedCount}</td>
                            <td style={{ textAlign: 'right' }}>{fmtMoney(attrData.untaggedSavings)}</td>
                            <td style={{ textAlign: 'right' }}>—</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textAlign: 'right', marginTop: 8 }}>
              Generated {fmtDate(data.generatedAt)}{data.generatedBy ? ` · by ${data.generatedBy}` : ''}
            </div>
          </>
        )}
      </div>
    </>
  );
}

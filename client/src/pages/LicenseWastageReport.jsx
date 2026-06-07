import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect } from 'react';
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
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function dataAgeColor(dataAge) {
  if (!dataAge) return '#64748b';
  const days = (Date.now() - new Date(dataAge).getTime()) / 86400000;
  if (days <= 30)  return 'var(--color-success)';
  if (days <= 90)  return 'var(--color-warning)';
  return '#dc2626';
}
function dataAgeLabel(dataAge) {
  if (!dataAge) return 'Unknown';
  const days = Math.round((Date.now() - new Date(dataAge).getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return '1 day ago';
  if (days < 30)  return `${days} days ago`;
  if (days < 60)  return '~1 month ago';
  return `${Math.round(days / 30)} months ago`;
}

function utilizationColor(pct) {
  if (pct >= 80) return 'var(--color-success)';
  if (pct >= 50) return 'var(--color-warning)';
  return '#dc2626';
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

export default function LicenseWastageReport() {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [meta, setMeta]       = useState(null); // v0.90.5: fix ReferenceError - missing state declaration
  const [error, setError]       = useState('');
  const [downloading, setDownloading] = useState(false);
  const [pdfing, setPdfing]           = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError('');
      try {
        const res = await api.get('/api/reports/license-wastage');
        if (!cancelled) { setData(res.data.data); setMeta(res.data.meta ?? null); }
      } catch (err) {
        if (!cancelled) setError(err?.response?.data?.error || 'Failed to load report.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function handlePDF() {
    setPdfing(true);
    try {
      const res = await api.get('/api/reports/license-wastage/pdf', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `LapseIQ_License_Wastage_${new Date().toISOString().split('T')[0]}.pdf`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('PDF download failed.'); }
    finally { setPdfing(false); }
  }

  async function handleCSV() {
    setDownloading(true);
    try {
      const res = await api.get('/api/reports/license-wastage/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `LapseIQ_License_Wastage_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  }

  // v0.60 Dollarized: chart by $-waste-by-vendor (top 10) so the worst
  // offenders stand out by bar height instead of by colour.
  const chartData = data?.byVendor?.slice(0, 10).map(v => ({
    name: (v.vendorName || 'Unknown').slice(0, 28),
    wasteValue: Math.round(v.wasteValue || 0),
    fill: v.wasteValue > 0 ? '#dc2626' : '#94a3b8',
  })) || [];

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">License Wastage</h1>
          <div className="page-subtitle">
            {data
              ? `${data.coverageCount} of ${data.totalActiveContracts} active contracts have utilization data · ${data.companyName}`
              : 'Seat utilization and estimated waste value'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
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
            <ReportAiNarrative reportId="license-wastage" params={{}} paramsKey={"_static"} />
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
        {loading && <div className="loading">Calculating wastage…</div>}

        {data && !loading && (
          <>
            {/* Data quality notice */}
            <div style={{
              marginBottom: 16, padding: '10px 14px',
              background: 'rgba(13,79,110,0.07)', border: '1px solid rgba(13,79,110,0.25)',
              borderRadius: 6, fontSize: 'var(--font-size-sm)', color: 'var(--color-text)',
            }}>
              <strong>Manual data:</strong> Utilization figures are entered by your team — not scanned automatically.
              The report flags data age per row. Update seat counts in Contract Detail before using this for negotiation.
              {data.totalActiveContracts > data.coverageCount && (
                <span style={{ color: 'var(--color-warning)', marginLeft: 8 }}>
                  {data.totalActiveContracts - data.coverageCount} active contract{data.totalActiveContracts - data.coverageCount === 1 ? '' : 's'} missing utilization data.
                </span>
              )}
            </div>

            {/* Summary cards */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
              <SummaryCard
                label="Est. Annual Waste"
                value={fmtMoney(data.totalEstimatedWaste)}
                subtitle="Based on entered seat data"
                color={data.totalEstimatedWaste > 0 ? '#dc2626' : undefined}
              />
              <SummaryCard
                label="Biggest Waste Vendor"
                value={data.biggestWasteVendor ? fmtMoney(data.biggestWasteVendor.wasteValue) : '-'}
                subtitle={data.biggestWasteVendor ? data.biggestWasteVendor.vendorName : 'No vendor flagged'}
                color={data.biggestWasteVendor ? '#dc2626' : undefined}
              />
              <SummaryCard
                label="Avg Utilization"
                value={data.avgUtilization != null ? `${data.avgUtilization.toFixed(0)}%` : '—'}
                subtitle="Across contracts with data"
                color={data.avgUtilization != null ? utilizationColor(data.avgUtilization) : undefined}
              />
              <SummaryCard
                label="Coverage"
                value={`${data.coverageCount} / ${data.totalActiveContracts}`}
                subtitle="Contracts with utilization data"
              />
            </div>

            {/* Utilization chart */}
            {chartData.length > 0 && (
              <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
                <h3 style={{ margin: '0 0 4px', fontSize: 'var(--font-size-data)', fontWeight: 700 }}>Top 10 vendors by estimated annual waste</h3>
                <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', margin: '0 0 14px' }}>
                  Bars sized by $ wasted across each vendor. Click a row in the table below for the per-contract breakdown.
                </p>
                <ResponsiveContainer width="100%" height={Math.max(80, chartData.length * 38)}>
                  <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 50 }}>
                    <XAxis type="number" domain={[0, 'dataMax']} tickFormatter={v => v >= 1000 ? `${Math.round(v/1000)}K` : `${v}`} tick={{ fontSize: 'var(--font-size-xs)', fill: 'var(--color-text)' }} />
                    <YAxis type="category" dataKey="name" width={190} tick={{ fontSize: 'var(--font-size-xs)', fill: 'var(--color-text)' }} />
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <Tooltip formatter={v => [fmtMoney(v), 'Est. Waste']} />
                    <Bar dataKey="wasteValue" radius={[0, 3, 3, 0]}>
                      {chartData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* v0.60 Dollarized: vendor + category rollup tables so the eye lands on
                the worst-offender vendor or category before scanning per-contract rows. */}
            {data.byVendor?.length > 0 && (
              <div className="card" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <h3 style={{ margin: 0, fontSize: 'var(--font-size-data)', fontWeight: 700 }}>Top vendors by waste</h3>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>summed across each vendor's contracts</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Vendor</th>
                        <th style={{ textAlign: 'right' }}>Contracts</th>
                        <th style={{ textAlign: 'right' }}>Waste Seats</th>
                        <th style={{ textAlign: 'right' }}>Annual Value</th>
                        <th style={{ textAlign: 'right' }}>Est. Waste</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byVendor.slice(0, 10).map(v => (
                        <tr key={v.vendorId || v.vendorName} style={{ cursor: v.vendorId ? 'pointer' : 'default' }}
                            onClick={() => v.vendorId && navigate(`/vendors/${v.vendorId}`)}
                            className="hover-row">
                          <td style={{ fontWeight: 600 }}>{v.vendorName}</td>
                          <td style={{ textAlign: 'right' }}>{v.contractCount}</td>
                          <td style={{ textAlign: 'right', color: v.wasteSeats > 0 ? '#dc2626' : 'var(--color-text-secondary)' }}>{v.wasteSeats}</td>
                          <td style={{ textAlign: 'right' }}>{fmtMoney(v.annualValue)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: v.wasteValue > 0 ? '#dc2626' : undefined }}>{fmtMoney(v.wasteValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {data.byCategory?.length > 0 && (
              <div className="card" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <h3 style={{ margin: 0, fontSize: 'var(--font-size-data)', fontWeight: 700 }}>By category</h3>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{data.byCategory.length} categor{data.byCategory.length === 1 ? 'y' : 'ies'} with utilization data</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Category</th>
                        <th style={{ textAlign: 'right' }}>Vendors</th>
                        <th style={{ textAlign: 'right' }}>Contracts</th>
                        <th style={{ textAlign: 'right' }}>Annual Value</th>
                        <th style={{ textAlign: 'right' }}>Est. Waste</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byCategory.map(cat => (
                        <tr key={cat.categoryId || cat.categoryName}>
                          <td style={{ fontWeight: 600 }}>{cat.categoryName}</td>
                          <td style={{ textAlign: 'right' }}>{cat.vendorCount}</td>
                          <td style={{ textAlign: 'right' }}>{cat.contractCount}</td>
                          <td style={{ textAlign: 'right' }}>{fmtMoney(cat.annualValue)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: cat.wasteValue > 0 ? '#dc2626' : undefined }}>{fmtMoney(cat.wasteValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Detail table */}
            <div className="card" style={{ overflow: 'hidden' }}>
              <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <h3 style={{ margin: 0, fontSize: 'var(--font-size-data)', fontWeight: 700 }}>Wastage detail</h3>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>sorted by estimated waste value</span>
              </div>
              {data.rows.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-title">No utilization data entered</div>
                  <div className="empty-state-body">Add seats licensed and seats in use on active contracts to see this report.</div>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Vendor</th>
                        <th>Product</th>
                        <th style={{ textAlign: 'right' }}>Licensed</th>
                        <th style={{ textAlign: 'right' }}>In Use</th>
                        <th style={{ textAlign: 'right' }}>Utilization</th>
                        <th style={{ textAlign: 'right' }}>Waste Seats</th>
                        <th style={{ textAlign: 'right' }}>Annual Value</th>
                        <th style={{ textAlign: 'right' }}>Est. Waste</th>
                        <th style={{ textAlign: 'right' }}>Data Age</th>
                        <th>Owner</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map(r => (
                        <tr key={r.id} onClick={() => navigate(`/contracts/${r.id}`)} style={{ cursor: 'pointer' }} className="hover-row">
                          <td style={{ fontWeight: 600 }}>{r.vendorName || '—'}</td>
                          <td>{r.product || '—'}</td>
                          <td style={{ textAlign: 'right' }}>{r.seatsLicensed}</td>
                          <td style={{ textAlign: 'right' }}>{r.seatsActivelyInUse}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: utilizationColor(r.utilizationPct) }}>
                            {r.utilizationPct.toFixed(0)}%
                          </td>
                          <td style={{ textAlign: 'right', color: r.wasteSeats > 0 ? '#dc2626' : 'var(--color-text-secondary)' }}>
                            {r.wasteSeats}
                          </td>
                          <td style={{ textAlign: 'right' }}>{fmtMoney(r.annualValue)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: r.estimatedWasteValue > 0 ? '#dc2626' : undefined }}>
                            {fmtMoney(r.estimatedWasteValue)}
                          </td>
                          <td style={{ textAlign: 'right', fontSize: 'var(--font-size-xs)' }}>
                            <span style={{ color: dataAgeColor(r.dataAge) }} title={fmtDate(r.dataAge)}>
                              {dataAgeLabel(r.dataAge)}
                            </span>
                          </td>
                          <td style={{ color: 'var(--color-text-secondary)' }}>{r.ownerDisplay || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
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

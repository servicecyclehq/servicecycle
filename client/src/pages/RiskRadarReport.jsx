import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';

function fmtMoney(n) {
  if (n == null || isNaN(n) || n === 0) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function IssueCountCard({ label, count, color, bg, border, description }) {
  return (
    <div className="card" style={{ padding: '16px 20px', flex: 1, minWidth: 180, borderTop: `3px solid ${color}` }}>
      <div style={{ fontSize: 'var(--font-size-hero)', fontWeight: 700, color: count > 0 ? color : 'var(--color-text-secondary)' }}>
        {count}
      </div>
      <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, color: count > 0 ? color : 'var(--color-text)', marginTop: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
        {description}
      </div>
    </div>
  );
}

function ContractTable({ rows, extraColumns }) {
  const navigate = useNavigate();
  if (!rows.length) return (
    <div className="empty-state"><div className="empty-state-title">No issues in this category</div></div>
  );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Product</th>
            <th>Category</th>
            {extraColumns.map(c => (
              <th key={c.key} style={{ textAlign: c.align || 'left' }}>{c.header}</th>
            ))}
            <th style={{ textAlign: 'right' }}>Value</th>
            <th>Owner</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(c => (
            <tr key={c.id} onClick={() => navigate(`/contracts/${c.id}`)} style={{ cursor: 'pointer' }} className="hover-row">
              <td style={{ fontWeight: 600 }}>{c.vendorName || '—'}</td>
              <td>{c.product || '—'}</td>
              <td style={{ color: 'var(--color-text-secondary)' }}>{c.categoryName || '—'}</td>
              {extraColumns.map(col => (
                <td key={col.key} style={{ textAlign: col.align || 'left', color: col.color || undefined }}>
                  {col.render(c)}
                </td>
              ))}
              <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtMoney(c.renewalValue)}</td>
              <td style={{ color: 'var(--color-text-secondary)' }}>{c.ownerDisplay || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RiskRadarReport() {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [meta, setMeta]       = useState(null); // v0.90.5: fix ReferenceError - missing state declaration
  const [error, setError]       = useState('');
  const [downloading, setDownloading] = useState(false);
  const [pdfing, setPdfing]           = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError('');
      try {
        const res = await api.get('/api/reports/risk-radar');
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
      const res = await api.get('/api/reports/risk-radar/pdf', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `LapseIQ_Risk_Radar_${new Date().toISOString().split('T')[0]}.pdf`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('PDF download failed.'); }
    finally { setPdfing(false); }
  }

  async function handleCSV() {
    setDownloading(true);
    try {
      const res = await api.get('/api/reports/risk-radar/csv', { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `LapseIQ_Risk_Radar_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { setError('CSV download failed.'); }
    finally { setDownloading(false); }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Risk Radar</h1>
          <div className="page-subtitle">
            {data
              ? `${data.totalIssues} issue${data.totalIssues === 1 ? '' : 's'} found · ${data.companyName}`
              : 'Auto-renewal exposures · Expired contracts · Co-term misalignments'}
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
            <ReportAiNarrative reportId="risk-radar" params={{}} paramsKey={"_static"} />
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
        {loading && <div className="loading">Scanning for risks…</div>}

        {data && !loading && (
          <>
            {/* Count cards */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
              <IssueCountCard
                label="Auto-Renewal Exposures"
                count={data.traps.length}
                color="#b91c1c"
                description="Cancel window passed. May be locked into renewal."
              />
              <IssueCountCard
                label="Expired Still Active"
                count={data.expiredActive.length}
                color="var(--color-warning)"
                description="End date passed but status not updated."
              />
              <IssueCountCard
                label="Co-term Misalignments"
                count={data.coTermMisaligned.length}
                color="var(--color-renewal-text)"
                description="Groups with end dates diverging more than 30 days."
              />
            </div>

            {data.totalIssues === 0 && (
              <div className="card" style={{ padding: 32, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-hero)', marginBottom: 8 }}>✓</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>No risks detected</div>
                <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
                  No auto-renewal exposures, expired contracts, or co-term misalignments found.
                </div>
              </div>
            )}

            {/* Auto-renewal exposures */}
            {data.traps.length > 0 && (
              <div className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
                <div style={{
                  padding: '12px 18px', borderBottom: '1px solid var(--color-border)',
                  background: 'rgba(220,38,38,0.06)', display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#b91c1c', flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: 'var(--font-size-data)', color: '#b91c1c' }}>Auto-Renewal Exposures</span>
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', flex: 1 }}>
                    Cancel-by date has passed and contract is still active. If auto-renewal is enabled, you may already be locked in.
                  </span>
                  <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: '#b91c1c', flexShrink: 0 }}>
                    {data.traps.length} contract{data.traps.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ContractTable
                  rows={data.traps}
                  extraColumns={[
                    {
                      key: 'cancelBy', header: 'Cancel-By (passed)',
                      align: 'right', color: '#b91c1c',
                      render: c => fmtDate(c.cancelByDate),
                    },
                    {
                      key: 'autoRenewal', header: 'Auto-Renews',
                      align: 'center',
                      render: c => c.autoRenewal
                        ? <span style={{ color: '#b91c1c', fontWeight: 600 }}>Yes</span>
                        : <span style={{ color: 'var(--color-text-secondary)' }}>No</span>,
                    },
                  ]}
                />
              </div>
            )}

            {/* Expired still active */}
            {data.expiredActive.length > 0 && (
              <div className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
                <div style={{
                  padding: '12px 18px', borderBottom: '1px solid var(--color-border)',
                  background: 'rgba(217,119,6,0.06)', display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-warning)', flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: 'var(--font-size-data)', color: 'var(--color-warning)' }}>Expired Contracts (Status: Active)</span>
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', flex: 1 }}>
                    End date has passed but status was not updated. Review and close or renew.
                  </span>
                  <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-warning)', flexShrink: 0 }}>
                    {data.expiredActive.length} contract{data.expiredActive.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ContractTable
                  rows={data.expiredActive}
                  extraColumns={[
                    {
                      key: 'endDate', header: 'Expired On',
                      align: 'right', color: 'var(--color-warning)',
                      render: c => fmtDate(c.endDate),
                    },
                  ]}
                />
              </div>
            )}

            {/* Co-term misalignments */}
            {data.coTermMisaligned.length > 0 && (
              <div className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
                <div style={{
                  padding: '12px 18px', borderBottom: '1px solid var(--color-border)',
                  background: 'rgba(124,58,237,0.06)', display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-renewal-text)', flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: 'var(--font-size-data)', color: 'var(--color-renewal-text)' }}>Co-term Misalignments</span>
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', flex: 1 }}>
                    Contracts sharing a co-term group whose end dates diverge by more than 30 days.
                  </span>
                  <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-renewal-text)', flexShrink: 0 }}>
                    {data.coTermMisaligned.length} group{data.coTermMisaligned.length === 1 ? '' : 's'}
                  </span>
                </div>
                {data.coTermMisaligned.map(group => (
                  <div key={group.groupName} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <div style={{
                      padding: '8px 18px',
                      background: 'var(--color-surface)',
                      fontSize: 'var(--font-size-sm)', fontWeight: 600,
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <span style={{ color: 'var(--color-renewal-text)' }}>Group: {group.groupName}</span>
                      <span style={{ color: 'var(--color-text-secondary)' }}>·</span>
                      <span style={{ color: 'var(--color-text-secondary)' }}>{group.divergeDays} day spread</span>
                    </div>
                    <ContractTable
                      rows={group.members}
                      extraColumns={[
                        {
                          key: 'endDate', header: 'End Date',
                          align: 'right',
                          render: c => fmtDate(c.endDate),
                        },
                      ]}
                    />
                  </div>
                ))}
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

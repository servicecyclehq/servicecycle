import ReportBackLink from '../components/ReportBackLink';
// ─────────────────────────────────────────────────────────────────────────────
// ApplicationOverlapReport.jsx — v0.60.0 Tier-2 differentiator
//
// Surfaces vendors that overlap in function. Two layers of heuristic:
//   1. Same Category from multiple vendors (works for any category — flags
//      "you have 4 different telecom vendors").
//   2. Within the SaaS category specifically, a product-name keyword stem
//      bucket (comms / crm / storage / security / analytics / etc.) so
//      Slack-vs-Teams shows up distinct from Slack-vs-Salesforce.
//
// Both layers feed into one "overlap groups" list. Each group has total
// addressable spend and member contracts, ranked by spend desc.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Download, FileSpreadsheet, FileText, Network } from 'lucide-react';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';

function fmtCurrency(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export default function ApplicationOverlapReport() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get('/api/reports/application-overlap')
      .then(r => { if (!cancelled) { setData(r?.data?.data || null); setMeta(r?.data?.meta ?? null); } })
      .catch(err => { if (!cancelled) setError(err?.response?.data?.error || 'Failed to load report'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function downloadExport(format) {
    try {
      const res = await api.get(`/api/reports/application-overlap/${format}`, { responseType: 'blob' });
      const cd = res.headers['content-disposition'] || '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m ? m[1] : `application-overlap.${format}`;
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setError('Export failed');
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Application Portfolio Overlap</h1>
          <div className="page-subtitle">
            Vendors and products that overlap in function — candidates for
            consolidation. Uses category + (for SaaS) product-name keyword stems.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => downloadExport('csv')}>
            <Download size={14} /> CSV
          </button>
          <button className="btn btn-secondary" onClick={() => downloadExport('xlsx')}>
            <FileSpreadsheet size={14} /> XLSX
          </button>
          <button className="btn btn-secondary" onClick={() => downloadExport('pdf')}>
            <FileText size={14} /> PDF
          </button>
        </div>
      </div>

      <div className="page-body">
        <TruncationBanner meta={meta} />
        <ReportAiNarrative reportId="application-overlap" params={{}} paramsKey={"_static"} />

        {error && (
          <div className="card" style={{ padding: 16, marginBottom: 16, color: '#991b1b', background: '#fee2e2' }}>
            {error}
          </div>
        )}

        {/* KPI band */}
        <div className="card" style={{ padding: 0, marginBottom: 20, overflow: 'hidden' }}>
          <div style={{ height: 3, background: '#0d4f6e' }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 0 }}>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Overlap Groups</div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>{loading ? '—' : (data?.groupCount ?? 0)}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>across {data?.contractCount ?? 0} contract{data?.contractCount === 1 ? '' : 's'}</div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Addressable Spend</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>{fmtCurrency(data?.totalAddressableSpend)}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>across overlap groups</div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: '#0d4f6e', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontWeight: 600 }}>Biggest Overlap</div>
              <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: '#0d4f6e', lineHeight: 1.1 }}>{fmtCurrency(data?.biggestOverlap?.spend)}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{data?.biggestOverlap?.label || '—'}</div>
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>SaaS Sub-Buckets</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>{data?.saasBucketCount ?? 0}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>functional clusters detected</div>
            </div>
          </div>
        </div>

        {/* Detail */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Loading…</div>
          ) : !data || !data.groups || data.groups.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
              <Network size={28} style={{ marginBottom: 8, opacity: 0.6 }} />
              <div>No overlap detected. Every category + functional bucket has a single vendor.</div>
              <div style={{ fontSize: 'var(--font-size-sm)', marginTop: 6 }}>This often means a small portfolio; the report becomes meaningful past ~20 vendors.</div>
            </div>
          ) : (
            <div>
              {data.groups.map(g => (
                <div key={g.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ padding: '14px 16px', background: 'var(--color-bg-subtle, #f1f5f9)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: 4,
                          fontSize: 'var(--font-size-2xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
                          background: g.heuristic === 'saas-bucket' ? '#0d4f6e' : '#475569', color: '#fff',
                        }}>
                          {g.heuristic === 'saas-bucket' ? 'SaaS bucket' : 'Category'}
                        </span>
                        <div style={{ fontSize: 'var(--font-size-data)', fontWeight: 700, color: 'var(--color-text)' }}>{g.label}</div>
                      </div>
                      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                        {g.vendorCount} vendor{g.vendorCount === 1 ? '' : 's'} · {g.members.length} contract{g.members.length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 'var(--font-size-data)', fontWeight: 600, color: 'var(--color-text)' }}>{fmtCurrency(g.totalSpend)}</div>
                      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 2 }}>annual spend at stake</div>
                    </div>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-ui)' }}>
                    <tbody>
                      {g.members.map(m => (
                        <tr key={m.id} style={{ borderTop: '1px solid var(--color-border)', cursor: 'pointer' }} onClick={() => navigate(`/contracts/${m.id}`)}>
                          <td style={{ padding: '8px 16px', color: 'var(--color-text)', width: '24%', fontWeight: 600 }}>{m.vendorName || '—'}</td>
                          <td style={{ padding: '8px 16px', color: 'var(--color-text)', width: '32%' }}>{m.product}</td>
                          <td style={{ padding: '8px 16px', color: 'var(--color-text-secondary)', width: '16%', fontSize: 'var(--font-size-sm)' }}>{m.department || '—'}</td>
                          <td style={{ padding: '8px 16px', textAlign: 'right', color: 'var(--color-text)', width: '14%', fontWeight: 600 }}>{fmtCurrency(m.spend)}</td>
                          <td style={{ padding: '8px 16px', color: 'var(--color-text-secondary)', width: '14%', fontSize: 'var(--font-size-sm)' }}>{m.ownerDisplay || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Methodology callout */}
        <div style={{ marginTop: 12, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          <strong>Methodology:</strong> Multi-vendor categories appear as overlap groups automatically.
          For SaaS contracts we additionally sub-bucket by product-name keyword stems
          (communication, meeting, crm, helpdesk, storage, security, analytics, project, design,
          email, video, esign). Add a vendor's product alias to the contract product name to make
          it show up in the right bucket.
        </div>
      </div>
    </>
  );
}

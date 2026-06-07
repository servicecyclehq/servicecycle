import ReportBackLink from '../components/ReportBackLink';
// M365OverlapReport.jsx - #19 part 2 (contract-section-refresh, 2026-05-29)
//
// Dedicated "Microsoft 365 Overlap" report. Consumes the shared detection
// module server/lib/m365Overlap.ts (via GET /api/reports/m365-overlap), which
// finds tools whose core function is already bundled in the Microsoft 365
// license the account already holds (Teams, Entra ID, OneDrive/SharePoint,
// Intune, Exchange Online, and - at E5 - Sentinel/Defender, Power BI, Purview).
//
// Reads "no M365 anchor / no overlap" when the account holds no qualifying
// M365 suite license or nothing displaceable was detected. The Reports-index
// card for this report is hidden unless overlap exists (the hub probes
// /api/reports/hub-kpis -> m365Overlap.hasOverlap).

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Download, FileSpreadsheet, FileText, ShieldCheck } from 'lucide-react';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';

function fmtCurrency(v) {
  if (v == null || !Number.isFinite(v)) return '-';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

const kpiLabel = { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 };
const kpiBig = { fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 };
const kpiBig2 = { fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 };
const kpiBig3 = { fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1.1 };
const kpiSub = { fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 };

export default function M365OverlapReport() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get('/api/reports/m365-overlap')
      .then(r => { if (!cancelled) { setData(r?.data?.data || null); setMeta(r?.data?.meta ?? null); } })
      .catch(err => { if (!cancelled) setError(err?.response?.data?.error || 'Failed to load report'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function downloadExport(format) {
    try {
      const res = await api.get(`/api/reports/m365-overlap/${format}`, { responseType: 'blob' });
      const cd = res.headers['content-disposition'] || '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m ? m[1] : `m365-overlap.${format}`;
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setError('Export failed');
    }
  }

  const members = (data && data.groups && data.groups[0] && data.groups[0].members) || [];
  const hasOverlap = !!(data && data.hasAnchor && members.length > 0);

  // Group displaceable contracts by the M365 capability they overlap with, so
  // the detail reads as "Teams replaces: Slack, Zoom" rather than a flat list.
  const capabilityGroups = useMemo(() => {
    const byCap = new Map();
    for (const m of members) {
      const key = m.capability || 'Other';
      if (!byCap.has(key)) byCap.set(key, { capability: key, note: m.note || '', requiresTier: m.requiresTier || 'E3', members: [], totalSpend: 0 });
      const g = byCap.get(key);
      g.members.push(m);
      g.totalSpend += (m.spend || 0);
    }
    return [...byCap.values()].sort((a, b) => b.totalSpend - a.totalSpend);
  }, [members]);

  const anchorLabel = data && data.anchor ? `${data.anchor.vendorName} ${data.anchor.product}`.trim() : '-';

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Microsoft 365 Overlap</h1>
          <div className="page-subtitle">
            Tools whose core function is already bundled in the Microsoft 365 license you hold - candidates to drop at renewal.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => downloadExport('csv')}><Download size={14} /> CSV</button>
          <button className="btn btn-secondary" onClick={() => downloadExport('xlsx')}><FileSpreadsheet size={14} /> XLSX</button>
          <button className="btn btn-secondary" onClick={() => downloadExport('pdf')}><FileText size={14} /> PDF</button>
        </div>
      </div>

      <div className="page-body">
        <TruncationBanner meta={meta} />
        <ReportAiNarrative reportId="m365-overlap" params={{}} paramsKey={"_static"} />

        {error && (
          <div className="card" style={{ padding: 16, marginBottom: 16, color: '#991b1b', background: '#fee2e2' }}>{error}</div>
        )}

        <div className="card" style={{ padding: 0, marginBottom: 20, overflow: 'hidden' }}>
          <div style={{ height: 3, background: '#0d4f6e' }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 0 }}>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={kpiLabel}>Displaceable Tools</div>
              <div style={kpiBig}>{loading ? '-' : (data?.overlapCount ?? 0)}</div>
              <div style={kpiSub}>already covered by M365</div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={kpiLabel}>Spend At Stake</div>
              <div style={kpiBig2}>{fmtCurrency(data?.totalSpendAtStake)}</div>
              <div style={kpiSub}>annual, across displaceable tools</div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ ...kpiLabel, color: '#0d4f6e', fontWeight: 600 }}>M365 Anchor</div>
              <div style={{ ...kpiBig3, color: '#0d4f6e' }}>{loading ? '-' : anchorLabel}</div>
              <div style={kpiSub}>the license you already hold</div>
            </div>
            <div style={{ padding: 20 }}>
              <div style={kpiLabel}>License Tier</div>
              <div style={kpiBig2}>{loading ? '-' : (data?.anchorTier || '-')}</div>
              <div style={kpiSub}>{data?.anchorTier === 'E5' ? 'includes security + BI + compliance' : 'core productivity + identity'}</div>
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Loading...</div>
          ) : !hasOverlap ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
              <ShieldCheck size={28} style={{ marginBottom: 8, opacity: 0.6 }} />
              <div>{data?.hasAnchor ? 'No overlap detected. Nothing in your portfolio duplicates a capability bundled in your Microsoft 365 license.' : 'No Microsoft 365 anchor found. Add your Microsoft 365 (E3 or E5) contract to surface tools it could replace.'}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', marginTop: 6 }}>This report fires when you hold an M365 suite license and own a tool whose function it already covers.</div>
            </div>
          ) : (
            <div>
              {capabilityGroups.map(g => (
                <div key={g.capability} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ padding: '14px 16px', background: 'var(--color-bg-subtle, #f1f5f9)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <div style={{ maxWidth: '70%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 'var(--font-size-2xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', background: g.requiresTier === 'E5' ? '#7c3aed' : '#0d4f6e', color: '#fff' }}>{g.requiresTier}</span>
                        <div style={{ fontSize: 'var(--font-size-data)', fontWeight: 700, color: 'var(--color-text)' }}>{g.capability}</div>
                      </div>
                      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{g.note}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 'var(--font-size-data)', fontWeight: 600, color: 'var(--color-text)' }}>{fmtCurrency(g.totalSpend)}</div>
                      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 2 }}>spend at stake</div>
                    </div>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-ui)' }}>
                    <tbody>
                      {g.members.map(m => (
                        <tr key={m.contractId} style={{ borderTop: '1px solid var(--color-border)', cursor: 'pointer' }} onClick={() => navigate(`/contracts/${m.contractId}`)}>
                          <td style={{ padding: '8px 16px', color: 'var(--color-text)', width: '26%', fontWeight: 600 }}>{m.vendorName || '-'}</td>
                          <td style={{ padding: '8px 16px', color: 'var(--color-text)', width: '38%' }}>{m.product}</td>
                          <td style={{ padding: '8px 16px', color: 'var(--color-text-secondary)', width: '20%', fontSize: 'var(--font-size-sm)' }}>{m.department || '-'}</td>
                          <td style={{ padding: '8px 16px', textAlign: 'right', color: 'var(--color-text)', width: '16%', fontWeight: 600 }}>{fmtCurrency(m.spend)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginTop: 12, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          <strong>Methodology:</strong> We detect a Microsoft 365 suite license (E3 or E5) in your portfolio, then match your other
          active contracts - by vendor (e.g. Slack, Okta, Zoom, Dropbox, Splunk, Tableau) or product keywords - against the
          capabilities that license already bundles. E5-only capabilities (Sentinel/Defender, Power BI Pro, Purview) are shown
          only when you hold an E5 anchor. Advisory only: confirm feature parity before acting, since a point tool may offer
          depth beyond the bundled equivalent.
        </div>
      </div>
    </>
  );
}
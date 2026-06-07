import ReportBackLink from '../components/ReportBackLink';
// ─────────────────────────────────────────────────────────────────────────────
// VendorPortfolioHeatMapReport.jsx — v0.59.0 Tier-3 executive report
//
// 4-row × 4-column heat map of vendors:
//   Rows  = criticalityTier (tier_1, tier_2, tier_3, tier_4, unset)
//   Cols  = spend bucket (>$1M / $100K–$1M / $10K–$100K / <$10K)
//
// Highlight callouts:
//   • Tier-1 in low-spend buckets  → strategic underinvestment
//   • Tier-4 in high-spend buckets → rationalization candidates
//   • Unset tier with any spend    → data-quality nudge
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Download, FileSpreadsheet, FileText, Network, AlertTriangle, Info } from 'lucide-react';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';

const TIER_LABELS = {
  tier_1: 'Tier 1 · Revenue-impacting',
  tier_2: 'Tier 2 · Business-important',
  tier_3: 'Tier 3 · Operational',
  tier_4: 'Tier 4 · Nice-to-have',
  unset:  'Unset · Needs tiering',
};
const TIER_ORDER = ['tier_1', 'tier_2', 'tier_3', 'tier_4', 'unset'];

const BUCKETS = [
  { id: 'gt_1m',    label: '> $1M' },
  { id: '100k_1m',  label: '$100K–$1M' },
  { id: '10k_100k', label: '$10K–$100K' },
  { id: 'lt_10k',   label: '< $10K' },
];

function fmtCurrency(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// Per-row max-spend ramp so each tier's high-spend cells stand out without
// the absolute scale crushing the lower tiers' cells.
function cellBg(value, rowMax) {
  if (!value || !rowMax) return 'transparent';
  const intensity = Math.min(1, value / rowMax);
  // Brand petrol with variable alpha
  const alpha = 0.08 + intensity * 0.5;
  return `rgba(13, 79, 110, ${alpha.toFixed(3)})`;
}

export default function VendorPortfolioHeatMapReport() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get('/api/reports/vendor-heat-map')
      .then(r => { if (!cancelled) { setData(r?.data?.data || null); setMeta(r?.data?.meta ?? null); } })
      .catch(err => { if (!cancelled) setError(err?.response?.data?.error || 'Failed to load report'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function downloadExport(format) {
    try {
      const res = await api.get(`/api/reports/vendor-heat-map/${format}`, { responseType: 'blob' });
      const cd = res.headers['content-disposition'] || '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m ? m[1] : `vendor-heat-map.${format}`;
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setError('Export failed');
    }
  }

  const rowMaxes = useMemo(() => {
    if (!data?.grid) return {};
    const out = {};
    for (const tier of TIER_ORDER) {
      const row = data.grid[tier] || {};
      out[tier] = Math.max(...BUCKETS.map(b => row[b.id]?.spend || 0), 0);
    }
    return out;
  }, [data]);

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Vendor Portfolio Heat Map</h1>
          <div className="page-subtitle">
            Two-axis view of strategic criticality vs. annual spend. Surfaces vendors that
            don't fit the spend-tier we'd expect from their business importance.
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
        <ReportAiNarrative reportId="vendor-heat-map" params={{}} paramsKey={"_static"} />

        {error && (
          <div className="card" style={{ padding: 16, marginBottom: 16, color: '#991b1b', background: '#fee2e2' }}>
            {error}
          </div>
        )}

        {/* KPI band */}
        <div className="card" style={{ padding: 0, marginBottom: 20, overflow: 'hidden' }}>
          <div style={{ height: 3, background: '#0891b2' }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 0 }}>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Vendors Tracked</div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>{data?.vendorCount ?? 0}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>with active contracts</div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: '#0891b2', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontWeight: 600 }}>Tier-1 Coverage</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: '#0891b2', lineHeight: 1 }}>{data?.tier1CoveragePct != null ? `${data.tier1CoveragePct.toFixed(1)}%` : '—'}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>vendors with criticalityTier set</div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontWeight: 600 }}>Tier-4 Spend</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-warning)', lineHeight: 1 }}>{fmtCurrency(data?.tier4Spend)}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{data?.tier4Pct != null ? `${data.tier4Pct.toFixed(1)}% of portfolio` : '—'}</div>
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Unset Vendors</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>{data?.unsetCount ?? 0}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>data-quality nudge</div>
            </div>
          </div>
        </div>

        {/* Heat map grid */}
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--color-text)', marginBottom: 12 }}>
            Criticality × Spend
          </div>
          {loading ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Loading…</div>
          ) : !data ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--color-text-secondary)' }}>No data.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 640, borderCollapse: 'separate', borderSpacing: 4, fontSize: 'var(--font-size-sm)' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: 'var(--color-text-secondary)' }}></th>
                    {BUCKETS.map(b => (
                      <th key={b.id} style={{ textAlign: 'center', padding: '4px 8px', fontWeight: 600, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>{b.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {TIER_ORDER.map(tier => {
                    const row = data.grid?.[tier] || {};
                    const max = rowMaxes[tier] || 0;
                    return (
                      <tr key={tier}>
                        <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600, color: 'var(--color-text)', whiteSpace: 'nowrap', background: tier === 'unset' ? 'var(--color-bg-subtle, #f1f5f9)' : 'transparent', borderRadius: 4 }}>{TIER_LABELS[tier]}</th>
                        {BUCKETS.map(b => {
                          const cell = row[b.id] || { vendorCount: 0, spend: 0 };
                          const bg = cellBg(cell.spend, max);
                          // Insight ring around concerning cells
                          const isStrategicGap = tier === 'tier_1' && (b.id === 'lt_10k');
                          const isRationalize = tier === 'tier_4' && (b.id === 'gt_1m' || b.id === '100k_1m');
                          const ring = isStrategicGap ? '2px solid #0891b2' : isRationalize ? '2px solid var(--color-warning)' : '1px solid var(--color-border)';
                          return (
                            <td key={b.id} style={{
                              background: bg, border: ring, borderRadius: 4,
                              padding: '14px 8px', textAlign: 'center', minWidth: 110,
                            }}>
                              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text)' }}>{cell.vendorCount || 0}</div>
                              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{cell.spend > 0 ? fmtCurrency(cell.spend) : '—'}</div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ marginTop: 12, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <span><span style={{ display:'inline-block', width:10, height:10, border:'2px solid #0891b2', marginRight:4, verticalAlign:'middle' }}/>Strategic gap (Tier-1 under-invested)</span>
                <span><span style={{ display:'inline-block', width:10, height:10, border:'2px solid var(--color-warning)', marginRight:4, verticalAlign:'middle' }}/>Rationalization candidate (Tier-4 high-spend)</span>
              </div>
            </div>
          )}
        </div>

        {/* Callouts */}
        {!loading && data && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            <div className="card" style={{ padding: 16, borderLeft: '3px solid var(--color-warning)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <AlertTriangle size={14} color="var(--color-warning)" />
                <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--color-text)' }}>Rationalization candidates</div>
              </div>
              {data.rationalizationCandidates?.length ? (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text)' }}>
                  {data.rationalizationCandidates.map(v => (
                    <li key={v.vendorId} style={{ display:'flex', justifyContent:'space-between', padding: '4px 0', borderTop: '1px solid var(--color-border)' }}>
                      <span style={{ cursor:'pointer', color:'var(--color-primary)' }} onClick={() => navigate(`/vendors/${v.vendorId}`)}>{v.vendorName}</span>
                      <span style={{ color:'var(--color-text-secondary)' }}>{fmtCurrency(v.spend)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>No Tier-4 vendors above $100K. Good.</div>
              )}
            </div>

            <div className="card" style={{ padding: 16, borderLeft: '3px solid #0891b2' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <Network size={14} color="#0891b2" />
                <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--color-text)' }}>Strategic gaps</div>
              </div>
              {data.strategicGaps?.length ? (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text)' }}>
                  {data.strategicGaps.map(v => (
                    <li key={v.vendorId} style={{ display:'flex', justifyContent:'space-between', padding: '4px 0', borderTop: '1px solid var(--color-border)' }}>
                      <span style={{ cursor:'pointer', color:'var(--color-primary)' }} onClick={() => navigate(`/vendors/${v.vendorId}`)}>{v.vendorName}</span>
                      <span style={{ color:'var(--color-text-secondary)' }}>{fmtCurrency(v.spend)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>No Tier-1 vendors under $10K. Coverage looks healthy.</div>
              )}
            </div>

            {data.unsetCount > 0 && (
              <div className="card" style={{ padding: 16, borderLeft: '3px solid #64748b' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <Info size={14} color="#64748b" />
                  <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--color-text)' }}>Data quality</div>
                </div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                  {data.unsetCount} vendor{data.unsetCount === 1 ? ' has' : 's have'} no <code>criticalityTier</code> set.
                  Tag them on the vendor page so this report reflects your real portfolio shape.
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

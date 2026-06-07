import ReportBackLink from '../components/ReportBackLink';
// ─────────────────────────────────────────────────────────────────────────────
// NonSaaSCategoryReport.jsx — v0.58.0 Tier-1 white-space report
//
// Per-category cards for telecom / lease / insurance / hardware / services /
// utilities / supplies / other. Each card shows vendor count, contract count,
// total spend, and expiring-soon count. Drill into a filtered Contracts view.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Download, FileSpreadsheet, Layers, FileText } from 'lucide-react';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';

function fmtCurrency(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(1) + '%';
}

export default function NonSaaSCategoryReport() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get('/api/reports/non-saas-categories')
      .then(r => { if (!cancelled) { setData(r?.data?.data || null); setMeta(r?.data?.meta ?? null); } })
      .catch(err => { if (!cancelled) setError(err?.response?.data?.error || 'Failed to load report'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function downloadExport(format) {
    try {
      const res = await api.get(`/api/reports/non-saas-categories/${format}`, {
        responseType: 'blob',
      });
      const cd = res.headers['content-disposition'] || '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m ? m[1] : `non-saas-categories.${format}`;
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setError('Export failed');
    }
  }

  function drillIntoCategory(categoryId) {
    // ContractsList accepts categoryId as a filter param (see /api/contracts).
    navigate(`/contracts?categoryId=${encodeURIComponent(categoryId)}`);
  }

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Non-SaaS Category Breakdown</h1>
          <div className="page-subtitle">
            Spend, vendor and contract counts across non-SaaS categories — the visibility
            most SaaS-management tools miss.
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
        <ReportAiNarrative reportId="non-saas-categories" params={{}} paramsKey={"_static"} />

        {error && (
          <div className="card" style={{ padding: 16, marginBottom: 16, color: '#991b1b', background: '#fee2e2' }}>
            {error}
          </div>
        )}

        {/* KPI band */}
        <div className="card" style={{ padding: 0, marginBottom: 20, overflow: 'hidden' }}>
          <div style={{ height: 3, background: 'var(--color-success)' }} />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          }}>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                Total Non-SaaS Spend
              </div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>
                {loading ? '—' : fmtCurrency(data?.totalSpend)}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                across {data?.categoryCount || 0} categor{data?.categoryCount === 1 ? 'y' : 'ies'}
              </div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                Active Contracts
              </div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>
                {data?.totalContracts ?? '—'}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                non-SaaS, active or under review
              </div>
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontWeight: 600 }}>
                Expiring in 90 days
              </div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-warning)', lineHeight: 1 }}>
                {data?.expiringSoonCount ?? '—'}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                contracts approaching end-date
              </div>
            </div>
          </div>
        </div>

        {/* Category cards */}
        {loading ? (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
            Loading…
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
            <Layers size={28} style={{ marginBottom: 8, opacity: 0.6 }} />
            <div>No non-SaaS contracts found. Categorise existing contracts to see them here.</div>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 14,
          }}>
            {data.rows.map(r => (
              <div
                key={r.categoryId}
                className="card"
                style={{
                  padding: 0,
                  overflow: 'hidden',
                  cursor: 'pointer',
                  transition: 'box-shadow 0.15s, transform 0.1s',
                }}
                onClick={() => drillIntoCategory(r.categoryId)}
                onMouseEnter={e => {
                  e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.10)';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.boxShadow = '';
                  e.currentTarget.style.transform = '';
                }}
              >
                <div style={{ height: 3, background: r.categoryColor || '#64748b' }} />
                <div style={{ padding: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: 7,
                      background: `${r.categoryColor || '#64748b'}14`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 18,
                    }}>
                      {r.categoryIcon || '📦'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 'var(--font-size-base)', color: 'var(--color-text)' }}>
                        {r.categoryName}
                      </div>
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                        {fmtPct(r.sharePct)} of non-SaaS spend
                      </div>
                    </div>
                  </div>

                  <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-text)', marginBottom: 12 }}>
                    {fmtCurrency(r.spend)}
                  </div>

                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr',
                    gap: 12,
                    paddingTop: 12,
                    borderTop: '1px solid var(--color-border)',
                  }}>
                    <div>
                      <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                        Vendors
                      </div>
                      <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, color: 'var(--color-text)' }}>
                        {r.vendorCount}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                        Contracts
                      </div>
                      <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, color: 'var(--color-text)' }}>
                        {r.contractCount}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 'var(--font-size-2xs)', color: r.expiringSoon > 0 ? '#92400e' : 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4, fontWeight: r.expiringSoon > 0 ? 600 : 500 }}>
                        Expiring
                      </div>
                      <div style={{
                        fontSize: 'var(--font-size-base)', fontWeight: 600,
                        color: r.expiringSoon > 0 ? 'var(--color-warning)' : 'var(--color-text)',
                      }}>
                        {r.expiringSoon}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

import ReportBackLink from '../components/ReportBackLink';
// ─────────────────────────────────────────────────────────────────────────────
// CoTerminationOpportunityReport.jsx — v0.59.0 Tier-1 white-space report
//
// Surfaces co-term groups whose member end-dates have drifted apart by more
// than the threshold (default 30 days) — each group is a candidate to
// re-align into a single negotiation event for vendor leverage. Builds on the
// Risk Radar co-term scaffold but pulls it into its own first-class report
// with a savings estimate, a proposed alignment date, and member detail.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Download, FileSpreadsheet, FileText, GitMerge } from 'lucide-react';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';

const THRESHOLD_CHIPS = [
  { value: 30,  label: '> 30 days spread' },
  { value: 60,  label: '> 60 days spread' },
  { value: 90,  label: '> 90 days spread' },
  { value: 0,   label: 'Any spread' },
];

function fmtCurrency(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmtDate(v) {
  if (!v) return '—';
  return new Date(v).toISOString().split('T')[0];
}

export default function CoTerminationOpportunityReport() {
  const navigate = useNavigate();
  const [minSpread, setMinSpread] = useState(30);
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get('/api/reports/co-term-opportunity', { params: { minSpread } })
      .then(r => { if (!cancelled) { setData(r?.data?.data || null); setMeta(r?.data?.meta ?? null); } })
      .catch(err => { if (!cancelled) setError(err?.response?.data?.error || 'Failed to load report'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [minSpread]);

  async function downloadExport(format) {
    try {
      const res = await api.get(`/api/reports/co-term-opportunity/${format}`, {
        params: { minSpread }, responseType: 'blob',
      });
      const cd = res.headers['content-disposition'] || '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m ? m[1] : `co-term-opportunity.${format}`;
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
          <h1 className="page-title">Co-Termination Opportunity</h1>
          <div className="page-subtitle">
            Co-term groups whose member end-dates have drifted apart — candidates to
            be re-aligned into a single negotiation event for vendor leverage.
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
        {/* Threshold chips */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {THRESHOLD_CHIPS.map(chip => (
            <button
              key={chip.value}
              onClick={() => setMinSpread(chip.value)}
              style={{
                padding: '6px 12px', fontSize: 'var(--font-size-sm)', borderRadius: 999,
                border: '1px solid ' + (minSpread === chip.value ? '#0d4f6e' : 'var(--color-border)'),
                background: minSpread === chip.value ? '#0d4f6e' : 'var(--color-card-bg)',
                color: minSpread === chip.value ? '#fff' : 'var(--color-text)',
                fontWeight: minSpread === chip.value ? 600 : 500,
                cursor: 'pointer',
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <ReportAiNarrative reportId="co-term-opportunity" params={{ minSpread }} paramsKey={String(minSpread)} />

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
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Opportunity Groups</div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>{loading ? '—' : (data?.groupCount ?? 0)}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>across {data?.contractCount ?? 0} contract{data?.contractCount === 1 ? '' : 's'}</div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Addressable Value</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>{fmtCurrency(data?.totalAnnualValue)}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>annualised</div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: '#0d4f6e', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontWeight: 600 }}>Top Opportunity</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: '#0d4f6e', lineHeight: 1 }}>{fmtCurrency(data?.biggestOpportunityUsd)}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{data?.biggestOpportunityGroup || '—'}</div>
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Total Spread</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>{(data?.totalSpreadDays ?? 0).toLocaleString()}d</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>days across groups</div>
            </div>
          </div>
        </div>

        {/* Detail */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Loading…</div>
          ) : !data || !data.groups || data.groups.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
              <GitMerge size={28} style={{ marginBottom: 8, opacity: 0.6 }} />
              <div>No co-term groups exceed the selected spread threshold.</div>
              <div style={{ fontSize: 'var(--font-size-sm)', marginTop: 6 }}>
                Tag a contract's <code>Co-term group</code> field to start tracking grouped renewals.
              </div>
            </div>
          ) : (
            <div>
              {data.groups.map(g => (
                <div key={g.groupName} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ padding: '14px 16px', background: 'var(--color-bg-subtle, #f1f5f9)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 'var(--font-size-data)', fontWeight: 700, color: 'var(--color-text)' }}>{g.groupName}</div>
                      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                        {g.memberCount} contract{g.memberCount === 1 ? '' : 's'} · {g.divergeDays}d spread · proposed alignment {fmtDate(g.proposedAlignedDate)}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 'var(--font-size-data)', fontWeight: 600, color: 'var(--color-text)' }}>{fmtCurrency(g.annualValue)}</div>
                      <div style={{ fontSize: 'var(--font-size-sm)', color: '#0d4f6e', marginTop: 2 }}>est. savings {fmtCurrency(g.estimatedSavingsUsd)}</div>
                    </div>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-ui)' }}>
                    <tbody>
                      {g.members.map(m => (
                        <tr key={m.id} style={{ borderTop: '1px solid var(--color-border)', cursor: 'pointer' }} onClick={() => navigate(`/contracts/${m.id}`)}>
                          <td style={{ padding: '8px 16px', color: 'var(--color-text)', width: '24%' }}>{m.vendorName || '—'}</td>
                          <td style={{ padding: '8px 16px', color: 'var(--color-text)', width: '28%' }}>{m.product}</td>
                          <td style={{ padding: '8px 16px', color: 'var(--color-text)', width: '14%', fontFamily: 'monospace', fontSize: 'var(--font-size-sm)' }}>{fmtDate(m.endDate)}</td>
                          <td style={{ padding: '8px 16px', textAlign: 'right', color: 'var(--color-text)', width: '16%', fontWeight: 600 }}>{fmtCurrency(m.renewalValue)}</td>
                          <td style={{ padding: '8px 16px', color: 'var(--color-text-secondary)', width: '18%' }}>{m.ownerDisplay || '—'}</td>
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
          <strong>Methodology:</strong> A group qualifies when its members' end-dates span more than the selected
          threshold. Savings estimate = 3% of annual value (vendor leverage) + $500 per misaligned contract
          (admin overhead removed). Proposed alignment uses the latest member end-date so nothing renews early
          without intention.
        </div>
      </div>
    </>
  );
}

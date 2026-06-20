// ─────────────────────────────────────────────────────────────────────────────
// ProposalCard.jsx — #5 multi-year scope / proposal builder.
//
// Turns the asset population + deficiencies + RUL + rate cards into a sellable
// multi-year program: three options (Essential / Recommended / Comprehensive)
// plus a repair/replace/defer line-item scope, exportable to PDF.
//
// Props: { accountId?: string|null }  — omit to build for the caller's account.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { FileText, Download } from 'lucide-react';
import api from '../api/client';
import { downloadAuthedFile } from '../api/download';
import Toast from './Toast';

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}
const range = (r) => (r ? `${money(r.min)} – ${money(r.max)}` : '—');

const REC_META = {
  replace: { color: '#b91c1c', label: 'Replace' },
  repair:  { color: '#b45309', label: 'Repair' },
  defer:   { color: '#5b6373', label: 'Defer' },
};

export default function ProposalCard({ accountId = null }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [expanded, setExpanded] = useState(false);

  const qs = accountId ? `?accountId=${accountId}` : '';

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get(`/api/proposals${qs}`);
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load proposal');
    } finally { setLoading(false); }
  }, [qs]);

  useEffect(() => { load(); }, [load]);

  async function exportPdf() {
    try {
      await downloadAuthedFile(`/api/proposals/proposal.pdf${qs}`, 'proposal.pdf');
    } catch (e) {
      setToast({ message: e.message || 'Export failed', type: 'error' });
    }
  }

  if (loading) return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>Building proposal…</div></div>;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: '#b91c1c' }}>{error}</div></div>;
  if (!data)   return null;

  const s = data.summary;

  return (
    <div className="card mb-16">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <FileText size={18} />
        <div className="card-title" style={{ flex: 1 }}>Multi-Year Program Proposal</div>
        <button className="btn btn-secondary btn-sm" onClick={exportPdf} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Download size={14} /> PDF
        </button>
      </div>
      <div className="card-body">
        {s.lineItems === 0 ? (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>No assets currently need repair, replacement, or catch-up — nothing to propose.</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              {data.options.map((o) => (
                <div key={o.key} style={{ flex: 1, minWidth: 150, border: `1px solid ${o.key === 'recommended' ? 'var(--color-primary, #0d4f6e)' : 'var(--color-border)'}`, borderRadius: 8, padding: '10px 12px', background: o.key === 'recommended' ? 'var(--color-bg-subtle, #eef5f9)' : 'transparent' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--color-text-secondary)' }}>{o.label}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-primary, #0d4f6e)', marginTop: 2 }}>{range(o.total)}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{o.count} item{o.count === 1 ? '' : 's'}</div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', marginBottom: 8 }}>
              <strong>{s.replace}</strong> replace · <strong>{s.repair}</strong> repair · <strong>{s.defer}</strong> defer ·
              {' '}5-year total <strong>{range(s.total)}</strong>
            </div>

            <button className="btn btn-secondary btn-sm" onClick={() => setExpanded((v) => !v)} style={{ marginBottom: 8 }}>
              {expanded ? 'Hide scope' : `Show scope (${s.lineItems} items)`}
            </button>

            {expanded && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {data.lineItems.map((li) => {
                  const m = REC_META[li.recommendation] || REC_META.repair;
                  return (
                    <div key={li.assetId} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 0', borderTop: '1px solid var(--color-border)' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: m.color, minWidth: 60 }}>{m.label}</span>
                      <div style={{ flex: 1, minWidth: 180, fontSize: 'var(--font-size-sm)' }}>
                        {li.assetLabel}{li.siteName ? <span style={{ color: 'var(--color-text-secondary)' }}> · {li.siteName}</span> : ''}
                        <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{li.drivers.join(' · ')}</div>
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>Yr {li.year}</span>
                      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, whiteSpace: 'nowrap' }}>{money(li.costMin)} – {money(li.costMax)}</span>
                    </div>
                  );
                })}
              </div>
            )}

            <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 10, fontStyle: 'italic' }}>{data.disclaimer}</p>
          </>
        )}
      </div>
    </div>
  );
}

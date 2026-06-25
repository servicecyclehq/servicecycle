// ─────────────────────────────────────────────────────────────────────────────
// ProposalCard.jsx — #5 multi-year scope / proposal builder.
//
// Two faces of the same program:
//   • Customer (costsRedacted): a value-framed plan — WHAT (repair/replace/defer)
//     / WHEN (year) / WHY (drivers), with NO pricing, plus a "request a quote /
//     call / meeting with your rep" CTA. Pricing is the contractor's to present.
//   • Contractor (oem_admin): the priced program + options + PDF export.
//
// Props: { accountId?: string|null }  — omit to build for the caller's account.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { FileText, Download, PhoneCall } from 'lucide-react';
import api from '../api/client';
import { downloadAuthedFile } from '../api/download';
import Toast from './Toast';

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}
const range = (r) => (r ? `${money(r.min)} – ${money(r.max)}` : '—');

const REC_META = {
  replace: { color: 'var(--chip-red-fg)',   label: 'Replace' },
  repair:  { color: 'var(--chip-amber-fg)', label: 'Repair' },
  defer:   { color: 'var(--chip-slate-fg)', label: 'Defer' },
};

export default function ProposalCard({ accountId = null }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [requesting, setRequesting] = useState(false);

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
    try { await downloadAuthedFile(`/api/proposals/proposal.pdf${qs}`, 'proposal.pdf'); }
    catch (e) { setToast({ message: e.message || 'Export failed', type: 'error' }); }
  }

  async function requestContact(mode) {
    setRequesting(true);
    try {
      const res = await api.post('/api/proposals/request-contact', { mode });
      const n = res.data?.data?.notified ?? 0;
      setToast({ message: n > 0 ? 'Sent — your rep will follow up shortly.' : (res.data?.data?.message || 'Request recorded.'), type: 'success' });
    } catch (e) {
      setToast({ message: e?.response?.data?.error || 'Could not send request', type: 'error' });
    } finally { setRequesting(false); }
  }

  if (loading) return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>Building proposal…</div></div>;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--chip-red-fg)' }}>{error}</div></div>;
  if (!data)   return null;

  const s = data.summary;
  const redacted = !!data.costsRedacted;
  const rep = data.rep || null;

  return (
    <div className="card mb-16">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <FileText size={18} />
        <div className="card-title" style={{ flex: 1 }}>{redacted ? 'Your Multi-Year Maintenance Plan' : 'Multi-Year Program Proposal'}</div>
        {!redacted && (
          <button className="btn btn-secondary btn-sm" onClick={exportPdf} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Download size={14} /> PDF
          </button>
        )}
      </div>
      <div className="card-body">
        {s.lineItems === 0 ? (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>No assets currently need repair, replacement, or catch-up — nothing to propose.</div>
        ) : (
          <>
            {/* Options / phases */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              {data.options.map((o) => (
                <div key={o.key} style={{ flex: 1, minWidth: 150, border: `1px solid ${o.key === 'recommended' ? 'var(--color-primary, #0d4f6e)' : 'var(--color-border)'}`, borderRadius: 8, padding: '10px 12px', background: o.key === 'recommended' ? 'var(--color-bg-subtle, #eef5f9)' : 'transparent' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--color-text-secondary)' }}>{o.label}</div>
                  {!redacted && <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-primary, #0d4f6e)', marginTop: 2 }}>{range(o.total)}</div>}
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: redacted ? 2 : 0 }}>{o.count} item{o.count === 1 ? '' : 's'}</div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', marginBottom: 8 }}>
              <strong>{s.replace}</strong> replace · <strong>{s.repair}</strong> repair · <strong>{s.defer}</strong> defer
              {!redacted && <> · 5-year total <strong>{range(s.total)}</strong></>}
              {redacted && <> · phased across years 1, 3 &amp; 5</>}
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
                      {!redacted && <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, whiteSpace: 'nowrap' }}>{money(li.costMin)} – {money(li.costMax)}</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Customer CTA — route to the rep instead of surfacing price */}
            {redacted && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', marginBottom: 8 }}>
                  Want pricing or to plan the work? {rep?.name ? <>Your rep <strong>{rep.name}</strong> can help.</> : 'Your service rep can put numbers to this plan.'}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="btn btn-primary btn-sm" disabled={requesting} onClick={() => requestContact('quote')} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <PhoneCall size={14} /> Request a quote
                  </button>
                  <button className="btn btn-secondary btn-sm" disabled={requesting} onClick={() => requestContact('call')}>Request a call</button>
                  <button className="btn btn-secondary btn-sm" disabled={requesting} onClick={() => requestContact('meeting')}>Request a meeting</button>
                  {rep?.email && <a href={`mailto:${rep.email}`} style={{ fontSize: 12, color: 'var(--color-primary, #0d4f6e)' }}>{rep.email}</a>}
                  {rep?.phone && <a href={`tel:${rep.phone}`} style={{ fontSize: 12, color: 'var(--color-primary, #0d4f6e)' }}>{rep.phone}</a>}
                </div>
              </div>
            )}

            {!redacted && <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 10, fontStyle: 'italic' }}>{data.disclaimer}</p>}
          </>
        )}
      </div>
    </div>
  );
}

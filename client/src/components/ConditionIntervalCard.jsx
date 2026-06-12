// ─────────────────────────────────────────────────────────────────────────────
// ConditionIntervalCard.jsx — gem R3: surface the condition-based interval
// engine. Shows the asset's governing condition and lets a manager preview +
// one-tap apply a condition change, with the interval/next-due delta spelled
// out ("set C3 → intervals tighten 75%, 6 schedules recomputed").
//
// Props: { asset: { id, governingCondition }, canWrite: bool, onApplied: fn }
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { Gauge } from 'lucide-react';
import api from '../api/client';
import Toast from './Toast';

const COND_META = {
  C1: { label: 'C1 · Good', hint: 'intervals stretch ×2.5', color: '#15803d', bg: '#f0fdf4' },
  C2: { label: 'C2 · Fair', hint: 'base NETA interval',     color: '#1d4ed8', bg: '#eff6ff' },
  C3: { label: 'C3 · Poor', hint: 'intervals tighten ×0.25', color: '#b91c1c', bg: '#fff1f1' },
};

export default function ConditionIntervalCard({ asset, canWrite, onApplied }) {
  const [preview, setPreview] = useState(null);   // { requestedCondition, affectedCount, intervalChangePct, schedules }
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState(null);

  const governing = asset.governingCondition || 'C2';

  async function loadPreview(cond) {
    if (cond === governing) { setPreview(null); return; }
    setLoading(true);
    try {
      const r = await api.get(`/api/assets/${asset.id}/interval-preview?condition=${cond}`);
      setPreview(r.data.data);
    } catch (e) {
      setToast({ message: 'Preview failed', type: 'error' });
    } finally { setLoading(false); }
  }

  async function apply(cond) {
    setApplying(true);
    try {
      const r = await api.put(`/api/assets/${asset.id}`, { conditionPhysical: cond, conditionCriticality: cond, conditionEnvironment: cond });
      const n = r.data?.data?.schedulesRecomputed ?? 0;
      setToast({ message: `Condition set to ${cond} — ${n} schedule${n !== 1 ? 's' : ''} recomputed`, type: 'success' });
      setPreview(null);
      onApplied && onApplied();
    } catch (e) {
      setToast({ message: e?.response?.data?.error || 'Failed to apply condition', type: 'error' });
    } finally { setApplying(false); }
  }

  const tighten = preview && preview.intervalChangePct < 0;
  const changeWord = preview ? (preview.intervalChangePct < 0 ? 'tighten' : preview.intervalChangePct > 0 ? 'stretch' : 'stay the same') : '';

  return (
    <div className="card mb-16">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Gauge size={16} />
        <div className="card-title" style={{ flex: 1 }}>Condition &amp; maintenance intervals</div>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
          background: COND_META[governing].bg, color: COND_META[governing].color }}>
          Now: {COND_META[governing].label}
        </span>
      </div>
      <div className="card-body">
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
          NFPA 70B condition of maintenance drives every interval on this asset. See what a condition change would do:
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {['C1', 'C2', 'C3'].map(c => (
            <button key={c} className="btn btn-secondary btn-sm" disabled={loading || c === governing}
              onClick={() => loadPreview(c)}
              style={{ borderColor: preview?.requestedCondition === c ? COND_META[c].color : undefined }}>
              {c === governing ? `${c} (current)` : `What if ${c}?`}
            </button>
          ))}
        </div>

        {loading && <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>Calculating…</div>}

        {preview && !loading && (
          <div style={{ padding: 12, borderRadius: 8, background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>
              Set to {COND_META[preview.requestedCondition].label} → intervals {changeWord}
              {preview.intervalChangePct !== 0 && <span style={{ color: tighten ? '#b91c1c' : '#15803d' }}> {Math.abs(preview.intervalChangePct)}%</span>}
              {' '}<span style={{ fontWeight: 400, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                ({preview.affectedCount} schedule{preview.affectedCount !== 1 ? 's' : ''} affected)
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
              {preview.schedules.filter(s => !s.hasOverride).slice(0, 5).map(s => (
                <div key={s.scheduleId} style={{ display: 'flex', gap: 10, fontSize: 'var(--font-size-sm)', flexWrap: 'wrap' }}>
                  <span style={{ flex: 1, minWidth: 160 }}>{s.taskName}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>
                    {s.currentIntervalMonths}mo → <strong style={{ color: s.projectedIntervalMonths < s.currentIntervalMonths ? '#b91c1c' : s.projectedIntervalMonths > s.currentIntervalMonths ? '#15803d' : 'inherit' }}>{s.projectedIntervalMonths}mo</strong>
                  </span>
                </div>
              ))}
              {preview.schedules.filter(s => s.hasOverride).length > 0 && (
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                  ({preview.schedules.filter(s => s.hasOverride).length} schedule(s) with a manual override are unaffected)
                </div>
              )}
            </div>
            {canWrite && (
              <button className="btn btn-primary btn-sm" disabled={applying} onClick={() => apply(preview.requestedCondition)}>
                {applying ? 'Applying…' : `Set condition to ${preview.requestedCondition} & recompute`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

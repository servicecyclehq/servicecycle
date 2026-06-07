// ─────────────────────────────────────────────────────────────────────────────
// OutageConsolidationCard.jsx — Outage Consolidation Planner.
//
// "No competitor does this."
//
// Reads GET /api/assets/:id/outage-plan and shows:
//   • Savings banner — shutdowns avoided by consolidating
//   • Outage task list — every task that needs a de-energised asset within ±90 d
//   • Downstream impact — which assets go dark with this feeder
//   • Existing outage windows — upcoming planned shutdowns from the calendar
//   • Consolidate button — creates one work order covering all tasks
//
// Takes { asset, canWrite }. Self-gating: renders null when there are no
// outage-requiring tasks in the window (no noise for assets that don't need it).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import Toast from './Toast';
import { fmtDate } from '../lib/equipment';

const STATUS_COLOR = {
  overdue:  { bg: '#fff1f1', color: '#b91c1c', label: 'Overdue' },
  due:      { bg: '#fffbeb', color: '#92400e', label: 'Due' },
  pending:  { bg: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)', label: 'Upcoming' },
};

function SectionHeading({ children }) {
  return (
    <div style={{
      fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.04em',
      textTransform: 'uppercase', color: 'var(--color-text-secondary)', margin: '16px 0 8px',
    }}>
      {children}
    </div>
  );
}

function StatusPill({ status }) {
  const meta = STATUS_COLOR[status] || STATUS_COLOR.pending;
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10,
      background: meta.bg, color: meta.color,
    }}>
      {meta.label}
    </span>
  );
}

export default function OutageConsolidationCard({ asset, canWrite }) {
  const [plan,    setPlan]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState(null);
  const [toast,   setToast]   = useState(null);

  // Work-order creation state
  const [creatingWO,       setCreatingWO]       = useState(false);
  const [showWOForm,       setShowWOForm]        = useState(false);
  const [woDate,           setWoDate]            = useState('');
  const [woNotes,          setWoNotes]           = useState('');
  const [woSubmitting,     setWoSubmitting]      = useState(false);

  const fetchPlan = useCallback(async () => {
    if (!asset?.id) return;
    setLoading(true);
    setErr(null);
    try {
      const { data } = await api.get(`/api/assets/${asset.id}/outage-plan`);
      setPlan(data.data);
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to load outage plan');
    } finally {
      setLoading(false);
    }
  }, [asset?.id]);

  useEffect(() => { fetchPlan(); }, [fetchPlan]);

  // Don't render if no outage tasks in window
  if (!loading && plan && plan.outageTasks.length === 0) return null;
  if (loading && !plan) return null;
  if (err) return null; // silent on error — non-blocking card

  if (!plan) return null;
  const { savings, outageTasks, downstreamAssets, existingOutageWindows, suggestedWindowTarget } = plan;

  const allScheduleIds = outageTasks.map(t => t.id);

  async function handleCreateWO(e) {
    e.preventDefault();
    if (!woDate) return;
    setWoSubmitting(true);
    try {
      await api.post(`/api/assets/${asset.id}/outage-plan/work-order`, {
        scheduledDate: woDate,
        notes:         woNotes || undefined,
        scheduleIds:   allScheduleIds,
      });
      setToast({ message: `Consolidated work order created covering ${outageTasks.length} task(s)`, type: 'success' });
      setShowWOForm(false);
      setWoDate('');
      setWoNotes('');
    } catch (e) {
      setToast({ message: e?.response?.data?.error || 'Failed to create work order', type: 'error' });
    } finally {
      setWoSubmitting(false);
    }
  }

  return (
    <div className="card mb-16">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div className="card-title">Outage Consolidation Planner</div>
        {savings.shutdownsAvoided > 0 && canWrite && !showWOForm && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              setShowWOForm(true);
              if (suggestedWindowTarget) {
                const d = new Date(suggestedWindowTarget);
                setWoDate(d.toISOString().split('T')[0]);
              }
            }}
          >
            Consolidate into 1 work order
          </button>
        )}
      </div>

      <div className="card-body">

        {/* ── Savings banner ─────────────────────────────────────────────────── */}
        {savings.shutdownsAvoided > 0 && (
          <div style={{
            background: 'var(--color-success-bg, #f0fdf4)',
            border: '1px solid var(--color-success-border, #bbf7d0)',
            borderRadius: 8, padding: '10px 14px', marginBottom: 16,
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 22 }}>⚡</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text)' }}>
                {savings.shutdownsAvoided} shutdown{savings.shutdownsAvoided !== 1 ? 's' : ''} avoided
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                {savings.shutdownsWithout} outage task{savings.shutdownsWithout !== 1 ? 's' : ''} across {Object.keys(plan.tasksByAsset).length} asset{Object.keys(plan.tasksByAsset).length !== 1 ? 's' : ''} consolidated into 1 outage window
                {savings.totalEstimatedHours > 0 && ` · est. ${savings.totalEstimatedHours}h total`}
              </div>
            </div>
          </div>
        )}

        {/* ── Work-order creation form ────────────────────────────────────────── */}
        {showWOForm && (
          <form onSubmit={handleCreateWO} style={{
            background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)',
            borderRadius: 8, padding: 16, marginBottom: 16,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 12 }}>Schedule Consolidated Work Order</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '0 0 auto' }}>
                <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  Outage date *
                </label>
                <input
                  type="date"
                  className="input"
                  value={woDate}
                  onChange={e => setWoDate(e.target.value)}
                  required
                  style={{ width: 160 }}
                />
              </div>
              <div style={{ flex: '1 1 200px' }}>
                <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  Notes (optional)
                </label>
                <input
                  type="text"
                  className="input"
                  value={woNotes}
                  onChange={e => setWoNotes(e.target.value)}
                  placeholder="Any special instructions…"
                />
              </div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={woSubmitting || !woDate}>
                {woSubmitting ? 'Creating…' : 'Create Work Order'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowWOForm(false)}>
                Cancel
              </button>
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 8 }}>
              Will cover {outageTasks.length} outage-required task{outageTasks.length !== 1 ? 's' : ''}.
            </div>
          </form>
        )}

        {/* ── Outage task list ────────────────────────────────────────────────── */}
        <SectionHeading>Outage-Required Tasks (±90 days)</SectionHeading>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-sm)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                <th style={{ textAlign: 'left', padding: '4px 8px 8px', color: 'var(--color-text-secondary)', fontWeight: 600 }}>Task</th>
                <th style={{ textAlign: 'left', padding: '4px 8px 8px', color: 'var(--color-text-secondary)', fontWeight: 600 }}>Asset</th>
                <th style={{ textAlign: 'left', padding: '4px 8px 8px', color: 'var(--color-text-secondary)', fontWeight: 600 }}>Due</th>
                <th style={{ textAlign: 'left', padding: '4px 8px 8px', color: 'var(--color-text-secondary)', fontWeight: 600 }}>Status</th>
                <th style={{ textAlign: 'right', padding: '4px 8px 8px', color: 'var(--color-text-secondary)', fontWeight: 600 }}>Std</th>
              </tr>
            </thead>
            <tbody>
              {outageTasks.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '7px 8px' }}>{t.taskName}</td>
                  <td style={{ padding: '7px 8px', color: 'var(--color-text-secondary)' }}>{t.assetName}</td>
                  <td style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>{t.dueDate ? fmtDate(t.dueDate) : '—'}</td>
                  <td style={{ padding: '7px 8px' }}><StatusPill status={t.status} /></td>
                  <td style={{ padding: '7px 8px', textAlign: 'right', color: 'var(--color-text-secondary)', fontSize: 11 }}>{t.standardRef || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Downstream impact ───────────────────────────────────────────────── */}
        {downstreamAssets.length > 0 && (
          <>
            <SectionHeading>Also Goes Dark ({downstreamAssets.length} downstream)</SectionHeading>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {downstreamAssets.map(a => (
                <span key={a.id} style={{
                  padding: '3px 10px', borderRadius: 12, fontSize: 12,
                  background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)',
                  color: 'var(--color-text)',
                }}>
                  {a.name}
                  {(a.criticalityScore ?? 0) >= 4 && <span title="High criticality" style={{ marginLeft: 4 }}>⚠️</span>}
                </span>
              ))}
            </div>
          </>
        )}

        {/* ── Existing outage windows ─────────────────────────────────────────── */}
        {existingOutageWindows.length > 0 && (
          <>
            <SectionHeading>Upcoming Outage Windows (calendar)</SectionHeading>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {existingOutageWindows.map(w => (
                <div key={w.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, fontSize: 'var(--font-size-sm)',
                  padding: '6px 10px', borderRadius: 6, background: 'var(--color-bg-secondary)',
                }}>
                  <span style={{ color: 'var(--color-text-secondary)' }}>📅</span>
                  <span style={{ fontWeight: 600 }}>{fmtDate(w.startsAt)}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>→ {fmtDate(w.endsAt)}</span>
                  {w.reason && <span style={{ color: 'var(--color-text-secondary)' }}>· {w.reason}</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

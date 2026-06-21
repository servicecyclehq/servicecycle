// ─────────────────────────────────────────────────────────────────────────────
// LotoProcCard.jsx — Read-only view of a structured LOTO procedure.
//
// Renders: status badge · version · approval info · energy sources table ·
// ordered step checklist (colour-coded by category) · edit / status buttons.
//
// Takes { proc, canWrite, onStatusChange, onEdit }
//   proc:           LotoProc object with energySources[] and steps[]
//   canWrite:       show edit + status controls (manager+)
//   onStatusChange: callback after PATCH /status
//   onEdit:         callback to open the editor form
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import api from '../api/client';
import Toast from './Toast';

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_META = {
  draft:    { bg: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)', label: 'Draft',    dot: '⬜' },
  active:   { bg: 'var(--chip-green-bg)', color: 'var(--chip-green-fg)', label: 'Active',   dot: '🟢' },
  archived: { bg: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)', label: 'Archived', dot: '⬛' },
};

const ENERGY_ICONS = {
  electrical: '⚡',
  pneumatic:  '💨',
  hydraulic:  '💧',
  mechanical: '⚙️',
  thermal:    '🌡️',
  chemical:   '⚗️',
  gravity:    '⬇️',
};

const STEP_COLORS = {
  shutdown:  { bg: 'var(--chip-orange-bg)', color: 'var(--chip-orange-fg)', label: 'Shutdown' },
  isolation: { bg: 'var(--chip-blue-bg)', color: 'var(--chip-blue-fg)', label: 'Isolation' },
  lockout:   { bg: 'var(--chip-red-bg)', color: 'var(--chip-red-fg)', label: 'Lockout' },
  verify:    { bg: 'var(--chip-green-bg)', color: 'var(--chip-green-fg)', label: 'Verify' },
  restore:   { bg: 'var(--chip-purple-bg)', color: 'var(--chip-purple-fg)', label: 'Restore' },
  release:   { bg: 'var(--chip-blue-bg)', color: 'var(--chip-blue-fg)', label: 'Release' },
};

function fmtDate(dt) {
  if (!dt) return null;
  return new Date(dt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.draft;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 12,
      background: m.bg, color: m.color,
    }}>
      {m.dot} {m.label}
    </span>
  );
}

function StepCatPill({ category }) {
  const m = STEP_COLORS[category] || STEP_COLORS.lockout;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 8,
      background: m.bg, color: m.color, whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  );
}

// ── LotoProcCard ──────────────────────────────────────────────────────────────
export default function LotoProcCard({ proc, canWrite, onStatusChange, onEdit }) {
  const [toast,    setToast]    = useState(null);
  const [patching, setPatching] = useState(false);

  async function handleStatus(newStatus) {
    if (!window.confirm(
      newStatus === 'active'
        ? 'Activate this procedure? Any currently active procedure for this asset will be archived.'
        : `Set this procedure to "${newStatus}"?`
    )) return;
    setPatching(true);
    try {
      await api.patch(`/api/assets/${proc.assetId}/loto/${proc.id}/status`, { status: newStatus });
      setToast({ message: `Procedure ${newStatus}`, type: 'success' });
      onStatusChange?.();
    } catch (e) {
      setToast({ message: e?.response?.data?.error || 'Failed to update status', type: 'error' });
    } finally { setPatching(false); }
  }

  const { energySources = [], steps = [] } = proc;

  return (
    <div style={{
      border: `2px solid ${proc.status === 'active' ? '#bbf7d0' : 'var(--color-border)'}`,
      borderRadius: 10, marginBottom: 12, overflow: 'hidden',
    }}>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        padding: '12px 16px', gap: 12, flexWrap: 'wrap',
        background: proc.status === 'active' ? '#f0fdf4' : 'var(--color-bg-secondary)',
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>
            🔒 {proc.title}
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <StatusBadge status={proc.status} />
            <span>Rev {proc.version}</span>
            {proc.approvedBy && <span>Approved by {proc.approvedBy.name}{proc.approvedAt ? ` · ${fmtDate(proc.approvedAt)}` : ''}</span>}
            <span>Created by {proc.createdBy?.name}</span>
            <span>{energySources.length} energy source{energySources.length !== 1 ? 's' : ''}</span>
            <span>{steps.length} step{steps.length !== 1 ? 's' : ''}</span>
          </div>
          {proc.notes && (
            <div style={{ marginTop: 6, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
              {proc.notes}
            </div>
          )}
        </div>

        {/* Action buttons */}
        {canWrite && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
            {proc.status === 'draft' && (
              <>
                <button className="btn btn-secondary btn-sm" onClick={onEdit} disabled={patching}>Edit</button>
                <button className="btn btn-primary btn-sm" onClick={() => handleStatus('active')} disabled={patching}>
                  {patching ? '…' : 'Activate'}
                </button>
              </>
            )}
            {proc.status === 'active' && (
              <>
                <button className="btn btn-secondary btn-sm" onClick={onEdit} disabled={patching}>New Revision</button>
                <button className="btn btn-secondary btn-sm" onClick={() => handleStatus('archived')} disabled={patching}>
                  Archive
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Energy Sources ─────────────────────────────────────────────────── */}
      {energySources.length > 0 && (
        <div style={{ padding: '0 16px 4px' }}>
          <div style={{
            fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.04em',
            textTransform: 'uppercase', color: 'var(--color-text-secondary)', margin: '12px 0 8px',
          }}>
            Energy Sources — Isolate All Before Work Begins
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-sm)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                  {['Type','Description','Isolation Point','Isolation Method','Verification'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '4px 8px 8px', color: 'var(--color-text-secondary)', fontWeight: 600, fontSize: 12 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {energySources.map((s, i) => (
                  <tr key={s.id || i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>
                      <span title={s.energyType}>{ENERGY_ICONS[s.energyType] || '⚡'} </span>
                      <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', textTransform: 'capitalize' }}>{s.energyType}</span>
                    </td>
                    <td style={{ padding: '7px 8px' }}>{s.description}</td>
                    <td style={{ padding: '7px 8px', color: 'var(--color-text-secondary)' }}>{s.isolationPoint}</td>
                    <td style={{ padding: '7px 8px' }}>{s.isolationMethod}</td>
                    <td style={{ padding: '7px 8px', color: 'var(--color-text-secondary)' }}>{s.verificationMethod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Steps ──────────────────────────────────────────────────────────── */}
      {steps.length > 0 && (
        <div style={{ padding: '0 16px 16px' }}>
          <div style={{
            fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.04em',
            textTransform: 'uppercase', color: 'var(--color-text-secondary)', margin: '12px 0 8px',
          }}>
            Procedure Steps
          </div>
          <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {steps.map((step, i) => {
              const cm = STEP_COLORS[step.category] || STEP_COLORS.lockout;
              return (
                <li key={step.id || i} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '8px 12px', borderRadius: 6,
                  background: step.requiresVerification ? cm.bg : 'var(--color-bg-secondary)',
                  border: `1px solid ${step.requiresVerification ? cm.color + '40' : 'var(--color-border)'}`,
                }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                    background: cm.bg, color: cm.color, fontWeight: 700, fontSize: 12,
                    border: `1px solid ${cm.color}40`,
                  }}>
                    {i + 1}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 'var(--font-size-sm)' }}>{step.instruction}</div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
                      <StepCatPill category={step.category} />
                      {step.requiresVerification && (
                        <span style={{ fontSize: 11, color: cm.color, fontWeight: 600 }}>☑ Verification required</span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

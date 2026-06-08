import React, { useState } from 'react';
import api from '../../api/client';
// ── DemoResetSection ───────────────────────────────────────────────────────────
// Renders only when DEMO_MODE=true and the viewer is admin. Both gates also
// live server-side on POST /api/admin/reset-demo, so a UI bug or a dev
// toggling demoMode in the console can't cause real damage.

export default function DemoResetSection() {
  const [confirming, setConfirming] = useState(false);
  const [running,    setRunning]    = useState(false);
  const [result,     setResult]     = useState(null);     // { ok, text }

  const onClick = () => {
    setResult(null);
    setConfirming(true);
  };

  const cancel = () => setConfirming(false);

  const reset = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await api.post('/api/admin/reset-demo');
      const d   = res.data?.data || {};
      const summary = `Reset complete · ${d.contracts ?? 0} contracts · ${d.vendors ?? 0} vendors`;
      setResult({ ok: true, text: summary });
      setConfirming(false);
    } catch (err) {
      const e = err.response?.data?.error || 'Demo reset failed.';
      setResult({ ok: false, text: e });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ marginTop: '0.5rem', padding: '1.25rem', borderRadius: 8, background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning)' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.25rem', color: 'var(--color-warning)' }}>
        Demo Mode — Reset Sandbox
      </h2>
      <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', marginBottom: '1rem', lineHeight: 1.55 }}>
        This instance is running in demo mode. The seed data refreshes automatically at 3:30 AM.
        Use this button to reset on demand — it wipes the demo account's contracts, vendors, and
        users, then re-runs the seed script.
      </p>

      {!confirming && (
        <button
          type="button"
          onClick={onClick}
          disabled={running}
          style={{
            background:   'var(--color-warning)',
            color: 'var(--color-surface)',
            border:       'none',
            padding:      '0.5rem 0.875rem',
            borderRadius: 6,
            fontSize:     '0.825rem',
            fontWeight:   600,
            cursor:       running ? 'wait' : 'pointer',
          }}
        >
          Reset demo data
        </button>
      )}

      {confirming && (
        <div style={{ marginTop: '0.25rem' }}>
          <div style={{ fontSize: '0.825rem', color: 'var(--color-danger-strong)', marginBottom: '0.625rem', fontWeight: 500 }}>
            This wipes all demo contracts, vendors, and users, then re-seeds. Continue?
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={reset}
              disabled={running}
              style={{
                background: 'var(--color-danger)',
                color: 'var(--color-surface)',
                border:       'none',
                padding:      '0.5rem 0.875rem',
                borderRadius: 6,
                fontSize:     '0.825rem',
                fontWeight:   600,
                cursor:       running ? 'wait' : 'pointer',
              }}
            >
              {running ? 'Resetting…' : 'Yes, reset now'}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={running}
              style={{
                background:   'transparent',
                color:        'var(--color-text-secondary)',
                border:       '1px solid var(--color-border)',
                padding:      '0.5rem 0.875rem',
                borderRadius: 6,
                fontSize:     '0.825rem',
                fontWeight:   500,
                cursor:       running ? 'wait' : 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && (
        <div
          style={{
            marginTop:   '0.875rem',
            padding:     '0.5rem 0.75rem',
            borderRadius: 6,
            background:   result.ok ? 'var(--color-success-soft)' : 'var(--color-danger-bg)',
            border:       `1px solid ${result.ok ? 'var(--color-success-bg-strong)' : 'var(--color-danger)'}`,
            color:        result.ok ? 'var(--color-success)' : 'var(--color-danger)',
            fontSize:     '0.8rem',
          }}
        >
          {result.text}
        </div>
      )}
    </div>
  );
}

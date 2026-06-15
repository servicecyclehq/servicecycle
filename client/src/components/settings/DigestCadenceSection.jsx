import React, { useState, useEffect } from 'react';
import api from '../../api/client';
import { sectionHeading, sectionDesc, btnPrimary } from './sharedStyles';

// ── Digest Cadence Section ───────────────────────────────────────────────────
//
// How often the monthly digest (manager roll-up + rep email) is pushed. Rides
// the watermark cadence engine (server lib/alertCadence.ts). Customer-triggered
// events (quotes/emergencies) are a separate immediate lane and are never
// throttled by this setting.

const OPTIONS = [
  { value: 'monthly',     label: 'Monthly (recommended)', hint: 'One roll-up + rep digest every ~4 weeks.' },
  { value: 'semimonthly', label: 'Twice monthly',         hint: 'Every ~2 weeks.' },
  { value: 'weekly',      label: 'Weekly',                hint: 'Every ~7 days — for fast-moving books.' },
  { value: 'off',         label: 'Off',                   hint: 'Pause the digest entirely (immediate customer events still fire).' },
];

export default function DigestCadenceSection() {
  const [cadence, setCadence] = useState(null); // null = loading
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    api.get('/api/settings')
      .then(r => setCadence(r.data.data?.alertCadence || 'monthly'))
      .catch(() => setCadence('monthly'));
  }, []);

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      const r = await api.put('/api/settings', { alertCadence: cadence });
      if (r.data.success) { setSaved(true); setTimeout(() => setSaved(false), 5000); }
      else setError(r.data.error || 'Failed to save cadence');
    } catch { setError('Network error'); }
    finally { setSaving(false); }
  }

  const active = OPTIONS.find(o => o.value === cadence);

  return (
    <section style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
      <h2 className={sectionHeading}>Digest Cadence</h2>
      <p className={sectionDesc}>
        How often ServiceCycle pushes the monthly digest — the manager compliance roll-up and each rep's
        action list. Quote requests and emergencies always notify immediately and are never affected by this.
      </p>

      {cadence === null ? (
        <div style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <select
              value={cadence}
              onChange={e => { setCadence(e.target.value); setSaved(false); }}
              style={{
                padding: '0.55rem 0.75rem', fontSize: '0.9rem', borderRadius: 6,
                border: '1px solid var(--color-border)', background: 'var(--color-surface)',
                color: 'var(--color-text)', minWidth: 240, cursor: 'pointer',
              }}
            >
              {OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button type="button" onClick={handleSave} disabled={saving} className={btnPrimary}>
              {saving ? 'Saving…' : 'Save Cadence'}
            </button>
            {saved && <span style={{ color: 'var(--color-success)', fontSize: '0.875rem', fontWeight: 500 }}>✓ Saved</span>}
            {error && <span style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</span>}
          </div>
          {active && (
            <p style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginTop: '0.75rem', lineHeight: 1.5 }}>
              {active.hint}
            </p>
          )}
        </>
      )}
    </section>
  );
}

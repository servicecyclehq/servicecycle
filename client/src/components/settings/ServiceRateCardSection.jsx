import React, { useState, useEffect } from 'react';
import api from '../../api/client';
import { sectionHeading, sectionDesc, btnPrimary, btnSecondary } from './sharedStyles';

// ── Service Rate Card Section ────────────────────────────────────────────────
//
// Account-level pricing overrides for the service lines that drive the digest's
// "Est. value $" column and the fleet modernization forecast. Each row shows the
// effective rate and its source (platform default / partner default / your
// override). Editing a row writes an ACCOUNT override; "Reset" reverts to the
// inherited default. Manager+ only (server-enforced).

const LABELS = {
  ARC_FLASH_STUDY:          'Arc Flash Study',
  SWITCHGEAR_MODERNIZATION: 'Switchgear Modernization',
  BREAKER_RETROFIT:         'Breaker Retrofit',
  TRANSFORMER_REPLACEMENT:  'Transformer Replacement',
  RELAY_UPGRADE:            'Relay Upgrade',
  INSPECTION:               'Inspection',
  LOAD_STUDY:               'Load Study',
  QEMW_TRAINING:            'QEMW Training',
};

const SOURCE_META = {
  account:  { label: 'Your override', color: 'var(--color-success)' },
  partner:  { label: 'Partner default', color: 'var(--color-info)' },
  platform: { label: 'Platform default', color: 'var(--color-text-secondary)' },
};

export default function ServiceRateCardSection() {
  const [rates, setRates] = useState(null); // null = loading
  const [draft, setDraft] = useState({});   // serviceType -> { minDollars, maxDollars }
  const [busy,  setBusy]  = useState(null);  // serviceType currently saving
  const [error, setError] = useState(null);

  function load() {
    api.get('/api/rate-cards')
      .then(r => setRates(r.data.data?.rates || []))
      .catch(() => setRates([]));
  }
  useEffect(load, []);

  function setField(type, key, val) {
    setDraft(d => ({ ...d, [type]: { ...(d[type] || {}), [key]: val } }));
  }
  function rowValues(r) {
    const d = draft[r.serviceType] || {};
    return {
      minDollars: d.minDollars !== undefined ? d.minDollars : String(r.minDollars ?? ''),
      maxDollars: d.maxDollars !== undefined ? d.maxDollars : String(r.maxDollars ?? ''),
    };
  }

  async function save(type) {
    const v = rowValues({ serviceType: type, minDollars: '', maxDollars: '' });
    const minDollars = Number(v.minDollars), maxDollars = Number(v.maxDollars);
    if (!Number.isFinite(minDollars) || !Number.isFinite(maxDollars)) { setError('Enter valid numbers'); return; }
    if (minDollars > maxDollars) { setError('Min cannot exceed max'); return; }
    setBusy(type); setError(null);
    try {
      const r = await api.put(`/api/rate-cards/${type}`, { minDollars, maxDollars });
      if (!r.data.success) setError(r.data.error || 'Save failed');
      else { setDraft(d => { const n = { ...d }; delete n[type]; return n; }); load(); }
    } catch { setError('Network error'); }
    finally { setBusy(null); }
  }

  async function reset(type) {
    setBusy(type); setError(null);
    try {
      await api.delete(`/api/rate-cards/${type}`);
      setDraft(d => { const n = { ...d }; delete n[type]; return n; });
      load();
    } catch { setError('Network error'); }
    finally { setBusy(null); }
  }

  return (
    <section style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
      <h2 className={sectionHeading}>Service Rate Card</h2>
      <p className={sectionDesc}>
        Pricing benchmarks behind the digest's estimated value and the fleet modernization forecast.
        Set your own min/max to match real agreed pricing — leave a row inherited to use the default.
      </p>

      {rates === null ? (
        <div style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Loading rate card…</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rates.map(r => {
              const v = rowValues(r);
              const src = SOURCE_META[r.source] || SOURCE_META.platform;
              const dirty = !!draft[r.serviceType];
              return (
                <div key={r.serviceType} style={{
                  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                  border: '1px solid var(--color-border)', borderRadius: 8, padding: '10px 14px',
                }}>
                  <div style={{ flex: '1 1 200px', minWidth: 160 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--color-text)' }}>
                      {LABELS[r.serviceType] || r.serviceType}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: src.color, fontWeight: 600 }}>{src.label}</div>
                  </div>
                  <label style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    Min $
                    <input type="number" min="0" value={v.minDollars}
                      onChange={e => setField(r.serviceType, 'minDollars', e.target.value)}
                      style={{ width: 110, padding: '0.4rem 0.5rem', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }} />
                  </label>
                  <label style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    Max $
                    <input type="number" min="0" value={v.maxDollars}
                      onChange={e => setField(r.serviceType, 'maxDollars', e.target.value)}
                      style={{ width: 110, padding: '0.4rem 0.5rem', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }} />
                  </label>
                  <button type="button" onClick={() => save(r.serviceType)} disabled={busy === r.serviceType || !dirty} className={btnPrimary}>
                    {busy === r.serviceType ? 'Saving…' : 'Save'}
                  </button>
                  {r.source === 'account' && (
                    <button type="button" onClick={() => reset(r.serviceType)} disabled={busy === r.serviceType} className={btnSecondary}>
                      Reset
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.875rem', marginTop: '0.75rem' }}>{error}</p>}
          <p style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginTop: '0.75rem', lineHeight: 1.5 }}>
            Estimates are benchmarks; actual site conditions vary. Your overrides apply only to this account.
          </p>
        </>
      )}
    </section>
  );
}

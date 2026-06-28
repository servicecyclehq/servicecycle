import React from 'react';
import api from '../../api/client';

/**
 * RateSheetSection — super_admin only. Platform-level pricing inputs that drive
 * the dollar estimates on /admin/opportunities (Revenue Intelligence).
 *
 * All money is stored in CENTS server-side; this form displays and edits dollars.
 * "Confirm Rates Are Current" is a separate audit action from saving — it
 * re-affirms the rates without changing them, refreshing the fresh/stale clock
 * and writing an ActivityLog entry (defensible pricing integrity).
 */

const MONEY_FIELDS = [
  { key: 'arcFlashStudyPerPanelCents', label: 'Arc flash study — per panel', hint: 'Per panel/bus enumerated in a study' },
  { key: 'arcFlashStudyMinimumCents', label: 'Arc flash study — site minimum', hint: 'Floor charge per site' },
  { key: 'arcFlashStudyMaximumCents', label: 'Arc flash study — site maximum', hint: 'Cap per site' },
  { key: 'pmServiceHourlyRateCents', label: 'PM service — hourly rate', hint: 'Per labor hour' },
  { key: 'pmVisitMinimumCents', label: 'PM service — visit minimum', hint: 'Minimum charge per site visit' },
  { key: 'oneLineDiagramCreationCents', label: 'One-line diagram creation', hint: 'Flat charge per diagram' },
];

const REPL_TYPES = [
  { key: 'CIRCUIT_BREAKER', label: 'Circuit Breaker' },
  { key: 'TRANSFORMER', label: 'Transformer' },
  { key: 'SWITCHGEAR', label: 'Switchgear' },
  { key: 'MCC', label: 'Motor Control Center' },
];

const c2d = (c) => (c == null ? '' : String(c / 100));
const d2c = (s) => { if (s === '' || s == null) return null; const n = Number(s); return Number.isFinite(n) ? Math.round(n * 100) : null; };

export default function RateSheetSection() {
  const [meta, setMeta] = React.useState(null);
  const [money, setMoney] = React.useState({});
  const [ranges, setRanges] = React.useState({});
  const [days, setDays] = React.useState('180');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const [error, setError] = React.useState('');

  function hydrate(d) {
    setMeta(d);
    const m = {};
    for (const f of MONEY_FIELDS) m[f.key] = c2d(d[f.key]);
    setMoney(m);
    const r = {};
    const src = d.equipmentReplacementRanges || {};
    for (const t of REPL_TYPES) r[t.key] = { min: c2d(src[t.key]?.min), max: c2d(src[t.key]?.max) };
    setRanges(r);
    setDays(String(d.expiresAfterDays ?? 180));
  }

  async function load() {
    setLoading(true); setError('');
    try {
      const { data: j } = await api.get('/api/admin/rate-sheet');
      if (!j.success) throw new Error(j.error || 'Failed to load rate sheet');
      hydrate(j.data);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  }
  React.useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true); setMsg(''); setError('');
    try {
      // Guard: a non-numeric entry serializes to null and would silently wipe the
      // field. Surface a validation error instead of saving a blanked value.
      const bad = [];
      for (const f of MONEY_FIELDS) { const v = money[f.key]; if (v !== '' && v != null && !Number.isFinite(Number(v))) bad.push(f.label); }
      for (const t of REPL_TYPES) for (const b of ['min', 'max']) { const v = ranges[t.key]?.[b]; if (v !== '' && v != null && !Number.isFinite(Number(v))) bad.push(`${t.label} ${b}`); }
      if (bad.length) { setError(`Please enter valid numbers for: ${bad.join(', ')}.`); setSaving(false); return; }
      const payload = { expiresAfterDays: Number(days) || 180, equipmentReplacementRanges: {} };
      for (const f of MONEY_FIELDS) payload[f.key] = d2c(money[f.key]);
      for (const t of REPL_TYPES) {
        const min = d2c(ranges[t.key]?.min); const max = d2c(ranges[t.key]?.max);
        if (min != null || max != null) payload.equipmentReplacementRanges[t.key] = { min, max };
      }
      const { data: j } = await api.put('/api/admin/rate-sheet', payload);
      if (!j.success) throw new Error(j.error || 'Save failed');
      hydrate(j.data);
      setMsg('Rate sheet saved.');
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setSaving(false); }
  }

  async function confirm() {
    setConfirming(true); setMsg(''); setError('');
    try {
      const { data: j } = await api.post('/api/admin/rate-sheet/confirm');
      if (!j.success) throw new Error(j.error || 'Confirm failed');
      hydrate(j.data);
      setMsg('Rates confirmed as current.');
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setConfirming(false); }
  }

  if (loading) return <section><p style={{ color: 'var(--color-text-muted)' }}>Loading rate sheet…</p></section>;

  const touched = meta?.lastConfirmedAt || meta?.updatedAt;
  const ageDays = touched ? Math.floor((Date.now() - new Date(touched).getTime()) / 86400000) : null;
  const validFor = ageDays == null ? null : (meta.expiresAfterDays ?? 180) - ageDays;
  const statusColor = meta?.status === 'fresh' ? 'success' : (meta?.status === 'stale' ? 'warning' : 'danger');
  const statusLabel = meta?.status === 'fresh' ? 'Current' : (meta?.status === 'stale' ? 'Stale — reconfirm' : 'Not configured');

  const inputStyle = { width: '100%', padding: '6px 10px 6px 20px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', background: 'var(--color-surface)', color: 'var(--color-text)', fontSize: 'var(--font-size-ui)' };
  const labelStyle = { display: 'block', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 4, fontWeight: 600 };

  return (
    <section id="rate-sheet" style={{ marginBottom: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 'var(--font-size-base)', fontWeight: 600, color: 'var(--color-text)' }}>Rate Sheet</h3>
          <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', maxWidth: 560 }}>
            Platform pricing inputs for Revenue Intelligence dollar estimates. Stored in cents; entered in dollars.
            Estimates are hidden everywhere until configured, and again once the sheet goes stale.
          </p>
        </div>
        <span style={{ padding: '3px 10px', borderRadius: 999, background: `var(--color-${statusColor}-bg)`, color: `var(--color-${statusColor})`, fontSize: 'var(--font-size-xs)', fontWeight: 700, whiteSpace: 'nowrap' }}>
          {statusLabel}
        </span>
      </div>

      {error && <div style={{ color: 'var(--color-danger)', background: 'var(--color-danger-bg)', padding: '8px 12px', borderRadius: 'var(--radius)', marginBottom: 12, fontSize: 'var(--font-size-ui)' }}>{error}</div>}
      {msg && <div style={{ color: 'var(--color-success)', background: 'var(--color-success-bg)', padding: '8px 12px', borderRadius: 'var(--radius)', marginBottom: 12, fontSize: 'var(--font-size-ui)' }}>{msg}</div>}

      <form onSubmit={save}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          {MONEY_FIELDS.map((f) => (
            <div key={f.key}>
              <label style={labelStyle}>{f.label}</label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 8, top: 7, color: 'var(--color-text-muted)', fontSize: 'var(--font-size-ui)' }}>$</span>
                <input type="number" min="0" step="0.01" value={money[f.key] ?? ''} onChange={(e) => setMoney((p) => ({ ...p, [f.key]: e.target.value }))} placeholder="0" style={inputStyle} />
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 3 }}>{f.hint}</div>
            </div>
          ))}
        </div>

        <h4 style={{ margin: '22px 0 10px', fontSize: 'var(--font-size-ui)', fontWeight: 700, color: 'var(--color-text)' }}>Equipment replacement ranges</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
          {REPL_TYPES.map((t) => (
            <div key={t.key} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: 12 }}>
              <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text)', marginBottom: 8 }}>{t.label}</div>
              <div style={{ display: 'flex', gap: 10 }}>
                {['min', 'max'].map((b) => (
                  <div key={b} style={{ flex: 1 }}>
                    <label style={{ ...labelStyle, fontWeight: 400, textTransform: 'capitalize' }}>{b}</label>
                    <div style={{ position: 'relative' }}>
                      <span style={{ position: 'absolute', left: 8, top: 7, color: 'var(--color-text-muted)', fontSize: 'var(--font-size-ui)' }}>$</span>
                      <input type="number" min="0" step="0.01" value={ranges[t.key]?.[b] ?? ''} onChange={(e) => setRanges((p) => ({ ...p, [t.key]: { ...p[t.key], [b]: e.target.value } }))} placeholder="0" style={inputStyle} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 18, maxWidth: 280 }}>
          <label style={labelStyle}>Estimate validity (days)</label>
          <input type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)} style={{ ...inputStyle, paddingLeft: 10 }} />
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 3 }}>Rates go stale this many days after the last save or confirmation.</div>
        </div>

        <div style={{ marginTop: 18 }}>
          <button type="submit" disabled={saving} style={primaryBtn(saving)}>{saving ? 'Saving…' : 'Save Rate Sheet'}</button>
        </div>
      </form>

      <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
            {meta?.lastConfirmedAt ? (
              <>
                Last confirmed <strong>{new Date(meta.lastConfirmedAt).toLocaleString()}</strong>
                {meta.lastConfirmedByName ? <> by <strong>{meta.lastConfirmedByName}</strong></> : null}.
                {validFor != null && (
                  <div style={{ color: validFor < 0 ? 'var(--color-danger)' : 'var(--color-text-muted)', marginTop: 2 }}>
                    {validFor < 0 ? `Rates expired ${Math.abs(validFor)} days ago — please reconfirm.` : `Rates valid for ${validFor} more days.`}
                  </div>
                )}
              </>
            ) : (
              <span style={{ color: 'var(--color-text-muted)' }}>Rates have never been confirmed.</span>
            )}
          </div>
          <button type="button" onClick={confirm} disabled={confirming} style={outlineBtn(confirming)}>
            {confirming ? 'Confirming…' : 'Confirm Rates Are Current'}
          </button>
        </div>
      </div>
    </section>
  );
}

function primaryBtn(disabled) {
  return { padding: '8px 16px', borderRadius: 'var(--radius)', border: '1px solid var(--color-primary)', background: disabled ? 'var(--color-border)' : 'var(--color-primary)', color: '#fff', fontSize: 'var(--font-size-ui)', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' };
}
function outlineBtn(disabled) {
  return { padding: '8px 16px', borderRadius: 'var(--radius)', border: '1px solid var(--color-primary)', background: 'var(--color-surface)', color: 'var(--color-primary)', fontSize: 'var(--font-size-ui)', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' };
}

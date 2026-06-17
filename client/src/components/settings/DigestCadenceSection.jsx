import React, { useState, useEffect } from 'react';
import api from '../../api/client';
import { sectionHeading, sectionDesc, btnPrimary } from './sharedStyles';

// ── Digest Cadence Section ───────────────────────────────────────────────────
//
// How often the monthly digest (manager roll-up + rep email) is pushed. Rides
// the watermark cadence engine (server lib/alertCadence.ts). Customer-triggered
// events (quotes/emergencies) are a separate immediate lane and are never
// throttled by this setting.
//
// Also hosts the #30 quarterly CFO board-report controls: an auto-send opt-in
// and an on-demand PDF download (GET /api/compliance/cfo-report.pdf).

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

  // #30 quarterly CFO report
  const [cfo,        setCfo]        = useState(null); // null = loading
  const [cfoSaving,  setCfoSaving]  = useState(false);
  const [cfoSaved,   setCfoSaved]   = useState(false);
  const [cfoError,   setCfoError]   = useState(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    api.get('/api/settings')
      .then(r => {
        setCadence(r.data.data?.alertCadence || 'monthly');
        setCfo(!!r.data.data?.customerQuarterlyCfo);
      })
      .catch(() => { setCadence('monthly'); setCfo(false); });
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

  async function handleSaveCfo(next) {
    setCfo(next); setCfoSaving(true); setCfoError(null); setCfoSaved(false);
    try {
      const r = await api.put('/api/settings', { customerQuarterlyCfo: next });
      if (r.data.success) { setCfoSaved(true); setTimeout(() => setCfoSaved(false), 5000); }
      else { setCfoError(r.data.error || 'Failed to save'); setCfo(!next); }
    } catch { setCfoError('Network error'); setCfo(!next); }
    finally { setCfoSaving(false); }
  }

  async function downloadCfo() {
    setDownloading(true); setCfoError(null);
    try {
      const r = await api.get('/api/compliance/cfo-report.pdf', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `servicecycle-cfo-report-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      setCfoError('Could not generate the CFO report. Try again.');
    } finally {
      setDownloading(false);
    }
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

      {/* #30 — Quarterly CFO board report */}
      <div style={{ marginTop: '1.75rem', paddingTop: '1.5rem', borderTop: '1px dashed var(--color-border)' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--color-text)', margin: '0 0 0.35rem' }}>
          Quarterly CFO report
        </h3>
        <p className={sectionDesc} style={{ marginTop: 0 }}>
          A board-grade PDF: readiness, coverage, open risk by severity, quarter activity, and an estimated
          remediation spend. No per-asset detail — the one-pager a finance lead actually reads.
        </p>

        {cfo === null ? (
          <div style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.875rem', cursor: cfoSaving ? 'default' : 'pointer' }}>
              <input
                type="checkbox"
                checked={cfo}
                disabled={cfoSaving}
                onChange={e => handleSaveCfo(e.target.checked)}
              />
              Auto-email the CFO report each quarter
            </label>
            <button type="button" onClick={downloadCfo} disabled={downloading} className={btnPrimary}>
              {downloading ? 'Generating…' : 'Download CFO report (PDF)'}
            </button>
            {cfoSaved && <span style={{ color: 'var(--color-success)', fontSize: '0.875rem', fontWeight: 500 }}>✓ Saved</span>}
            {cfoError && <span style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{cfoError}</span>}
          </div>
        )}
      </div>
    </section>
  );
}

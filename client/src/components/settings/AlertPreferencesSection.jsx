import React, { useState, useEffect } from 'react';
import api from '../../api/client';

import { sectionHeading, sectionDesc, toggle, toggleThumb, btnPrimary } from './sharedStyles';

// ── Alert Preferences Section ────────────────────────────────────────────────
//
// ServiceCycle maintenance-alert preferences. Only `maintenance_due` lead-day
// tiers are user-configurable (default 180/120/90/60/30/7 days before due).
// The overdue / escalation / regulatory-breach tiers always fire at
// -1 / -7 / -30 / -90 days — only their email delivery can be toggled.

const ALERT_TYPE_META = {
  maintenance_due: {
    label:  'Maintenance Due',
    desc:   'Lead alerts before an NFPA 70B maintenance task is due. Choose which lead-day tiers fire for you.',
    color:  'var(--color-primary)',
    bg:     'var(--color-primary-light)',
    border: 'var(--color-info)',
    availableDays: [180, 120, 90, 60, 30, 7],
  },
  overdue: {
    label:  'Overdue',
    desc:   'A scheduled maintenance task has passed its due date without a completed record.',
    color:  'var(--color-warning)',
    bg:     'var(--color-warning-bg)',
    border: 'var(--color-warning)',
  },
  escalation: {
    label:  'Escalation',
    desc:   'An overdue task has remained open long enough to escalate to site and account managers.',
    color:  'var(--color-danger)',
    bg:     'var(--color-danger-bg)',
    border: 'var(--color-danger)',
  },
  regulatory_breach: {
    label:  'Regulatory Breach',
    desc:   'Maintenance is overdue far enough to put the asset out of compliance with its governing standard.',
    color:  '#7f1d1d',
    bg:     'var(--color-danger-bg)',
    border: '#7f1d1d',
  },
};

const ALERT_TYPE_ORDER = ['maintenance_due', 'overdue', 'escalation', 'regulatory_breach'];

export default function AlertPreferencesSection() {
  const [prefs,  setPrefs]  = useState(null);  // null = loading
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [error,  setError]  = useState(null);

  useEffect(() => {
    api.get('/api/alerts/preferences')
      .then(r => setPrefs(r.data.data?.preferences || []))
      .catch(() => setPrefs([]));
  }, []);

  function getPref(alertType) {
    return prefs?.find(p => p.alertType === alertType)
      || { alertType, daysBeforeList: '', emailEnabled: true, configurable: alertType === 'maintenance_due' };
  }

  function getDays(pref) {
    return (pref.daysBeforeList || '').split(',').map(Number).filter(Boolean);
  }

  function toggleDay(alertType, day) {
    setPrefs(prev => prev.map(p => {
      if (p.alertType !== alertType) return p;
      const days    = getDays(p);
      const newDays = days.includes(day)
        ? days.filter(d => d !== day)
        : [...days, day].sort((a, b) => b - a);
      return { ...p, daysBeforeList: newDays.join(',') };
    }));
    setSaved(false);
  }

  function toggleEmail(alertType) {
    setPrefs(prev => prev.map(p =>
      p.alertType === alertType ? { ...p, emailEnabled: !p.emailEnabled } : p
    ));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const r = await api.put('/api/alerts/preferences', { preferences: prefs });
      if (r.data.success) {
        setSaved(true);
        setTimeout(() => setSaved(false), 5000);
      } else {
        setError(r.data.error || 'Failed to save preferences');
      }
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
      <h2 className={sectionHeading}>Alert Preferences</h2>
      <p className={sectionDesc}>
        Control which alerts you receive and when. Settings are per-user — each team member can configure
        their own lead-day tiers and email preferences independently.
      </p>

      {prefs === null ? (
        <div style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Loading preferences…</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {ALERT_TYPE_ORDER.map(alertType => {
              const meta = ALERT_TYPE_META[alertType];
              const pref = getPref(alertType);
              const configurable = pref.configurable ?? (alertType === 'maintenance_due');
              const activeDays = getDays(pref);

              return (
                <div key={alertType} style={{
                  border: `1px solid ${meta.border}`,
                  borderRadius: 8,
                  overflow: 'hidden',
                }}>
                  {/* Header row */}
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 16px',
                    background: meta.bg,
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: '0.875rem', color: meta.color }}>
                        {meta.label}
                      </div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
                        {meta.desc}
                      </div>
                    </div>

                    {/* Email toggle */}
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 16, flexShrink: 0, cursor: 'pointer' }}
                      onClick={() => toggleEmail(alertType)}
                    >
                      <span style={{ fontSize: '0.78rem', color: pref.emailEnabled ? meta.color : 'var(--color-text-secondary)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        Email {pref.emailEnabled ? 'on' : 'off'}
                      </span>
                      <div
                        role="switch"
                        aria-checked={pref.emailEnabled}
                        className={toggle}
                        data-state={pref.emailEnabled ? 'on' : 'off'}
                        style={pref.emailEnabled ? { background: meta.color } : undefined}
                      >
                        <div className={toggleThumb} />
                      </div>
                    </div>
                  </div>

                  {/* Lead-day tier checkboxes (maintenance_due only) */}
                  {configurable ? (
                    <div style={{ padding: '12px 16px', background: 'var(--color-surface)', display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                        Alert me at:
                      </span>
                      {meta.availableDays.map(day => {
                        const checked = activeDays.includes(day);
                        return (
                          <label key={day} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.8rem', color: 'var(--color-text)', userSelect: 'none' }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleDay(alertType, day)}
                              style={{ accentColor: meta.color, width: 15, height: 15, cursor: 'pointer' }}
                            />
                            <span style={{ fontWeight: checked ? 600 : 400, color: checked ? meta.color : 'var(--color-text-secondary)' }}>
                              {day} days before
                            </span>
                          </label>
                        );
                      })}
                      {activeDays.length === 0 && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--color-warning)', fontStyle: 'italic' }}>
                          No tiers selected — lead alerts for this type are effectively muted
                        </span>
                      )}
                    </div>
                  ) : (
                    <div style={{ padding: '10px 16px', background: 'var(--color-surface)', fontSize: '0.78rem', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                      Always on — overdue and escalation tiers fire automatically at 1, 7, 30, and 90 days
                      overdue and cannot be suppressed. Only email delivery is configurable here.
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Save row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className={btnPrimary}
            >
              {saving ? 'Saving…' : 'Save Alert Preferences'}
            </button>
            {saved && (
              <span style={{ color: 'var(--color-success)', fontSize: '0.875rem', fontWeight: 500 }}>✓ Preferences saved</span>
            )}
            {error && (
              <span style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</span>
            )}
          </div>

          <p style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginTop: '0.75rem', lineHeight: 1.5 }}>
            The digest email is sent once per day and consolidates all firing alerts for that day into a single message.
            Adjusting tiers here controls which lead alerts fire for you — your teammates' preferences are managed separately.
          </p>
        </>
      )}
    </section>
  );
}

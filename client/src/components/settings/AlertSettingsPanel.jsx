import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api/client';
import { sectionHeading, sectionDesc, btnPrimary } from './sharedStyles';

// ── AlertSettingsPanel ───────────────────────────────────────────────────────
//
// Configurable alert system settings. Manages 5 alert categories:
//   1. Condition Degradation  — C1→C2 or C2→C3 governing-condition worsening
//   2. Critical Deficiency    — new IMMEDIATE/RECOMMENDED deficiency created
//   3. Arc Flash Study Expiry — configurable warning windows before expiry
//   4. Overdue Maintenance    — which roles receive overdue escalation emails
//   5. Asset Decommission     — asset inService=false / archive lifecycle event
//
// All settings are stored in AccountSetting KV rows via GET/PUT /api/settings/alert-settings.

const ALL_ROLES = ['admin', 'manager', 'consultant', 'viewer'];
const ROLE_LABELS = {
  admin:      'Admin',
  manager:    'Manager',
  consultant: 'Consultant / NETA Inspector',
  viewer:     'Viewer (read-only)',
};

const DEFAULTS = {
  COND_DEGRADE_ALERT_ENABLED:       'true',
  COND_DEGRADE_NOTIFY_ROLES:        'admin,manager,consultant',
  DEFICIENCY_ALERT_ENABLED:         'true',
  DEFICIENCY_ALERT_MIN_SEVERITY:    'IMMEDIATE',
  DEFICIENCY_ALERT_NOTIFY_ROLES:    'admin,manager',
  ARC_FLASH_EXPIRY_WARNING_DAYS:    '90,60,30',
  ASSET_DECOMMISSION_ALERT_ENABLED: 'true',
  ASSET_DECOMMISSION_NOTIFY_ROLES:  'admin,manager',
  OVERDUE_NOTIFY_ROLES:             'admin,manager',
};

const ARC_FLASH_DAY_OPTIONS = [
  { value: 180, label: '180 days (~6 months)' },
  { value: 90,  label: '90 days (~3 months)' },
  { value: 60,  label: '60 days (~2 months)' },
  { value: 30,  label: '30 days (1 month)' },
  { value: 14,  label: '14 days (2 weeks)' },
];

// Toggle control for enabled/disabled
function ToggleSwitch({ checked, onChange, disabled, label }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 10,
      cursor: disabled ? 'default' : 'pointer', userSelect: 'none',
    }}>
      <div
        onClick={() => !disabled && onChange(!checked)}
        style={{
          width: 40, height: 22, borderRadius: 11, position: 'relative',
          background: checked ? 'var(--color-primary, #3b82f6)' : 'var(--color-border)',
          transition: 'background 0.2s', cursor: disabled ? 'default' : 'pointer',
          flexShrink: 0,
        }}
      >
        <div style={{
          position: 'absolute', top: 2, left: checked ? 20 : 2,
          width: 18, height: 18, borderRadius: '50%', background: '#fff',
          transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
      </div>
      {label && <span style={{ fontSize: '0.875rem', color: 'var(--color-text)' }}>{label}</span>}
    </label>
  );
}

// Role checkbox group
function RoleCheckboxes({ value, onChange, label }) {
  const active = value.split(',').map(r => r.trim()).filter(Boolean);
  function toggle(role) {
    const next = active.includes(role)
      ? active.filter(r => r !== role)
      : [...active, role];
    onChange(next.join(','));
  }
  return (
    <div>
      {label && <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', margin: '0 0 8px', fontWeight: 500 }}>{label}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {ALL_ROLES.map(role => (
          <label key={role} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.85rem' }}>
            <input
              type="checkbox"
              checked={active.includes(role)}
              onChange={() => toggle(role)}
            />
            {ROLE_LABELS[role] || role}
          </label>
        ))}
      </div>
    </div>
  );
}

// Multi-select for arc flash warning days
function ArcFlashDaysSelector({ value, onChange }) {
  const active = value.split(',').map(d => parseInt(d.trim(), 10)).filter(n => !isNaN(n));
  function toggle(days) {
    const next = active.includes(days)
      ? active.filter(d => d !== days)
      : [...active, days];
    onChange(next.sort((a, b) => b - a).join(','));
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      {ARC_FLASH_DAY_OPTIONS.map(opt => (
        <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.85rem' }}>
          <input
            type="checkbox"
            checked={active.includes(opt.value)}
            onChange={() => toggle(opt.value)}
          />
          {opt.label}
        </label>
      ))}
    </div>
  );
}

// Category card wrapper
function AlertCategory({ title, description, enabled, onToggle, children }) {
  return (
    <div style={{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 8, padding: '1.25rem',
      marginBottom: '1rem',
      opacity: enabled === false ? 0.6 : 1,
      transition: 'opacity 0.2s',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
        <div style={{ flex: 1, marginRight: 12 }}>
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--color-text)' }}>{title}</h3>
          <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            {description}
          </p>
        </div>
        {onToggle && (
          <ToggleSwitch
            checked={enabled === true}
            onChange={onToggle}
          />
        )}
      </div>
      {enabled !== false && children && (
        <div style={{ borderTop: '1px dashed var(--color-border)', paddingTop: '0.75rem' }}>
          {children}
        </div>
      )}
    </div>
  );
}

export default function AlertSettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [error,    setError]    = useState(null);

  useEffect(() => {
    api.get('/api/settings/alert-settings')
      .then(r => setSettings(r.data.data || { ...DEFAULTS }))
      .catch(() => setSettings({ ...DEFAULTS }));
  }, []);

  const set = useCallback((key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  }, []);

  async function handleSave() {
    if (!settings) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const r = await api.put('/api/settings/alert-settings', settings);
      if (r.data.success) {
        setSaved(true);
        setTimeout(() => setSaved(false), 5000);
      } else {
        setError(r.data.error || 'Failed to save');
      }
    } catch {
      setError('Network error — changes not saved');
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <div style={{ padding: '2rem', fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Loading alert settings…</div>;
  }

  const condEnabled  = settings.COND_DEGRADE_ALERT_ENABLED  === 'true';
  const defEnabled   = settings.DEFICIENCY_ALERT_ENABLED    === 'true';
  const decommEnabled = settings.ASSET_DECOMMISSION_ALERT_ENABLED === 'true';

  return (
    <section style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
      <h2 className={sectionHeading}>Alert Notifications</h2>
      <p className={sectionDesc}>
        Configure which events trigger email notifications and who receives them.
        Notifications are deduplicated — repeated events in a short window send only one email.
      </p>

      {/* 1. Condition Degradation */}
      <AlertCategory
        title="Condition Degradation Alerts"
        description="Sends email when an asset's governing condition worsens (C1 → C2, or C2 → C3). Triggered by manual edits, work order as-left conditions, missed maintenance cycles (NFPA 70B §9.3.1), or continuous monitoring alerts."
        enabled={condEnabled}
        onToggle={v => set('COND_DEGRADE_ALERT_ENABLED', v ? 'true' : 'false')}
      >
        <RoleCheckboxes
          value={settings.COND_DEGRADE_NOTIFY_ROLES}
          onChange={v => set('COND_DEGRADE_NOTIFY_ROLES', v)}
          label="Notify these roles:"
        />
      </AlertCategory>

      {/* 2. Critical Deficiency */}
      <AlertCategory
        title="Critical Deficiency Alerts"
        description="Sends email when a new deficiency finding is recorded. NETA MTS IMMEDIATE deficiencies require action before re-energizing — these should always notify promptly."
        enabled={defEnabled}
        onToggle={v => set('DEFICIENCY_ALERT_ENABLED', v ? 'true' : 'false')}
      >
        <div style={{ marginBottom: '0.75rem' }}>
          <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', margin: '0 0 8px', fontWeight: 500 }}>
            Minimum severity to trigger alert:
          </p>
          <div style={{ display: 'flex', gap: 16 }}>
            {[
              { value: 'IMMEDIATE',   label: 'IMMEDIATE only',               hint: 'Safety/operational risk now' },
              { value: 'RECOMMENDED', label: 'RECOMMENDED and above',         hint: 'Also include recommended findings' },
            ].map(opt => (
              <label key={opt.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.85rem' }}>
                <input
                  type="radio"
                  name="deficiency_min_severity"
                  value={opt.value}
                  checked={settings.DEFICIENCY_ALERT_MIN_SEVERITY === opt.value}
                  onChange={() => set('DEFICIENCY_ALERT_MIN_SEVERITY', opt.value)}
                  style={{ marginTop: 2 }}
                />
                <div>
                  <div style={{ fontWeight: 500 }}>{opt.label}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: 1 }}>{opt.hint}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <RoleCheckboxes
          value={settings.DEFICIENCY_ALERT_NOTIFY_ROLES}
          onChange={v => set('DEFICIENCY_ALERT_NOTIFY_ROLES', v)}
          label="Notify these roles:"
        />
      </AlertCategory>

      {/* 3. Arc Flash Study Expiry */}
      <AlertCategory
        title="Arc Flash Study Expiry Warnings"
        description="Sends email ahead of arc flash study expiration (NFPA 70E §130.5 — studies must be reviewed every 5 years or on system change). Select how far in advance to send warnings."
        enabled={true}
      >
        <div>
          <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', margin: '0 0 8px', fontWeight: 500 }}>
            Send warnings at these milestones before expiry:
          </p>
          <ArcFlashDaysSelector
            value={settings.ARC_FLASH_EXPIRY_WARNING_DAYS}
            onChange={v => set('ARC_FLASH_EXPIRY_WARNING_DAYS', v || '90,60,30')}
          />
          <p style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: 8 }}>
            Each selected milestone sends one notification per study (deduplicated within 30 days).
            Admins and managers are always notified for arc flash expiry.
          </p>
        </div>
      </AlertCategory>

      {/* 4. Overdue Maintenance */}
      <AlertCategory
        title="Overdue Maintenance Escalation"
        description="Controls which roles receive the overdue and escalation tier emails from the maintenance alert engine. The engine runs daily and sends digest emails for each tier crossed."
        enabled={true}
      >
        <RoleCheckboxes
          value={settings.OVERDUE_NOTIFY_ROLES}
          onChange={v => set('OVERDUE_NOTIFY_ROLES', v)}
          label="Notify these roles for overdue escalations:"
        />
        <p style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: 8 }}>
          The maintenance alert engine (lead-time and overdue tiers) also respects each user's
          individual Alert Preferences below. This setting controls the role-level default recipients.
        </p>
      </AlertCategory>

      {/* 5. Asset Decommission */}
      <AlertCategory
        title="Asset Decommission Alerts"
        description="Sends email when an asset is decommissioned (marked Out of Service or archived). Useful for contractors managing asset lifecycle and ensuring open work orders are resolved."
        enabled={decommEnabled}
        onToggle={v => set('ASSET_DECOMMISSION_ALERT_ENABLED', v ? 'true' : 'false')}
      >
        <RoleCheckboxes
          value={settings.ASSET_DECOMMISSION_NOTIFY_ROLES}
          onChange={v => set('ASSET_DECOMMISSION_NOTIFY_ROLES', v)}
          label="Notify these roles:"
        />
      </AlertCategory>

      {/* Save */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: '1.25rem' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className={btnPrimary}
        >
          {saving ? 'Saving…' : 'Save Alert Settings'}
        </button>
        {saved  && <span style={{ color: 'var(--color-success)', fontSize: '0.875rem', fontWeight: 500 }}>✓ Saved</span>}
        {error  && <span style={{ color: 'var(--color-danger)',  fontSize: '0.875rem' }}>{error}</span>}
      </div>
    </section>
  );
}

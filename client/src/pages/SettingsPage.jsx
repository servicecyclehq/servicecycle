import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import PasswordInput from '../components/PasswordInput';
import DlqPanel from '../components/DlqPanel'; // v0.67.12 (audit H33): DLQ inspection panel
import UsersPage from './UsersPage';
import PermissionsPage from './PermissionsPage';
import SettingsTabRouter from './settings/SettingsTabRouter.jsx'; // v0.91 Phase 1a
import ApiKeysSection  from '../components/settings/ApiKeysSection.jsx';  // v0.91 Phase 1b
import WebhooksSection from '../components/settings/WebhooksSection.jsx'; // v0.91 Phase 1b
import ImportWebhookSection from '../components/settings/ImportWebhookSection.jsx'; // import event webhook
import SlackIntegrationSection from '../components/settings/SlackIntegrationSection.jsx'; // v0.91 Phase 1b cont'd
import TeamsIntegrationSection from '../components/settings/TeamsIntegrationSection.jsx'; // v0.91 Phase 1b cont'd
import AlertPreferencesSection from '../components/settings/AlertPreferencesSection.jsx'; // v0.91 Phase 1b cont'd
import ConsultantAccessSection from '../components/settings/ConsultantAccessSection.jsx'; // v0.91 Phase 1b cont'd
import AiCapsSection from '../components/settings/AiCapsSection.jsx'; // v0.91 Phase 1b cont'd
import DemoResetSection from '../components/settings/DemoResetSection.jsx'; // v0.91 Phase 1b cont'd
import BackupSection from '../components/settings/BackupSection.jsx'; // v0.91 Phase 1b cont'd
import EncryptionSection from '../components/settings/EncryptionSection.jsx'; // v0.91 Phase 1b cont'd
import CustomFieldsSection from '../components/settings/CustomFieldsSection.jsx'; // v0.91 Phase 1b cont'd
import EmpSection from '../components/settings/EmpSection.jsx'; // EMP / NFPA 70B §4.2 program settings
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const API = import.meta.env.VITE_API_URL || '/api';

const STORAGE_PROVIDERS = [
  { value: 'local',  label: 'Local (default — app install directory)' },
  { value: 'custom', label: 'Custom path (local or network share)' },
  { value: 's3',     label: 'S3-compatible (AWS, Backblaze B2, Wasabi, MinIO, R2)' },
];

const PROVIDERS = [
  { value: 'anthropic',    label: 'Anthropic Claude' },
  { value: 'openai',       label: 'OpenAI (GPT-4o, etc.)' },
  { value: 'azure_openai', label: 'Azure OpenAI (Microsoft tenant)' },
  { value: 'gemini',       label: 'Google Gemini' },
];

const DEFAULT_MODELS = {
  anthropic:    'claude-haiku-4-5-20251001',
  openai:       'gpt-4o-mini',
  azure_openai: '',
  gemini:       'gemini-1.5-flash',
};

export default function SettingsPage() {
  useDocumentTitle('Settings');
  const { user, demoMode, updateUser } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [loading, setLoading]   = useState(true);
  const [saving,  setSaving]    = useState(false);
  const [testing, setTesting]   = useState(false);
  const [saved,   setSaved]     = useState(false);
  const [error,   setError]     = useState(null);
  const [testResult, setTestResult] = useState(null); // { ok, message }

  const [form, setForm] = useState({
    AI_ENABLED:              'true',
    AI_PROVIDER:             'anthropic',
    AI_API_KEY:              '',
    AI_MODEL:                '',
    AZURE_OPENAI_ENDPOINT:   '',
    AZURE_OPENAI_DEPLOYMENT: '',
    AZURE_API_VERSION:       '2024-02-01',
    STORAGE_PROVIDER:        'local',
    STORAGE_PATH:            '',
    AI_INGEST_LIMIT:          '10',
    FISCAL_YEAR_START_MONTH:  '1',
    PASSWORD_MIN_LENGTH:      '12',
    PASSWORD_REQUIRE_NUMBER:  'true',
    PASSWORD_REQUIRE_SPECIAL: 'true',
    // Phase 4: per-account boolean column (not a KV setting). Sent to the
    // PUT handler as `aiBriefEnabled: true|false` — handled in its own
    // server-side branch so it doesn't go through the accountSetting upsert.
    aiBriefEnabled:          false,
    // v0.18.0: opt-in upstream anonymous feedback sync (AccountSetting KV).
    // Admin-only. When true, thumbs ratings are forwarded to the upstream feedback endpoint.
    aiFeedbackUpstreamEnabled: false,
    // Phase 4: per-user boolean column. "Don't ask me each session"
    // suppresses the AI consent modal entirely for THIS user.
    aiConsentSilenced:       false,
    // v0.58.1: per-tenant total headcount (real Account column). Drives cost-per-employee KPIs in the Reports hub.
    fteCount:                '',
    // v0.66.0: per-role daily AI-call caps. Empty string = no override (use built-in default).
    // Defaults: admin=unlimited, manager=100, consultant=50, viewer=20. Sum across ALL AI actions.
    ai_cap_role_admin:        '',
    ai_cap_role_manager:      '',
    ai_cap_role_consultant:   '',
    ai_cap_role_viewer:       '',
  });

  const [ingestCount, setIngestCount] = useState(0);
  const [keyIsMasked, setKeyIsMasked] = useState(false);
  const [exporting,   setExporting]   = useState(false);
  const [activeTab,   setActiveTab]   = useState(() => { const _p = new URLSearchParams(window.location.search); return _p.get('tab') || 'general'; });

  useEffect(() => {
    fetch(`${API}/settings`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('servicecycle_token')}` },
    })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          const s = d.data;
          setForm({
            AI_ENABLED:              s.AI_ENABLED              || 'true',
            AI_PROVIDER:             s.AI_PROVIDER             || 'anthropic',
            AI_API_KEY:              s.AI_API_KEY              || '',
            AI_MODEL:                s.AI_MODEL                || '',
            AZURE_OPENAI_ENDPOINT:   s.AZURE_OPENAI_ENDPOINT   || '',
            AZURE_OPENAI_DEPLOYMENT: s.AZURE_OPENAI_DEPLOYMENT || '',
            AZURE_API_VERSION:       s.AZURE_API_VERSION       || '2024-02-01',
            STORAGE_PROVIDER:        s.STORAGE_PROVIDER        || 'local',
            STORAGE_PATH:            s.STORAGE_PATH            || '',
            AI_INGEST_LIMIT:          String(s._ingestLimit || 10),
            FISCAL_YEAR_START_MONTH:  String(s.FISCAL_YEAR_START_MONTH  || '1'),
            PASSWORD_MIN_LENGTH:      String(s.PASSWORD_MIN_LENGTH      || '12'),
            PASSWORD_REQUIRE_NUMBER:  String(s.PASSWORD_REQUIRE_NUMBER  ?? 'true'),
            PASSWORD_REQUIRE_SPECIAL: String(s.PASSWORD_REQUIRE_SPECIAL ?? 'true'),
            // Phase 4: per-account AI brief toggle
            aiBriefEnabled:             !!s.aiBriefEnabled,
            // v0.18.0: opt-in upstream feedback sync
            aiFeedbackUpstreamEnabled:  !!s.aiFeedbackUpstreamEnabled,
            // Phase 4: per-user "don't ask me each session" — comes from
            // /api/auth/me via AuthContext (NOT /api/settings). Pulled
            // from the user prop below via a separate effect.
            aiConsentSilenced:          !!user?.aiConsentSilenced,
            // v0.58.1: per-tenant headcount. Empty string = unset (placeholder shows).
            fteCount:                   s.fteCount != null ? String(s.fteCount) : '',
            // v0.66.0: per-role caps. Empty string = no override.
            ai_cap_role_admin:          s.ai_cap_role_admin       || '',
            ai_cap_role_manager:        s.ai_cap_role_manager     || '',
            ai_cap_role_consultant:     s.ai_cap_role_consultant  || '',
            ai_cap_role_viewer:         s.ai_cap_role_viewer      || '',
          });
          setIngestCount(s._ingestCount || 0);
          if (s.AI_API_KEY && /^[•]+$/.test(s.AI_API_KEY.replace(/[^•.]/g, ''))) {
            setKeyIsMasked(true);
          } else if (s._apiKeySet) {
            setKeyIsMasked(true);
          }
        }
      })
      .finally(() => setLoading(false));
  }, []);

  function set(key, val) {
    setForm(f => ({ ...f, [key]: val }));
    if (key === 'AI_API_KEY') setKeyIsMasked(false);
    setSaved(false);
    setTestResult(null);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    const payload = { ...form };
    if (keyIsMasked) delete payload.AI_API_KEY;
    try {
      const r = await fetch(`${API}/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('servicecycle_token')}`,
        },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (d.success) {
        setSaved(true);
        // M4 fix (2026-05-12): bumped 3s -> 5s. Save confirmations
        // were getting missed; users need more reading time.
        setTimeout(() => setSaved(false), 5000);
        // v0.4.1 round-2 fix (#11): refresh AuthContext so the cached
        // user.account.aiBriefEnabled flips immediately. Without this,
        // toggling the AI Maintenance Brief OFF in Settings leaves the
        // asset-detail card-hide gate looking at stale state until
        // the next page reload — the card stays visible.
        if (typeof updateUser === 'function') {
          const patches = {};
          if (Object.prototype.hasOwnProperty.call(payload, 'aiBriefEnabled')) {
            patches.account = { ...(user?.account || {}), aiBriefEnabled: !!payload.aiBriefEnabled };
          }
          if (Object.prototype.hasOwnProperty.call(payload, 'aiConsentSilenced')) {
            patches.aiConsentSilenced = !!payload.aiConsentSilenced;
          }
          if (Object.keys(patches).length > 0) updateUser(patches);
        }
      } else {
        setError(d.error || 'Failed to save');
      }
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    const payload = { ...form };
    if (keyIsMasked) delete payload.AI_API_KEY;
    try {
      const r = await fetch(`${API}/settings/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('servicecycle_token')}`,
        },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      setTestResult({ ok: d.success, message: d.success ? d.message : d.error });
    } catch {
      setTestResult({ ok: false, message: 'Network error' });
    } finally {
      setTesting(false);
    }
  }

  const isAzure = form.AI_PROVIDER === 'azure_openai';

  async function handleExport() {
    setExporting(true);
    try {
      const r = await fetch(`${API}/settings/export`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('servicecycle_token')}` },
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(d.error || 'Export failed. Please try again.');
        return;
      }
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href     = url;
      a.download = `servicecycle-export-${date}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      alert('Export failed. Please check your connection and try again.');
    } finally {
      setExporting(false);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: '2rem', color: 'var(--color-text-secondary)' }}>
        Loading settings…
      </div>
    );
  }

  // The "Users & Roles" tab folds in Team Members + Permissions + Consultant
  // Access — per UX review 2026-05-01 it's the canonical place to manage who
  // can do what. The sidebar's standalone Team Members + Permissions links
  // were removed; the /users and /permissions routes still exist for direct
  // navigation and bookmarks.
  // v0.91 Phase 1a: TABS + GROUP_BEFORE removed - the two-level chrome
  // (Workspace / Integrations / Security top tabs + sub-pills) is owned
  // by SettingsTabRouter (client/src/pages/settings/). The per-section
  // display gating below still keys off the same activeTab state, so
  // section bodies remain in place until Phase 1b.
    const FORM_TABS = ['general', 'ai', 'security', 'storage']; // tabs that use the shared handleSave

  return (
    <div style={{ maxWidth: 760, padding: '2rem' }}>

      {/* Header */}
      <div style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-accent-strong)', letterSpacing: '-0.005em', marginBottom: '0.25rem' }}>
          Settings
        </h1>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem' }}>
          Configure your account, AI features, security, and integrations.
          {!isAdmin && ' (View only — admin access required to change settings.)'}
        </p>
      </div>

      <SettingsTabRouter
        activeSubTab={activeTab}
        onSubTabChange={(id) => {
          setActiveTab(id);
          window.history.replaceState(null, '', '?tab=' + id);
        }}
        isAdmin={isAdmin}
      />

            {/* T3-N3 (v0.71.7): tabpanel role wired to active tab so aria-controls resolves */}
      <form
        onSubmit={handleSave}
        role="tabpanel"
        id={`settings-tabpanel-${activeTab}`}
        aria-labelledby={`settings-tab-${activeTab}`}
        tabIndex={0}
      >

        {/* M4 fix (2026-05-12): top-of-form save confirmation banner.
            The inline "✓ Settings saved" near the Save button (line ~699)
            sits at the bottom of long forms where users miss it after
            clicking Save. This banner sits above every tab's content
            and uses the existing .alert.alert-success token so it picks
            up the palette automatically. The inline confirmation is
            preserved as a redundant fallback (also useful when the form
            is short and the button area IS in view). */}
        {saved && (
          <div
            className="alert alert-success"
            role="status"
            aria-live="polite"
            style={{ marginBottom: '1rem', fontSize: '0.9375rem', fontWeight: 500 }}
          >
            ✓ Settings saved
          </div>
        )}

        {/* ── AI & Extraction tab ─────────────────────────────── */}
        <div style={{ display: activeTab === 'ai' ? 'block' : 'none' }}>
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={sectionHeading}>AI Features</h2>
          <p style={sectionDesc}>
            When disabled, no equipment or maintenance data is sent to any external AI service.
            All uploads still work — AI extraction and maintenance briefs are simply turned off.
          </p>

          <label style={toggleRow}>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                Enable AI features
              </div>
              <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem', marginTop: 2 }}>
                Test-report extraction and maintenance brief generation
              </div>
            </div>
            <div
              role="switch"
              aria-checked={form.AI_ENABLED === 'true'}
              tabIndex={isAdmin ? 0 : -1}
              onClick={() => isAdmin && set('AI_ENABLED', form.AI_ENABLED === 'true' ? 'false' : 'true')}
              onKeyDown={e => e.key === ' ' && isAdmin && set('AI_ENABLED', form.AI_ENABLED === 'true' ? 'false' : 'true')}
              style={{
                ...toggle,
                background: form.AI_ENABLED === 'true' ? 'var(--accent)' : 'var(--color-text-muted)',
                cursor: isAdmin ? 'pointer' : 'not-allowed',
                opacity: isAdmin ? 1 : 0.6,
              }}
            >
              <div style={{
                ...toggleThumb,
                transform: form.AI_ENABLED === 'true' ? 'translateX(20px)' : 'translateX(2px)',
              }} />
            </div>
          </label>

          {/* Per-feature AI Maintenance Brief toggle. Sits below the master
              toggle. Disabled (greyed) when AI is turned off globally — the
              brief endpoint also requires AI_ENABLED so flipping this on
              while AI_ENABLED is false has no effect. */}
          <label style={{ ...toggleRow, opacity: form.AI_ENABLED === 'true' ? 1 : 0.5 }}>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                Enable AI Maintenance Brief
              </div>
              <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem', marginTop: 2 }}>
                Per-asset AI maintenance recommendation and compliance summary.
                {' '}Off by default. When on, the brief endpoint also enforces the per-session AI consent prompt.
              </div>
            </div>
            <div
              role="switch"
              aria-checked={form.aiBriefEnabled === true}
              tabIndex={isAdmin && form.AI_ENABLED === 'true' ? 0 : -1}
              onClick={() => isAdmin && form.AI_ENABLED === 'true' && set('aiBriefEnabled', !form.aiBriefEnabled)}
              onKeyDown={e => e.key === ' ' && isAdmin && form.AI_ENABLED === 'true' && set('aiBriefEnabled', !form.aiBriefEnabled)}
              style={{
                ...toggle,
                background: form.aiBriefEnabled === true ? 'var(--accent)' : 'var(--color-text-muted)',
                cursor: isAdmin && form.AI_ENABLED === 'true' ? 'pointer' : 'not-allowed',
                opacity: isAdmin && form.AI_ENABLED === 'true' ? 1 : 0.6,
              }}
            >
              <div style={{
                ...toggleThumb,
                transform: form.aiBriefEnabled === true ? 'translateX(20px)' : 'translateX(2px)',
              }} />
            </div>
          </label>

          {/* ── v0.18.0: opt-in upstream anonymous feedback sync ─────────────── */}
          {/* Admin-only. Only visible when the AI Maintenance Brief is on,   */}
          {/* since feedback is generated by the brief feature. Sends         */}
          {/* anonymous thumbs ratings upstream; no PII leaves the server —   */}
          {/* instanceId is a truncated SHA-256 hash of accountId.            */}
          {isAdmin && form.aiBriefEnabled && (
            <label style={{ ...toggleRow, opacity: form.AI_ENABLED === 'true' ? 1 : 0.5 }}>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                  Help improve ServiceCycle templates
                </div>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem', marginTop: 2 }}>
                  Anonymously share thumbs-up/down ratings from AI maintenance brief output with ForgeRift.
                  {' '}No account name, user identity, or equipment data leaves your server — only an
                  {' '}anonymous instance ID and the rating. Free-text feedback is included only if provided.
                </div>
              </div>
              <div
                role="switch"
                aria-checked={form.aiFeedbackUpstreamEnabled === true}
                tabIndex={isAdmin && form.AI_ENABLED === 'true' ? 0 : -1}
                onClick={() => isAdmin && form.AI_ENABLED === 'true' && set('aiFeedbackUpstreamEnabled', !form.aiFeedbackUpstreamEnabled)}
                onKeyDown={e => e.key === ' ' && isAdmin && form.AI_ENABLED === 'true' && set('aiFeedbackUpstreamEnabled', !form.aiFeedbackUpstreamEnabled)}
                style={{
                  ...toggle,
                  background: form.aiFeedbackUpstreamEnabled === true ? 'var(--accent)' : 'var(--color-text-muted)',
                  cursor: isAdmin && form.AI_ENABLED === 'true' ? 'pointer' : 'not-allowed',
                  opacity: isAdmin && form.AI_ENABLED === 'true' ? 1 : 0.6,
                }}
              >
                <div style={{
                  ...toggleThumb,
                  transform: form.aiFeedbackUpstreamEnabled === true ? 'translateX(20px)' : 'translateX(2px)',
                }} />
              </div>
            </label>
          )}

          {/* ── Phase 4: per-USER "Don't ask me each session" consent silence ──── */}
          {/* This is a personal preference — not admin-gated. */}
          <label style={toggleRow}>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                Don't ask me each session
              </div>
              <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem', marginTop: 2 }}>
                Suppress the AI provider acknowledgment modal for your account.
                {' '}Affects only your sign-in; other users on this instance keep
                {' '}the per-session prompt unless they silence it themselves.
              </div>
            </div>
            <div
              role="switch"
              aria-checked={form.aiConsentSilenced === true}
              tabIndex={0}
              onClick={() => set('aiConsentSilenced', !form.aiConsentSilenced)}
              onKeyDown={e => e.key === ' ' && set('aiConsentSilenced', !form.aiConsentSilenced)}
              style={{
                ...toggle,
                background: form.aiConsentSilenced === true ? 'var(--accent)' : 'var(--color-text-muted)',
                cursor: 'pointer',
              }}
            >
              <div style={{
                ...toggleThumb,
                transform: form.aiConsentSilenced === true ? 'translateX(20px)' : 'translateX(2px)',
              }} />
            </div>
          </label>

          {/* ── v0.66.0: per-role daily AI-call caps ───────────────────────────── */}
          {/* Admin-only. Sum across all AI actions (ingest_extract + ask +
              maintenance_brief + narrate). Lowest cap wins between this and
              per-action caps. Empty input = use built-in default (admin=unlimited,
              manager=100, consultant=50, viewer=20). Self-host operators
              can also pin via env AI_DAILY_CAP_PER_USER_ROLE_<ROLE>. */}
          {isAdmin && (
            <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: '1.25rem', marginTop: '1rem' }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.95rem', marginBottom: '0.25rem' }}>
                Daily AI calls per role
              </div>
              <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem', marginBottom: '1rem', lineHeight: 1.5 }}>
                Maximum AI calls a user in each role can make per UTC day, summed across all AI actions.
                Leave blank to use the built-in default. Set to 0 to block AI for that role entirely.
                Lower of this cap and any per-action cap applies.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
                {[
                  { key: 'ai_cap_role_admin',      label: 'Admin',      placeholder: 'unlimited' },
                  { key: 'ai_cap_role_manager',    label: 'Manager',    placeholder: '100' },
                  { key: 'ai_cap_role_consultant', label: 'Consultant', placeholder: '50' },
                  { key: 'ai_cap_role_viewer',     label: 'Viewer',     placeholder: '20' },
                ].map(({ key, label, placeholder }) => (
                  <div key={key}>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '0.25rem' }}>
                      {label}
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={form[key]}
                      placeholder={placeholder}
                      onChange={e => set(key, e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.5rem 0.65rem',
                        fontSize: '0.9rem',
                        borderRadius: 6,
                        border: '1px solid var(--color-border)',
                        background: 'var(--color-surface, #fff)',
                        color: 'var(--color-text)',
                      }}
                    />
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: '0.75rem', fontStyle: 'italic' }}>
                Tip: Admins typically stay unlimited so operations work isn't bottlenecked. Cap viewers + consultants if AI provider cost is a concern.
              </div>
            </div>
          )}
        </section>

        {/* ── AI Provider ──────────────────────────────────────── */}
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={sectionHeading}>AI Provider</h2>
          <p style={sectionDesc}>
            Select which AI service processes your uploaded documents and test reports.
            Each provider requires its own API key.
          </p>

          <div style={formGrid}>
            <div style={fieldGroup}>
              <label style={fieldLabel}>Provider</label>
              <select
                aria-label="AI provider"
                value={form.AI_PROVIDER}
                onChange={e => set('AI_PROVIDER', e.target.value)}
                disabled={!isAdmin}
                style={select}
              >
                {PROVIDERS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            <div style={fieldGroup}>
              <label style={fieldLabel}>
                API Key
                {keyIsMasked && (
                  <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400, marginLeft: 6 }}>
                    (key saved — enter new value to replace)
                  </span>
                )}
              </label>
              <PasswordInput
                
                placeholder={keyIsMasked ? '••••••••••••••••' : 'Enter API key'}
                value={keyIsMasked ? '' : form.AI_API_KEY}
                onChange={e => set('AI_API_KEY', e.target.value)}
                disabled={!isAdmin}
                style={input}
                autoComplete="off"
              />
            </div>

            <div style={fieldGroup}>
              <label style={fieldLabel}>
                Model Override
                <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400, marginLeft: 6 }}>
                  (optional — default: {DEFAULT_MODELS[form.AI_PROVIDER] || 'provider default'})
                </span>
              </label>
              <input
                type="text"
                placeholder={DEFAULT_MODELS[form.AI_PROVIDER] || 'e.g. gpt-4o'}
                value={form.AI_MODEL}
                onChange={e => set('AI_MODEL', e.target.value)}
                disabled={!isAdmin}
                style={input}
              />
            </div>
          </div>
        </section>

        {/* ── Azure-specific ────────────────────────────────────── */}
        {isAzure && (
          <section style={{ marginBottom: '2rem' }}>
            <h2 style={sectionHeading}>Azure OpenAI Configuration</h2>
            <p style={sectionDesc}>
              Required when using Azure OpenAI. Your data stays entirely within your Microsoft tenant.
            </p>

            <div style={formGrid}>
              <div style={fieldGroup}>
                <label style={fieldLabel}>Azure Endpoint</label>
                <input
                  type="text"
                  placeholder="https://your-tenant.openai.azure.com"
                  value={form.AZURE_OPENAI_ENDPOINT}
                  onChange={e => set('AZURE_OPENAI_ENDPOINT', e.target.value)}
                  disabled={!isAdmin}
                  style={input}
                />
              </div>
              <div style={fieldGroup}>
                <label style={fieldLabel}>Deployment Name</label>
                <input
                  type="text"
                  placeholder="gpt-4o"
                  value={form.AZURE_OPENAI_DEPLOYMENT}
                  onChange={e => set('AZURE_OPENAI_DEPLOYMENT', e.target.value)}
                  disabled={!isAdmin}
                  style={input}
                />
              </div>
              <div style={fieldGroup}>
                <label style={fieldLabel}>API Version</label>
                <input
                  type="text"
                  placeholder="2024-02-01"
                  value={form.AZURE_API_VERSION}
                  onChange={e => set('AZURE_API_VERSION', e.target.value)}
                  disabled={!isAdmin}
                  style={input}
                />
              </div>
            </div>
          </section>
        )}

        </div>{/* end AI tab */}

        {/* ── Storage & Backup tab ─────────────────────────────── */}
        <div style={{ display: activeTab === 'storage' ? 'block' : 'none' }}>
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={sectionHeading}>Document Storage</h2>
          <p style={sectionDesc}>
            Where uploaded documents and test reports are stored on this instance.
            <strong> Local</strong> stores files relative to the app install directory.
            <strong> Custom path</strong> lets you map any local, network share, or mounted cloud folder.
            <strong> S3-compatible</strong> uploads to any S3-compatible bucket (AWS S3, Backblaze B2, Wasabi, Cloudflare R2, or self-hosted MinIO).
          </p>

          <div style={formGrid}>
            <div style={fieldGroup}>
              <label style={fieldLabel}>Storage provider</label>
              <select
                aria-label="Storage provider"
                value={form.STORAGE_PROVIDER}
                onChange={e => set('STORAGE_PROVIDER', e.target.value)}
                disabled={!isAdmin}
                style={select}
              >
                {STORAGE_PROVIDERS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            {form.STORAGE_PROVIDER === 'custom' && (
              <div style={fieldGroup}>
                <label style={fieldLabel}>
                  Storage path
                  <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400, marginLeft: 6 }}>
                    (absolute path, e.g. /mnt/nas/servicecycle or C:\Storage\ServiceCycle)
                  </span>
                </label>
                <input
                  type="text"
                  placeholder="/mnt/nas/servicecycle-docs"
                  value={form.STORAGE_PATH}
                  onChange={e => set('STORAGE_PATH', e.target.value)}
                  disabled={!isAdmin}
                  style={input}
                />
              </div>
            )}

            {form.STORAGE_PROVIDER === 's3' && (
              <div style={{ padding: '0.75rem 1rem', borderRadius: 6, background: 'var(--color-primary-light)', border: '1px solid #bfdbfe', fontSize: '0.82rem', color: 'var(--color-primary-hover)', lineHeight: 1.5 }}>
                S3-compatible storage is configured via environment variables on the server: <code>STORAGE_S3_BUCKET</code>,{' '}
                <code>STORAGE_S3_REGION</code>, <code>STORAGE_S3_KEY_ID</code>, <code>STORAGE_S3_SECRET</code>, and
                optionally <code>STORAGE_S3_ENDPOINT</code> for non-AWS providers. Update your <code>.env</code> file
                and restart the server.
              </div>
            )}
          </div>
        </section>

        </div>{/* end Storage tab */}

        {/* ── General tab ──────────────────────────────────────── */}
        <div style={{ display: activeTab === 'general' ? 'block' : 'none' }}>
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={sectionHeading}>Company</h2>
          <p style={sectionDesc}>
            The company name shown across this ServiceCycle instance. Set at registration.
          </p>
          <div style={{ maxWidth: 320 }}>
            <label style={fieldLabel}>Company name</label>
            <input
              type="text"
              style={fieldInput}
              value={user?.account?.companyName || ''}
              disabled
              readOnly
              aria-label="Company name"
            />
          </div>
        </section>

        <section style={{ marginBottom: '2rem' }}>
          <h2 style={sectionHeading}>Account Preferences</h2>
          <p style={sectionDesc}>
            Set your fiscal year start month. This controls how maintenance schedules are grouped in the
            Quarter and Fiscal Year calendar views.
          </p>
          <div style={{ maxWidth: 320 }}>
            <label style={fieldLabel}>Fiscal year starts in</label>
            <select
              aria-label="Fiscal year starts in"
              style={fieldInput}
              value={form.FISCAL_YEAR_START_MONTH}
              onChange={e => set('FISCAL_YEAR_START_MONTH', e.target.value)}
              disabled={!isAdmin}
            >
              {['January','February','March','April','May','June',
                'July','August','September','October','November','December'].map((name, i) => (
                <option key={i + 1} value={String(i + 1)}>
                  {name}{i === 0 ? ' (calendar year default)' : ''}
                </option>
              ))}
            </select>
            <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', marginTop: 6 }}>
              Example: select July for a Jul 1 – Jun 30 fiscal year. Every grouped view updates instantly.
            </p>
          </div>
        </section>

        <section style={{ marginBottom: '2rem' }}>
          <h2 style={sectionHeading}>Headcount</h2>
          <p style={sectionDesc}>
            Total headcount for this account. Drives per-employee KPIs in reports.
            Single value, not per-department. Admin-only.
          </p>
          <div style={{ maxWidth: 320 }}>
            <label style={fieldLabel}>Total employees (FTE)</label>
            <input
              type="number"
              min={0}
              max={1000000}
              step={1}
              style={fieldInput}
              placeholder="e.g. 250"
              value={form.fteCount}
              onChange={e => set('fteCount', e.target.value)}
              disabled={!isAdmin}
            />
            <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', marginTop: 6 }}>
              Leave blank to hide per-employee KPIs. Range: 0 - 1,000,000.
            </p>
          </div>
        </section>

        </div>{/* end General tab */}

        {/* ── Security tab ─────────────────────────────────────── */}
        <div style={{ display: activeTab === 'security' ? 'block' : 'none' }}>
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={sectionHeading}>Password Policy</h2>
          <p style={sectionDesc}>
            Applied when team members set or reset passwords. Applies to all invite
            acceptances and password resets on this account. Register (new account creation)
            always uses the system default of 12 characters + number + special character.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', maxWidth: 480 }}>
            {/* Min length */}
            <div style={fieldGroup}>
              <label style={fieldLabel}>Minimum password length</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="number"
                  min={8}
                  max={64}
                  value={form.PASSWORD_MIN_LENGTH}
                  onChange={e => set('PASSWORD_MIN_LENGTH', e.target.value)}
                  disabled={!isAdmin}
                  style={{ ...input, width: 80 }}
                />
                <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                  characters (minimum 8, recommended 12+)
                </span>
              </div>
            </div>

            {/* Require number */}
            <label style={toggleRow}>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                  Require at least one number
                </div>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem', marginTop: 2 }}>
                  Password must contain at least one digit (0–9)
                </div>
              </div>
              <div
                role="switch"
                aria-checked={form.PASSWORD_REQUIRE_NUMBER === 'true'}
                tabIndex={isAdmin ? 0 : -1}
                onClick={() => isAdmin && set('PASSWORD_REQUIRE_NUMBER', form.PASSWORD_REQUIRE_NUMBER === 'true' ? 'false' : 'true')}
                onKeyDown={e => e.key === ' ' && isAdmin && set('PASSWORD_REQUIRE_NUMBER', form.PASSWORD_REQUIRE_NUMBER === 'true' ? 'false' : 'true')}
                style={{ ...toggle, background: form.PASSWORD_REQUIRE_NUMBER === 'true' ? 'var(--accent)' : 'var(--color-text-muted)', cursor: isAdmin ? 'pointer' : 'not-allowed', opacity: isAdmin ? 1 : 0.6 }}
              >
                <div style={{ ...toggleThumb, transform: form.PASSWORD_REQUIRE_NUMBER === 'true' ? 'translateX(20px)' : 'translateX(2px)' }} />
              </div>
            </label>

            {/* Require special */}
            <label style={toggleRow}>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                  Require at least one special character
                </div>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem', marginTop: 2 }}>
                  Password must contain at least one non-alphanumeric character (!@#$%^&* etc.)
                </div>
              </div>
              <div
                role="switch"
                aria-checked={form.PASSWORD_REQUIRE_SPECIAL === 'true'}
                tabIndex={isAdmin ? 0 : -1}
                onClick={() => isAdmin && set('PASSWORD_REQUIRE_SPECIAL', form.PASSWORD_REQUIRE_SPECIAL === 'true' ? 'false' : 'true')}
                onKeyDown={e => e.key === ' ' && isAdmin && set('PASSWORD_REQUIRE_SPECIAL', form.PASSWORD_REQUIRE_SPECIAL === 'true' ? 'false' : 'true')}
                style={{ ...toggle, background: form.PASSWORD_REQUIRE_SPECIAL === 'true' ? 'var(--accent)' : 'var(--color-text-muted)', cursor: isAdmin ? 'pointer' : 'not-allowed', opacity: isAdmin ? 1 : 0.6 }}
              >
                <div style={{ ...toggleThumb, transform: form.PASSWORD_REQUIRE_SPECIAL === 'true' ? 'translateX(20px)' : 'translateX(2px)' }} />
              </div>
            </label>
          </div>

          {/* Live preview */}
          <div style={{ marginTop: '0.875rem', padding: '0.75rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Current requirement: </span>
            At least {form.PASSWORD_MIN_LENGTH || 12} characters
            {form.PASSWORD_REQUIRE_NUMBER === 'true' ? ', one number' : ''}
            {form.PASSWORD_REQUIRE_SPECIAL === 'true' ? ', one special character' : ''}.
          </div>
        </section>

        </div>{/* end Security tab */}

        {/* ProviderInfo only relevant on AI tab */}
        <div style={{ display: activeTab === 'ai' ? 'block' : 'none' }}>
          <ProviderInfo provider={form.AI_PROVIDER} />
        </div>

        {/* ── Actions: show on any form tab ──────────────────────── */}
        {isAdmin && FORM_TABS.includes(activeTab) && (
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '1.5rem' }}>
            <button type="submit" disabled={saving} style={btnPrimary}>
              {saving ? 'Saving…' : 'Save Settings'}
            </button>
            {activeTab === 'ai' && (
              <button type="button" onClick={handleTest} disabled={testing} style={btnSecondary}>
                {testing ? 'Testing…' : 'Test Connection'}
              </button>
            )}
            {saved && (
              <span style={{ color: 'var(--color-success)', fontSize: '0.875rem', fontWeight: 500 }}>
                {'✓'} Settings saved
              </span>
            )}
            {error && (
              <span style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</span>
            )}
          </div>
        )}

        {testResult && (
          <div style={{
            marginTop: '1rem',
            padding: '0.75rem 1rem',
            borderRadius: 6,
            background: testResult.ok ? '#f0fdf4' : 'var(--color-danger-bg)',
            border: `1px solid ${testResult.ok ? '#bbf7d0' : 'var(--color-danger)'}`,
            color: testResult.ok ? '#15803d' : 'var(--color-danger)',
            fontSize: '0.875rem',
          }}>
            {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
          </div>
        )}

      </form>

      {/* ── AI Ingestion Usage — AI tab ──────────────────────── */}
      {isAdmin && activeTab === 'ai' && (
        <div style={{ marginTop: '2rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.5rem' }}>AI Ingestion Usage</h2>
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', marginBottom: '1rem' }}>
            Tracks how many AI document extractions this account has used. The default free limit is 10.
            Paid accounts can have this limit increased.
          </p>
          {(() => {
            const limit     = parseInt(form.AI_INGEST_LIMIT || '10', 10);
            const pct       = Math.min(100, Math.round((ingestCount / limit) * 100));
            const remaining = Math.max(0, limit - ingestCount);
            const atLimit   = ingestCount >= limit;
            const barColor  = atLimit ? '#b91c1c' : remaining <= 2 ? '#b45309' : 'var(--color-primary)';
            return (
              <div style={{ padding: '1rem 1.25rem', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>
                    {ingestCount} of {limit} AI imports used
                  </span>
                  <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                    {remaining} remaining
                  </span>
                </div>
                <div style={{ height: 8, background: 'var(--color-border-strong)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 4 }} />
                </div>
              </div>
            );
          })()}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ fontSize: '0.875rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
              Limit for this account
            </label>
            <input
              type="number"
              min={1}
              max={9999}
              value={form.AI_INGEST_LIMIT}
              onChange={e => set('AI_INGEST_LIMIT', e.target.value)}
              style={{ width: 100, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--color-border-strong)', fontSize: '0.875rem', background: 'var(--color-surface)', color: 'var(--color-text)' }}
            />
            <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
              Save settings above to apply
            </span>
          </div>
        </div>
      )}

      {/* ── AI Daily Caps — AI tab, admin only ───────────────── */}
      {isAdmin && activeTab === 'ai' && <AiCapsSection />}

      {/* (A4) Demo Reset — only on demo instances, top of the data tab.
              Sales prospects who pollute the seed data can hit this instead
              of waiting for the 03:30 nightly reset cron. */}
      {isAdmin && demoMode && activeTab === 'data' && <DemoResetSection />}

      {/* ── Account Data Export — data tab ───────────────────── */}
      {isAdmin && activeTab === 'data' && (
        <div style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.5rem' }}>Account Data Export</h2>
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', marginBottom: '1rem', lineHeight: 1.6 }}>
            Download a complete export of your account data as a ZIP archive. Includes all assets (CSV + JSON),
            contractors, activity log, and a document manifest. Useful for backups, audits, or migrating to another instance.
          </p>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            style={{
              ...btnSecondary,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {exporting ? (
              <>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ animation: 'spin 1s linear infinite' }}>
                  <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="10 6" />
                </svg>
                Generating export…
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M7 1v8M4 6l3 3 3-3M2 11h10" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Download Export
              </>
            )}
          </button>
          <p style={{ fontSize: '0.775rem', color: 'var(--color-text-secondary)', marginTop: 8 }}>
            Export includes assets.csv, assets.json, contractors.json, activity_log.json, documents.json
          </p>
        </div>
      )}

      {/* ── Alert Preferences — alerts tab ───────────────────── */}
      {activeTab === 'alerts' && (
        <>
          <AlertPreferencesSection />
          {isAdmin && <SlackIntegrationSection />}
          {isAdmin && <TeamsIntegrationSection />}
        </>
      )}

      {/* ── Custom Fields — customfields tab ───────────────────── */}
      {activeTab === 'customfields' && <CustomFieldsSection isAdmin={isAdmin} />}

      {/* ── Electrical Maintenance Program — emp tab ─────────────── */}
      {/* NFPA 70B:2023 §4.2 written-EMP settings: coordinator, retention
          policy, review interval, and document generation. */}
      {activeTab === 'emp' && <EmpSection isAdmin={isAdmin} />}

      {/* ── API Keys — admin-only (v0.20.0) ─────────────────────────────── */}
      {isAdmin && activeTab === 'api-keys' && <ApiKeysSection />}

      {/* ── Webhooks — admin-only (v0.24.0) ────────────────────────────── */}
      {isAdmin && activeTab === 'webhooks' && <><WebhooksSection /><ImportWebhookSection /><DlqPanel /></>}

      {/* ── Users & Roles — access tab ────────────────────────── */}
      {/* Per UX review 2026-05-01: Team Members + Permissions + Consultant
          Access live together here as the canonical role-management surface.
          Each subsection retains its own save flow; no global "Save tab". */}
      {activeTab === 'access' && (
        <div>
          {!isAdmin && (
            <div style={{ padding: '1rem 1.25rem', borderRadius: 6, background: 'var(--color-surface)', border: '1px solid var(--color-border)', fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
              View only — admin access is required to manage users, roles, or permissions.
            </div>
          )}
          {isAdmin && (
            <>
              {/* Team Members — embeds UsersPage. The component owns its
                  own page-header + page-body shell, which renders fine
                  inline within the Settings tab content area. */}
              <section style={{ marginBottom: '2.5rem' }}>
                <UsersPage />
              </section>

              {/* Permissions — embeds PermissionsPage with the same approach. */}
              <section style={{ marginBottom: '2.5rem' }}>
                <PermissionsPage />
              </section>

              {/* Consultant Access — already settings-resident; one of the
                  three role-management surfaces this tab unifies. */}
              <section>
                <ConsultantAccessSection />
              </section>
            </>
          )}
        </div>
      )}

      {/* ── Backup — storage tab ──────────────────────────────── */}
      {isAdmin && activeTab === 'storage' && <BackupSection />}

      {/* ── Document Encryption — encryption tab ──────────────── */}
      {isAdmin && activeTab === 'encryption' && <EncryptionSection />}

    </div>
  );
}

// ── Provider info blurbs ──────────────────────────────────────────────────────

function ProviderInfo({ provider }) {
  const info = {
    anthropic: {
      color: 'var(--color-warning)', bg: 'var(--color-warning-bg)', border: 'var(--color-warning)',
      title: 'Anthropic Claude',
      body: 'Fast, accurate document extraction. Get your API key at console.anthropic.com. Default model: claude-haiku-4-5-20251001 (cost-effective for extraction workloads).',
    },
    openai: {
      color: '#059669', bg: 'var(--color-success-bg)', border: 'var(--color-success)',
      title: 'OpenAI',
      body: 'GPT-4o and variants. Get your API key at platform.openai.com. Default model: gpt-4o-mini. Use gpt-4o for higher accuracy on complex documents.',
    },
    azure_openai: {
      color: 'var(--color-primary)', bg: 'var(--color-primary-light)', border: 'var(--color-info)',
      title: 'Azure OpenAI',
      body: 'Runs on the same GPT models but entirely within your Microsoft Azure tenant — no data leaves your environment. Requires an Azure OpenAI resource with a deployed model. Ideal for M365 E5/E7 customers and organizations with strict data residency requirements.',
    },
    gemini: {
      color: 'var(--color-renewal-text)', bg: 'var(--color-renewal-bg)', border: 'var(--color-renewal-border)',
      title: 'Google Gemini',
      body: 'Google\'s Gemini models via AI Studio or Vertex AI. Get your API key at aistudio.google.com. Default model: gemini-1.5-flash.',
    },
  };

  const i = info[provider];
  if (!i) return null;

  return (
    <div style={{ padding: '0.875rem 1rem', borderRadius: 8, background: i.bg, border: `1px solid ${i.border}`, marginBottom: '0.5rem' }}>
      <div style={{ fontWeight: 600, color: i.color, fontSize: '0.875rem', marginBottom: 4 }}>{i.title}</div>
      <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem', lineHeight: 1.5 }}>{i.body}</div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const sectionHeading = {
  fontSize: '0.9rem',
  fontWeight: 700,
  color: 'var(--text-primary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '0.25rem',
};

const sectionDesc = {
  fontSize: '0.825rem',
  color: 'var(--color-text-secondary)',
  marginBottom: '1rem',
  lineHeight: 1.5,
};

const formGrid  = { display: 'flex', flexDirection: 'column', gap: '0.875rem' };
const fieldGroup = { display: 'flex', flexDirection: 'column', gap: '0.3rem' };
const fieldLabel = { fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' };

const input = {
  padding: '0.55rem 0.75rem',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: '0.875rem',
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

const select     = { ...input, cursor: 'pointer' };
const fieldInput = { ...input, cursor: 'pointer' }; // alias used in Account Preferences

// v0.4.1 fix (UI/11): toggleRow now uses a grid that pins the switch to
// the row's right edge — every toggle across the AI / Security / Storage
// / Account-prefs tabs now lines up at the same vertical column. The
// previous space-between layout drifted with description length.
const toggleRow = {
  display: 'grid',
  gridTemplateColumns: '1fr 44px',
  alignItems: 'center',
  gap: 16,
  padding: '0.75rem 1rem',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  cursor: 'pointer',
  marginBottom: 8,
};

// v0.4.1 fix (UI/11): OFF state was previously #ccc (very low contrast on
// our cream background — users routinely missed the control). Bumped to
// a darker neutral with a visible border so the switch reads as a real
// affordance from a foot away.
const toggle = {
  width: 44, height: 24, borderRadius: 12,
  position: 'relative', transition: 'background 0.2s', flexShrink: 0,
  border: '1px solid var(--border, #9aa3b2)',
};

const toggleThumb = {
  position: 'absolute', top: 1, width: 20, height: 20,
  borderRadius: '50%', background: 'var(--color-surface)',
  boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
  transition: 'transform 0.2s',
};

// 2026-05-10 review M7 fix: btnPrimary previously referenced the undefined
// CSS variable `--accent`, which fell through to no background — the
// "Save Settings" button rendered as transparent text and was practically
// invisible. Same for btnSecondary's `--text-primary` / `--border`.
// Aligned to the actual variable names from index.css.
const btnPrimary = {
  padding: '0.55rem 1.25rem',
  background: 'var(--color-primary)', color: 'var(--color-surface)',
  border: 'none', borderRadius: 6,
  fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
  // Explicit disabled state — opacity:0.5 on a real blue is readable;
  // opacity:0.5 on transparent (the old bug) was not.
};

// v0.4.2 round-3: secondary buttons were too faint. Was transparent
// background + 1px grey border + 500-weight; users routinely missed
// them. Bumped to filled neutral background + stronger border +
// 600-weight so they read as real affordances on every tab.
const btnSecondary = {
  padding: '0.55rem 1.25rem',
  background: 'var(--color-surface-alt, #f3f4f6)',
  color: 'var(--color-text, #1f2937)',
  border: '1px solid var(--color-border-strong, #9aa3b2)',
  borderRadius: 6,
  fontSize: '0.875rem',
  fontWeight: 600,
  cursor: 'pointer',
};

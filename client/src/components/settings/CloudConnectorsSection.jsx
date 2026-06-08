import React, { useState, useEffect, useCallback } from 'react';
import { useConfirm } from '../../context/ConfirmContext';
import api from '../../api/client';

import { sectionHeading, sectionDesc, btnPrimary, btnSecondary } from './sharedStyles';

// ── Cloud Connectors Section ──────────────────────────────────────────────────

const PROVIDER_META = {
  aws: {
    name:       'Amazon Web Services',
    shortName:  'AWS',
    desc:       'Import software subscriptions and Marketplace purchases from your AWS account.',
    accentColor: '#FF9900', // brand: AWS identification color -- keep raw
    bgColor:    'rgba(255,153,0,0.06)',
    borderColor: 'rgba(255,153,0,0.25)',
    logo: (
      <svg viewBox="0 0 48 48" style={{ width: 32, height: 32 }} fill="none">
        <text y="30" fontSize="11" fontWeight="700" fill="#FF9900" fontFamily="sans-serif">AWS</text>
      </svg>
    ),
  },
  azure: {
    name:       'Microsoft Azure',
    shortName:  'Azure',
    desc:       'Import Azure Marketplace purchases and software subscriptions from your Microsoft tenant.',
    accentColor: '#0078d4', // brand: Azure identification color -- keep raw
    bgColor:    'rgba(0,120,212,0.05)',
    borderColor: 'rgba(0,120,212,0.2)',
    logo: null,
  },
  gcp: {
    name:       'Google Cloud',
    shortName:  'GCP',
    desc:       'Import Google Cloud Marketplace purchases and entitlements from your GCP billing account.',
    accentColor: '#4285f4', // brand: Google Cloud identification color -- keep raw
    bgColor:    'rgba(66,133,244,0.05)',
    borderColor: 'rgba(66,133,244,0.2)',
    logo: null,
  },
};

// Per-provider field definitions (mirrors server/lib/cloudConnectors/*.js)
const PROVIDER_FIELDS = {
  aws: [
    { key: 'accessKeyId',      label: 'Access Key ID',       type: 'text',     placeholder: 'AKIAIOSFODNN7EXAMPLE',   help: 'Found in IAM → Users → Security credentials. Starts with AKIA.' },
    { key: 'secretAccessKey',  label: 'Secret Access Key',   type: 'password', placeholder: 'wJalrXUtnFEMI/K7MDENG…', help: 'Only shown once when the IAM key is created.' },
    { key: 'accountId',        label: 'AWS Account ID',      type: 'text',     placeholder: '123456789012',            help: '12-digit number shown in the top-right of the AWS console.' },
    {
      key: 'region', label: 'Region', type: 'select',
      options: ['us-east-1','us-east-2','us-west-1','us-west-2','eu-west-1','eu-west-2','eu-central-1','ap-southeast-1','ap-southeast-2','ap-northeast-1','ap-south-1','ca-central-1'],
      default: 'us-east-1', help: 'Region where your Marketplace subscriptions are managed.',
    },
  ],
  azure: [
    { key: 'tenantId',       label: 'Tenant ID (Directory ID)',  type: 'text',     placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', help: 'Azure AD → Overview → Directory (tenant) ID.' },
    { key: 'clientId',       label: 'Client ID (Application ID)', type: 'text',    placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', help: 'Azure AD → App Registrations → your app → Application (client) ID.' },
    { key: 'clientSecret',   label: 'Client Secret',             type: 'password', placeholder: 'Your application client secret value',  help: 'App Registrations → your app → Certificates & Secrets → Value.' },
    { key: 'subscriptionId', label: 'Subscription ID',           type: 'text',     placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', help: 'Azure Portal → Subscriptions. The subscription whose purchases you want to import.' },
  ],
  gcp: [
    { key: 'projectId',           label: 'Project ID',                    type: 'text',     placeholder: 'my-project-123456',                                help: 'Lowercase letters, numbers, hyphens. Found in the project selector at the top of the console.' },
    { key: 'billingAccountId',    label: 'Billing Account ID',            type: 'text',     placeholder: 'XXXXXX-XXXXXX-XXXXXX',                             help: 'Billing → Manage Billing Accounts. Format: 6-6-6 alphanumeric groups.' },
    { key: 'serviceAccountEmail', label: 'Service Account Email',         type: 'text',     placeholder: 'reader@my-project.iam.gserviceaccount.com',         help: 'IAM & Admin → Service Accounts. Full email ending in .iam.gserviceaccount.com.' },
    // nosemgrep: generic.secrets.security.detected-google-gcm-service-account.detected-google-gcm-service-account -- placeholder example shown to user; not a real key.
    { key: 'serviceAccountKey',   label: 'Service Account Key (JSON)',    type: 'textarea', placeholder: '{\n  "type": "service_account",\n  ...\n}',           help: 'Paste the full contents of the JSON key file from IAM → Service Accounts → Keys.' },
  ],
};

const PROVIDER_SETUP = {
  aws: `1. Open AWS Console → IAM → Users → Create user.\n2. Name the user (e.g. "lapseiq-reader") and select Programmatic access.\n3. Attach a custom policy with: aws-marketplace:ListEntities, aws-marketplace:DescribeEntity, ce:GetCostAndUsage.\n4. Copy the Access Key ID and Secret Access Key.\n5. Paste both below along with your 12-digit AWS Account ID.`,
  azure: `1. Azure Portal → Azure Active Directory → App Registrations → New Registration.\n2. Name the app "LapseIQ Connector", choose accounts in this org, and register.\n3. Copy the Application (client) ID and Directory (tenant) ID from Overview.\n4. Go to Certificates & Secrets → New Client Secret — copy the generated Value.\n5. Open Subscriptions → your subscription → Access Control (IAM) → Add role assignment → Billing Reader → assign to your app.\n6. Enter all four IDs below.`,
  gcp: `1. Google Cloud Console → IAM & Admin → Service Accounts → Create Service Account.\n2. Name it (e.g. "lapseiq-reader") and grant: Billing Viewer + Cloud Commerce Consumer Admin roles.\n3. Click Done, open the service account → Keys → Add Key → JSON. Download the file.\n4. Paste the JSON key file contents into the field below, along with your Project ID and Billing Account ID.`,
};


function _fmtSyncTime(isoStr) {
  if (!isoStr) return '';
  const d   = new Date(isoStr);
  const now  = new Date();
  const diffMs = now - d;
  const diffH  = diffMs / 3600000;
  const diffD  = diffMs / 86400000;
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffH < 1)   return `${Math.round(diffMs / 60000)} min ago`;
  if (diffH < 24)  return `today at ${timeStr}`;
  if (diffD < 2)   return `yesterday at ${timeStr}`;
  return `${d.toLocaleDateString()} at ${timeStr}`;
}

// Form-field style primitives for the expanded configure panel. These were
// referenced (fieldGroup/fieldLabel/input/select) but never declared after an
// earlier refactor, which crashed the panel on open with a ReferenceError.
const fieldGroup = { display: 'flex', flexDirection: 'column', gap: 6 };
const fieldLabel = { fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text)' };
const input = {
  padding: '8px 11px',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  fontSize: '0.85rem',
  width: '100%',
  boxSizing: 'border-box',
};
const select = { ...input };

export default function CloudConnectorsSection() {
  const confirm = useConfirm();
  const [connectors, setConnectors]   = useState({});  // { aws: {...}, azure: {...}, gcp: {...} }
  const [loading, setLoading]         = useState(true);
  const [openPanel, setOpenPanel]     = useState(null); // provider key or null
  const [panelCreds, setPanelCreds]   = useState({});   // { [field.key]: value }
  const [panelLabel, setPanelLabel]   = useState('');
  const [saving, setSaving]           = useState(false);
  const [testing, setTesting]         = useState(false);
  const [panelMsg, setPanelMsg]       = useState(null); // { ok, text }
  const [disconnecting, setDisconnecting] = useState(null);
  const [syncing, setSyncing]             = useState(null); // provider key or null
  const [syncResult, setSyncResult]       = useState(null); // { provider, created, updated, error }

  const load = useCallback(() => {
    setLoading(true);
    api.get('/api/cloud-connectors')
      .then(r => {
        const map = {};
        (r.data.data?.connectors || []).forEach(c => { map[c.id === null ? c.shortName?.toLowerCase() : c.id] = c; });
        // Rekey by provider shortName (aws/azure/gcp)
        const byProvider = {};
        (r.data.data?.connectors || []).forEach(c => {
          const key = c.shortName?.toLowerCase();
          if (key) byProvider[key] = c;
        });
        setConnectors(byProvider);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function openConfigure(provider) {
    const existing = connectors[provider];
    setOpenPanel(provider);
    setPanelLabel(existing?.label || '');
    // Pre-fill creds from existing (masked values already in there)
    const fields = PROVIDER_FIELDS[provider] || [];
    const creds  = existing?.credentials || {};
    const init   = {};
    fields.forEach(f => { init[f.key] = creds[f.key] || (f.type === 'select' ? (f.default || f.options?.[0] || '') : ''); });
    setPanelCreds(init);
    setPanelMsg(null);
  }

  function closePanel() {
    setOpenPanel(null);
    setPanelCreds({});
    setPanelLabel('');
    setPanelMsg(null);
  }

  async function handleSave() {
    if (!openPanel) return;
    setSaving(true);
    setPanelMsg(null);
    try {
      await api.put(`/api/cloud-connectors/${openPanel}`, {
        label:       panelLabel || null,
        credentials: panelCreds,
      });
      setPanelMsg({ ok: true, text: 'Configuration saved.' });
      load();
    } catch (err) {
      setPanelMsg({ ok: false, text: err.response?.data?.error || 'Failed to save.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!openPanel) return;
    setTesting(true);
    setPanelMsg(null);
    try {
      const r = await api.post(`/api/cloud-connectors/${openPanel}/test`, { credentials: panelCreds });
      setPanelMsg({ ok: r.data.success, text: r.data.success ? r.data.message : r.data.error });
      if (r.data.success) load();
    } catch (err) {
      setPanelMsg({ ok: false, text: err.response?.data?.error || 'Test failed.' });
    } finally {
      setTesting(false);
    }
  }

  async function handleSync(provider) {
    setSyncing(provider);
    setSyncResult(null);
    try {
      const r = await api.post(`/api/cloud-connectors/${provider}/sync`);
      const d = r.data.data || {};
      setSyncResult({
        provider,
        ok: true,
        text: `Sync complete: ${d.created} created, ${d.updated} updated, ${d.skipped} skipped.`,
        errors: d.errors || [],
      });
      load();
    } catch (err) {
      setSyncResult({
        provider,
        ok: false,
        text: err.response?.data?.error || 'Sync failed. Check connector credentials.',
      });
    } finally {
      setSyncing(null);
    }
  }

  async function handleDisconnect(provider) {
    if (!await confirm({
      title: 'Remove connector',
      message: `Remove the ${PROVIDER_META[provider]?.name} connector? This won't affect any imported contracts.`,
      confirmLabel: 'Remove',
      danger: true,
    })) return;
    setDisconnecting(provider);
    try {
      await api.delete(`/api/cloud-connectors/${provider}`);
      if (openPanel === provider) closePanel();
      load();
    } catch {
      // silent
    } finally {
      setDisconnecting(null);
    }
  }

  const statusBadge = (status) => {
    const map = {
      connected:      { label: 'Connected',      color: 'var(--color-success)', bg: 'rgba(22,163,74,0.1)',   border: 'rgba(22,163,74,0.2)' },
      not_configured: { label: 'Not configured', color: 'var(--color-text-secondary)', bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.15)' },
      error:          { label: 'Error',           color: 'var(--color-danger)', bg: 'rgba(220,38,38,0.08)',   border: 'rgba(220,38,38,0.15)' },
    };
    const s = map[status] || map.not_configured;
    return (
      <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
        {s.label}
      </span>
    );
  };

  return (
    <section style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
      <h2 className={sectionHeading}>Cloud Marketplace Connectors</h2>
      <p className={sectionDesc}>
        Connect your cloud marketplace accounts to automatically import software purchase data as contracts.
        LapseIQ requests read-only access — it never creates, modifies, or cancels subscriptions on your behalf.
        Once credentials are saved and tested, use Sync Now to pull agreements, subscriptions, and spend data directly into your contract list.
      </p>

      {loading ? (
        <div style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Loading connectors…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {['aws', 'azure', 'gcp'].map(provider => {
            const meta      = PROVIDER_META[provider];
            const connector = connectors[provider] || {};
            const status    = connector.status || 'not_configured';
            const isOpen    = openPanel === provider;

            return (
              <div key={provider} style={{ border: `1px solid ${isOpen ? meta.accentColor : 'var(--color-border)'}`, borderRadius: 8, overflow: 'hidden', transition: 'border-color 0.15s' }}>

                {/* ── Provider card header ───────────────────────── */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: isOpen ? meta.bgColor : 'var(--color-surface)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 8, background: meta.bgColor, border: `1px solid ${meta.borderColor}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 800, color: meta.accentColor, letterSpacing: '-0.5px' }}>{meta.shortName}</span>
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 8 }}>
                        {meta.name}
                        {statusBadge(status)}
                      </div>
                      <div style={{ fontSize: '0.78rem', color: connector.lastError ? 'var(--color-warning)' : 'var(--color-text-secondary)', marginTop: 2 }}>
                        {connector.lastError
                          ? `⚠ ${connector.lastError.length > 72 ? connector.lastError.slice(0, 72) + '…' : connector.lastError}`
                          : connector.lastSyncAt
                            ? `Last synced ${_fmtSyncTime(connector.lastSyncAt)}`
                            : meta.desc}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {connector.configured && status === 'connected' && (
                      <button
                        type="button"
                        onClick={() => handleSync(provider)}
                        disabled={syncing === provider}
                        className={btnSecondary} style={{ fontSize: '0.8rem', padding: '6px 14px', color: meta.accentColor, borderColor: meta.borderColor }}
                      >
                        {syncing === provider ? 'Syncing…' : 'Sync Now'}
                      </button>
                    )}
                    {connector.configured && (
                      <button
                        type="button"
                        onClick={() => handleDisconnect(provider)}
                        disabled={disconnecting === provider}
                        style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}
                      >
                        {disconnecting === provider ? 'Removing…' : 'Remove'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => isOpen ? closePanel() : openConfigure(provider)}
                      className={btnSecondary} style={{ fontSize: '0.8rem', padding: '6px 14px', borderColor: isOpen ? meta.accentColor : undefined, color: isOpen ? meta.accentColor : undefined }}
                    >
                      {isOpen ? 'Close' : connector.configured ? 'Edit' : 'Configure'}
                    </button>
                  </div>
                </div>

                {/* ── Expanded config panel ──────────────────────── */}
                {isOpen && (
                  <div style={{ borderTop: `1px solid ${meta.borderColor}`, background: 'var(--color-bg)', padding: '20px 20px 24px' }}>

                    {/* Setup instructions */}
                    <div style={{ marginBottom: 20, padding: '12px 14px', background: meta.bgColor, border: `1px solid ${meta.borderColor}`, borderRadius: 6, fontSize: '0.8rem', color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>
                      <div style={{ fontWeight: 700, color: meta.accentColor, marginBottom: 6, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        Setup instructions
                      </div>
                      {PROVIDER_SETUP[provider].split('\n').map((line, i) => (
                        <div key={i} style={{ marginBottom: 3 }}>{line}</div>
                      ))}
                    </div>

                    {/* Optional label */}
                    <div style={{ ...fieldGroup, marginBottom: 16 }}>
                      <label style={fieldLabel}>
                        Connection label
                        <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400, marginLeft: 6 }}>(optional)</span>
                      </label>
                      <input
                        type="text"
                        placeholder={`e.g. Production ${meta.shortName}`}
                        value={panelLabel}
                        onChange={e => setPanelLabel(e.target.value)}
                        style={{ ...input, maxWidth: 340 }}
                      />
                    </div>

                    {/* Credential fields */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {(PROVIDER_FIELDS[provider] || []).map(f => (
                        <div key={f.key} style={fieldGroup}>
                          <label style={fieldLabel}>{f.label}</label>
                          {f.type === 'select' ? (
                            <select
                              aria-label={f.label}
                              value={panelCreds[f.key] || f.default || ''}
                              onChange={e => setPanelCreds(p => ({ ...p, [f.key]: e.target.value }))}
                              style={{ ...select, maxWidth: 300 }}
                            >
                              {(f.options || []).map(o => (
                                <option key={o} value={o}>{o}</option>
                              ))}
                            </select>
                          ) : f.type === 'textarea' ? (
                            <textarea
                              value={panelCreds[f.key] || ''}
                              onChange={e => setPanelCreds(p => ({ ...p, [f.key]: e.target.value }))}
                              placeholder={f.placeholder}
                              rows={6}
                              style={{ ...input, resize: 'vertical', fontFamily: 'monospace', fontSize: '0.78rem' }}
                            />
                          ) : (
                            <input
                              type={f.type === 'password' ? 'password' : 'text'}
                              value={panelCreds[f.key] || ''}
                              onChange={e => setPanelCreds(p => ({ ...p, [f.key]: e.target.value }))}
                              placeholder={f.placeholder}
                              autoComplete="off"
                              style={{ ...input, maxWidth: 440 }}
                            />
                          )}
                          {f.help && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: 2 }}>{f.help}</div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Action row */}
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 20, flexWrap: 'wrap' }}>
                      <button type="button" onClick={handleSave} disabled={saving} className={btnPrimary}>
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button type="button" onClick={handleTest} disabled={testing || saving} className={btnSecondary}>
                        {testing ? 'Testing…' : 'Test Connection'}
                      </button>
                      <button type="button" onClick={closePanel} className={btnSecondary} style={{ color: 'var(--color-text-secondary)' }}>
                        Cancel
                      </button>
                    </div>

                    {/* Result message */}
                    {panelMsg && (
                      <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 6, background: panelMsg.ok ? 'var(--color-success-soft)' : 'var(--color-danger-bg)', border: `1px solid ${panelMsg.ok ? 'var(--color-success-bg-strong)' : 'var(--color-danger)'}`, color: panelMsg.ok ? 'var(--color-success)' : 'var(--color-danger)', fontSize: '0.825rem' }}>
                        {panelMsg.ok ? '✓ ' : '✗ '}{panelMsg.text}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Sync result notification ─────────────────── */}
                {!isOpen && syncResult && syncResult.provider === provider && (
                  <div style={{ padding: '10px 16px', borderTop: `1px solid ${syncResult.ok ? 'var(--color-success-bg-strong)' : 'var(--color-danger)'}`, background: syncResult.ok ? 'var(--color-success-soft)' : 'var(--color-danger-bg)', color: syncResult.ok ? 'var(--color-success)' : 'var(--color-danger)', fontSize: '0.815rem' }}>
                    {syncResult.ok ? '✓ ' : '✗ '}{syncResult.text}
                    {syncResult.ok && syncResult.errors?.length > 0 && (
                      <span style={{ marginLeft: 8, opacity: 0.8 }}>({syncResult.errors.length} error{syncResult.errors.length !== 1 ? 's' : ''})</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

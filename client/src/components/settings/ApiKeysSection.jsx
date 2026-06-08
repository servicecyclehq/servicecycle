// client/src/components/settings/ApiKeysSection.jsx
// -------------------------------------------------------------
// v0.91 Phase 1b extraction. Originally inline in SettingsPage.jsx
// (function declared around line 4073 pre-extraction). Component
// body is unchanged -- only the file home moved so SettingsPage
// shrinks and the section can be evolved independently.
//
// Renders the admin-only /api/v1 machine-to-machine API key
// management surface. Generate, copy-once-then-hide, revoke.
// -------------------------------------------------------------

import React from 'react';
import { useConfirm } from '../../context/ConfirmContext';
import api from '../../api/client';

export default function ApiKeysSection() {
  const confirm = useConfirm();
  const API = import.meta.env.VITE_API_URL || '/api';
  const [keys,       setKeys]       = React.useState([]);
  const [loading,    setLoading]    = React.useState(true);
  const [error,      setError]      = React.useState(null);
  const [creating,   setCreating]   = React.useState(false);
  const [newName,    setNewName]    = React.useState('');
  const [newExpiry,  setNewExpiry]  = React.useState('');
  const [saveErr,    setSaveErr]    = React.useState(null);
  const [saveBusy,   setSaveBusy]   = React.useState(false);
  // Revealed key modal state
  const [revealed,   setRevealed]   = React.useState(null); // { name, key }
  const [copied,     setCopied]     = React.useState(false);
  const [revoking,   setRevoking]   = React.useState(null); // keyId being revoked

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { data: j } = await api.get('/api/settings/api-keys');
      if (!j.success) throw new Error(j.error || 'Failed to load API keys');
      setKeys(j.data);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally     { setLoading(false); }
  }

  React.useEffect(() => { load(); }, []);

  async function handleGenerate(e) {
    e.preventDefault();
    if (!newName.trim()) { setSaveErr('Key name is required'); return; }
    setSaveBusy(true); setSaveErr(null);
    try {
      const body = { name: newName.trim() };
      if (newExpiry) body.expiresAt = new Date(newExpiry).toISOString();
      const { data: j } = await api.post('/api/settings/api-keys', body);
      if (!j.success) throw new Error(j.error || 'Failed to create key');
      setRevealed({ name: j.data.name, key: j.data.key });
      setCreating(false); setNewName(''); setNewExpiry('');
      await load();
    } catch (e) { setSaveErr(e.response?.data?.error || e.message); }
    finally     { setSaveBusy(false); }
  }

  async function handleRevoke(id) {
    if (!await confirm({
      title: 'Revoke API key',
      message: 'Revoke this API key? Any integrations using it will stop working immediately.',
      confirmLabel: 'Revoke',
      danger: true,
    })) return;
    setRevoking(id);
    try {
      const { data: j } = await api.delete(`/api/settings/api-keys/${id}`);
      if (!j.success) throw new Error(j.error || 'Failed to revoke key');
      await load();
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally     { setRevoking(null); }
  }

  function copyKey() {
    navigator.clipboard.writeText(revealed.key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const active  = keys.filter(k => !k.revokedAt);
  const revoked = keys.filter(k =>  k.revokedAt);

  const sectionHead = { fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 };
  const btn = (extra = {}) => ({ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-ui)', fontWeight: 500, ...extra });
  const inputStyle = { padding: '7px 10px', borderRadius: 6, border: '1px solid var(--color-border)', fontSize: 'var(--font-size-ui)', background: 'var(--color-surface)', color: 'var(--color-text)', width: '100%', boxSizing: 'border-box' };

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 'var(--font-size-base)', fontWeight: 600 }}>API Keys</h3>
          <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
            Read-only machine-to-machine access to <code style={{ fontSize: 'var(--font-size-sm)' }}>/api/v1/*</code>.
            Use these keys for integrations, BI tools, or automation scripts.
          </p>
        </div>
        {!creating && (
          <button style={btn({ background: 'var(--color-primary)', color: '#fff' })} onClick={() => { setCreating(true); setSaveErr(null); }}>
            + Generate Key
          </button>
        )}
      </div>

      {/* ── Generate form ── */}
      {creating && (
        <form onSubmit={handleGenerate} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '16px', marginBottom: 20 }}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 'var(--font-size-ui)', fontWeight: 500, display: 'block', marginBottom: 4 }}>Key name <span style={{ color: 'var(--color-danger)' }}>*</span></label>
            <input style={inputStyle} placeholder="e.g. Splunk integration" value={newName} onChange={e => setNewName(e.target.value)} autoFocus maxLength={100} />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 'var(--font-size-ui)', fontWeight: 500, display: 'block', marginBottom: 4 }}>Expires (optional)</label>
            <input type="date" style={{ ...inputStyle, width: 'auto' }} value={newExpiry} onChange={e => setNewExpiry(e.target.value)} min={new Date().toISOString().split('T')[0]} />
          </div>
          {saveErr && <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-danger)', marginBottom: 10 }}>{saveErr}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={saveBusy} style={btn({ background: 'var(--color-primary)', color: '#fff', opacity: saveBusy ? 0.7 : 1 })}>
              {saveBusy ? 'Generating…' : 'Generate Key'}
            </button>
            <button type="button" style={btn({ background: 'var(--color-surface)', border: '1px solid var(--color-border)' })} onClick={() => { setCreating(false); setSaveErr(null); setNewName(''); setNewExpiry(''); }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* ── Revealed key modal ── */}
      {revealed && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--color-bg)', borderRadius: 10, padding: 28, maxWidth: 520, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>API Key Created — Save It Now</h3>
            <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 14 }}>
              This key will <strong>not</strong> be shown again. Copy it somewhere safe before closing.
            </p>
            <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '10px 12px', fontFamily: 'monospace', fontSize: 'var(--font-size-sm)', wordBreak: 'break-all', marginBottom: 14 }}>
              {revealed.key}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={btn({ background: 'var(--color-primary)', color: '#fff' })} onClick={copyKey}>
                {copied ? '✓ Copied!' : 'Copy Key'}
              </button>
              <button style={btn({ background: 'var(--color-surface)', border: '1px solid var(--color-border)' })} onClick={() => { setRevealed(null); setCopied(false); }}>
                I've saved it — Close
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-danger)', marginBottom: 12 }}>{error}</div>}

      {loading ? (
        <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Loading…</div>
      ) : (
        <>
          {/* ── Active keys ── */}
          <div style={{ marginBottom: 24 }}>
            <div style={sectionHead}>Active Keys ({active.length})</div>
            {active.length === 0 ? (
              <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', padding: '12px 0' }}>No active API keys. Generate one above to get started.</div>
            ) : (
              <table style={{ width: '100%', fontSize: 'var(--font-size-ui)', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                    <th scope="col" style={{ padding: '6px 8px' }}>Name</th>
                    <th scope="col" style={{ padding: '6px 8px', width: 160 }}>Last used</th>
                    <th scope="col" style={{ padding: '6px 8px', width: 130 }}>Expires</th>
                    <th scope="col" style={{ padding: '6px 8px', width: 80 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {active.map(k => (
                    <tr key={k.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '8px 8px', fontWeight: 500 }}>{k.name}</td>
                      <td style={{ padding: '8px 8px', color: 'var(--color-text-secondary)' }}>
                        {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'Never'}
                      </td>
                      <td style={{ padding: '8px 8px', color: 'var(--color-text-secondary)' }}>
                        {k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'Never'}
                      </td>
                      <td style={{ padding: '8px 8px', textAlign: 'right' }}>
                        <button
                          disabled={revoking === k.id}
                          onClick={() => handleRevoke(k.id)}
                          style={btn({ background: 'transparent', color: 'var(--color-danger)', border: '1px solid var(--color-danger)', padding: '4px 10px', opacity: revoking === k.id ? 0.6 : 1 })}
                        >
                          {revoking === k.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Revoked keys ── */}
          {revoked.length > 0 && (
            <div>
              <div style={sectionHead}>Revoked Keys ({revoked.length})</div>
              <table style={{ width: '100%', fontSize: 'var(--font-size-ui)', borderCollapse: 'collapse', opacity: 0.6 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                    <th scope="col" style={{ padding: '6px 8px' }}>Name</th>
                    <th scope="col" style={{ padding: '6px 8px', width: 160 }}>Revoked</th>
                    <th scope="col" style={{ padding: '6px 8px', width: 160 }}>Last used</th>
                  </tr>
                </thead>
                <tbody>
                  {revoked.map(k => (
                    <tr key={k.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '8px 8px' }}>{k.name}</td>
                      <td style={{ padding: '8px 8px', color: 'var(--color-text-secondary)' }}>{new Date(k.revokedAt).toLocaleDateString()}</td>
                      <td style={{ padding: '8px 8px', color: 'var(--color-text-secondary)' }}>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'Never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
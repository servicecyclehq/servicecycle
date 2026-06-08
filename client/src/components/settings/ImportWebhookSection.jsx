// client/src/components/settings/ImportWebhookSection.jsx
// ─────────────────────────────────────────────────────────────
// Settings section for the per-account CSV/XLSX import webhook.
// Admins can configure (or rotate) the HTTPS endpoint + HMAC
// signing secret used by the assets.imported event. The secret
// is shown once in a modal after save and never again.
//
// API surface:
//   GET    /api/settings/import-webhook            → { configured, urlMasked, secretSet }
//   PUT    /api/settings/import-webhook            → { urlMasked, hmacSecretOnce }
//   DELETE /api/settings/import-webhook
//   GET    /api/settings/import-webhook/deliveries → WebhookDelivery[]
// ─────────────────────────────────────────────────────────────

import React from 'react';
import api from '../../api/client';

export default function ImportWebhookSection() {
  const [config,      setConfig]      = React.useState(null);  // { configured, urlMasked, secretSet }
  const [loading,     setLoading]     = React.useState(true);
  const [error,       setError]       = React.useState(null);

  // Edit form
  const [editing,     setEditing]     = React.useState(false);
  const [newUrl,      setNewUrl]      = React.useState('');
  const [saveBusy,    setSaveBusy]    = React.useState(false);
  const [saveErr,     setSaveErr]     = React.useState(null);

  // Secret reveal modal (shown once after PUT)
  const [revealed,    setRevealed]    = React.useState(null);  // { urlMasked, hmacSecretOnce }
  const [copied,      setCopied]      = React.useState(false);

  // Delete
  const [delBusy,     setDelBusy]     = React.useState(false);

  // Delivery history
  const [deliveries,  setDeliveries]  = React.useState(null);
  const [delvLoading, setDelvLoading] = React.useState(false);
  const [delvError,   setDelvError]   = React.useState(null);
  const [showHistory, setShowHistory] = React.useState(false);

  async function loadConfig() {
    setLoading(true); setError(null);
    try {
      const { data: j } = await api.get('/api/settings/import-webhook');
      if (!j.success) throw new Error(j.error || 'Failed to load');
      setConfig(j.data);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => { loadConfig(); }, []);

  async function handleSave(e) {
    e.preventDefault();
    if (!newUrl.trim()) { setSaveErr('URL is required'); return; }
    setSaveBusy(true); setSaveErr(null);
    try {
      const { data: j } = await api.put('/api/settings/import-webhook', { url: newUrl.trim() });
      if (!j.success) throw new Error(j.error || 'Failed to save');
      setRevealed(j.data);
      setEditing(false); setNewUrl('');
      await loadConfig();
    } catch (e) {
      setSaveErr(e.response?.data?.error || e.message);
    } finally {
      setSaveBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm('Remove the import webhook? ServiceCycle will stop POSTing after bulk imports.')) return;
    setDelBusy(true);
    try {
      const { data: j } = await api.delete('/api/settings/import-webhook');
      if (!j.success) throw new Error(j.error || 'Failed to delete');
      setConfig({ configured: false, urlMasked: null, secretSet: false });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setDelBusy(false);
    }
  }

  async function loadDeliveries() {
    setDelvLoading(true); setDelvError(null);
    try {
      const { data: j } = await api.get('/api/settings/import-webhook/deliveries');
      if (!j.success) throw new Error(j.error || 'Failed to load deliveries');
      setDeliveries(j.data);
    } catch (e) {
      setDelvError(e.response?.data?.error || e.message);
    } finally {
      setDelvLoading(false);
    }
  }

  function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next && deliveries === null) loadDeliveries();
  }

  function copySecret() {
    navigator.clipboard.writeText(revealed.hmacSecretOnce).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const btn = (extra = {}) => ({
    padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
    fontSize: 'var(--font-size-ui)', fontWeight: 500, ...extra,
  });
  const inputStyle = {
    padding: '7px 10px', borderRadius: 6, border: '1px solid var(--color-border)',
    fontSize: 'var(--font-size-ui)', background: 'var(--color-surface)',
    color: 'var(--color-text)', width: '100%', boxSizing: 'border-box',
  };

  return (
    <section style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 'var(--font-size-base)', fontWeight: 600 }}>Import Webhook</h3>
          <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', maxWidth: 520 }}>
            POST a signed <code style={{ fontSize: 'var(--font-size-sm)' }}>assets.imported</code> event to your endpoint after every successful CSV/XLSX bulk import.
            Use this to trigger downstream automation (inventory sync, Slack notifications, CMMS updates, etc.).
          </p>
        </div>
        {!loading && !editing && (
          <button
            style={btn({ background: 'var(--color-primary)', color: '#fff', whiteSpace: 'nowrap' })}
            onClick={() => { setEditing(true); setSaveErr(null); setNewUrl(config?.urlMasked ? '' : ''); }}>
            {config?.configured ? 'Rotate / Change URL' : '+ Configure'}
          </button>
        )}
      </div>

      {error && (
        <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-danger)', marginBottom: 12 }}>{error}</div>
      )}

      {loading ? (
        <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Loading…</div>
      ) : (
        <>
          {/* ── Current status ── */}
          {!editing && (
            <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '14px 16px', marginBottom: 16 }}>
              {config?.configured ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 500, marginBottom: 2 }}>
                      Endpoint: <span style={{ fontFamily: 'monospace', fontWeight: 400 }}>{config.urlMasked}</span>
                    </div>
                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                      HMAC secret: {config.secretSet ? '✓ set (not shown)' : 'not set'}
                    </div>
                  </div>
                  <button
                    disabled={delBusy}
                    onClick={handleDelete}
                    style={btn({ background: 'transparent', color: 'var(--color-danger)', border: '1px solid var(--color-danger)', opacity: delBusy ? 0.6 : 1 })}>
                    {delBusy ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
                  No import webhook configured.
                </div>
              )}
            </div>
          )}

          {/* ── Edit / configure form ── */}
          {editing && (
            <form onSubmit={handleSave} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '16px', marginBottom: 16 }}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 'var(--font-size-ui)', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                  Endpoint URL <span style={{ color: 'var(--color-danger)' }}>*</span>
                </label>
                <input
                  style={inputStyle}
                  placeholder="https://hooks.zapier.com/hooks/catch/…"
                  value={newUrl}
                  onChange={e => setNewUrl(e.target.value)}
                  autoFocus
                  maxLength={2048}
                />
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                  Must be HTTPS. Saving generates a new 32-byte HMAC secret (shown once).
                </div>
              </div>
              {saveErr && (
                <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-danger)', marginBottom: 10 }}>{saveErr}</div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" disabled={saveBusy}
                  style={btn({ background: 'var(--color-primary)', color: '#fff', opacity: saveBusy ? 0.7 : 1 })}>
                  {saveBusy ? 'Saving…' : 'Save & Rotate Secret'}
                </button>
                <button type="button"
                  style={btn({ background: 'var(--color-surface)', border: '1px solid var(--color-border)' })}
                  onClick={() => { setEditing(false); setSaveErr(null); setNewUrl(''); }}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* ── Secret reveal modal ── */}
          {revealed && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ background: 'var(--color-bg)', borderRadius: 10, padding: 28, maxWidth: 540, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
                <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>Import Webhook Saved — Copy Your Secret Now</h3>
                <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                  This HMAC signing secret will <strong>not</strong> be shown again. Use it to verify the{' '}
                  <code style={{ fontSize: 'var(--font-size-sm)' }}>X-ServiceCycle-Signature</code> header on incoming requests.
                </p>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                  Sending to: <strong>{revealed.urlMasked}</strong>
                </div>
                <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '10px 12px', fontFamily: 'monospace', fontSize: 'var(--font-size-sm)', wordBreak: 'break-all', marginBottom: 14 }}>
                  {revealed.hmacSecretOnce}
                </div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 14 }}>
                  <strong>Verification example (Node.js):</strong>
                  <code style={{ fontSize: 'var(--font-size-xs)', display: 'block', marginTop: 4, whiteSpace: 'pre-wrap', background: 'var(--color-surface)', padding: '6px 8px', borderRadius: 4 }}>
{`const [ts] = req.headers['x-servicecycle-timestamp'].split(',');
const sig = crypto.createHmac('sha256', SECRET)
  .update(ts + '.' + rawBody, 'utf8').digest('hex');
if ('sha256=' + sig !== req.headers['x-servicecycle-signature'])
  return res.status(401).send('Bad signature');`}
                  </code>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={btn({ background: 'var(--color-primary)', color: '#fff' })} onClick={copySecret}>
                    {copied ? '✓ Copied!' : 'Copy Secret'}
                  </button>
                  <button
                    style={btn({ background: 'var(--color-surface)', border: '1px solid var(--color-border)' })}
                    onClick={() => { setRevealed(null); setCopied(false); }}>
                    I've saved it — Close
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Delivery history ── */}
          {config?.configured && (
            <div>
              <button
                style={{ ...btn({ background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', padding: '4px 0' }), textDecoration: 'underline', cursor: 'pointer' }}
                onClick={toggleHistory}>
                {showHistory ? 'Hide delivery history' : 'View recent delivery history'}
              </button>

              {showHistory && (
                <div style={{ marginTop: 10 }}>
                  {delvLoading && <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Loading…</div>}
                  {delvError  && <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-danger)' }}>{delvError}</div>}
                  {!delvLoading && !delvError && (
                    deliveries?.length === 0 ? (
                      <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', padding: '8px 0' }}>
                        No deliveries yet.
                      </div>
                    ) : (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-sm)' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}>
                            <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>Time</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>Status</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>HTTP</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>ms</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>Error</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(deliveries || []).map(d => (
                            <tr key={d.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                              <td style={{ padding: '5px 8px', color: 'var(--color-text-secondary)' }}>
                                {new Date(d.createdAt).toLocaleString()}
                              </td>
                              <td style={{ padding: '5px 8px' }}>
                                <span style={{
                                  padding: '2px 7px', borderRadius: 4, fontSize: 'var(--font-size-xs)', fontWeight: 500,
                                  background: d.status === 'delivered' ? 'var(--color-success-bg)' : 'var(--color-danger-soft)',
                                  color: d.status === 'delivered' ? 'var(--color-success-strong)' : 'var(--color-danger)',
                                }}>
                                  {d.status}
                                </span>
                              </td>
                              <td style={{ padding: '5px 8px', color: 'var(--color-text-secondary)' }}>{d.statusCode ?? '—'}</td>
                              <td style={{ padding: '5px 8px', color: 'var(--color-text-secondary)' }}>{d.responseMs ?? '—'}</td>
                              <td style={{ padding: '5px 8px', color: 'var(--color-danger)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {d.error || '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

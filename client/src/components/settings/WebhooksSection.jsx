// client/src/components/settings/WebhooksSection.jsx
// -------------------------------------------------------------
// v0.91 Phase 1b extraction. Originally inline in SettingsPage.jsx
// (function declared around line 4288 pre-extraction). Component
// body unchanged -- only the file home moved.
//
// Renders the admin-only outbound webhook endpoint management
// surface plus the DLQ inspection panel mount. Endpoints are
// HMAC-signed; create, copy-once-then-hide the secret, retry,
// disable, delete.
// -------------------------------------------------------------

import React from 'react';
import { useConfirm } from '../../context/ConfirmContext';
import api from '../../api/client';

export default function WebhooksSection() {
  const confirm = useConfirm();
  const API = import.meta.env.VITE_API_URL || '/api';
  const [endpoints, setEndpoints] = React.useState([]);
  const [loading,   setLoading]   = React.useState(true);
  const [error,     setError]     = React.useState(null);
  const [creating,  setCreating]  = React.useState(false);
  const [newLabel,  setNewLabel]  = React.useState('');
  const [newUrl,    setNewUrl]    = React.useState('');
  const [saveErr,   setSaveErr]   = React.useState(null);
  const [saveBusy,  setSaveBusy]  = React.useState(false);
  const [revealed,  setRevealed]  = React.useState(null); // { id, urlMasked, hmacSecretOnce }
  const [copied,    setCopied]    = React.useState(false);
  const [deleting,  setDeleting]  = React.useState(null);  // endpointId
  const [testing,   setTesting]   = React.useState(null);  // endpointId
  const [testResult, setTestResult] = React.useState({});  // { [id]: { ok, msg } }

  async function load() {
    setLoading(true); setError(null);
    try {
      const { data: j } = await api.get('/api/webhooks');
      if (!j.success) throw new Error(j.error || 'Failed to load webhooks');
      setEndpoints(j.data);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally     { setLoading(false); }
  }

  React.useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (!newUrl.trim()) { setSaveErr('URL is required'); return; }
    setSaveBusy(true); setSaveErr(null);
    try {
      const { data: j } = await api.post('/api/webhooks', { label: newLabel.trim(), url: newUrl.trim() });
      if (!j.success) throw new Error(j.error || 'Failed to create webhook');
      setRevealed(j.data);
      setCreating(false); setNewLabel(''); setNewUrl('');
      await load();
    } catch (e) { setSaveErr(e.response?.data?.error || e.message); }
    finally     { setSaveBusy(false); }
  }

  async function handleToggle(ep) {
    try {
      const { data: j } = await api.patch(`/api/webhooks/${ep.id}`, { enabled: !ep.enabled });
      if (!j.success) throw new Error(j.error);
      await load();
    } catch (e) { setError(e.response?.data?.error || e.message); }
  }

  async function handleDelete(id) {
    if (!await confirm({
      title: 'Delete webhook',
      message: 'Delete this webhook endpoint? Any automation listening to it will stop receiving alerts.',
      confirmLabel: 'Delete',
      danger: true,
    })) return;
    setDeleting(id);
    try {
      const { data: j } = await api.delete(`/api/webhooks/${id}`);
      if (!j.success) throw new Error(j.error || 'Failed to delete webhook');
      await load();
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally     { setDeleting(null); }
  }

  async function handleTest(id) {
    setTesting(id);
    setTestResult(prev => ({ ...prev, [id]: null }));
    try {
      const { data: j } = await api.post(`/api/webhooks/${id}/test`);
      if (j.success) {
        setTestResult(prev => ({ ...prev, [id]: { ok: true, msg: `✓ Delivered (HTTP ${j.status})` } }));
      } else {
        setTestResult(prev => ({ ...prev, [id]: { ok: false, msg: j.error || 'Test failed' } }));
      }
    } catch (e) {
      setTestResult(prev => ({ ...prev, [id]: { ok: false, msg: e.message } }));
    } finally {
      setTesting(null);
    }
  }

  function copySecret() {
    navigator.clipboard.writeText(revealed.hmacSecretOnce).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const btn = (extra = {}) => ({ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-ui)', fontWeight: 500, ...extra });
  const inputStyle = { padding: '7px 10px', borderRadius: 6, border: '1px solid var(--color-border)', fontSize: 'var(--font-size-ui)', background: 'var(--color-surface)', color: 'var(--color-text)', width: '100%', boxSizing: 'border-box' };

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 'var(--font-size-base)', fontWeight: 600 }}>Webhook Endpoints</h3>
          {/* v0.68.6 webhook 2xx delivery contract help -- audit M-tier */}
          <p style={{ fontSize: 'var(--font-size-sm)', color: "var(--color-text-secondary)", margin: "6px 0 0", lineHeight: 1.5 }}>
            <strong>Delivery contract:</strong> LapseIQ treats any HTTP 2xx response as a successful delivery. If your receiver wants to reject a delivery, return a 4xx with a descriptive body -- a 200 OK with an error in the body still counts as delivered.
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', maxWidth: 520 }}>
            LapseIQ POSTs a signed JSON event to each enabled endpoint when an alert fires.
            Use these to trigger Zapier, n8n, Make, or any custom HTTP listener.
            Up to 5 endpoints per account.
          </p>
        </div>
        {!creating && (
          <button style={btn({ background: 'var(--color-primary)', color: '#fff', whiteSpace: 'nowrap' })}
            onClick={() => { setCreating(true); setSaveErr(null); }}>
            + Add Endpoint
          </button>
        )}
      </div>

      {/* ── How it works callout ── */}
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--color-text)' }}>How it works:</strong> Each alert fires one POST per contract per threshold hit.
        The body is a JSON object with <code style={{ fontSize: 'var(--font-size-sm)' }}>alertType</code>, <code style={{ fontSize: 'var(--font-size-sm)' }}>daysUntil</code>,
        and contract details. Every request includes an{' '}
        <code style={{ fontSize: 'var(--font-size-sm)' }}>X-LapseIQ-Signature: sha256=…</code> header so you can verify authenticity using your HMAC secret.
        Thresholds fire at <strong>60, 30, and 7 days</strong> before renewal or auto-renew cancellation deadlines.
      </div>

      {/* ── Create form ── */}
      {creating && (
        <form onSubmit={handleCreate} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '16px', marginBottom: 20 }}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 'var(--font-size-ui)', fontWeight: 500, display: 'block', marginBottom: 4 }}>
              Label <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', fontWeight: 400 }}>(optional — helps you remember what this is)</span>
            </label>
            <input style={inputStyle} placeholder="e.g. Zapier renewal automation" value={newLabel}
              onChange={e => setNewLabel(e.target.value)} maxLength={100} />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 'var(--font-size-ui)', fontWeight: 500, display: 'block', marginBottom: 4 }}>
              Endpoint URL <span style={{ color: 'var(--color-danger)' }}>*</span>
            </label>
            <input style={inputStyle} placeholder="https://hooks.zapier.com/hooks/catch/…" value={newUrl}
              onChange={e => setNewUrl(e.target.value)} autoFocus maxLength={2048} />
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>Must be an HTTPS URL on a public host.</div>
          </div>
          {saveErr && <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-danger)', marginBottom: 10 }}>{saveErr}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={saveBusy}
              style={btn({ background: 'var(--color-primary)', color: '#fff', opacity: saveBusy ? 0.7 : 1 })}>
              {saveBusy ? 'Adding…' : 'Add Endpoint'}
            </button>
            <button type="button" style={btn({ background: 'var(--color-surface)', border: '1px solid var(--color-border)' })}
              onClick={() => { setCreating(false); setSaveErr(null); setNewLabel(''); setNewUrl(''); }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* ── HMAC secret reveal modal ── */}
      {revealed && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--color-bg)', borderRadius: 10, padding: 28, maxWidth: 540, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>Endpoint Added — Copy Your Secret Now</h3>
            <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
              This HMAC signing secret will <strong>not</strong> be shown again.
              Paste it into your receiving app to verify the <code style={{ fontSize: 'var(--font-size-sm)' }}>X-LapseIQ-Signature</code> header.
            </p>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
              Sending to: <strong>{revealed.urlMasked}</strong>
            </div>
            <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '10px 12px', fontFamily: 'monospace', fontSize: 'var(--font-size-sm)', wordBreak: 'break-all', marginBottom: 14 }}>
              {revealed.hmacSecretOnce}
            </div>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 14 }}>
              <strong>Verification example (Node.js):</strong><br />
              <code style={{ fontSize: 'var(--font-size-xs)', display: 'block', marginTop: 4, whiteSpace: 'pre-wrap', background: 'var(--color-surface)', padding: '6px 8px', borderRadius: 4 }}>
{`const sig = crypto.createHmac('sha256', SECRET)
  .update(rawBody, 'utf8').digest('hex');
if ('sha256=' + sig !== req.headers['x-lapseiq-signature'])
  return res.status(401).send('Bad signature');`}
              </code>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={btn({ background: 'var(--color-primary)', color: '#fff' })} onClick={copySecret}>
                {copied ? '✓ Copied!' : 'Copy Secret'}
              </button>
              <button style={btn({ background: 'var(--color-surface)', border: '1px solid var(--color-border)' })}
                onClick={() => { setRevealed(null); setCopied(false); }}>
                I've saved it — Close
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-danger)', marginBottom: 12 }}>{error}</div>}

      {loading ? (
        <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Loading…</div>
      ) : endpoints.length === 0 && !creating ? (
        <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', padding: '16px 0' }}>
          No webhook endpoints configured. Add one above to start sending alerts to Zapier, n8n, or a custom HTTP listener.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {endpoints.map(ep => {
            const tr = testResult[ep.id];
            return (
              <div key={ep.id} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 'var(--font-size-data)', marginBottom: 2 }}>
                      {ep.label || <span style={{ color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>Unlabelled endpoint</span>}
                      {' '}
                      <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 400, padding: '2px 7px', borderRadius: 4, background: ep.enabled ? 'var(--color-success-bg)' : 'var(--color-bg)', color: ep.enabled ? 'var(--color-success-strong)' : 'var(--color-text-secondary)', marginLeft: 4 }}>
                        {ep.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </div>
                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', fontFamily: 'monospace' }}>{ep.urlMasked}</div>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                      Added {new Date(ep.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      disabled={testing === ep.id}
                      onClick={() => handleTest(ep.id)}
                      style={btn({ background: 'var(--color-surface)', border: '1px solid var(--color-border)', opacity: testing === ep.id ? 0.6 : 1 })}>
                      {testing === ep.id ? 'Sending…' : 'Test'}
                    </button>
                    <button
                      onClick={() => handleToggle(ep)}
                      style={btn({ background: 'var(--color-surface)', border: '1px solid var(--color-border)' })}>
                      {ep.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      disabled={deleting === ep.id}
                      onClick={() => handleDelete(ep.id)}
                      style={btn({ background: 'transparent', color: 'var(--color-danger)', border: '1px solid var(--color-danger)', opacity: deleting === ep.id ? 0.6 : 1 })}>
                      {deleting === ep.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </div>
                {tr && (
                  <div style={{ marginTop: 10, fontSize: 'var(--font-size-sm)', color: tr.ok ? 'var(--color-success-strong)' : 'var(--color-danger)', background: tr.ok ? 'var(--color-success-bg)' : 'var(--color-danger-soft)', borderRadius: 5, padding: '6px 10px' }}>
                    {tr.msg}
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
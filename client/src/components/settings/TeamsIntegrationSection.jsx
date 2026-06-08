import React, { useState, useEffect } from 'react';

const API = import.meta.env.VITE_API_URL || '/api';

import { sectionHeading, sectionDesc, toggle, toggleThumb, btnPrimary } from './sharedStyles';

// ── Teams Integration Section ─────────────────────────────────────────────────
// Mirror of SlackIntegrationSection — same masked-placeholder save flow, same
// optional URL on the Test button so a fresh paste can be verified before
// saving. Diverges only in the placeholder text, helper link, and the
// allowed-host hint, since the Teams URL format isn't a single fixed prefix.

export default function TeamsIntegrationSection() {
  const [enabled, setEnabled]       = useState(false);
  const [url, setUrl]               = useState('');
  const [urlMasked, setUrlMasked]   = useState(false);
  const [preview, setPreview]       = useState(null);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [testing, setTesting]       = useState(false);
  const [saved, setSaved]           = useState(false);
  const [error, setError]           = useState(null);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    fetch(`${API}/settings`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('servicecycle_token')}` },
    })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          const s = d.data;
          setEnabled(s.TEAMS_ENABLED === 'true');
          setUrl(s.TEAMS_WEBHOOK_URL || '');
          setPreview(s._teamsPreview || null);
          setConfigured(!!s._teamsConfigured);
          if (s._teamsSet) setUrlMasked(true);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  function onUrlChange(v) {
    setUrl(v);
    setUrlMasked(false);
    setSaved(false);
    setTestResult(null);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const payload = { TEAMS_ENABLED: enabled ? 'true' : 'false' };
    if (!urlMasked) payload.TEAMS_WEBHOOK_URL = url;
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
        if (url) {
          setUrl('••••••••');
          setUrlMasked(true);
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
    try {
      const body = urlMasked ? {} : { TEAMS_WEBHOOK_URL: url };
      const r = await fetch(`${API}/settings/teams/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('servicecycle_token')}`,
        },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      setTestResult({ ok: d.success, message: d.success ? d.message : d.error });
    } catch {
      setTestResult({ ok: false, message: 'Network error' });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <section style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
        <div style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Loading Teams settings…</div>
      </section>
    );
  }

  return (
    <section style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
      <h2 className={sectionHeading}>Microsoft Teams Notifications</h2>
      <p className={sectionDesc}>
        Post the nightly alert digest into a Teams channel using an{' '}
        <a href="https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>
          incoming webhook
        </a>. One consolidated message per account per day — same alerts that go to email, formatted for the channel.
      </p>

      {/* Enabled toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1rem' }}>
        <div
          role="switch"
          aria-checked={enabled}
          onClick={() => { setEnabled(v => !v); setSaved(false); }}
          className={toggle}
          data-state={enabled ? 'on' : 'off'}
          style={enabled ? { background: 'var(--color-emerald)' } : undefined}
        >
          <div className={toggleThumb} />
        </div>
        <span style={{ fontSize: '0.875rem', color: 'var(--color-text)', fontWeight: 600 }}>
          {enabled ? 'Teams digests on' : 'Teams digests off'}
        </span>
        {configured && enabled && (
          <span style={{ fontSize: '0.75rem', color: 'var(--color-success)', fontWeight: 500 }}>✓ Configured</span>
        )}
      </div>

      {/* Webhook URL */}
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
          Webhook URL
        </label>
        <input
          type="text"
          value={url}
          onChange={e => onUrlChange(e.target.value)}
          onFocus={() => { if (urlMasked) { setUrl(''); setUrlMasked(false); } }}
          placeholder="https://<tenant>.webhook.office.com/webhookb2/…"
          style={{
            width: '100%',
            padding: '8px 10px',
            fontSize: '0.875rem',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            fontFamily: 'monospace',
            background: 'var(--color-surface)',
            color: 'var(--color-text)',
          }}
        />
        {preview && urlMasked && (
          <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', marginTop: 4, fontFamily: 'monospace' }}>
            Currently: {preview}
          </div>
        )}
        <p style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
          Add an incoming webhook to a Teams channel: <em>Channel → Manage channel → Connectors → Incoming Webhook → Configure</em>.
          Only Microsoft-hosted webhook URLs are accepted (<code>outlook.office.com</code>, <code>outlook.office365.com</code>, or <code>*.webhook.office.com</code>).
        </p>
      </div>

      {/* Save + Test */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button type="button" onClick={handleSave} disabled={saving} className={btnPrimary}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={handleTest}
          disabled={testing || (!url && !urlMasked)}
          className={btnPrimary} style={{ background: 'var(--color-text)', opacity: (testing || (!url && !urlMasked)) ? 0.5 : 1 }}
        >
          {testing ? 'Sending…' : 'Send test message'}
        </button>
        {saved && <span style={{ color: 'var(--color-success)', fontSize: '0.875rem', fontWeight: 500 }}>✓ Saved</span>}
        {error && <span style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</span>}
      </div>

      {testResult && (
        <div style={{
          marginTop: '0.75rem', padding: '8px 12px', borderRadius: 6,
          background: testResult.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
          color: testResult.ok ? 'var(--color-success)' : 'var(--color-danger)',
          fontSize: '0.825rem',
          border: `1px solid ${testResult.ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
        }}>
          {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
        </div>
      )}
    </section>
  );
}

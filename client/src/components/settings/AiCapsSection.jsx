import React, { useState, useEffect } from 'react';
import api from '../../api/client';
// ── AiCapsSection ─────────────────────────────────────────────────────────────
// Admin-only panel on Settings → AI tab.
// Shows today's per-user AI usage for each action and lets the admin set a
// per-account cap override (stored in AccountSetting). The override takes
// priority over the env-var / demo-default resolution in aiQuota.js.
// null override = fall back to env-var/demo defaults.

const AI_CAP_LABELS = {
  extract:      'PDF & Signature Extraction (shared)',
  ask:          'Ask LapseIQ Assistant',
  brief:        'Renewal Brief',
  brief_search: 'Brief Web-Search Enrichment',
};

export default function AiCapsSection() {
  const [data,    setData]    = useState(null);   // { actions: [...] }
  const [drafts,  setDrafts]  = useState({});     // action -> '' | number string
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState('');

  useEffect(() => {
    api.get('/api/admin/ai-caps')
      .then(r => {
        setData(r.data.data);
        // Seed drafts from current accountCap values
        const d = {};
        for (const a of r.data.data.actions) {
          d[a.action] = a.accountCap !== null ? String(a.accountCap) : '';
        }
        setDrafts(d);
      })
      .catch(() => setError('Failed to load AI cap data.'));
  }, []);

  async function handleSave() {
    setSaving(true); setSaved(false); setError('');
    const caps = {};
    for (const [action, val] of Object.entries(drafts)) {
      caps[action] = val === '' ? null : val;
    }
    try {
      await api.put('/api/admin/ai-caps', { caps });
      // Refresh
      const r = await api.get('/api/admin/ai-caps');
      setData(r.data.data);
      const d = {};
      for (const a of r.data.data.actions) {
        d[a.action] = a.accountCap !== null ? String(a.accountCap) : '';
      }
      setDrafts(d);
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    } catch {
      setError('Save failed.');
    } finally {
      setSaving(false);
    }
  }

  if (error && !data) {
    return <div style={{ marginTop: '2rem', color: 'var(--color-danger)', fontSize: 'var(--font-size-data)' }}>{error}</div>;
  }
  if (!data) {
    return <div style={{ marginTop: '2rem', fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)' }}>Loading AI cap data…</div>;
  }

  return (
    <div style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.4rem' }}>AI Daily Caps</h2>
      <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', marginBottom: '1.25rem', lineHeight: 1.55 }}>
        Per-account overrides for AI daily quotas. Blank = use the instance default (env var or demo default).
        Set to <strong>0</strong> to block an action entirely. Changes take effect immediately — no restart required.
      </p>
      <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', fontSize: 'var(--font-size-ui)', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
              <th scope="col" style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Action</th>
              <th scope="col" style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600 }}>Default cap</th>
              <th scope="col" style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600 }}>Account override</th>
              <th scope="col" style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600 }}>Effective</th>
              <th scope="col" style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600 }}>Today's usage</th>
            </tr>
          </thead>
          <tbody>
            {data.actions.map((a, i) => {
              const effectiveDisplay = a.effectiveCap === null ? '∞' : String(a.effectiveCap);
              const envDisplay       = a.envCap === null ? '∞' : String(a.envCap);
              return (
                <tr key={a.action} style={{ borderBottom: i < data.actions.length - 1 ? '1px solid var(--color-border)' : 'none' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 500 }}>
                    {AI_CAP_LABELS[a.action] || a.action}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                    {envDisplay}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                    <input
                      type="number"
                      min={0}
                      max={9999}
                      placeholder="(default)"
                      value={drafts[a.action] ?? ''}
                      onChange={e => setDrafts(d => ({ ...d, [a.action]: e.target.value }))}
                      style={{
                        width: 80,
                        padding: '4px 8px',
                        borderRadius: 6,
                        border: '1px solid var(--color-border-strong)',
                        fontSize: 'var(--font-size-ui)',
                        background: 'var(--color-surface)',
                        color: 'var(--color-text)',
                        textAlign: 'center',
                      }}
                    />
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600, color: a.accountCap !== null ? 'var(--color-primary)' : 'var(--color-text-secondary)' }}>
                    {effectiveDisplay}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                    {a.todayTotal > 0 ? (
                      <span title={a.users.map(u => `${u.name}: ${u.count}`).join('\n')} style={{ cursor: 'default' }}>
                        {a.todayTotal} call{a.todayTotal !== 1 ? 's' : ''}
                        {a.users.length > 1 && <span style={{ color: 'var(--color-text-secondary)', marginLeft: 4 }}>({a.users.length} users)</span>}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--color-text-muted)' }}>0</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving}
          style={{ padding: '7px 18px', fontSize: 'var(--font-size-ui)' }}
        >
          {saving ? 'Saving…' : 'Save cap overrides'}
        </button>
        {saved && <span style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-success)' }}>✓ Saved</span>}
        {error && <span style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-danger)' }}>{error}</span>}
      </div>
    </div>
  );
}

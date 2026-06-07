import { useState, useEffect, useCallback } from 'react';

// v0.68.6 (audit Medium `Admin UX Reviewer`): local copy of the role baseline
// so we can disable feature checkboxes that the role doesn't support.
// Server route at /api/users/permissions also enforces this; client gate is
// belt-and-suspenders + clearer UX (no "toggle me, get 403 later" surprises).
const FEATURE_DEFAULTS = {
  admin:      { contracts_write: true,  vendors_write: true,  renewal_brief: true,  contract_flags: true,  communications: true,  export: true,  budget: true,  ingest: true,  alerts: true,  news: true  },
  manager:    { contracts_write: true,  vendors_write: true,  renewal_brief: true,  contract_flags: true,  communications: true,  export: true,  budget: true,  ingest: true,  alerts: true,  news: true  },
  viewer:     { contracts_write: false, vendors_write: false, renewal_brief: false, contract_flags: true,  communications: false, export: false, budget: false, ingest: false, alerts: true,  news: false },
  consultant: { contracts_write: false, vendors_write: false, renewal_brief: true,  contract_flags: false, communications: false, export: true,  budget: true,  ingest: false, alerts: true,  news: false },
};
function roleAllows(role, feature) {
  return FEATURE_DEFAULTS[role]?.[feature] === true;
}

import api from '../api/client';

// ── Feature display config ────────────────────────────────────────────────────
const FEATURE_META = {
  contracts_write: { label: 'Edit Contracts', icon: '📝', desc: 'Create & edit contracts' },
  vendors_write:   { label: 'Edit Vendors',   icon: '🏢', desc: 'Add & manage vendors' },
  renewal_brief:   { label: 'AI Brief',       icon: '✨', desc: 'AI renewal brief' },
  contract_flags:  { label: 'Risk Flags',     icon: '🚩', desc: 'AI contract flags' },
  communications:  { label: 'Log Comms',      icon: '💬', desc: 'Log communications' },
  export:          { label: 'Export',         icon: '⬇️', desc: 'Export data to CSV' },
  budget:          { label: 'Budget',         icon: '📊', desc: 'Budget forecast page' },
  ingest:          { label: 'Upload',         icon: '⬆️', desc: 'AI doc ingestion' },
  alerts:          { label: 'Alerts',         icon: '🔔', desc: 'Renewal alerts' },
  news:            { label: 'News',           icon: '📰', desc: 'Vendor news feed' },
};

const ROLE_LABELS   = { admin: 'Admin', manager: 'Manager', viewer: 'Viewer', consultant: 'Consultant' };
const ROLE_COLORS   = {
  admin:      { bg: 'var(--color-primary-light)', text: 'var(--color-primary)', border: 'var(--color-info)' },
  manager:    { bg: 'var(--color-success-bg)', text: 'var(--color-success)', border: 'var(--color-success)' },
  viewer:     { bg: 'var(--color-surface)', text: 'var(--color-text-secondary)', border: 'var(--color-border)' },
  consultant: { bg: 'var(--color-warning-bg)', text: 'var(--color-warning)', border: 'var(--color-warning)' },
};

function RoleBadge({ role }) {
  const c = ROLE_COLORS[role] || ROLE_COLORS.viewer;
  return (
    <span style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: 10,
      fontSize: 'var(--font-size-xs)', fontWeight: 600,
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
    }}>
      {ROLE_LABELS[role] || role}
    </span>
  );
}

// ── Feature checkbox cell ─────────────────────────────────────────────────────

function FeatureCell({ userId, feature, checked, disabled, onChange, userName, featureLabel, title }) {
  return (
    <td style={{ textAlign: 'center', padding: '10px 8px', verticalAlign: 'middle' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: disabled ? 'not-allowed' : 'pointer' }}>
        <input
          type="checkbox"
          aria-label={(featureLabel || feature) + ' for ' + (userName || 'user')}
          title={title}
          checked={checked}
          disabled={disabled}
          onChange={e => onChange(userId, feature, e.target.checked)}
          style={{
            width: 16, height: 16, cursor: disabled ? 'not-allowed' : 'pointer',
            accentColor: 'var(--color-primary)',
            opacity: disabled ? 0.45 : 1,
          }}
        />
      </label>
    </td>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PermissionsPage() {
  const [users, setUsers]     = useState([]);
  const [features, setFeatures] = useState([]);
  const [dirty, setDirty]     = useState({});   // { userId: { feature: bool } }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/api/users/permissions');
      setUsers(res.data.data.users);
      setFeatures(res.data.data.features);
      setDirty({});
    } catch {
      setError('Failed to load permissions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function getFlag(user, feature) {
    // dirty state takes priority
    if (dirty[user.id] && typeof dirty[user.id][feature] === 'boolean') {
      return dirty[user.id][feature];
    }
    return user.featureFlags?.[feature] ?? false;
  }

  function handleToggle(userId, feature, value) {
    setDirty(prev => ({
      ...prev,
      [userId]: { ...(prev[userId] || {}), [feature]: value },
    }));
    setSaved(false);
  }

  async function saveAll() {
    const updates = Object.entries(dirty).map(([userId, changes]) => {
      const user = users.find(u => u.id === userId);
      const base = user?.featureFlags || {};
      return {
        userId,
        flags: { ...base, ...changes },
      };
    });

    if (updates.length === 0) return;
    setSaving(true);
    setError('');
    try {
      await api.put('/api/users/permissions', { updates });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      await load();
    } catch {
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function resetDefaults(userId) {
    const user = users.find(u => u.id === userId);
    if (!user) return;
    const defaults = {
      admin:   { contracts_write:true,  vendors_write:true,  renewal_brief:true,  contract_flags:true,  communications:true,  export:true,  budget:true,  ingest:true,  alerts:true,  news:true  },
      manager: { contracts_write:true,  vendors_write:true,  renewal_brief:true,  contract_flags:true,  communications:true,  export:true,  budget:true,  ingest:true,  alerts:true,  news:true  },
      viewer:  { contracts_write:false, vendors_write:false, renewal_brief:false, contract_flags:true,  communications:false, export:false, budget:false, ingest:false, alerts:true,  news:false },
      consultant: { contracts_write:false, vendors_write:false, renewal_brief:true, contract_flags:true, communications:true, export:false, budget:false, ingest:false, alerts:true, news:true },
    };
    const d = defaults[user.role] || defaults.viewer;
    setDirty(prev => ({ ...prev, [userId]: { ...d } }));
    setSaved(false);
  }

  const hasDirty = Object.keys(dirty).length > 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Permissions</h1>
          <div className="page-subtitle">
            Control which features each team member can access. Admins always have full access.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {saved && <span style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-success, #15803d)' }}>Saved ✓</span>}
          <button
            className="btn btn-primary"
            onClick={saveAll}
            disabled={saving || !hasDirty}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {loading ? (
          <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>
            Loading…
          </div>
        ) : (
          <div className="card" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border)' }}>
                  {/* User column */}
                  <th style={{ textAlign: 'left', padding: '12px 20px', fontSize: 'var(--font-size-sm)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', minWidth: 220 }}>
                    Team Member
                  </th>

                  {/* Feature columns */}
                  {features.map(f => {
                    const m = FEATURE_META[f] || { label: f, icon: '◆', desc: '' };
                    return (
                      <th key={f} style={{ textAlign: 'center', padding: '12px 8px', fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', minWidth: 110 }}>
                        <div style={{ marginBottom: 2 }}>{m.icon}</div>
                        <div style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>{m.label}</div>
                        <div style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginTop: 2, fontSize: 'var(--font-size-xs)' }}>{m.desc}</div>
                      </th>
                    );
                  })}

                  <th style={{ textAlign: 'center', padding: '12px 16px', fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                    Reset
                  </th>
                </tr>
              </thead>

              <tbody>
                {users.map((u, i) => {
                  const isAdmin   = u.role === 'admin';
                  const rowDirty  = dirty[u.id];
                  const isDirtyRow = rowDirty && Object.keys(rowDirty).length > 0;

                  return (
                    <tr
                      key={u.id}
                      style={{
                        borderBottom: '1px solid var(--color-border)',
                        background: isDirtyRow ? 'rgba(var(--color-primary-rgb, 99,102,241), 0.03)' : (i % 2 === 0 ? '' : 'var(--color-surface)'),
                        transition: 'background 0.1s',
                      }}
                    >
                      {/* User info */}
                      <td style={{ padding: '12px 20px', verticalAlign: 'middle' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{
                            width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                            background: 'var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-secondary)',
                          }}>
                            {u.name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {u.name}
                              {isDirtyRow && <span style={{ marginLeft: 6, fontSize: 'var(--font-size-2xs)', color: 'var(--color-primary)', fontWeight: 700 }}>●</span>}
                            </div>
                            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 1 }}>
                              <RoleBadge role={u.role} />
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Feature checkboxes */}
                      {features.map(f => {
                        const allowed = roleAllows(u.role, f);
                        return (
                          <FeatureCell
                            key={f}
                            userId={u.id}
                            feature={f}
                            userName={u.name}
                            featureLabel={(FEATURE_META[f] && FEATURE_META[f].label) || f}
                            checked={isAdmin ? true : (allowed && getFlag(u, f))}
                            disabled={isAdmin || !allowed}
                            title={!allowed && !isAdmin ? `Disabled: ${ROLE_LABELS[u.role] || u.role} role cannot have ${f}. Change the user's role first.` : undefined}
                            onChange={handleToggle}
                          />
                        );
                      })}

                      {/* Reset to defaults */}
                      <td style={{ textAlign: 'center', padding: '10px 16px', verticalAlign: 'middle' }}>
                        {isAdmin ? (
                          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>—</span>
                        ) : (
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => resetDefaults(u.id)}
                            title={`Reset to ${ROLE_LABELS[u.role] || u.role} defaults`}
                            style={{ fontSize: 'var(--font-size-xs)', padding: '3px 10px' }}
                          >
                            Reset
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {users.length === 0 && !loading && (
              <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-data)' }}>
                No team members found.
              </div>
            )}
          </div>
        )}

        {/* Legend */}
        <div style={{ marginTop: 16, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <span>● Unsaved changes</span>
          <span>Admin rows are locked — admins always have full access</span>
          <span>Click Reset to restore a user's role defaults</span>
        </div>
      </div>
    </>
  );
}
